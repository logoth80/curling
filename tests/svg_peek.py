"""Rasterize a small SVG subset so the weight widget can actually be looked at.

There is no browser and no SVG library in this environment, and the game's weight
control is drawn as SVG, so the only way to *see* what tests/uitest.mjs
generates is to draw it here. This covers exactly the subset track.js emits:
rect / circle / line / polyline / path-with-M-and-l / text. Styles come from the
same class rules index.html defines — read out of index.html, so the picture
cannot drift from what the page paints — and translucent fills are composited
the way a browser would composite them.

  python tests/svg_peek.py tests/track_preview.svg tests/track_preview.png
"""
import re
import sys
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = 'C:/Windows/Fonts/consola.ttf'   # monospace, like the widget's CSS


def parse_style(css):
    """{'.class': {prop: value}} from `#sheetTrack .cls { prop: v; ... }` rules."""
    rules = {}
    for sel, body in re.findall(r'([^{}]*)\{([^{}]*)\}', css):
        props = {}
        for decl in body.split(';'):
            if ':' in decl:
                k, v = decl.split(':', 1)
                props[k.strip()] = v.strip()
        for part in sel.split(','):
            for cls in re.findall(r'\.([A-Za-z0-9_-]+)', part):
                rules.setdefault(cls, {}).update(props)
    return rules


def rgba(color, opacity=1.0):
    """'#abc', '#aabbcc', 'rgba(r,g,b,a)' -> (r,g,b,alpha*opacity) or None."""
    c = (color or '').strip()
    m = re.match(r'rgba?\(([^)]+)\)', c)
    if m:
        p = [float(v) for v in re.split(r'[\s,]+', m.group(1).strip()) if v]
        return (int(p[0]), int(p[1]), int(p[2]), int(255 * (p[3] if len(p) > 3 else 1.0) * opacity))
    if c.startswith('#'):
        h = c[1:]
        if len(h) == 3:
            h = ''.join(ch * 2 for ch in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (int(255 * opacity),)
    return None


class Painter:
    """Draws one shape at a time; translucent shapes go on their own layer so
    they composite over what is already drawn instead of replacing it."""

    def __init__(self, img):
        self.img = img
        self.layer = None
        self.d = None

    def begin(self, alpha):
        if alpha < 255:
            self.layer = Image.new('RGBA', self.img.size, (0, 0, 0, 0))
            self.d = ImageDraw.Draw(self.layer)
        else:
            self.layer = None
            self.d = ImageDraw.Draw(self.img)

    def commit(self):
        if self.layer is not None:
            self.img.alpha_composite(self.layer)
            self.layer = None


def main(svg_path, png_path):
    src = open(svg_path, encoding='utf-8').read()
    vb = [float(v) for v in re.search(r'viewBox="([\d. ]+)"', src).group(1).split()]
    scale = 2
    w, h = int(vb[2] * scale), int(vb[3] * scale)
    style_css = re.search(r'<style>(.*?)</style>', src, re.S).group(1)
    styles = parse_style(style_css)
    base = rgba(re.search(r'svg\{background:([^}]+)\}', style_css).group(1)) or (5, 8, 13, 255)
    img = Image.new('RGBA', (w, h), base)
    p = Painter(img)

    try:
        base_font = ImageFont.truetype(FONT_PATH, int(7 * scale))
    except OSError:
        base_font = ImageFont.load_default()

    def dash_of(style):
        if 'stroke-dasharray' not in style:
            return None
        return [float(v) * scale for v in re.split(r'[ ,]+', style['stroke-dasharray']) if v]

    def stroke_of(style, opacity):
        col = rgba(style.get('stroke') or style.get('fill'), opacity)
        width = max(1, int(float(style.get('stroke-width', 1)) * scale))
        return col, width

    def segment(d, pts, color, width, dashes, X, Y):
        pts = [(X(x), Y(y)) for x, y in pts]
        if not dashes:
            d.line(pts, fill=color, width=width)
            return
        on, off = dashes[0], (dashes[1] if len(dashes) > 1 else dashes[0])
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            total = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
            if total <= 0:
                continue
            t = 0.0
            while t < total:
                t2 = min(total, t + on)
                d.line([(x0 + (x1 - x0) * t / total, y0 + (y1 - y0) * t / total),
                        (x0 + (x1 - x0) * t2 / total, y0 + (y1 - y0) * t2 / total)],
                       fill=color, width=width)
                t = t2 + off

    # Walk the document in order, keeping a stack of <g transform="translate …">
    # offsets so a multi-panel artifact draws each panel where it belongs.
    stack = [(0.0, 0.0)]
    for m in re.finditer(r'<(/?)(g|rect|circle|line|polyline|path|text)([^>]*)(?:>([^<]*))?', src):
        close, kind, attrs, body = m.group(1), m.group(2), m.group(3), m.group(4)
        if close:
            # only a real </g> leaves a panel; </text>, </polyline> etc. must not
            if kind == 'g' and len(stack) > 1:
                stack.pop()
            continue
        if kind == 'g':
            tr = re.search(r'transform="translate\(([-\d. ]+)\)"', attrs)
            ox, oy = stack[-1]
            if tr:
                dx, dy = [float(v) for v in tr.group(1).split()]
                ox, oy = ox + dx, oy + dy
            stack.append((ox, oy))
            continue

        cls = (re.search(r'class="([^"]+)"', attrs) or [None, ''])[1]
        style = dict(styles.get(cls, {}))
        for k, v in re.findall(r'\b(fill|stroke|text-anchor|opacity)="([^"]+)"', attrs):
            style[k] = v
        ox, oy = stack[-1]

        def num(name, default=0.0):
            mm = re.search(r'\b' + name + r'="(-?[\d.]+)"', attrs)
            return float(mm.group(1)) if mm else default

        X = lambda v: (v + ox) * scale
        Y = lambda v: (v + oy) * scale

        opacity = float(style.get('opacity', 1))
        fill = rgba(style.get('fill'), opacity)
        stroke, width = stroke_of(style, opacity)
        dashes = dash_of(style)

        if kind in ('rect', 'circle'):
            p.begin(min(a for a in [fill[3] if fill else 0, stroke[3] if stroke else 0] if a) or 255)
            if kind == 'rect':
                x, y, ww, hh = num('x'), num('y'), num('width'), num('height')
                box = [X(x), Y(y), X(x + ww), Y(y + hh)]
                shape = p.d.rectangle
            else:
                cx, cy, r = num('cx'), num('cy'), num('r')
                box = [X(cx - r), Y(cy - r), X(cx + r), Y(cy + r)]
                shape = p.d.ellipse
            if fill and style.get('fill', 'none') != 'none':
                shape(box, fill=fill)
            if stroke:
                shape(box, outline=stroke, width=width)
            p.commit()
        elif kind == 'line':
            p.begin(stroke[3] if stroke else 0)
            segment(p.d, [(num('x1'), num('y1')), (num('x2'), num('y2'))], stroke, width, dashes, X, Y)
            p.commit()
        elif kind == 'polyline':
            pts = [tuple(map(float, s.split(','))) for s in
                   (re.search(r'points="([^"]*)"', attrs) or ['', ''])[1].split() if ',' in s]
            p.begin(stroke[3] if stroke else 0)
            segment(p.d, pts, stroke, width, dashes, X, Y)
            p.commit()
        elif kind == 'path':
            cur = [0.0, 0.0]
            p.begin(stroke[3] if stroke else 0)
            for cmd, args in re.findall(r'([MmLl])\s*([-\d., ]+)', (re.search(r'\sd="([^"]*)"', attrs) or ['', ''])[1]):
                vals = [float(v) for v in re.split(r'[ ,]+', args.strip()) if v]
                for i in range(0, len(vals), 2):
                    ref = list(cur) if cmd in 'lL' else [0.0, 0.0]
                    cur = [ref[0] + vals[i], ref[1] + vals[i + 1]]
                    if cmd == 'M':
                        continue
                    segment(p.d, [ref, cur], stroke, width, dashes, X, Y)
            p.commit()
        else:  # text
            text = (body or '').strip()
            if not text:
                continue
            font = base_font
            if style.get('font-size'):
                try:
                    font = ImageFont.truetype(FONT_PATH, int(float(re.sub(r'[^0-9.]', '', style['font-size'])) * scale))
                except (OSError, ValueError):
                    pass
            p.begin(fill[3] if fill else 255)
            x, y = X(num('x')), Y(num('y'))
            anchor = style.get('text-anchor', 'start')
            wtext = p.d.textlength(text, font=font)
            x = x - wtext if anchor == 'end' else x - wtext / 2 if anchor == 'middle' else x
            p.d.text((x, y - 7 * scale), text, font=font, fill=fill or (255, 255, 255, 255))
            p.commit()

    img.convert('RGB').save(png_path)
    print(f'wrote {png_path} {w}x{h}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
