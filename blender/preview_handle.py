"""Render the shipped stone's handle from the three angles that show whether it
reads as a handle at all.

preview_assets.py renders the game's own cameras; that is where a wrong handle
would be noticed in play, but it is a poor place to *judge* the shape: at the
track camera a gooseneck seen from the front looks like a hoop, and from the plan
view it is a line. So this script looks at the same shipped file from:

  side_profile   a true side elevation, orthographic, along the axis the handle
                 is turned about. This is the view the product photograph is
                 roughly in, and the only one where the gooseneck's curve can be
                 measured rather than squinted at.
  photo_view     a low three-quarter view at about the reference's elevation, for
                 the eye.
  from_above     what the game's plan view sees, where the handle has to read as
                 a bar and not a blob.

The stone is imported from assets/stone_red.glb, so this is evidence about the
file the game loads, not about the build script's in-memory scene. The staging is
a flat light background, as in the product photograph, because check_handle.py
separates the coloured handle from the granite by colour in both images and
compares their outlines; a white background is what makes the two comparable.
"""
import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, 'assets')
OUT = os.path.join(HERE, 'preview')

GLB = os.path.join(ASSETS, 'stone_red.glb')

VIEWS = [
    # orthographic elevation: up is +Z (Blender), the handle's run is along Y
    dict(name='side_profile', kind='ORTHO', loc=(2.0, 0.0, 0.10), rot_deg=(90, 0, 90),
         ortho_scale=0.34, w=1000, h=620),
    # about the reference's framing: the handle's run lying ACROSS the frame (aimed
    # down the run, the gooseneck collapses into a hoop and no outline comparison
    # means anything), and at the low angle the photograph is taken at - around 20
    # degrees up. Raised to 30 degrees the handle's silhouette measured *further*
    # from the reference, not closer, which is what the two images' own body
    # heights say: the photo is a low shot. check_handle.py measures the body
    # height in both images and refuses the comparison if the angles differ.
    dict(name='photo_view', kind='PERSP', loc=(0.62, 0.22, 0.34), look_at=(0.0, 0.0, 0.085),
         lens_mm=50, sensor_mm=36.0, w=1000, h=640),
    # the plan view: the handle as a bar across the cap
    dict(name='from_above', kind='ORTHO', loc=(0.0, 0.0, 1.20), rot_deg=(0, 0, 0),
         ortho_scale=0.34, w=700, h=700),
]


def new_scene():
    bpy.ops.wm.read_homefile(use_empty=True)
    for cand in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            bpy.context.scene.render.engine = cand
            break
        except TypeError:
            continue
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1000, 620
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    try:
        scene.eevee.taa_render_samples = 24
    except AttributeError:
        pass


def light_world():
    """A flat light background, close to the product photograph's staging. The
    checker separates pixels by colour, so what matters is that the background is
    uniform and clearly not the granite or the coloured handle."""
    world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.90, 0.91, 0.93, 1.0)
    bg.inputs[1].default_value = 1.0


def lights():
    key_data = bpy.data.lights.new('key', 'SUN')
    key_data.energy = 2.2
    key_data.angle = math.radians(12)
    key = bpy.data.objects.new('key', key_data)
    key.rotation_euler = (math.radians(52), 0, math.radians(28))
    bpy.context.collection.objects.link(key)
    fill_data = bpy.data.lights.new('fill', 'AREA')
    fill_data.energy = 12.0
    fill_data.size = 1.2
    fill = bpy.data.objects.new('fill', fill_data)
    fill.location = (-0.7, -0.5, 0.9)
    fill.rotation_euler = (math.radians(35), 0, math.radians(-54))
    bpy.context.collection.objects.link(fill)


def aim_at(obj, target):
    from mathutils import Vector
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def camera_for(spec):
    cam_data = bpy.data.cameras.new(spec['name'])
    cam_data.type = 'ORTHO' if spec['kind'] == 'ORTHO' else 'PERSP'
    if spec['kind'] == 'ORTHO':
        cam_data.ortho_scale = spec['ortho_scale']
    else:
        cam_data.lens = spec['lens_mm']
        cam_data.sensor_fit = 'HORIZONTAL'
        cam_data.sensor_width = spec['sensor_mm']
    cam = bpy.data.objects.new(spec['name'], cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = spec['loc']
    if 'rot_deg' in spec:
        cam.rotation_euler = tuple(math.radians(a) for a in spec['rot_deg'])
    if 'look_at' in spec:
        aim_at(cam, spec['look_at'])
    return cam


def main():
    if not os.path.exists(GLB):
        raise SystemExit('no %s to look at' % GLB)
    os.makedirs(OUT, exist_ok=True)
    new_scene()
    light_world()
    lights()

    bpy.ops.import_scene.gltf(filepath=GLB)
    stones = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not stones:
        raise SystemExit('importing %s produced no meshes' % GLB)
    report = {'glb': os.path.relpath(GLB, ROOT).replace('\\', '/'),
              'objects': sorted(o.name for o in stones),
              'meshes': len(stones)}

    outs = []
    for spec in VIEWS:
        cam = camera_for(spec)
        scene = bpy.context.scene
        scene.camera = cam
        scene.render.resolution_x, scene.render.resolution_y = spec['w'], spec['h']
        path = os.path.join(OUT, 'handle_%s.png' % spec['name'])
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outs.append(os.path.relpath(path, ROOT).replace('\\', '/'))
        report[spec['name']] = {'camera': spec['kind'], 'loc': list(spec['loc']),
                                'pixels': [spec['w'], spec['h']],
                                'ortho_scale': spec.get('ortho_scale'),
                                'lens_mm': spec.get('lens_mm'),
                                'bytes': os.path.getsize(path)}
    report['images'] = outs
    with open(os.path.join(HERE, '_handle_report.json'), 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=2)
    print('HEADLESS ' + json.dumps({'ok': True, 'images': outs, 'objects': report['objects']}))


main()
