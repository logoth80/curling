"""preview_assets.py — renders the exported GLBs back through the importer.

This is the visual gate for the asset work: it re-imports the files the game
will load (so embedded textures, the Y-up conversion and the part naming are
all exercised), places a realistic end of curling at real game coordinates, and
shoots it with the same camera angles main.js uses. If the ice renders black,
the house is on the wrong end, or a stone reads as a blob, it shows up here.

Game coordinates (physics.js) map into Blender as:
    blender_x = game_x,  blender_y = -game_z,  blender_z = game_y
which is exactly the export_yup conversion, so an imported GLB lands where the
game would put it.

    blender -b --factory-startup -P blender/preview_assets.py
"""
import json
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, 'assets')
OUT = os.path.join(HERE, 'preview')
os.makedirs(OUT, exist_ok=True)

SHEET_LEN, SHEET_W = 34.0, 4.88
TEE_Z, HACK_Z = 15.0, -15.0


def gb(x, y, z):
    """game point (x lateral, y up, z down-ice) -> blender (x, -z, y).
    This is the same mapping as the export, so a placed object lands where
    main.js would put it."""
    return (x, -z, y)


def new_scene():
    bpy.ops.wm.read_homefile(use_empty=True)


def set_engine():
    """Prefer EEVEE (fast, and it is what a realtime viewer approximates);
    fall back to Cycles if EEVEE cannot get a context in this process."""
    for cand in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            bpy.context.scene.render.engine = cand
            return cand
        except TypeError:
            continue
    bpy.context.scene.render.engine = 'CYCLES'
    return 'CYCLES'


def import_glb(name):
    path = os.path.join(ASSETS, name)
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=path)
    added = [o for o in bpy.data.objects if o.name not in before]
    return added


def place(objs, x, z, up=0.0, yaw=0.0, scale=1.0):
    """Position a root object at a game location. Importers keep their own
    Y-up node transforms, so we drive the outermost objects we just added."""
    for o in objs:
        if o.parent is not None:
            continue
        o.location = gb(x, up, z)
        o.rotation_euler = (0, 0, -yaw)
        if scale != 1.0:
            o.scale = (scale, scale, scale)
    return objs


def add_lights():
    """Roughly the game's rig: a cool key from the side, a soft top wash, and
    two pools of light over the sheet."""
    sky = bpy.data.worlds.new('world')
    bpy.context.scene.world = sky
    sky.use_nodes = True
    bg = sky.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.10, 0.14, 0.20, 1)
        bg.inputs[1].default_value = 0.9

    def area(name, game_loc, size, power, color=(1, 1, 1)):
        d = bpy.data.lights.new(name, 'AREA')
        d.energy = power
        d.size = size
        d.color = color
        ob = bpy.data.objects.new(name, d)
        bpy.context.collection.objects.link(ob)
        ob.location = gb(*game_loc)
        return ob

    # One-for-one with main.js so the preview says something about the game:
    # the world background stands in for HemisphereLight(0xdceaf6, 0.55), the
    # key for DirectionalLight(1.0) at (6,14,6), the fill for the cool
    # DirectionalLight(0.45) behind the hack, and the pools for the two
    # PointLights at (0,6.4,-6) and (0,6.4,10). Watts are not three.js units,
    # so the energies are tuned to land the ice at a mid tone instead of white:
    # a broadcast sheet lights ice well under clipping so the pebble keeps its
    # sparkle. main.js is then set to match *this* rig's measured result, which
    # is what makes the numbers below a statement about the game.
    area('key', (6, 14, 6), 8.0, 400, (1.0, 0.97, 0.92))
    area('fill', (-8, 9, -20), 10.0, 150, (0.75, 0.85, 1.0))
    area('house_pool', (0, 6.4, 10), 7.0, 260)
    area('hack_pool', (0, 6.4, -6), 6.0, 180)


def add_camera(name, pos_game, look_game, fov_deg=40, up_game=None):
    """Match main.js: its cameras carry a *vertical* FOV, so use a vertical
    sensor fit and derive the lens from the same angle. Framing has to match
    the game or these previews say nothing about the game.

    Pass up_game for a camera that declares its own up in main.js (CAM.plan
    does). A top-down view has no sky to point its head at, so the roll is the
    whole question and a TRACK_TO constraint would pick it arbitrarily; the
    basis is built with the same arithmetic Three.js uses in Matrix4.lookAt
    (z = eye - target, x = up x z, y = z x x) so this image and the assertions
    in tests/uitest.mjs are computed from the same vectors.
    """
    cam = bpy.data.cameras.new(name)
    cam.sensor_fit = 'VERTICAL'
    cam.sensor_width = 24.0
    cam.lens = 12.0 / math.tan(math.radians(fov_deg) / 2.0)
    ob = bpy.data.objects.new(name, cam)
    bpy.context.collection.objects.link(ob)
    ob.location = gb(*pos_game)
    if up_game is None:
        target = bpy.data.objects.new(name + '_target', None)
        bpy.context.collection.objects.link(target)
        target.location = gb(*look_game)
        con = ob.constraints.new('TRACK_TO')
        con.target = target
        con.track_axis = 'TRACK_NEGATIVE_Z'
        con.up_axis = 'UP_Y'
        return ob
    eye = Vector(gb(*pos_game))
    zc = (eye - Vector(gb(*look_game))).normalized()
    xc = Vector(gb(*up_game)).cross(zc).normalized()
    yc = zc.cross(xc)
    ob.matrix_world = Matrix((
        (xc[0], yc[0], zc[0], eye[0]),
        (xc[1], yc[1], zc[1], eye[1]),
        (xc[2], yc[2], zc[2], eye[2]),
        (0.0, 0.0, 0.0, 1.0),
    ))
    return ob


def stone_at(name, team_col, x, z, spin=0.0):
    """Place one of the exported stones. Re-importing per stone is wasteful but
    it keeps this script honest: every stone on the sheet is the shipped file."""
    objs = import_glb(team_col)
    place(objs, x, z, yaw=spin)
    return objs


def sample_frame(path):
    """Measure the frame instead of eyeballing it. The PNG is display-referred
    (sRGB, 0..1), which is exactly what a game renderer would show, so a value
    at 1.0 is a blown highlight. The lower-centre band is where the ice sits in
    a sheet view: that number says whether the sheet reads as ice or as a
    white floor."""
    img = bpy.data.images.load(path)
    try:
        w, h = img.size
        flat = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(flat)
    finally:
        bpy.data.images.remove(img)
    px = flat.reshape(h, w, 4)
    lum = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    region = lum[int(h * 0.55):int(h * 0.75), int(w * 0.40):int(w * 0.60)]
    return {
        'mean': round(float(lum.mean()), 3),
        'clip_frac': round(float((lum > 0.985).mean()), 4),
        'black_frac': round(float((lum < 0.02).mean()), 3),
        'ice_region_mean': round(float(region.mean()), 3),
        'ice_region_clip': round(float((region > 0.985).mean()), 3),
        'colour_std': round(float(px[..., :3].std()), 3),
    }


def render(view_name, shots):
    bpy.context.scene.render.resolution_percentage = 100
    results = []
    stats = {}
    for s in shots:
        cam = add_camera(s['name'], s['from'], s['look'], s.get('fov', 40), s.get('up_game'))
        bpy.context.scene.camera = cam
        bpy.context.scene.render.resolution_x = s.get('w', 1100)
        bpy.context.scene.render.resolution_y = s.get('h', 620)
        out = os.path.join(OUT, view_name + '_' + s['name'] + '.png')
        bpy.context.scene.render.filepath = out
        bpy.ops.render.render(write_still=True)
        results.append(out)
        stats[s['name']] = sample_frame(out)
    return results, stats


def main():
    report = {}
    new_scene()
    engine = set_engine()
    report['engine'] = engine
    try:
        bpy.context.scene.eevee.taa_render_samples = 24
    except Exception:
        pass
    bpy.context.scene.cycles.samples = 48
    try:
        bpy.context.scene.cycles.device = 'GPU'
    except Exception:
        pass
    bpy.context.scene.view_settings.view_transform = 'Filmic'
    bpy.context.scene.view_settings.look = 'Medium Contrast'

    # the sheet, the arena and the hack are single imports
    import_glb('sheet.glb')
    import_glb('arena.glb')
    hack = import_glb('hack.glb')
    place(hack, 0, HACK_Z)

    # a realistic end: two guards, a corner guard, counters and the hammer stone
    layout = [
        ('stone_yellow.glb', 0.00, 8.60),       # centre guard, no hammer
        ('stone_yellow.glb', 1.65, 9.80),       # corner guard
        ('stone_red.glb', 0.62, 13.40),         # opponent counter, raised
        ('stone_red.glb', -0.35, 15.02),        # on the button
        ('stone_yellow.glb', 0.46, 15.28),      # hammer stone, shot against it
        ('stone_red.glb', 0.00, 11.90),         # a front guard in play
    ]
    for glb, x, z in layout:
        stone_at(glb, glb, x, z, spin=(x * 3.0))
    report['stones'] = len(layout)

    add_lights()

    # Each view is a real camera from main.js CAM, not an approximation of one:
    # the framing has to match the game for these images to be evidence.
    views = [
        # CAM.hack - the AIM/SPIN/POWER view, from behind the hack
        dict(name='aim_from_hack', **{'from': (1.15, 1.85, -17.6), 'look': (-0.35, 0.12, 4.0), 'fov': 40}),
        # CAM.track - as it stands when a delivered stone is at z=10 on the line
        dict(name='track_midice', **{'from': (2.5, 2.15, 6.4), 'look': (0.0, 0.1, 11.6), 'fov': 42}),
        # CAM.skip - the end-summary / measure-up view (teeZ + 6.2)
        dict(name='summary_from_back', **{'from': (0.9, 2.9, 21.2), 'look': (0.0, 0.12, 4.0), 'fov': 40}),
        # CAM.title - the attract screen view
        dict(name='title_view', **{'from': (6.4, 3.6, -9.5), 'look': (0.0, 0.35, 7.5), 'fov': 40}),
        # CAM.plan - what Enter gives you: straight above the tee, below the arena's
        # light bank (y 7.04), ice running up the screen with the boards left and
        # right. Rendered at a desktop aspect because that is the window it is seen in.
        dict(name='plan_over_house', **{'from': (0, 6.2, 15.0), 'look': (0, 0.0, 15.0), 'fov': 60,
                                        'up_game': (0, 0, 1)}),
        # The same view as it was when it was reported broken: above the light bank,
        # with the ice lying across the frame. Kept as evidence of the bug, and not
        # held to the gates - failing them is the point.
        dict(name='plan_as_it_was', **{'from': (0, 9.4, 15.0), 'look': (0, 0.0, 15.0), 'fov': 34,
                                       'up_game': (1, 0, 0), 'gate': False}),
        # CAM.track's held view: the shot is over and the played stone left the
        # sheet, so the view stays on the house rather than cutting to a default.
        dict(name='hold_after_shot', **{'from': (2.5, 2.15, 11.4), 'look': (0.0, 0.1, 15.0), 'fov': 42}),
        # a stone close-up: granite, coloured handle, pebble ice
        dict(name='stone_closeup', **{'from': (-0.9, 0.55, 13.4), 'look': (0.0, 0.10, 15.0), 'fov': 23, 'w': 900, 'h': 700}),
    ]
    outs, stats = render('glb', views)
    report['images'] = [os.path.relpath(o, ROOT).replace('\\', '/') for o in outs]
    report['sizes'] = {os.path.basename(o): os.path.getsize(o) for o in outs}
    # look metrics (reference-look-calibration): recorded so the next change can
    # be judged against this, not against a feeling.
    report['look'] = stats
    gates = {}
    gated = {s['name'] for s in views if s.get('gate', True)}
    for name, m in stats.items():
        if not m or name not in gated:
            continue
        gates[name] = {
            'framed': m['black_frac'] < 0.75,
            'ice_not_clipped': m.get('ice_region_clip', 0) < 0.20,
            'ice_visible': m.get('ice_region_mean', 0) > 0.05,
            'not_flat_tone': m.get('colour_std', 0) > 0.02,
        }
    report['gates'] = gates
    report['all_gates_pass'] = all(all(v.values()) for v in gates.values()) if gates else False
    # Write it as well as print it, so a plain `blender --background --python`
    # run leaves the same evidence a harness run does, and so a look change can
    # be compared against the previous numbers rather than a memory of them.
    with open(os.path.join(HERE, '_look_report.json'), 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=2)
    if not report['all_gates_pass']:
        raise SystemExit('visual gate failed: ' + json.dumps(gates))
    print('HEADLESS ' + json.dumps(report))


main()
