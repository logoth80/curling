"""build_assets.py — authors every GLB the curling game loads.

Run headless (Blender 5.2 LTS):

    blender -b --factory-startup -P blender/build_assets.py

Contract (from GAME_PROMPT.md, "Asset Authoring"):
  * 1 Blender unit = 1 metre. The glTF export uses export_yup=True.
  * Authoring axis: Blender is Z-up. With export_yup=True the mapping is
        (x, y, z)_blender  ->  (x, z, -y)_glTF
    so the game's +Z (down-ice, toward the house) is Blender -Y. The house is
    therefore authored at Blender Y = -15 and lands at glTF Z = +15, which is
    exactly SHEET.teeZ in physics.js. X is unchanged (no mirroring).
  * Stones: origin at the bottom centre of the body, a child object named
    "handle" (the game rotates it to show the chosen spin), body <= 2k tris,
    granite roughness ~0.9, coloured plastic handle roughness ~0.5.
  * Sheet: origin at the centre of the ice.

Textures are generated here with numpy (pebbled-ice normal map, granite albedo
and normal map) so the GLBs are self-contained and the game needs no runtime
texture work.
"""
import json
import math
import os
import re
import sys

import bpy
import bmesh
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, 'assets')
TEX = os.path.join(ASSETS, 'tex')
os.makedirs(ASSETS, exist_ok=True)
os.makedirs(TEX, exist_ok=True)

# --- sheet geometry constants, mirrored from physics.js SHEET (1 unit = 1 m)
SHEET_LEN = 34.0
SHEET_W = 4.88
HACK_Z = -15.0
TEE_Z = 15.0
BACK_LINE_Z = 18.4
# A real sheet's ice ends 10 ft (3.05 m) beyond the back line, at the end
# dasher. The game's end-summary camera stands at Z = 21.2, i.e. right there,
# so this setback is part of the coordinate contract and not decoration.
# https://en.wikipedia.org/wiki/Glossary_of_curling#back_line
ICE_END_Z = BACK_LINE_Z + 3.05
DECK_FAR_Z = 30.0            # floor beyond the ice, where the stands begin
DECK_NEAR_Z = -24.0
HOG_FAR_Z = 3.0
HOG_NEAR_Z = -8.0
RING12, RING8, RING4, BUTTON = 1.83, 1.22, 0.61, 0.15
STONE_R, STONE_H = 0.145, 0.114

# House colours, outer to inner: blue 12-foot, white 8-foot, red 4-foot, white
# button. Painted on ice, so they keep the pebble normal map rather than being
# a separate smooth material. https://en.wikipedia.org/wiki/Glossary_of_curling#house
COL_BLUE = (0.05, 0.24, 0.55, 1)
COL_WHITE = (0.72, 0.80, 0.87, 1)
COL_RED = (0.62, 0.08, 0.08, 1)
COL_LINE = (0.03, 0.04, 0.05, 1)
COL_HOGLINE = (0.55, 0.04, 0.04, 1)


# --------------------------------------------------------------------- utils
def new_scene():
    """Start from an empty file. Only ever called once, at the top of main():
    it purges bpy.data, which would throw away generated textures."""
    bpy.ops.wm.read_homefile(use_empty=True)


def clear_objects():
    """Drop the geometry of the previous asset but keep images (the generated
    textures are reused across the stone and sheet builds)."""
    try:
        bpy.ops.object.select_all(action='DESELECT')
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
    except Exception:
        pass
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)


def principled(name, base=(0.5, 0.5, 0.5, 1), rough=0.5, metal=0.0, emit=None, emit_str=0.0):
    mat = bpy.data.materials.new(name)
    if hasattr(mat, 'use_nodes'):                # deprecated in 5.x, gone in 6.0
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    set_in(bsdf, ('Base Color', 'Base Color'), base)
    set_in(bsdf, ('Roughness',), rough)
    set_in(bsdf, ('Metallic',), metal)
    if emit is not None:
        set_in(bsdf, ('Emission Color', 'Emission'), emit)
        set_in(bsdf, ('Emission Strength', 'Emission Strength'), emit_str)
    bsdf.location = (-200, 0)
    out.location = (200, 0)
    return mat, nt, bsdf


def set_in(node, names, value):
    """Resolve a shader input by display name (names change across versions)."""
    for inp in node.inputs:
        if inp.name in names:
            try:
                inp.default_value = value
                return True
            except Exception:
                pass
    return False


def link_normal(mat, nt, bsdf, img, scale_u=1.0, scale_v=1.0):
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.location = (-700, -300)
    if scale_u != 1.0 or scale_v != 1.0:
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (scale_u, scale_v, 1.0)
        nt.links.new(tc.outputs['UV'], mp.inputs['Vector'])
        nt.links.new(mp.outputs['Vector'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Normal'])
    try:
        set_in(bsdf, ('Normal',), (0, 0, 1, 1))
    except Exception:
        pass
    return tex


def new_mesh_obj(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.clear()
        me.materials.append(mat)
    return ob


def set_uv_cylindrical(me, height, u_by_index=None):
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u = (math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0
            v = (co.z / height) if height else 0.0
            uv.data[li].uv = (u, v)


def grid_plane(name, x0, x1, y0, y1, z, uv_tile=None):
    """An XY-aligned quad; UVs are in metres/uv_tile so a tiled texture maps
    to a fixed real-world size regardless of the plane's extent."""
    bm = bmesh.new()
    bm.verts.new((x0, y0, z)); bm.verts.new((x1, y0, z))
    bm.verts.new((x1, y1, z)); bm.verts.new((x0, y1, z))
    bm.faces.new(bm.verts[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    uv = me.uv_layers.new(name='UVMap')
    t = uv_tile or 1.0
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (co.x / t, co.y / t)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def uv_planar(me, tile=0.15):
    """Planar XY UVs in metres/tile, for the flat painted parts (house rings,
    lines) so the pebble normal map continues across them the way paint on
    pebbled ice does. Without UVs a textured material has nothing to sample."""
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (co.x / tile, co.y / tile)


def disc(name, r, z, segs=64):
    bm = bmesh.new()
    c = bm.verts.new((0, 0, z))
    ring = [bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z))
            for i in range(segs)]
    for i in range(segs):
        bm.faces.new((c, ring[i], ring[(i + 1) % segs]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def annulus(name, r_in, r_out, z, segs=64):
    bm = bmesh.new()
    a = [bm.verts.new((r_in * math.cos(2 * math.pi * i / segs), r_in * math.sin(2 * math.pi * i / segs), z)) for i in range(segs)]
    b = [bm.verts.new((r_out * math.cos(2 * math.pi * i / segs), r_out * math.sin(2 * math.pi * i / segs), z)) for i in range(segs)]
    for i in range(segs):
        bm.faces.new((a[i], a[(i + 1) % segs], b[(i + 1) % segs], b[i]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def box(name, sx, sy, sz, loc):
    """A cuboid whose *object origin is its centre*, so rotation_euler tilts it
    in place instead of swinging it around the world origin."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    ob = new_mesh_obj(name, bm)
    ob.location = (loc[0], loc[1], loc[2])
    return ob


def lathe(name, profile, segs, mat):
    """Revolve an (r, z) profile about Z. r == 0 becomes a pole."""
    bm = bmesh.new()
    levels = []
    for r, z in profile:
        if r <= 1e-9:
            levels.append([bm.verts.new((0.0, 0.0, z))])
        else:
            levels.append([bm.verts.new((r * math.cos(2 * math.pi * i / segs),
                                         r * math.sin(2 * math.pi * i / segs), z)) for i in range(segs)])
    for j in range(len(levels) - 1):
        A, B = levels[j], levels[j + 1]
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:
            for i in range(len(B)):
                bm.faces.new((A[0], B[i], B[(i + 1) % len(B)]))
        elif len(B) == 1:
            for i in range(len(A)):
                bm.faces.new((B[0], A[(i + 1) % len(A)], A[i]))
        else:
            for i in range(len(A)):
                bm.faces.new((A[i], A[(i + 1) % len(A)], B[(i + 1) % len(B)], B[i]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    height = profile[-1][1] - profile[0][1]
    set_uv_cylindrical(me, height)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.clear(); me.materials.append(mat)
    return ob


def sweep(name, spine, width, thick, mat, rings=20, cross=10, power=0.62, taper=None):
    """Sweep a flattened-oval section along a spine given as (y, z) control
    points, so a moulded grip can be one continuous part instead of a stack of
    revolved pucks. The section is a superellipse: power < 1 flattens the faces
    while keeping the edges round, which is what a handle is cast like so a
    gloved hand can hold it without winding up the stone. The section stays
    square to the spine, so the grip keeps its thickness through the bend.

    `taper` is a list of (fraction along the spine, scale) pairs, linearly
    interpolated: a real grip narrows toward its free end."""
    from mathutils import Vector
    from mathutils.geometry import interpolate_bezier

    # Catmull-Rom through the control points, drawn as a chain of Beziers whose
    # handles come from the neighbouring control points.
    pts = []
    n = len(spine)
    per = max(2, (rings - 1) // max(1, n - 1))
    for i in range(n - 1):
        p0 = spine[i - 1] if i > 0 else (2 * spine[i][0] - spine[i + 1][0], 2 * spine[i][1] - spine[i + 1][1])
        p1, p2 = spine[i], spine[i + 1]
        p3 = spine[i + 2] if i + 2 < n else (2 * spine[-1][0] - spine[-2][0], 2 * spine[-1][1] - spine[-2][1])
        c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
        seg = interpolate_bezier(Vector(p1), Vector(c1), Vector(c2), Vector(p2), per + 1)
        # Blender 5.x hands back Vectors; older releases wrapped them.
        got = [v if hasattr(v, 'length') else v.co for v in seg]
        pts.extend(got[:-1] if i < n - 2 else got)
    total = len(pts)

    def scale_at(i):
        if not taper:
            return 1.0
        f = i / (total - 1.0)
        prev, nxt = taper[0], taper[-1]
        for a, b in zip(taper, taper[1:]):
            if a[0] <= f <= b[0]:
                k = 0.0 if b[0] == a[0] else (f - a[0]) / (b[0] - a[0])
                return a[1] + (b[1] - a[1]) * k
        return prev[1] if f < taper[0][0] else nxt[1]

    bm = bmesh.new()
    rows = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, total - 1)] - pts[max(i - 1, 0)])
        if t.length < 1e-9:
            t = Vector((0.0, 1.0))
        t.normalize()
        nrm = Vector((-t.y, t.x))             # in the spine's own Y-Z plane
        k = scale_at(i)
        w, h = 0.5 * width * k, 0.5 * thick * k
        row = []
        for j in range(cross):
            a = 2.0 * math.pi * j / cross
            ca, sa = math.cos(a), math.sin(a)
            # across the run is world X (the spine lies in the x = 0 plane);
            # along it is the section normal in the spine's own Y-Z plane
            ux = math.copysign(1.0, ca) * abs(ca) ** power * w
            un = math.copysign(1.0, sa) * abs(sa) ** power * h
            row.append(bm.verts.new((ux, p.x + nrm.x * un, p.y + nrm.y * un)))
        rows.append(row)
    for i in range(total - 1):
        A, B = rows[i], rows[i + 1]
        for j in range(cross):
            bm.faces.new((A[j], A[(j + 1) % cross], B[(j + 1) % cross], B[j]))

    # The ends: a vertex pushed a little along the run so the free end of a grip
    # reads as rounded rather than sliced off.
    for i, d in ((0, -1.0), (total - 1, 1.0)):
        t = (pts[min(i + 1, total - 1)] - pts[max(i - 1, 0)])
        if t.length < 1e-9:
            continue
        t.normalize()
        k = scale_at(i)
        tip = pts[i] + t * (0.45 * thick * k * d)
        v = bm.verts.new((0.0, tip.x, tip.y))
        row = rows[i]
        for j in range(cross):
            if d < 0:
                bm.faces.new((v, row[(j + 1) % cross], row[j]))
            else:
                bm.faces.new((v, row[j], row[(j + 1) % cross]))

    # UVs along the run and around the section: the part carries no texture, but
    # the asset contract says a mesh has a UV layer, and one costs nothing here.
    uv = bm.loops.layers.uv.new('UVMap')
    for i, f in enumerate(bm.faces):
        for j, loop in enumerate(f.loops):
            loop[uv].uv = (i / (total - 1.0), j / 4.0)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.clear(); me.materials.append(mat)
    return ob


def parent(child, parent_ob):
    child.parent = parent_ob
    child.matrix_parent_inverse = parent_ob.matrix_world.inverted()


def tri_count(ob):
    if ob.type not in {'MESH'}:
        return 0                                 # the handle is an Empty by design
    deps = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(deps)
    try:
        me = ev.to_mesh()
    except RuntimeError:
        return 0
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    return n


def export_glb(objects, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    full = dict(filepath=path, export_format='GLB', use_selection=True,
                export_apply=True, export_materials='EXPORT', export_yup=True,
                export_animations=False, export_skins=False, export_shapes=False,
                export_extras=True, export_nla_strips=False, export_lights=False,
                export_cameras=False, export_image_format='AUTO')
    tried = []
    while True:
        try:
            bpy.ops.export_scene.gltf(**full)
            return tried
        except TypeError as e:
            msg = str(e)
            drop = None
            for k in list(full):
                if re.search(r'\b%s\b' % k, msg):
                    drop = k
                    break
            if drop is None:                      # unknown shape: retry minimal
                full = dict(filepath=path, export_format='GLB', use_selection=True,
                            export_materials='EXPORT', export_yup=True)
                tried.append('fallback-minimal')
                try:
                    bpy.ops.export_scene.gltf(**full)
                    return tried
                except TypeError:
                    raise
            full.pop(drop)
            tried.append('-' + drop)


# --------------------------------------------------------- texture generation
_TEXCACHE = {}


def pebble_maps(size=512, seed=11):
    """Cached: the sheet and the stones both need them, and generating them is
    the slowest part of this script."""
    key = ('pebble', size, seed)
    if key not in _TEXCACHE:
        _TEXCACHE[key] = _pebble_maps(size, seed)
    return _TEXCACHE[key]


def granite_maps(size=512, seed=5):
    key = ('granite', size, seed)
    if key not in _TEXCACHE:
        _TEXCACHE[key] = _granite_maps(size, seed)
    return _TEXCACHE[key]


def write_image(name, rgb, size, noncolor=True):
    """rgb: float array (size,size,3) in 0..1. Written bottom-up like Blender."""
    path = os.path.join(TEX, name + '.png')
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    flat = np.empty(size * size * 4, np.float32)
    flat[0::4] = rgb[:, :, 0].reshape(-1)
    flat[1::4] = rgb[:, :, 1].reshape(-1)
    flat[2::4] = rgb[:, :, 2].reshape(-1)
    flat[3::4] = 1.0
    img.pixels = flat.tolist()
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    loaded = bpy.data.images.load(path, check_existing=False)
    if noncolor:
        loaded.colorspace_settings.name = 'Non-Color'
    return loaded


def _pebble_maps(size=512, seed=11):
    """Curling ice is pebbled: water droplets frozen into the sheet scatter the
    light and are what make ice read as ice.
    https://en.wikipedia.org/wiki/Curling#Ice_rink
    Returns (normal_map, roughness_map, height)."""
    rng = np.random.default_rng(seed)
    h = np.full((size, size), 0.35, np.float32)
    base = 0.0
    # a soft long-wavelength undulation (the sheet flooding)
    for _ in range(6):
        freq = rng.integers(2, 5)
        xs = np.linspace(0, 2 * math.pi * freq, size)
        ph = rng.random()
        g = 0.02 * np.sin(xs + ph)[:, None] + 0.02 * np.sin(xs + ph * 1.7)[None, :]
        base = base + g
    h = h + base
    n_drop = 1100
    for _ in range(n_drop):
        cx, cy = rng.random(2) * size
        r = rng.uniform(3.0, 8.0)
        amp = rng.uniform(0.30, 0.75)
        # tile the droplet across the seams so the map repeats cleanly
        for ox in (0, -size, size):
            for oy in (0, -size, size):
                x0 = int(cx + ox - r - 1); x1 = int(cx + ox + r + 2)
                y0 = int(cy + oy - r - 1); y1 = int(cy + oy + r + 2)
                if x1 < 0 or y1 < 0 or x0 >= size or y0 >= size:
                    continue
                x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, size); y1 = min(y1, size)
                yy, xx = np.mgrid[y0:y1, x0:x1]
                d2 = (xx - (cx + ox)) ** 2 + (yy - (cy + oy)) ** 2
                m = d2 < r * r
                if not m.any():
                    continue
                prof = np.zeros_like(d2, np.float32)
                prof[m] = amp * (1.0 - np.sqrt(d2[m]) / r) ** 1.6
                h[y0:y1, x0:x1] += prof
    gx = np.gradient(h, axis=1)
    gy = np.gradient(h, axis=0)
    k = 6.0                       # the pebble has to survive mip filtering at
    nx = -gx * k; ny = -gy * k; nz = np.ones_like(nx)   # playing-field distance
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
    nrm = write_image('ice_pebble_normal', rgb.astype(np.float32), size, noncolor=True)
    rough = 0.10 + 0.22 * (h - h.min()) / max(1e-6, (h.max() - h.min()))
    rr = np.stack([rough, rough, rough], -1).astype(np.float32)
    rmap = write_image('ice_pebble_rough', rr, size, noncolor=True)
    return nrm, rmap, h


def _granite_maps(size=512, seed=5):
    """Ailsa Craig granite: a bluish-grey body with lighter feldspar crystals
    and darker mica flecks. https://en.wikipedia.org/wiki/Curling#Equipment"""
    rng = np.random.default_rng(seed)
    acc = np.zeros((size, size), np.float32)
    amp = 1.0
    for octave in range(6):
        n = int(4 * 2 ** octave)
        grid = rng.random((n, n)).astype(np.float32)
        # bilinear upsample by repeating with smoothing
        up = np.repeat(np.repeat(grid, size // n, 0), size // n, 1)
        for _ in range(2):
            up = (up + np.roll(up, 1, 0) + np.roll(up, -1, 0) + np.roll(up, 1, 1) + np.roll(up, -1, 1)) / 5.0
        acc += amp * up
        amp *= 0.55
    acc /= acc.max()
    lo, hi = 0.30, 0.62
    g = lo + (hi - lo) * acc
    rgb = np.stack([g * 0.96, g * 0.99, g * 1.06], -1)         # faint blue cast
    # feldspar crystals: sparse pale flecks
    fleck = rng.random((size, size)) > 0.9965
    for _ in range(2):
        fleck |= np.roll(fleck, 1, 0) | np.roll(fleck, 1, 1)
    rgb[fleck] = (0.78, 0.79, 0.80)
    dark = rng.random((size, size)) > 0.9985
    rgb[dark] = (0.16, 0.17, 0.18)
    albedo = write_image('granite_albedo', np.clip(rgb, 0, 1).astype(np.float32), size, noncolor=False)
    gx = np.gradient(acc, axis=1); gy = np.gradient(acc, axis=0)
    nx = -gx * 1.2; ny = -gy * 1.2; nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    nrm = write_image('granite_normal', (np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5).astype(np.float32),
                      size, noncolor=True)
    return albedo, nrm


# ----------------------------------------------------------------- the sheet
def build_sheet():
    """Ice, apron, house and lines. Origin at the centre of the ice; the house
    is authored at Y = -15 so it lands at glTF Z = +15 (the game's tee)."""
    clear_objects()
    nrm, rmap, _ = pebble_maps()
    ice_mat, nt, bsdf = principled('ice', base=(0.46, 0.57, 0.68, 1), rough=0.18, metal=0.0)
    link_normal(ice_mat, nt, bsdf, nrm)
    # roughness varies across the pebble field — that is what makes the sheen
    # break up the way swept ice does under arena lights
    rtex = nt.nodes.new('ShaderNodeTexImage'); rtex.image = rmap; rtex.location = (-700, -600)
    nt.links.new(rtex.outputs['Color'], bsdf.inputs['Roughness'])
    # a thin coat layer reads as the drainage film on top of the pebble
    set_in(bsdf, ('Coat Weight',), 0.35)
    set_in(bsdf, ('Coat Roughness',), 0.18)

    objs = []
    # main ice: X = width, Y = length (Blender -Y is the game's +Z). The UV tile
    # is 15 cm, so the pebble lands at its real 1-3 mm scale.
    ice = grid_plane('ice', -SHEET_W / 2, SHEET_W / 2, -SHEET_LEN / 2, SHEET_LEN / 2, 0.0, uv_tile=0.15)
    ice.data.materials.append(ice_mat)
    objs.append(ice)

    # Ice beyond the back line, up to the end dasher, so the end-summary view
    # (camera at Z = 21.2) looks across ice and not into a void. The near end
    # gets a floor instead of ice: behind the hack is matting, not sheet.
    apron = grid_plane('ice_apron', -SHEET_W / 2, SHEET_W / 2, -ICE_END_Z, -SHEET_LEN / 2, -0.002, uv_tile=0.15)
    apron.data.materials.append(ice_mat)
    objs.append(apron)

    rubber = principled('rink_floor', base=(0.045, 0.055, 0.07, 1), rough=0.9)[0]
    for nm, z0, z1 in (('floor_far', ICE_END_Z, DECK_FAR_Z), ('floor_near', DECK_NEAR_Z, -SHEET_LEN / 2)):
        f = grid_plane(nm, -(SHEET_W / 2 + 3.0), (SHEET_W / 2 + 3.0), -z1, -z0, -0.006, uv_tile=1.0)
        f.data.materials.append(rubber)
        objs.append(f)

    def yof(z):            # game Z -> Blender Y
        return -z

    # House: four filled discs, each a hair above the previous so nothing
    # z-fights at a grazing camera angle.
    discs = [('house_twelve', RING12, COL_BLUE, 0.0010),
             ('house_eight', RING8, COL_WHITE, 0.0020),
             ('house_four', RING4, COL_RED, 0.0030),
             ('house_button', BUTTON, COL_WHITE, 0.0040)]
    for nm, r, col, z in discs:
        m, mnt, mbsdf = principled(nm + '_mat', base=col, rough=0.5)
        link_normal(nm + '_mat', mnt, mbsdf, nrm)     # paint takes the pebble too
        d = disc(nm, r, z, segs=72)
        uv_planar(d.data)
        d.location = (0, yof(TEE_Z), 0)
        d.data.materials.append(m)
        objs.append(d)

    # Lines: back line, tee line, two hog lines (red), the centre line and the
    # 4-foot "18-yard" centre-line stub. Widths follow the glossary: hog lines
    # are wider than the rest. https://en.wikipedia.org/wiki/Glossary_of_curling
    # Lines: back line, tee line, two hog lines (red), and the centre line.
    # Hog lines are drawn wider than the rest, as on a real sheet.
    # https://en.wikipedia.org/wiki/Glossary_of_curling
    def line(nm, z, w, col, x0=-SHEET_W / 2, x1=SHEET_W / 2, t=0.0015):
        # painted lines: 1.5 mm proud of the ice. Any thicker and a low camera
        # reads them as rails laid on the sheet instead of paint.
        m, mnt, mbsdf = principled(nm + '_mat', base=col, rough=0.55)
        link_normal(nm + '_mat', mnt, mbsdf, nrm)
        b = box(nm, x1 - x0, w, t, ((x0 + x1) / 2, yof(z), 0.0055 + t / 2))
        uv_planar(b.data)
        b.data.materials.append(m)
        objs.append(b)
        return b

    line('line_back', BACK_LINE_Z, 0.05, COL_LINE)
    line('line_tee', TEE_Z, 0.05, COL_LINE)
    line('line_hog_far', HOG_FAR_Z, 0.10, COL_HOGLINE)
    line('line_hog_near', HOG_NEAR_Z, 0.10, COL_HOGLINE)

    # Centre line: 2.5 cm wide, running from the far hog line to the back line.
    cl = box('line_centre', 0.05, abs(BACK_LINE_Z - HOG_FAR_Z), 0.0015,
             (0, yof((HOG_FAR_Z + BACK_LINE_Z) / 2), 0.0055 + 0.00075))
    clm, clnt, clbsdf = principled('line_centre_mat', base=COL_LINE, rough=0.55)
    link_normal('line_centre_mat', clnt, clbsdf, nrm)
    uv_planar(cl.data)
    cl.data.materials.append(clm)
    objs.append(cl)

    # The hack the thrower braces against, fixed to the ice at the hack point.
    hm, _, _ = principled('hack_sheet_mat', base=(0.02, 0.03, 0.04, 1), rough=0.6)
    for i, sx in enumerate((-0.18, 0.18)):
        h = box('hack_sheet_%d' % i, 0.16, 0.06, 0.09, (sx, yof(HACK_Z), 0.045))
        h.rotation_euler = (0.35, 0, 0)
        h.data.materials.append(hm)
        objs.append(h)
    return objs


# -------------------------------------------------------------------- stones
STONE_PROFILE = [
    (0.00, 0.000), (0.62, 0.000), (0.80, 0.015), (0.94, 0.055), (1.00, 0.30),
    (0.985, 0.55), (0.90, 0.78), (0.70, 0.94), (0.42, 1.00), (0.00, 1.00),
]


# The handle, read off a photograph of two real stones rather than invented. What
# makes a curling handle recognisable is not a knob on top of the granite; it is
# two pieces that meet: a moulded cap that hooks over the shoulder of the stone,
# wider than the granite's top face so its edge stands proud of it, and one
# continuous gooseneck that leaves the back of that cap, runs forward over the
# top, and curls down at its free end to stop just above the cap again.
#
# Every number is a proportion measured in the photo and then scaled by STONE_R
# or STONE_H, so the handle keeps its shape if the body ever changes:
#   cap outer radius      0.77 of the body's radius (the photo's caps measure
#                         0.72-0.90 across the two stones shown, depending on the
#                         angle they are seen at)
#   cap's lower edge      0.91 of the granite's height, where its skirt grips the
#                         shoulder and the lip overhangs it by about 3 mm
#   cap dome              0.078 of the granite's height above the stone's top
#   the gooseneck's rise   out of the cap near its rear rim, 0.55-0.63 of the body
#                         radius behind the centre, steeply -- measured off both
#                         handles in the photo, which agree on this
#   its highest point     1.37 of the granite's height, behind the centre: the
#                         arch leans, because the handle is meant to be held from
#                         one side. The bar's own thickness puts the top of the
#                         handle 0.055-0.065 m above the granite, which is what
#                         the photo measures and what a real delivered stone does
#   its free end          0.43 of the body's radius in front, curling down to end
#                         in the cap rather than hanging above it or reaching past
#                         it, which is how both handles in the photo finish
#   the bar's section     0.32 wide x 0.24 thick, in units of the body radius.
#                         The photo measures the bar's thickness at 0.15-0.18 of
#                         its own cap width: half that is what made the first
#                         model read as a bent rod instead of a moulded handle.
#                         Wide and flat so a gloved hand cannot wind the stone,
#                         and only slightly narrower at the free end, so that end
#                         reads blunt, as a cast handle's does.
HANDLE_CAP_PROFILE = [
    (0.000 * STONE_R, 0.985 * STONE_H),   # under the cap, buried in the stone
    (0.420 * STONE_R, 0.985 * STONE_H),
    (0.700 * STONE_R, 0.915 * STONE_H),   # following the granite's shoulder down
    (0.765 * STONE_R, 0.910 * STONE_H),   # the lip, standing proud of the stone
    (0.770 * STONE_R, 0.950 * STONE_H),
    (0.730 * STONE_R, 1.000 * STONE_H),
    (0.650 * STONE_R, 1.035 * STONE_H),
    (0.480 * STONE_R, 1.060 * STONE_H),
    (0.270 * STONE_R, 1.075 * STONE_H),
    (0.000 * STONE_R, 1.078 * STONE_H),
]

# (y, z) control points of the gooseneck's spine, in the handle's own plane. The
# first point sits inside the cap, so the grip is moulded out of it rather than
# balanced on top of it. The arch leans: rise at the back, high point behind the
# centre, and only then a run forward that turns down above the cap. A spine that
# climbs and falls evenly makes a teacup handle, which is the mistake this
# replaces; both handles in the photo lean the same way.
HANDLE_SPINE = [
    (-0.55 * STONE_R, 1.02 * STONE_H),    # buried in the cap, near its rear rim
    (-0.63 * STONE_R, 1.20 * STONE_H),    # rising steeply, not ramping
    (-0.58 * STONE_R, 1.32 * STONE_H),
    (-0.38 * STONE_R, 1.37 * STONE_H),    # the high point, behind the centre
    (-0.10 * STONE_R, 1.37 * STONE_H),    # the run
    (+0.14 * STONE_R, 1.35 * STONE_H),
    (+0.36 * STONE_R, 1.22 * STONE_H),    # turning down above the cap, not past it
    (+0.43 * STONE_R, 1.05 * STONE_H),    # and ending into it, as both do in the photo
]

# The section stays square to the spine, with its wide face level everywhere --
# which is how a handle is cast, so that a hand on it does not wind the stone.
# `power` shapes it: at 0.4 the boundary sits near a rounded rectangle, which is
# what the reference's edges read as, while a value nearer 1 gives an oval that
# looks like tubing once it is this thick.
#
# The scale along the run matters more than it looks: a handle is not a rod bent
# into a curve. It is thickest where it leaves the cap, because that is where the
# moulding carries the load into the cap, and it eases to its grip thickness along
# the run. Sweeping a constant section makes a hoop sitting above the cap.
HANDLE_SECTION = dict(width=0.32 * STONE_R, thick=0.24 * STONE_R, power=0.40,
                      taper=[(0.0, 1.15), (0.25, 1.05), (0.65, 1.00), (1.0, 0.92)])


def cap_top_z_at(radius):
    """The cap's own upper surface at a given distance from the axis, read out of
    HANDLE_CAP_PROFILE. Used to check that the gooseneck is rooted inside the cap
    and that its free end stops above the cap, instead of hoping the two parts
    meet."""
    top = max(range(len(HANDLE_CAP_PROFILE)), key=lambda i: HANDLE_CAP_PROFILE[i][0])
    chain = HANDLE_CAP_PROFILE[top:]        # from the widest point in over the top
    for (r0, z0), (r1, z1) in zip(chain, chain[1:]):
        if min(r0, r1) <= radius <= max(r0, r1):
            k = 0.0 if r0 == r1 else (radius - r0) / (r1 - r0)
            return z0 + (z1 - z0) * k
    return chain[-1][1]


def measure_handle(objs):
    """Arithmetic on the handle as actually built, in the same proportions the
    design above is stated in. If a number here moves, the shape moved."""
    from mathutils import Vector
    deps = bpy.context.evaluated_depsgraph_get()

    def box(name):
        ob = next(o for o in objs if o.name == name)
        ev = ob.evaluated_get(deps)
        pts = [ev.matrix_world @ Vector(c.co) for c in ev.data.vertices]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        return lo, hi, pts

    b_lo, b_hi, _ = box('stone_body')
    c_lo, c_hi, _ = box('handle_cap')
    g_lo, g_hi, g_pts = box('handle_grip')
    body_d = max(b_hi[0] - b_lo[0], b_hi[1] - b_lo[1])
    body_r = body_d / 2.0
    run = max(g_hi[1] - g_lo[1], g_hi[0] - g_lo[0])
    other = min(g_hi[1] - g_lo[1], g_hi[0] - g_lo[0])
    # a gooseneck turns back down at its free end: how far the point furthest out
    # from the axis sits below the highest point of the grip
    far = max(g_pts, key=lambda p: abs(p.y))
    # the bar's own cross-section, taken at the middle of its run where the spine
    # is level and the slice measures thickness and width directly
    gy = [p.y for p in g_pts]
    g_lo_y, g_hi_y = min(gy), max(gy)
    slice_mid = [p for p in g_pts
                 if g_lo_y + 0.45 * (g_hi_y - g_lo_y) <= p.y <= g_lo_y + 0.55 * (g_hi_y - g_lo_y)]
    root_r = abs(HANDLE_SPINE[0][0])
    tip_r = abs(HANDLE_SPINE[-1][0])
    return {
        'body_diameter': round(body_d, 4),
        'cap_diameter_over_body': round(max(c_hi[0] - c_lo[0], c_hi[1] - c_lo[1]) / body_d, 3),
        'cap_lower_edge_over_stone_height': round(c_lo[2] / STONE_H, 3),
        'cap_top_above_stone_top_m': round(c_hi[2] - STONE_H, 4),
        'handle_top_over_stone_height': round(g_hi[2] / STONE_H, 3),
        'handle_top_above_stone_top_m': round(g_hi[2] - STONE_H, 4),
        'grip_run_m': round(run, 4),
        'grip_run_over_body_radius': round(run / body_r, 3),
        'grip_section_thickness_m': round(max(p.z for p in slice_mid) - min(p.z for p in slice_mid), 4),
        'grip_section_width_m': round(max(p.x for p in slice_mid) - min(p.x for p in slice_mid), 4),
        'grip_is_elongated': round(run / max(1e-6, other), 2),
        'grip_free_end_drops_below_peak_m': round(g_hi[2] - far.z, 4),
        'grip_tip_reach_over_cap_radius': round(tip_r / max(p[0] for p in HANDLE_CAP_PROFILE), 3),
        'grip_root_is_under_cap_surface_m': round(cap_top_z_at(root_r) - HANDLE_SPINE[0][1], 4),
        'grip_tip_clears_cap_by_m': round(HANDLE_SPINE[-1][1] - cap_top_z_at(tip_r), 4),
    }


def build_stone(col, col_name):
    """Body + a child named 'handle'. Origin at the bottom centre of the body;
    the handle's own numbers are in HANDLE_CAP_PROFILE / HANDLE_SPINE above, as
    proportions of the body (a delivered stone is 114 mm of granite with a
    moulded cap and gooseneck on top)."""
    clear_objects()
    galb, gnrm = granite_maps()
    gran, nt, bsdf = principled('granite_%s' % col_name, base=(0.55, 0.56, 0.58, 1), rough=0.9, metal=0.04)
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = galb; tex.location = (-700, 200)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    link_normal(gran, nt, bsdf, gnrm)

    prof = [(r * STONE_R, z * STONE_H) for r, z in STONE_PROFILE]
    body = lathe('stone_body', prof, segs=32, mat=gran)

    # coloured plastic, roughness ~0.5 per the asset spec
    plastic = principled('handle_%s' % col_name, base=col, rough=0.5, metal=0.05)[0]
    handle = bpy.data.objects.new('handle', None)
    bpy.context.collection.objects.link(handle)

    cap = lathe('handle_cap', HANDLE_CAP_PROFILE, segs=24, mat=plastic)
    grip = sweep('handle_grip', HANDLE_SPINE, mat=plastic, rings=28, cross=14, **HANDLE_SECTION)
    for p in (cap, grip):
        parent(p, handle)
    return [body, handle, cap, grip]


# --------------------------------------------------------------------- broom
def build_broom():
    clear_objects()
    shaft_mat = principled('broom_shaft', base=(0.10, 0.12, 0.15, 1), rough=0.35, metal=0.75)[0]
    head_mat = principled('broom_head', base=(0.92, 0.68, 0.05, 1), rough=0.5)[0]
    pad_mat = principled('broom_pad', base=(0.75, 0.78, 0.80, 1), rough=0.7)[0]
    objs = []
    shaft = lathe('broom_shaft', [(0.0, 0.0), (0.018, 0.0), (0.021, 0.30), (0.019, 1.05), (0.016, 1.28), (0.0, 1.28)],
                  segs=14, mat=shaft_mat)
    objs.append(shaft)
    head = box('broom_head', 0.30, 0.16, 0.045, (0, 0, 0.03))
    head.data.materials.append(head_mat)
    parent(head, shaft)
    objs.append(head)
    pad = box('broom_pad', 0.27, 0.13, 0.012, (0, 0, 0.006))
    pad.data.materials.append(pad_mat)
    parent(pad, shaft)
    objs.append(pad)
    brace = box('broom_brace', 0.02, 0.02, 0.34, (0, 0, 0.20))
    brace.rotation_euler = (0.5, 0, 0)
    brace.data.materials.append(shaft_mat)
    parent(brace, shaft)
    objs.append(brace)
    return objs


# ---------------------------------------------------------------------- hack
def build_hack():
    clear_objects()
    mat = principled('hack_rubber', base=(0.02, 0.025, 0.03, 1), rough=0.65)[0]
    metal = principled('hack_frame', base=(0.35, 0.37, 0.40, 1), rough=0.4, metal=0.9)[0]
    base = box('hack_base', 0.62, 0.20, 0.02, (0, 0, 0.01))
    base.data.materials.append(metal)
    pads = []
    for i, sx in enumerate((-0.19, 0.19)):
        p = box('hack_pad_%d' % i, 0.17, 0.06, 0.10, (sx, 0, 0.06))
        p.rotation_euler = (0.35, 0, 0)
        p.data.materials.append(mat)
        parent(p, base)
        pads.append(p)
    pin = lathe('hack_pin', [(0, 0), (0.03, 0), (0.03, 0.16), (0, 0.16)], segs=12, mat=metal)
    pin.location = (0, -0.12, 0.0)
    parent(pin, base)
    return [base] + pads + [pin]


# --------------------------------------------------------------------- arena
def build_arena():
    """Dasher boards, side boards, stands, banners and ceiling light banks:
    the "arena atmosphere" the brief asks for. Plain PBR boxes, and note the
    axis convention: box(name, sx, sy, sz, loc) with Y along the rink axis and
    Z up, matching the authoring contract at the top of this file.

    The setbacks are not decoration. The end dasher sits 10 ft (3.05 m) beyond
    the back line, which is where a real sheet's ice ends
    (https://en.wikipedia.org/wiki/Glossary_of_curling#back_line), and the game's
    end-summary camera stands at Z=21.2, i.e. right at that dasher. With the
    banners behind it, that camera looks at the house over the boards; an arena
    that closes in earlier buries the camera in a wall (measured: the first
    build blocked the whole frame)."""
    clear_objects()
    board = principled('dasher_board', base=(0.86, 0.90, 0.94, 1), rough=0.5)[0]
    kick = principled('dasher_kick', base=(0.03, 0.16, 0.36, 1), rough=0.55)[0]
    stand = principled('stand_dark', base=(0.03, 0.05, 0.08, 1), rough=0.95)[0]
    crowd = principled('crowd_dim', base=(0.04, 0.07, 0.11, 1), rough=1.0, emit=(0.03, 0.06, 0.10, 1), emit_str=0.35)[0]
    banner = principled('banner_blue', base=(0.04, 0.16, 0.36, 1), rough=0.85)[0]
    strip = principled('banner_strip', base=(0.10, 0.40, 0.75, 1), rough=0.6, emit=(0.08, 0.30, 0.62, 1), emit_str=1.2)[0]
    lamp = principled('ceiling_lamp', base=(0.9, 0.95, 1.0, 1), rough=0.4, emit=(1.0, 0.98, 0.92, 1), emit_str=6.0)[0]
    steel = principled('truss_steel', base=(0.06, 0.07, 0.09, 1), rough=0.9)[0]

    half = SHEET_W / 2
    BANNER_Z = ICE_END_Z + 6.0
    objs = []
    # Rubber deck around the sheet. Without it the rink reads as floating in
    # the sky, because the cameras that sit outside the boards (the title view
    # at X=6.4, the track camera at its clamp limit) look down at nothing.
    deck = principled('rink_deck', base=(0.030, 0.038, 0.05, 1), rough=0.92)[0]
    for side, tag in ((-1, 'l'), (1, 'r')):
        d = box('deck_%s' % tag, 6.4, 48.0, 0.02,
                (side * (half + 3.4), 0, -0.03))
        d.data.materials.append(deck); objs.append(d)
    for side, tag in ((-1, 'l'), (1, 'r')):
        b = box('board_%s' % tag, 0.08, SHEET_LEN + 2.0, 0.42, (side * (half + 0.05), 0, 0.21))
        b.data.materials.append(board); objs.append(b)
        k = box('kick_%s' % tag, 0.30, SHEET_LEN + 2.0, 0.10, (side * (half + 0.19), 0, 0.05))
        k.data.materials.append(kick); objs.append(k)
    for z, tag in ((-ICE_END_Z, 'near'), (ICE_END_Z, 'far')):
        y = -z
        d = box('dasher_%s' % tag, SHEET_W + 1.2, 0.10, 1.15, (0, y, 0.575))
        d.data.materials.append(board); objs.append(d)
        k = box('dasher_kick_%s' % tag, SHEET_W + 1.2, 0.14, 0.52, (0, y - (0.12 if z > 0 else -0.12), 0.26))
        k.data.materials.append(kick); objs.append(k)
    for side, tag in ((-1, 'l'), (1, 'r')):
        for step in range(4):
            h = 1.2 + step * 1.05
            depth = 1.6
            # set back from the boards so a title camera standing in the
            # walkway is not inside a stand riser
            x = side * (7.2 + depth * (step + 0.5))
            s = box('stand_%s_%d' % (tag, step), depth, SHEET_LEN * 0.92, h, (x, 0, h / 2))
            s.data.materials.append(stand); objs.append(s)
            c = box('crowd_%s_%d' % (tag, step), depth * 0.8, SHEET_LEN * 0.9, 0.6, (x, 0, h + 0.32))
            c.data.materials.append(crowd); objs.append(c)
    for z, tag in ((-BANNER_Z, 'near'), (BANNER_Z, 'far')):
        y = -z
        b = box('banner_%s' % tag, SHEET_W + 10.0, 0.10, 3.0, (0, y, 1.5))
        b.data.materials.append(banner); objs.append(b)
        s = box('banner_strip_%s' % tag, SHEET_W + 10.0, 0.12, 0.36, (0, y + (0.08 if z > 0 else -0.08), 0.45))
        s.data.materials.append(strip); objs.append(s)
    for i in range(11):
        t = box('truss_%d' % i, 14.0, 0.18, 0.18, (0, -22.0 + i * 4.4, 7.4))
        t.data.materials.append(steel); objs.append(t)
    for i in range(8):
        l = box('lamp_%d' % i, 1.2, 6.0, 0.12, (0, -20.0 + i * 5.7, 7.1))
        l.data.materials.append(lamp); objs.append(l)
    return objs


# ---------------------------------------------------------------------- main
def summary(objs):
    return {'tris': sum(tri_count(o) for o in objs),
            'parts': sorted({o.name for o in objs})}


def main():
    report = {}
    new_scene()
    # warm the texture cache once; both the sheet and the stones use it
    pebble_maps()
    granite_maps()

    for name, builder in (('sheet.glb', build_sheet),
                         ('stone_red.glb', lambda: build_stone((0.72, 0.11, 0.10, 1), 'red')),
                         ('stone_yellow.glb', lambda: build_stone((0.85, 0.70, 0.06, 1), 'yellow')),
                         ('broom.glb', build_broom),
                         ('hack.glb', build_hack),
                         ('arena.glb', build_arena)):
        objs = builder()
        export_glb(objs, os.path.join(ASSETS, name))
        info = summary(objs)
        info['bytes'] = os.path.getsize(os.path.join(ASSETS, name))
        if any(o.name == 'handle_cap' for o in objs):
            # the handle's proportions, measured off the mesh that was built
            info['handle'] = measure_handle(objs)
        report[name] = info

    report['_textures'] = sorted(f for f in os.listdir(TEX) if f.endswith('.png'))
    # Written as well as printed: a plain `blender --background --python` run
    # should leave the same evidence behind as a harness run.
    with open(os.path.join(HERE, '_build_report.json'), 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=2)
    print('HEADLESS ' + json.dumps(report))


main()
