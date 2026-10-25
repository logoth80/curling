"""Generate favicon.ico out of the sheet's own numbers.

Nothing in here is eyeballed. The ring radii are read from SHEET.rings in
physics.js and the colours from the material factors in blender/build_assets.py,
so the icon cannot quietly drift away from the sheet the game actually draws. If
a number stops parsing, the generator stops with a complaint instead of drawing
something plausible -- which is the same rule the rest of this repo follows.

An icon is unlit. A glTF base-colour factor is linear, so the factors are
encoded to sRGB before they become pixels: that is the colour the rings are made
of. The renders in blender/preview sit lower than these values because they are
shot under lights, and that is a different measurement in a different file.

Two honest consequences of drawing the real thing at a small size. The tee line
and the centre line are 0.05 m wide, which is 2.7 per cent of the house radius:
at 16 px they are gone except where the two lines meet. The button is a twelfth
of the house, so at 16 px it is a single dot. Neither is corrected, because a
favicon that quietly invents proportions stops being this sheet.

The container carries two entry formats, and that is not decoration. The sizes
Windows asks for -- 16 through 64 px -- are stored as classic uncompressed 32-bit
DIBs with an AND mask; 128 and 256 stay PNG, because an uncompressed 256 px entry
would cost eight times what it is worth and only browsers ask for those. An
all-PNG file was tried first: browsers drew it happily and Windows answered
ExtractIconEx(large) with zero icons, the 16 px entry decoding while the 32 and 48
px ones did not. That is what "the icon looks blank in Explorer" turns out to mean,
and it is why the small sizes are written the way the Windows decoder expects.

    python tools/make_favicon.py                  # needs Pillow
    python tools/make_favicon.py --qa <dir>       # also writes PNGs to look at
"""
import json
import os
import re
import struct
import sys
from io import BytesIO

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'favicon.ico')

# The sizes a browser and a desktop will actually ask for. Each one is drawn from
# its own supersample rather than shrunk down from one master, because a 16 px
# ring wants a 16 px answer.
SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 8

# The sizes stored as classic uncompressed DIBs rather than PNG. This is not
# nostalgia: a .ico whose entries are all PNG compressed was tried and Windows
# answered `ExtractIconEx(path, large, ...)` with **zero icons** -- the small
# entry decoded, the 32 and 48 px ones did not, so File Explorer drew nothing at
# all for the file. Browsers read either form; the Windows icon machinery is the
# one that wants the form it was built on. The big sizes stay PNG, because an
# uncompressed 256 px entry would cost 8x what it is worth.
DIB_SIZES = [16, 24, 32, 48, 64]


def fail(message):
    print('ICON: ' + message)
    sys.exit(1)


def read_text(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.isfile(path):
        fail('missing ' + rel)
    with open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


# ------------------------------------------------------------------ the inputs
def parse_rings(src):
    """The four radii, in metres, exactly as the physics uses them."""
    m = re.search(r'rings:\s*\{\s*twelve:\s*([0-9.]+),\s*eight:\s*([0-9.]+),'
                  r'\s*four:\s*([0-9.]+),\s*button:\s*([0-9.]+)', src)
    if not m:
        fail('SHEET.rings in physics.js does not look like the four-ring house this expects')
    return [float(v) for v in m.groups()]


def parse_rgba(src, name):
    """A material factor tuple from the asset builder: (r, g, b, a), linear."""
    m = re.search(r'^' + name + r'\s*=\s*\(([^)]*)\)', src, re.M)
    if not m:
        fail(name + ' not found in blender/build_assets.py')
    parts = [float(v) for v in m.group(1).replace('\n', ' ').split(',') if v.strip()]
    if len(parts) < 3:
        fail(name + ' is not an (r, g, b, a) factor')
    return parts[:3]


def parse_line_width(src):
    """The tee line is drawn with an explicit width; the centre line uses the same one."""
    m = re.search(r"line\('line_tee',\s*[A-Za-z_0-9]+,\s*([0-9.]+),", src)
    if not m:
        fail('the tee line width is not readable out of blender/build_assets.py')
    return float(m.group(1))


def to_srgb(value):
    """Linear factor to the byte an unlit pixel must carry for the same colour."""
    v = 12.92 * value if value <= 0.0031308 else 1.055 * (value ** (1.0 / 2.4)) - 0.055
    return max(0, min(255, int(round(v * 255))))


# ------------------------------------------------------------------- the drawing
def draw_house(px, rings, colours, line_col, line_width_m):
    """One size, supersampled and then resolved down.

    `rings` are metres, so every radius is a fraction of the 12-foot radius --
    the same ratio the sheet is built with. `colours` and `line_col` are sRGB
    bytes, converted by the caller: the drawing never sees a linear factor, which
    is how a colour space gets quietly mixed into an image. The cross is clipped
    by the house disc, which is what a plan view cropped to the house looks like.
    """
    ss = px * SUPERSAMPLE
    r_px = 0.46 * ss                       # the 12-foot ring fills 92 per cent of the canvas
    cx = cy = ss / 2.0

    img = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for radius_m, col in zip(rings, colours):
        r = r_px * radius_m / rings[0]
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))

    lw = max(1, int(round(r_px * line_width_m / rings[0])))
    d.line([(cx - r_px, cy), (cx + r_px, cy)], fill=line_col, width=lw)     # tee line
    d.line([(cx, cy - r_px), (cx, cy + r_px)], fill=line_col, width=lw)     # centre line

    mask = Image.new('L', (ss, ss), 0)
    ImageDraw.Draw(mask).ellipse([cx - r_px, cy - r_px, cx + r_px, cy + r_px], fill=255)
    img.putalpha(mask)
    # BOX, not LANCZOS. The canvas is already an 8x supersample, so averaging
    # each block down is the filter this needs, and it leaves flat areas flat.
    # LANCZOS was tried first and rang badly enough around the small, saturated
    # button to shift plain white pixels by eleven - which the self-check under
    # main() caught, and which would have been an invisible colour drift in the
    # file the browser actually shows.
    return img.resize((px, px), Image.Resampling.BOX)


def sample_check(img, rings, colours):
    """Read the drawing back, off a diagonal, where no line passes.

    A generator that only writes pixels has no idea whether it wrote the right
    ones. These are the mid-radius points of each annulus along a 45 degree
    diagonal, so the tee and centre lines cannot land on the probe.
    """
    px = img.size[0]
    r_px = 0.46 * px
    diag = 0.7071
    probes = []
    for i in range(len(rings)):
        inner = rings[i + 1] if i + 1 < len(rings) else 0.0
        r = r_px * 0.5 * (rings[i] + inner) / rings[0]
        got = img.getpixel((int(round(px / 2 + r * diag)), int(round(px / 2 - r * diag))))
        want = colours[i]
        off = max(abs(a - b) for a, b in zip(got[:3], want))
        probes.append({'ring': i, 'want': list(want), 'got': list(got[:3]), 'max_off': off})
    return probes


# ------------------------------------------------------------------- the container
def png_bytes(img):
    buf = BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def dib_bytes(img):
    """The entry format the Windows icon machinery was built on.

    A BI_RGB BITMAPINFOHEADER whose biHeight is *twice* the image height: colour
    pixels bottom-up as BGRA, then the AND mask, rows padded to a 4-byte
    boundary. The mask is not left empty just because the alpha channel is there
    too: a set bit in the AND mask means "this pixel is transparent", and code
    that reads the mask instead of the alpha renders an empty mask as a solid
    black square. So the mask carries the hard silhouette while the alpha channel
    carries the soft anti-aliased edge, which is what modern Windows composites.
    """
    w, h = img.size
    rgba = img.tobytes()
    mask_row = ((w + 31) // 32) * 4
    px = bytearray()
    mask = bytearray(mask_row * h)
    for out_row, y in enumerate(range(h - 1, -1, -1)):     # both halves are bottom-up
        row = rgba[y * w * 4:(y + 1) * w * 4]
        for x in range(w):
            r, g, b, a = row[x * 4:x * 4 + 4]
            px += bytes((b, g, r, a))
            if a < 128:
                mask[out_row * mask_row + x // 8] |= 0x80 >> (x % 8)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(px) + len(mask), 0, 0, 0, 0)
    return header + bytes(px) + bytes(mask)


def payload_for(img):
    """DIB for the sizes Windows asks for, PNG for the sizes only browsers ask for."""
    return dib_bytes(img) if img.size[0] in DIB_SIZES else png_bytes(img)


def write_ico(path, payloads):
    """ICONDIR plus one ICONDIRENTRY per image.

    bPlanes=1 and bBitCount=32 are what both entry kinds want; a decoder tells
    them apart by the payload's own signature, not by the directory. The width and
    height bytes wrap to 0 for a 256 px entry, which is how the format says so.
    """
    header = struct.pack('<HHH', 0, 1, len(payloads))
    entries, body, offset = b'', b'', 6 + 16 * len(payloads)
    for px, data in zip(SIZES, payloads):
        entries += struct.pack('<BBBBHHII', px % 256, px % 256, 0, 0, 1, 32, len(data), offset)
        body += data
        offset += len(data)
    with open(path, 'wb') as fh:
        fh.write(header + entries + body)


def read_ico(path):
    """Parse the container back, so the file is checked rather than trusted."""
    with open(path, 'rb') as fh:
        data = fh.read()
    reserved, kind, count = struct.unpack('<HHH', data[:6])
    if reserved != 0 or kind != 1:
        fail('the .ico header is not an icon directory')
    out = []
    for i in range(count):
        entry = data[6 + 16 * i: 22 + 16 * i]
        w, _h, _c, _r, planes, bpp, size, off = struct.unpack('<BBBBHHII', entry)
        px = w or 256
        blob = data[off:off + size]
        info = {'px': px, 'planes': planes, 'bpp': bpp, 'bytes': size,
                'kind': 'png' if blob[:4] == b'\x89PNG' else 'dib',
                'complete': off + size <= len(data) and len(blob) == size}
        if info['kind'] == 'dib':
            hdr = struct.unpack('<IiiHHIIiiII', blob[:40])
            hsz, dw, dh, dplanes, dbpp, comp = hdr[:6]
            mask_row = ((dw + 31) // 32) * 4
            mask_at, mask_len = 40 + dw * px * 4, mask_row * px
            mask = blob[mask_at:mask_at + mask_len]
            # Both halves of a DIB entry are stored bottom-up, so stored row r of
            # the pixels pairs with stored row r of the mask. A masked pixel must
            # be transparent in the alpha channel and vice versa: either half
            # lying is a black square or a hole, depending on which half a
            # particular Windows component believes.
            agrees = len(mask) == mask_len
            for r in range(px if agrees else 0):
                for x in range(px):
                    alpha = blob[40 + (r * px + x) * 4 + 3]
                    bit = (mask[r * mask_row + x // 8] >> (7 - x % 8)) & 1
                    if bool(bit) != (alpha < 128):
                        agrees = False
                        break
                if not agrees:
                    break
            info.update({'dib_header': hsz, 'dib_w': dw, 'dib_double_height': dh == 2 * px,
                         'dib_compression': comp, 'dib_bitcount': dbpp,
                         'mask_matches_alpha': agrees})
        out.append(info)
    return out


def main():
    physics = read_text('physics.js')
    assets = read_text(os.path.join('blender', 'build_assets.py'))

    rings = parse_rings(physics)
    factors = [parse_rgba(assets, n) for n in ('COL_BLUE', 'COL_WHITE', 'COL_RED')]
    line_factor = parse_rgba(assets, 'COL_LINE')
    line_w = parse_line_width(assets)

    # The house as the sheet builds it: blue 12-foot, white 8-foot, red 4-foot,
    # white button. Outermost inward, which is also the draw order.
    order = [rings[0], rings[1], rings[2], rings[3]]
    linear = [factors[0], factors[1], factors[2], factors[1]]
    colours = [tuple(to_srgb(c) for c in col) for col in linear]
    line_col = tuple(to_srgb(c) for c in line_factor) + (255,)

    images = [draw_house(px, order, colours, line_col, line_w) for px in SIZES]
    payloads = [payload_for(im) for im in images]
    write_ico(OUT, payloads)

    probes = sample_check(images[-1], order, colours)
    entries = read_ico(OUT)
    worst = max(p['max_off'] for p in probes)
    report = {
        'out': os.path.relpath(OUT, ROOT).replace('\\', '/'),
        'bytes': os.path.getsize(OUT),
        'ring_radii_m': order,
        'line_width_m': line_w,
        'palette_srgb': [list(c) for c in colours],
        'entries': [{'px': e['px'], 'kind': e['kind'], 'bytes': e['bytes'],
                     'mask_matches_alpha': e.get('mask_matches_alpha')} for e in entries],
        'dib_sizes': [e['px'] for e in entries if e['kind'] == 'dib'],
        'sampled_ring_pixels_off_by_at_most': worst,
    }
    if worst > 2:
        fail('the drawn rings do not carry the sheet colours: ' + json.dumps(probes))
    if [e['px'] for e in entries] != SIZES or not all(e['complete'] for e in entries):
        fail('the written container does not read back as intended: ' + json.dumps(entries))
    # The whole point of the DIB entries is that the Windows decoder accepts them,
    # so they are checked in the form it expects rather than assumed correct.
    for e in entries:
        want_dib = e['px'] in DIB_SIZES
        is_dib = e['kind'] == 'dib'
        if is_dib != want_dib:
            fail('%d px entry is stored as %s; %s' % (
                e['px'], e['kind'], 'Windows wants a DIB at this size' if want_dib else 'this size should stay PNG'))
        if e['kind'] == 'dib' and not (e['dib_header'] == 40 and e['dib_w'] == e['px']
                                       and e['dib_double_height'] and e['dib_compression'] == 0
                                       and e['dib_bitcount'] == 32 and e['mask_matches_alpha']):
            fail('%d px DIB entry is not in the form the classic decoder reads: %s' % (e['px'], json.dumps(e)))

    if '--qa' in sys.argv:
        out_dir = sys.argv[sys.argv.index('--qa') + 1]
        os.makedirs(out_dir, exist_ok=True)
        for im in images:
            im.save(os.path.join(out_dir, 'icon_%d.png' % im.size[0]))
        report['qa_dir'] = out_dir

    print('ICON ' + json.dumps(report))


if __name__ == '__main__':
    main()
