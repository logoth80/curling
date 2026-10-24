"""Compare the modelled stone handle with the reference photograph.

Not a look-alike contest: the reference carries a shape, and the only honest way
to say a model follows it is to measure both the same way.

Two measurements, on purpose.

  from the photographs (the reference, and a render of the shipped GLB framed like
  the reference: low camera, the handle's run across the frame)
    The coloured handle - cap and grip are one moulded piece in the photo and two
    parts in the model, but one colour each - is split out by saturation and kept
    as its largest blob. Each handle is then reduced to an outline: for 41 columns
    across its own bounding box, the topmost and bottommost row it reaches,
    normalised by that height. Scale, image size and camera distance drop out and
    what is left is the shape: where the grip rises, where its high point sits,
    how flat its run is, where it turns down. The reference holds two handles
    facing opposite ways, so the model is compared with both and with either
    facing, and the two also bound the measurement's own noise for each other.

  from the mesh (blender/_build_report.json, written by build_assets.py)
    the ratios a photograph cannot give exactly because of the angle it is taken
    at: how wide the cap sits against the stone, how far the handle stands above
    the granite, and how each end of the bar meets the cap's own surface - how
    deep it bites, how much of it is still standing above the surface there, how
    far it runs underground. That last group is the authority on where the ends
    stop, because it needs no camera: the failure it exists to catch is a bar that
    runs on under the cap, which reads in a profile view as the handle bending
    back into the stone.

The outline comparison, for all it is the only part that touches the reference, is
the COARSE one and is treated as such below: the blob it measures includes the cap,
and a 0.223 m disc seen at 20 degrees adds 76 mm of silhouette, more than the whole
rise of the bar. What it can settle is whether the handle reads as a leaning
gooseneck rather than a knob. It cannot settle where the feet land, and using it to
try once put both ends of the bar inside the stone.

It writes the classification it used to preview/handle_*_mask.png, so a wrong
measurement can be seen to be wrong rather than argued about, and
blender/_handle_check.json beside the numbers.

    python blender/check_handle.py
"""
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

REF = os.path.join(HERE, 'reference', 'handle_reference.webp')
MINE = os.path.join(HERE, 'preview', 'handle_photo_view.png')
BUILD = os.path.join(HERE, '_build_report.json')

SAMPLES = 41
# How far two outlines may disagree, in fractions of the handle's own height. This
# is a COARSE guard and is treated as one: the outline it compares is the handle
# and cap seen as one coloured blob from the photograph's angle, and the height of
# that blob is set mostly by the cap's projected ellipse -- a disc 0.223 m across
# seen at ~20 degrees adds 0.223*sin(20) = 76 mm of silhouette, which is more than
# the whole rise of the bar. It can tell a knob from a gooseneck, and which way the
# handle leans, and that is what it is used for. Where the ends of the bar stop is
# settled by the mesh checks at the end of this file, which read the built geometry
# against the cap surface directly and need no camera at all; designing against this
# number instead is what once buried both ends of the bar inside the stone.
# Set against what the reference's two handles - the same object seen from different
# sides - differ by, plus room for that projection difference.
OUTLINE_TOL = 0.16
# Where along the handle its high point may sit. A handle meant to be held from
# one side leans: the high point is near one end. Centred, it is a teacup handle.
PEAK_EDGE = 0.42
# How far the free end has to fall below the level of the run. The reference reads
# much larger than this here (0.8), and that figure is the cap's ellipse, not the
# bar's curl: the mesh checks below hold the real drop in metres.
FREE_END_DROP = 0.10


def load255(path):
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    return a[..., 0], a[..., 1], a[..., 2]


def masks(path):
    """Colour classes on 0-255 values. The ranges are the same for the reference
    and the render on purpose: both are staged on a light background, the granite
    is unsaturated grey, and the handle is the only saturated thing in frame -
    red in the render, red or yellow in the photo, which is why the handle is one
    class rather than two."""
    r, g, b = load255(path)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    return {
        'handle': (mx > 130) & ((mx - mn) > 55) & (r == mx),
        'granite': ((mx - mn) < 26) & (mx > 60) & (mx < 205),
        'background': (mn > 215),
    }


def largest_blob(m):
    keep = np.zeros_like(m)
    best, best_size = None, 0
    seen = np.zeros_like(m)
    h, w = m.shape
    for y in range(h):
        for x in range(w):
            if not m[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)])
            seen[y, x] = True
            blob = []
            while q:
                cy, cx = q.popleft()
                blob.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and m[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(blob) > best_size:
                best, best_size = blob, len(blob)
    if best:
        for y, x in best:
            keep[y, x] = True
    return keep


def bbox(m):
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def widest_row(m):
    bb = bbox(m)
    if not bb:
        return 0
    x0, y0, x1, y1 = bb
    return int(m[y0:y1 + 1, x0:x1 + 1].sum(axis=1).max())


def widest_row_in_band(m, x_from, x_to):
    return int(m[:, x_from:x_to].sum(axis=1).max())


def body_aspect(m):
    """A stone body's projected height over its widest row. If the render and the
    photograph disagree here they are not looking at the stone from the same
    angle, and the outline numbers below would compare a shape with a viewpoint.
    Height over widest row, not over a bounding box, because the two stones in
    the reference overlap each other and a bounding box would be truncated."""
    ys, _ = np.nonzero(m)
    if len(ys) == 0:
        return None
    w = widest_row(m)
    return round((int(ys.max()) - int(ys.min()) + 1) / float(w), 3) if w >= 50 else None


def outline(m, samples=SAMPLES):
    bb = bbox(m)
    if not bb:
        return None
    x0, y0, x1, y1 = bb
    h = max(1, y1 - y0 + 1)
    top, bot = [], []
    for i in range(samples):
        c = x0 + round(i * (x1 - x0) / (samples - 1.0))
        col = np.nonzero(m[:, c])[0]
        if len(col) == 0:
            top.append(None)
            bot.append(None)
        else:
            top.append((int(col.min()) - y0) / h)
            bot.append((int(col.max()) - y0) / h)
    return {'bbox': [x0, y0, x1, y1], 'w': x1 - x0 + 1, 'h': h,
            'aspect': round(h / float(x1 - x0 + 1), 3), 'top': top, 'bottom': bot}


def outline_deviation(a, b):
    """Mean absolute deviation between two outlines, in fractions of the handle's
    own height. The better of direct and mirrored: the reference's two handles
    face opposite ways, and the model's may be seen from either side."""
    def mad(t1, b1, t2, b2):
        d = [abs(x - y) for x, y in zip(t1 + b1, t2 + b2) if x is not None and y is not None]
        return sum(d) / len(d) if d else 1.0
    rev = lambda s: s[::-1]
    return min(mad(a['top'], a['bottom'], b['top'], b['bottom']),
               mad(a['top'], a['bottom'], rev(b['top']), rev(b['bottom'])))


def shape_reading(o):
    """What the outline says about the handle's build: where its high point sits
    along its length, and how far its free end falls below the level of the run."""
    pts = [(i, t) for i, t in enumerate(o['top']) if t is not None]
    if len(pts) < 12:
        return None
    n = len(pts)
    hi_i = min(range(n), key=lambda k: pts[k][1])
    peak_pos = hi_i / float(n - 1)
    mid = [t for i, t in pts[n // 3: 2 * n // 3]]
    ends = [t for i, t in pts if i < 3 or i > n - 4]
    level = min(mid) if mid else 1.0
    drop = (max(ends) - level) if ends else -1.0
    return {'peak_position': round(peak_pos, 3), 'free_end_drop': round(drop, 3)}


def dump_masks(path, out, **tints):
    """Write what the classifier actually saw, so a wrong measurement can be seen
    to be wrong instead of argued about."""
    img = np.zeros(load255(path)[0].shape + (3,), dtype=np.uint8)
    got = masks(path)
    for (name, (cr, cg, cb)) in tints.items():
        img[got[name]] = (cr, cg, cb)
    Image.fromarray(img).save(out)
    return os.path.relpath(out, ROOT).replace('\\', '/')


def main():
    for p in (REF, MINE, BUILD):
        if not os.path.exists(p):
            raise SystemExit('missing %s - build and render first '
                             '(blender/build_assets.py, blender/preview_handle.py)' % p)

    ref = masks(REF)
    W = ref['handle'].shape[1]
    # the reference holds two stones side by side; split them so each handle is
    # measured against the body it belongs to
    split = int(W * 0.47)
    built = json.load(open(BUILD, encoding='utf-8'))
    dumps = [dump_masks(REF, os.path.join(HERE, 'preview', 'handle_ref_mask.png'),
                        handle=(255, 0, 255), granite=(90, 90, 90)),
             dump_masks(MINE, os.path.join(HERE, 'preview', 'handle_model_mask.png'),
                        handle=(255, 0, 255), granite=(90, 90, 90))]

    my_handle = largest_blob(masks(MINE)['handle'])
    my_out = outline(my_handle)
    if not my_out:
        raise SystemExit('could not find the coloured handle in %s' % MINE)
    my_shape = shape_reading(my_out)
    my_body_aspect = body_aspect(largest_blob(masks(MINE)['granite']))
    if my_body_aspect is None:
        raise SystemExit('could not find the granite body in %s' % MINE)

    rows, checks, ref_caps, ref_devs, ref_body_aspects = [], [], [], [], []
    for name, (x0, x1) in (('left', (0, split)), ('right', (split, W))):
        band = ref['handle'].copy()
        band[:, :x0] = False
        band[:, x1:] = False
        hm = largest_blob(band)
        o = outline(hm)
        body_w = widest_row_in_band(ref['granite'], x0, x1)
        body_ar = body_aspect(largest_blob(_band(ref['granite'], x0, x1)))
        if not o or body_w < 50 or body_ar is None:
            continue
        cap_w = widest_row(hm)
        d = outline_deviation(my_out, o)
        ref_caps.append(cap_w / float(body_w))
        ref_devs.append(d)
        ref_body_aspects.append(body_ar)
        rows.append({'source': 'reference ' + name, 'handle_w_px': o['w'], 'handle_h_px': o['h'],
                     'aspect': o['aspect'], 'body_aspect': body_ar,
                     'cap_over_body': round(cap_w / float(body_w), 3),
                     'shape': shape_reading(o), 'outline_deviation_vs_model': round(d, 3)})

    rows.append({'source': 'model (this build)', 'handle_w_px': my_out['w'], 'handle_h_px': my_out['h'],
                 'aspect': my_out['aspect'], 'body_aspect': my_body_aspect, 'cap_over_body': None,
                 'shape': my_shape, 'outline_deviation_vs_model': None})

    if len(ref_devs) < 2:
        raise SystemExit('the reference should yield two handles; it gave %d - check the split point'
                         % len(ref_devs))
    # the reference's two handles are the same object seen differently: how far
    # they differ from each other is the floor under any threshold here
    against_each_other = outline_deviation(
        outline(largest_blob(_band(ref['handle'], 0, split))),
        outline(largest_blob(_band(ref['handle'], split, W))))

    ref_ba = sum(ref_body_aspects) / len(ref_body_aspects)
    checks.append(('the render looks at the stone from near the angle the reference is taken at',
                   abs(my_body_aspect - ref_ba) < 0.12,
                   'body height over width: %.2f in the render, %.2f in the reference' % (my_body_aspect, ref_ba)))
    for row, d in zip([r for r in rows if r['source'].startswith('reference')], ref_devs):
        checks.append(('the modelled handle outline matches the reference (%s)' % row['source'],
                       d < OUTLINE_TOL,
                       'mean deviation %.3f of the handle height, limit %.2f '
                       '(the reference handles differ from each other by %.3f)' % (d, OUTLINE_TOL, against_each_other)))

    if not my_shape:
        raise SystemExit('the model outline is too sparse to read its shape from')
    checks.append(('the handle leans: its high point sits near one end, not centred',
                   my_shape['peak_position'] < PEAK_EDGE or my_shape['peak_position'] > 1 - PEAK_EDGE,
                   'high point at %.2f along the handle' % my_shape['peak_position']))
    checks.append(('the free end turns down below the level of the run',
                   my_shape['free_end_drop'] > FREE_END_DROP,
                   'free end %.2f of the handle height below the run' % my_shape['free_end_drop']))
    checks.append(('the cap and grip together are wider than they are tall',
                   my_out['aspect'] < 0.75, 'aspect height/width = %.2f' % my_out['aspect']))

    mesh = built['stone_red.glb']['handle']
    lo, hi = min(ref_caps) - 0.07, max(ref_caps) + 0.07
    checks.append(('the cap sits as wide against the stone as the reference measures (%.2f-%.2f)' % (lo, hi),
                   lo <= mesh['cap_diameter_over_body'] <= hi,
                   'cap %.2f of the body diameter' % mesh['cap_diameter_over_body']))
    checks.append(('the handle stands as far above the stone as the reference shows (0.045-0.075 m)',
                   0.045 <= mesh['handle_top_above_stone_top_m'] <= 0.075,
                   '%.3f m above the granite' % mesh['handle_top_above_stone_top_m']))
    checks.append(('the bar is as thick as the reference measures it (0.028-0.042 m)',
                   0.028 <= mesh['grip_section_thickness_m'] <= 0.042,
                   '%.3f m through' % mesh['grip_section_thickness_m']))
    root_burial = mesh['grip_root_foot_burial_m']
    tip_burial = mesh['grip_tip_foot_burial_m']
    root_proud = mesh['grip_root_proud_of_cap_m']
    tip_proud = mesh['grip_tip_proud_of_cap_m']
    checks.append(('both feet of the bar bite the cap surface, so the joint is moulded rather than butted',
                   min(root_burial, tip_burial) >= 0.001,
                   'root bites %.4f m, free end %.4f m' % (root_burial, tip_burial)))
    checks.append(('no end of the bar runs deep under the cap surface (<= 0.015 m of material underground)',
                   max(root_burial, tip_burial) <= 0.015,
                   'deepest material %.4f m under the cap' % max(root_burial, tip_burial)))
    checks.append(('the bar is still standing where it meets the cap (>= 0.020 m proud of it at both feet)',
                   min(root_proud, tip_proud) >= 0.020,
                   'proud of the cap by %.4f m at the rear foot and %.4f m at the free foot'
                   % (root_proud, tip_proud)))
    checks.append(('the arch stands clear of the cap across its run, leaving room for a hand (>= 0.008 m)',
                   mesh['grip_clears_cap_over_the_run_m'] >= 0.008,
                   'tightest clearance under the bar over the run %.4f m'
                   % mesh['grip_clears_cap_over_the_run_m']))
    root_reach = mesh['grip_root_reach_over_cap_radius']
    tip_reach = mesh['grip_tip_reach_over_cap_radius']
    checks.append(('both buried tails stay under the cap, so none of the joint shows',
                   max(root_reach, tip_reach) <= 0.85,
                   'tails reach %.2f and %.2f of the cap radius, both under its surface'
                   % (root_reach, tip_reach)))

    failed = [c for c, ok, _ in checks if not ok]
    summary = {'reference_caps_on_body': [round(c, 3) for c in ref_caps],
               'reference_handles_differ_by': round(against_each_other, 3),
               'masks': dumps, 'rows': rows,
               'checks': [[ok, c, m] for c, ok, m in checks], 'failed': len(failed)}
    print('HANDLE ' + json.dumps(summary, ensure_ascii=False))
    with open(os.path.join(HERE, '_handle_check.json'), 'w', encoding='utf-8') as fh:
        json.dump({'reference': os.path.relpath(REF, ROOT).replace('\\', '/'),
                   'model': os.path.relpath(MINE, ROOT).replace('\\', '/'),
                   'samples': SAMPLES, 'outline_tolerance': OUTLINE_TOL,
                   'peak_edge': PEAK_EDGE, 'free_end_drop': FREE_END_DROP,
                   **summary}, fh, indent=2, default=str)
    if failed:
        raise SystemExit('the handle does not follow the reference: ' + '; '.join(failed))
    print('HANDLE OK %d checks' % len(checks))


def _band(m, x0, x1):
    b = m.copy()
    b[:, :x0] = False
    b[:, x1:] = False
    return b


main()
