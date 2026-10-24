"""The sweeper stance: measured in the game's coordinates, rendered through the
game's camera.

    blender --background --factory-startup --python blender/preview_figure.py

There is no player asset. The figure that runs beside a moving stone is built out
of capsules, spheres and boxes in main.js, which means its shape is code and can
be measured rather than admired. This script runs the same joint arithmetic the
game runs, in the game's own coordinates, and fails on the claims that matter:

  * the brush head is on the stone's line, and ahead of the stone, while the
    body stands off the line and on the far side from the camera that follows it;
  * the feet are apart *along* the path with the toes *across* it, which is the
    stance of a sweeper rather than a runner;
  * the head clears the shoulders and looks back at the stone;
  * no limb is stretched so far that a capsule stops reading as a limb.

Then it renders the same figure through the camera that follows the play, plus two
diagnostic views, so the shape can be looked at as well as measured.

Two coordinate frames are in play, and one conversion:

  game frame      X lateral, Y up, +Z down-ice (the direction of travel).
  figure frame    after updateSweeper turns the body a quarter turn off the
                  travel: local -X is along the path, local +Z is toward the ice
                  lane and the stone, +Y stays up. The stance in poseSweeper is
                  written in this frame.
  Blender frame   Z up. The conversion is B(x, y, z) = (x, -z, y), a quarter turn
                  about X with determinant +1, so a rotation about the game's Y is
                  a rotation about Blender's Z with the same sign: the angles
                  written in main.js port here unmodified. Only the pictures need
                  Blender; the measurements are plain arithmetic in the game frame.

The joint numbers below are mirrored from poseSweeper. LITERALS below pins the
exact source text they were taken from, so this gate fails loudly instead of
quietly measuring a stance the game no longer uses.
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "preview")
MAIN = os.path.join(ROOT, "main.js")

# --------------------------------------------------------------------------- 1
# the literals this gate was copied from; if any of these stop appearing in
# main.js, the numbers below are stale and the run must fail rather than pass
LITERALS = [
    "const SWEEP_REACH = ",
    "const BROOM_GRIP = { upper: ",
    "const SWEEP_GAZE = new THREE.Vector3(",
    ".addScaledVector(dir, 0.85).addScaledVector(right, 0.52)",
    "sweeper.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2;",
    "broomHolder.rotation.y = -Math.PI / 2;",
    "broomHolder.rotation.x = -0.55;",
    "broomHolder.position.set(-stroke,",
    "const shuffle = Math.sin(step);",
    "const hips = 0.70 + 0.02 * Math.abs(shuffle);",
    "const lean = 0.56 + 0.16 * brush;",
    "const slide = 0.16 * shuffle;",
    "const lift = 0.05;",
    "J.footL.set(-0.30 + slide, 0.05 + (shuffle > 0 ? shuffle * lift : 0), 0);",
    "J.footR.set(0.30 + slide, 0.05 + (shuffle < 0 ? -shuffle * lift : 0), 0);",
    "J.hipL.set(-0.12, hips, 0); J.hipR.set(0.12, hips, 0);",
    "J.chest.set(0, J.waist.y + 0.32 * cLean, 0.32 * sLean);",
    "J.skull.set(0, J.waist.y + 0.50 * cLean, 0.50 * sLean);",
    "J.shoulderBot.set(-0.17, J.chest.y + 0.02, J.chest.z + 0.02);",
    "twoSeg(J.hipL, J.footL, LIMB.thigh, LIMB.shin, LIMB_BEND.kneeL, J.kneeL);",
    "twoSeg(J.shoulderTop, J.handTop, LIMB.upper, LIMB.lower, LIMB_BEND.armTop, J.elbowTop);",
    "grip(BROOM_GRIP.upper, J.handTop);",
    "aim(P.thighL, J.hipL, J.kneeL); aim(P.shinL, J.kneeL, J.footL);",
    "aim(P.upperArmTop, J.shoulderTop, J.elbowTop); aim(P.foreArmTop, J.elbowTop, J.handTop);",
    "limb(0.085, LIMB.thigh, mat.trousers)",
    "limb(0.070, LIMB.shin, mat.socks)",
    "limb(0.052, LIMB.upper, mat.jacket)",
    "limb(0.13, 0.18, mat.trousers)",
    "limb(0.155, 0.32, mat.jacket)",
]

# part -> (joint a, joint b), as poseSweeper aims it
LIMBS = {
    "pelvis": ("hipR", "hipL"),
    "thighL": ("hipL", "kneeL"), "shinL": ("kneeL", "footL"),
    "thighR": ("hipR", "kneeR"), "shinR": ("kneeR", "footR"),
    "torso": ("waist", "chest"),
    "upperArmTop": ("shoulderTop", "elbowTop"), "foreArmTop": ("elbowTop", "handTop"),
    "upperArmBot": ("shoulderBot", "elbowBot"), "foreArmBot": ("elbowBot", "handBot"),
}
# the two-segment chains: proximal part, distal part, and the joints they span,
# with which bend direction main.js gives them
CHAINS = {
    "legL": ("thighL", "shinL", "hipL", "kneeL", "footL", "thigh", "shin", "kneeL"),
    "legR": ("thighR", "shinR", "hipR", "kneeR", "footR", "thigh", "shin", "kneeR"),
    "steering arm": ("upperArmTop", "foreArmTop", "shoulderTop", "elbowTop", "handTop",
                     "upper", "lower", "armTop"),
    "driving arm": ("upperArmBot", "foreArmBot", "shoulderBot", "elbowBot", "handBot",
                    "upper", "lower", "armBot"),
}


def must(src, pattern, what):
    found = re.search(pattern, src)
    if not found:
        raise SystemExit("main.js no longer looks like this gate does: %s is gone. "
                         "Update the numbers here before trusting a picture." % what)
    return found


def read_constants():
    src = open(MAIN, encoding="utf-8").read()
    c = {}
    c["reach"] = float(must(src, r"const SWEEP_REACH = ([\d.]+);", "the broom's reach").group(1))
    g = must(src, r"const BROOM_GRIP = \{ upper: ([\d.]+), lower: ([\d.]+) \}", "the two grips")
    c["gripUpper"], c["gripLower"] = float(g.group(1)), float(g.group(2))
    v = must(src, r"const SWEEP_GAZE = new THREE\.Vector3\(([-\d., ]+)\)", "the gaze")
    c["gaze"] = [float(x) for x in v.group(1).split(",")]
    s = must(src, r"\.addScaledVector\(dir, ([\d.]+)\)\.addScaledVector\(right, ([\d.]+)\)",
             "where the figure stands beside the stone")
    c["ahead"], c["standOff"] = float(s.group(1)), float(s.group(2))
    m = must(src, r"const stroke = ([\d.]+) \+ swing \* ([\d.]+);", "the stroke length")
    c["stroke"], c["strokeSwing"] = float(m.group(1)), float(m.group(2))
    c["swing"] = float(must(src, r"const swing = Math\.sin\(t\) \* \(G\.sweeping \? ([\d.]+) : ([\d.]+)\);",
                            "the swing amplitude").group(1))
    c["rollK"] = float(must(src, r"broomHolder\.rotation\.z = swing \* ([\d.]+);",
                            "how much wrist is in the stroke").group(1))
    # bone lengths and joint directions, read rather than restated: main.js has
    # one source for them, so a copied pair of numbers could only ever go stale
    m = must(src, r"const LIMB = \{ thigh: ([\d.]+), shin: ([\d.]+), upper: ([\d.]+), lower: ([\d.]+) \};",
             "the bone lengths")
    c["limb"] = {"thigh": float(m.group(1)), "shin": float(m.group(2)),
                 "upper": float(m.group(3)), "lower": float(m.group(4))}
    c["bend"] = {}
    for key in ("kneeL", "kneeR", "armTop", "armBot"):
        v = must(src, r"%s: \[([-\d., ]+)\]," % key, "the direction the %s bends" % key)
        c["bend"][key] = [float(x) for x in v.group(1).split(",")]
    c["bones"] = {
        "pelvis": float(must(src, r"limb\(0\.13, ([\d.]+), mat\.trousers\)", "the pelvis").group(1)),
        "torso": float(must(src, r"limb\(0\.155, ([\d.]+), mat\.jacket\)", "the torso").group(1)),
        "thighL": c["limb"]["thigh"], "shinL": c["limb"]["shin"],
        "thighR": c["limb"]["thigh"], "shinR": c["limb"]["shin"],
        "upperArmTop": c["limb"]["upper"], "foreArmTop": c["limb"]["lower"],
        "upperArmBot": c["limb"]["upper"], "foreArmBot": c["limb"]["lower"],
    }
    # CAM.track, read out of main.js rather than transcribed: the picture has to be
    # taken from the camera the game actually flies, or it proves nothing.
    cam = {}
    for key, pattern, what in (
        ("side", r"const x = clamp\(s\.x \+ ([\d.]+), ([-\d.]+), ([-\d.]+)\);", "the camera's stand-off"),
        ("back", r"const z = clamp\(s\.z - ([\d.]+), SHEET\.hackZ - [\d.]+, SHEET\.backLineZ \+ [\d.]+\);",
         "how far behind the stone the camera sits"),
        ("height", r"return new THREE\.Vector3\(x, ([\d.]+), z\);", "the camera's height"),
        ("lateral", r"new THREE\.Vector3\(s\.x \* ([\d.]+), ([\d.]+), lerp\(s\.z, SHEET\.teeZ, ([\d.]+)\)\);",
         "what the camera looks at"),
        ("fov", r"tau: [\d.]+, fov: ([\d.]+),\n  \},\n  skip:", "the camera's field of view"),
    ):
        cam[key] = [float(g) for g in must(src, pattern, what).groups()]
    c["cam"] = cam
    stale = [lit for lit in LITERALS if lit not in src]
    return c, stale


# --------------------------------------------------------------------------- 2
# the joints, in the figure's frame — the same arithmetic poseSweeper runs
STONE = (0.0, 0.0, 1.0)          # a shot on the line, just past the tee
DIR = (0.0, 0.0, 1.0)            # straight down it, so the frame is fully determined
PITCH = -0.55                    # the broom's tilt, mirrored from the holder's pose


def apply_broom(v, roll):
    """A point on the shaft through the holder's pose: yaw -pi/2, pitch, then a
    small roll that is what the stroke's swing does to the grip."""
    x, y, z = v
    x, y = x * math.cos(roll) - y * math.sin(roll), x * math.sin(roll) + y * math.cos(roll)
    y, z = y * math.cos(PITCH) - z * math.sin(PITCH), y * math.sin(PITCH) + z * math.cos(PITCH)
    x, z = x * math.cos(-math.pi / 2) + z * math.sin(-math.pi / 2), \
           -x * math.sin(-math.pi / 2) + z * math.cos(-math.pi / 2)
    return (x, y, z)


def two_seg(a, b, l1, l2, bend):
    """The same solve main.js runs: the cosine rule for the angle at the proximal
    joint, then the joint pushed off the straight line toward `bend`."""
    d = sub(b, a)
    raw = length(d)
    if raw < 1e-4:
        return tuple(a[i] + bend[i] for i in range(3))
    u = scale(d, 1.0 / raw)
    reach = min(raw, l1 + l2 - 1e-3)
    cos_a = max(-1.0, min(1.0, (l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach)))
    sin_a = math.sqrt(max(0.0, 1.0 - cos_a * cos_a))
    perp = add(bend, scale(u, -dot(bend, u)))
    n = length(perp)
    if n < 1e-6:
        perp = (u[1], -u[0], u[2])
    else:
        perp = scale(perp, 1.0 / n)
    return tuple(a[i] + u[i] * cos_a * l1 + perp[i] * sin_a * l1 for i in range(3))


def joints(step, brush, c, stroke, roll):
    shuffle = math.sin(step)
    hips = 0.70 + 0.02 * abs(shuffle)
    lean = 0.56 + 0.16 * brush
    sLean, cLean = math.sin(lean), math.cos(lean)
    slide, lift = 0.16 * shuffle, 0.05
    J = {}
    J["hipL"] = (-0.12, hips, 0.0)
    J["hipR"] = (0.12, hips, 0.0)
    J["footL"] = (-0.30 + slide, 0.05 + (shuffle * lift if shuffle > 0 else 0.0), 0.0)
    J["footR"] = (0.30 + slide, 0.05 + (-shuffle * lift if shuffle < 0 else 0.0), 0.0)
    J["waist"] = (0.0, hips + 0.03, 0.0)
    J["chest"] = (0.0, J["waist"][1] + 0.32 * cLean, 0.32 * sLean)
    J["skull"] = (0.0, J["waist"][1] + 0.50 * cLean, 0.50 * sLean)
    J["shoulderBot"] = (-0.17, J["chest"][1] + 0.02, J["chest"][2] + 0.02)
    J["shoulderTop"] = (0.17, J["chest"][1] + 0.02, J["chest"][2] + 0.02)
    # hands: points up the shaft, read through the broom holder's pose, which is
    # what the game does — so the arms follow the stroke instead of waving
    for name, s in (("handTop", c["gripUpper"]), ("handBot", c["gripLower"])):
        g = apply_broom((0.0, s, 0.0), roll)
        J[name] = (g[0] - stroke, g[1], g[2] + c["reach"])
    for _, _, hip, knee, foot, l1, l2, bendKey in CHAINS.values():
        J[knee] = two_seg(J[hip], J[foot], c["limb"][l1], c["limb"][l2], c["bend"][bendKey])
    return J


# vector helpers in the game frame
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def scale(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def length(a): return math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def norm(a):
    n = length(a) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def perp_dist(p, a, b):
    """How far p sits off the straight line from a to b: a joint's bend, measured."""
    ab = sub(b, a)
    n = length(ab)
    if n < 1e-6:
        return length(sub(p, a))
    ab = scale(ab, 1.0 / n)
    ap = sub(p, a)
    t = dot(ap, ab)
    return math.sqrt(max(0.0, length(ap) ** 2 - t * t))


def yaw_local_to_world(phi, v):
    """A model with rotation.y = phi maps its local frame into the game's."""
    cs, sn = math.cos(phi), math.sin(phi)
    return (v[0] * cs + v[2] * sn, v[1], -v[0] * sn + v[2] * cs)


def measure(c):
    """Evaluate one delivery in game coordinates and judge the stance."""
    stone = STONE
    d = DIR
    right = (-d[2], 0.0, d[0])
    fig = add(add(stone, scale(d, c["ahead"])), scale(right, c["standOff"]))
    phi = math.atan2(d[0], d[2]) + math.pi / 2

    def world(local):
        return add(fig, yaw_local_to_world(phi, local))

    report = {"checks": [], "frames": {}}

    def check(name, ok, value):
        report["checks"].append({"name": name, "ok": bool(ok), "measured": value})

    for label, step, swing in (("neutral", 0.0, 0.0), ("stroke_far", 1.2, c["swing"]),
                               ("stroke_near", 1.2 + math.pi, -c["swing"])):
        stroke = c["stroke"] + swing * c["strokeSwing"]
        roll = swing * c["rollK"]
        J = joints(step, 1.0, c, stroke, roll)
        pad = world((-stroke, 0.0, c["reach"]))            # the broom pad sits at the holder origin
        across = abs(pad[0] - stone[0])
        ahead = pad[2] - stone[2]

        check("%s: the brush head is on the stone's line" % label, across <= 0.01,
              "%.3f m off the line" % across)
        check("%s: and ahead of the stone, not beside it" % label, 0.6 <= ahead <= 1.6,
              "%.2f m up the ice" % ahead)
        check("%s: the body is off the line" % label,
              0.45 <= abs(fig[0] - stone[0]) <= 0.6, "%.2f m off the line" % abs(fig[0] - stone[0]))
        check("%s: and on the far side from the camera that follows the play" % label,
              (fig[0] - stone[0]) * c["cam"]["side"][0] < 0,
              "figure x %.2f, camera stands x +%.2f" % (fig[0], c["cam"]["side"][0]))

        fl, fr = world(J["footL"]), world(J["footR"])
        sep = sub(fl, fr)
        check("%s: feet apart along the path" % label, abs(dot(sep, d)) >= 0.5,
              "%.2f m apart up the ice, %.2f m across" % (abs(dot(sep, d)), abs(dot(sep, right))))
        check("%s: with the toes pointing across it, not straddling the line" % label,
              abs(dot(sep, right)) <= 0.15, "%.2f m of straddle" % abs(dot(sep, right)))
        toe = norm(yaw_local_to_world(phi, (0.0, 0.0, 1.0)))    # the foot boxes are long along +Z
        check("%s: toes square to the ice lane" % label, abs(dot(toe, d)) <= 0.2,
              "%.0f° off across" % math.degrees(math.acos(max(-1, min(1, abs(dot(toe, right)))))))

        shoulder_line = max(world(J["shoulderTop"])[1], world(J["shoulderBot"])[1])
        head = world(J["skull"])
        check("%s: the head clears the shoulders instead of sitting inside them" % label,
              head[1] - shoulder_line >= 0.10,
              "%.2f m above the shoulder line" % (head[1] - shoulder_line))
        check("%s: the head stays at a crouching height" % label, 1.0 <= head[1] + 0.105 <= 1.55,
              "top of the head %.2f m" % (head[1] + 0.105))

        to_stone = norm(sub(stone, head))
        gaze = norm(yaw_local_to_world(phi, norm(c["gaze"])))
        ang = math.degrees(math.acos(max(-1.0, min(1.0, dot(gaze, to_stone)))))
        check("%s: the head is turned toward the stone" % label, ang <= 40.0,
              "%.0f° from the line to the stone" % ang)

        # A limb that cannot span its own joints gets stretched, and a stretched
        # capsule stops reading as a limb: the first version of this figure had
        # arms at two and a half times their length and they looked like planks.
        # The chains are solved for their mid joint instead, so what matters is
        # whether they can reach, and that the joint actually bent.
        for name, (up, low, prox, mid, dist_, l1, l2, _) in CHAINS.items():
            a, b, j = world(J[prox]), world(J[dist_]), world(J[mid])
            raw = length(sub(b, a))
            bone = c["limb"][l1] + c["limb"][l2]
            check("%s: the %s can reach without being stretched" % (label, name),
                  raw <= bone - 0.02, "%.2f m to span on %.2f m of limb" % (raw, bone))
            off = perp_dist(j, a, b)
            check("%s: the %s is bent, not locked straight" % (label, name),
                  off >= 0.03, "%s sits %.3f m off the straight line" % (mid, off))
            # A joint that solves is not the same as a joint that makes sense. An
            # upper arm that leaves the shoulder sideways reads as arms akimbo, and
            # an elbow that comes out below the hand when the hand is even lower is
            # a pose the chain can reach and no body can hold. Note the hand may
            # legally sit above the shoulder — a bent-over body holding a broom at
            # chest height is exactly that — so that case is not a failure.
            seg = sub(j, a)
            check("%s: the %s hangs down from its root, not out sideways" % (label, up),
                  -seg[1] >= 0.3 * length(seg), "drops %.2f m along a %.2f m segment" % (-seg[1], length(seg)))
            if b[1] < a[1] - 0.05:
                check("%s: the %s does not come out below its own end" % (label, mid),
                      a[1] > j[1] > b[1] - 0.02,
                      "%s %.2f m, root %.2f m, end %.2f m" % (mid, j[1], a[1], b[1]))

        # The single-segment parts have no joint to solve for, so their stretch
        # is what is measurable.
        chained = {p for ch in CHAINS.values() for p in ch[:2]}
        for part, (a, b) in LIMBS.items():
            if part in chained:
                continue
            want = length(sub(world(J[b]), world(J[a])))
            ratio = want / c["bones"][part]
            check("%s: the %s is not drawn out of shape" % (label, part),
                  0.55 <= ratio <= 1.9, "drawn x%.2f over %.2f m" % (ratio, c["bones"][part]))

        report["frames"][label] = {
            "figure": list(fig), "yaw": phi, "stroke": stroke, "roll": roll,
            "pad": list(pad), "joints": {k: list(v) for k, v in J.items()},
        }
    return report


# --------------------------------------------------------------------------- 3
# the pictures: the camera that follows the play, plus two diagnostics
# The measurements are plain arithmetic in the game's own coordinates, so they
# run anywhere:  python blender/preview_figure.py --no-render
# The pictures are what Blender is for, and they are optional in that sense only.
try:
    import bpy                                          # noqa: F401,E402
    from mathutils import Matrix, Quaternion, Vector    # noqa: E402
    HAS_BLENDER = True
except ImportError:
    HAS_BLENDER = False

TEE_Z = 15.0


def B(x, y, z):                                       # game -> Blender, see the docstring
    return Vector((x, -z, y))


def make_material(name, colour, rough=0.7):
    m = bpy.data.materials.new(name)
    if not m.node_tree:
        m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF") if m.node_tree else None
    if b:
        b.inputs["Base Color"].default_value = (*colour, 1.0)
        b.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*colour, 1.0)                  # the Workbench shading reads this one
    return m


def capsule(name, r, length, material):
    parts = []
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=r, depth=length)
    parts.append(bpy.context.object)
    for s in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=r,
                                            location=(0, s * length / 2, 0))
        parts.append(bpy.context.object)
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.materials.clear()
    ob.data.materials.append(material)
    return ob


def sphere(name, r, material):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=r)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.append(material)
    return ob


def cube(name, dims, material):
    bpy.ops.mesh.primitive_cube_add(size=1)
    ob = bpy.context.object
    ob.name = name
    ob.scale = dims
    ob.data.materials.append(material)
    return ob


def parent(child, ob):
    ob.parent = child
    ob.matrix_parent_inverse = Matrix.Identity(4)
    return ob


def build_set(M, stone_at):
    ice = cube("ice", (4.88, 38.0, 0.02), M["ice"])
    ice.location = (0, -1.0, -0.011)
    for nm, r, col in (("house12", 1.83, "blue"), ("house8", 1.22, "white"),
                       ("house4", 0.61, "red"), ("button", 0.15, "white")):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=r, depth=0.004)
        ob = bpy.context.object
        ob.name = nm
        ob.location = (0, -TEE_Z, 0.002)
        ob.data.materials.append(M[col])
    body = capsule("stone_body", 0.145, 0.115, M["granite"])
    body.location = B(stone_at[0], 0.0, stone_at[2]) + Vector((0, 0, 0.058))
    handle = cube("stone_handle", (0.05, 0.16, 0.05), M["yellow"])
    handle.location = B(stone_at[0], 0.0, stone_at[2]) + Vector((0, 0, 0.19))


def build_figure(tag, c, M):
    bones = c["bones"]
    root = bpy.data.objects.new("fig_" + tag, None)
    bpy.context.collection.objects.link(root)
    holder = bpy.data.objects.new("holder_" + tag, None)
    bpy.context.collection.objects.link(holder)
    parent(root, holder)

    def limb(name, r, length, material):
        return parent(root, capsule(name, r, length, M[material]))

    parts = {
        "pelvis": limb("pelvis", 0.13, bones["pelvis"], "trousers"),
        "thighL": limb("thighL", 0.085, bones["thighL"], "trousers"),
        "shinL": limb("shinL", 0.070, bones["shinL"], "socks"),
        "thighR": limb("thighR", 0.085, bones["thighR"], "trousers"),
        "shinR": limb("shinR", 0.070, bones["shinR"], "trousers"),
        "torso": limb("torso", 0.155, bones["torso"], "jacket"),
        "upperArmTop": limb("upperArmTop", 0.052, bones["upperArmTop"], "jacket"),
        "foreArmTop": limb("foreArmTop", 0.044, bones["foreArmTop"], "jacket"),
        "upperArmBot": limb("upperArmBot", 0.052, bones["upperArmBot"], "jacket"),
        "foreArmBot": limb("foreArmBot", 0.044, bones["foreArmBot"], "jacket"),
    }
    for nm in ("footL", "footR"):
        parts[nm] = parent(root, cube(nm, (0.10, 0.06, 0.22), M["sole"]))
    for nm in ("handTop", "handBot"):
        parts[nm] = parent(root, sphere(nm, 0.058, M["skin"]))
    head = bpy.data.objects.new("head_" + tag, None)
    bpy.context.collection.objects.link(head)
    parent(root, head)
    parent(head, sphere("skull", 0.105, M["skin"]))
    hair = parent(head, sphere("hair", 0.112, M["hair"]))
    hair.location = B(0.0, 0.025, -0.05)
    knot = parent(head, sphere("knot", 0.048, M["hair"]))
    knot.location = B(0.0, 0.03, -0.14)

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, "assets", "broom.glb"))
    shaft = next(o for o in bpy.data.objects
                 if o not in before and o.name.startswith("broom_shaft"))
    parent(holder, shaft)
    return root, holder, parts, head


def pose_figure(root, holder, parts, head, J, c, stroke, roll, phi, fig):
    root.location = B(fig[0], 0.0, fig[2])
    root.rotation_mode = "QUATERNION"
    root.rotation_quaternion = (math.cos(phi / 2), 0.0, 0.0, math.sin(phi / 2))
    holder.location = B(-stroke, 0.0, c["reach"])
    # main.js poses the broom as yaw(-pi/2) then pitch then a small roll about
    # its own axis. Under B those axes map to Blender Z, X and -Y, and the order
    # is preserved by @: the rightmost quaternion is applied first.
    q_yaw = Quaternion((0, 0, 1), -math.pi / 2)
    q_pitch = Quaternion((1, 0, 0), PITCH)
    q_roll = Quaternion((0, 1, 0), -roll)
    holder.rotation_mode = "QUATERNION"
    holder.rotation_quaternion = q_yaw @ q_pitch @ q_roll

    bones = c["bones"]

    def aim(part, a, b):
        ba, bb = B(*a), B(*b)
        d = bb - ba
        n = max(1e-4, d.length)
        part.rotation_mode = "QUATERNION"
        part.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(d.normalized())
        part.location = ba + d.normalized() * (n * 0.5)
        if part.name in bones:
            part.scale = (1, n / bones[part.name], 1)

    for part, (a, b) in LIMBS.items():
        aim(parts[part], J[a], J[b])
    for nm in ("handTop", "handBot"):
        parts[nm].location = B(*J[nm])
    for nm in ("footL", "footR"):
        f = J[nm]
        parts[nm].location = B(f[0], f[1] - 0.02, f[2] + 0.07)
    head.location = B(*J["skull"])
    gaze = B(*norm(c["gaze"])).normalized()
    head.rotation_mode = "QUATERNION"
    head.rotation_quaternion = B(0.0, 0.0, 1.0).rotation_difference(gaze)


def add_camera(name, eye, target, fov_deg):
    """The same basis Three.js Matrix4.lookAt builds, converted to Blender."""
    e, t = B(*eye), B(*target)
    zdir = (e - t).normalized()
    xdir = Vector((0, 0, 1)).cross(zdir).normalized()
    ydir = zdir.cross(xdir)
    m = Matrix(((xdir.x, ydir.x, zdir.x, e.x),
                (xdir.y, ydir.y, zdir.y, e.y),
                (xdir.z, ydir.z, zdir.z, e.z),
                (0, 0, 0, 1)))
    bpy.ops.object.camera_add(location=(0, 0, 0))
    cam = bpy.context.object
    cam.name = name
    cam.matrix_world = m
    cam.data.lens = 24.0
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 2.0 * 24.0 * math.tan(math.radians(fov_deg) / 2.0)
    return cam


def render_shots(fig, yaw, stone_at, c, M, views, prefix):
    scene = bpy.context.scene
    images = {}

    def clamp(v, lo, hi):
        return max(lo, min(hi, v))

    side = c["cam"]["side"]
    back = c["cam"]["back"][0]
    height = c["cam"]["height"][0]
    lat = c["cam"]["lateral"]
    fov = c["cam"]["fov"][0]
    all_views = {
        # CAM.track in main.js, posed from the numbers parsed out of it above.
        # glbtest pins the game's camera list; this mirrors its pose so the
        # stance is judged in the frame the player actually sees.
        "follow": ((clamp(stone_at[0] + side[0], side[1], side[2]), height,
                    clamp(stone_at[2] - back, -17.4, 19.6)),
                   (stone_at[0] * lat[0], lat[1], stone_at[2] + (TEE_Z - stone_at[2]) * lat[2]), fov),
        # not in the game: a view from the side of the sheet, where "square to
        # the ice lane" and "face-first down the line" cannot be confused
        "square_on": ((fig[0] + 4.2, 1.15, fig[2] + 0.9), (fig[0], 0.85, fig[2] + 0.3), 40.0),
        # nor this one: from the house end, where a skip calling line weight sees
        # the sweeper arrive across the line in front of the stone
        "from_the_skip": ((fig[0] - 0.2, 1.6, fig[2] + 5.2), (fig[0], 0.8, fig[2]), 40.0),
    }
    for name in views:
        eye, target, fov = all_views[name]
        cam = add_camera("cam_" + name, eye, target, fov)
        scene.camera = cam
        path = os.path.join(OUT, "%s_%s.png" % (prefix, name))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        images[name] = path
        bpy.data.objects.remove(cam, do_unlink=True)
    return images


def render(report, c):
    """The pictures: the game's own camera, plus two diagnostics."""
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.025, 0.03, 1.0)
    M = {
        "jacket": make_material("jacket", (0.80, 0.16, 0.16)),
        "trousers": make_material("trousers", (0.10, 0.13, 0.17)),
        "socks": make_material("socks", (0.17, 0.21, 0.27)),
        "skin": make_material("skin", (0.847, 0.706, 0.549), 0.8),
        "hair": make_material("hair", (0.17, 0.13, 0.10)),
        "sole": make_material("sole", (0.07, 0.09, 0.11)),
        "ice": make_material("ice", (0.74, 0.78, 0.82), 0.3),
        "blue": make_material("blue", (0.19, 0.45, 0.75), 0.5),
        "white": make_material("white", (0.92, 0.93, 0.95), 0.5),
        "red": make_material("red", (0.78, 0.16, 0.14), 0.5),
        "granite": make_material("granite", (0.42, 0.43, 0.45), 0.9),
        "yellow": make_material("yellow", (0.90, 0.72, 0.10), 0.6),
    }
    stone_at = STONE
    build_set(M, stone_at)
    bpy.ops.object.light_add(type="SUN")
    sun = bpy.context.object
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(25), math.radians(-15), math.radians(30))
    bpy.ops.object.light_add(type="AREA", location=(0, 0, 5))
    fill = bpy.context.object
    fill.data.energy = 900.0
    fill.data.size = 14.0
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 600

    fig = tuple(report["frames"]["neutral"]["figure"])
    yaw = report["frames"]["neutral"]["yaw"]
    images = {}
    for tag, prefix, views in (("neutral", "fig_side_on",
                               ("follow", "square_on", "from_the_skip")),
                              ("stroke_far", "fig_mid_stroke", ("follow",))):
        frame = report["frames"][tag]
        root, holder, parts, head = build_figure(tag, c, M)
        pose_figure(root, holder, parts, head, frame["joints"], c, frame["stroke"],
                    frame["roll"], yaw, fig)
        images.update(render_shots(fig, yaw, stone_at, c, M, views, prefix))
        for ob in list(bpy.data.objects):
            if ob.name.startswith(("fig_", "holder_", "head_", "pelvis", "thigh", "shin",
                                   "foot", "torso", "upperArm", "foreArm", "hand",
                                   "skull", "hair", "knot", "broom")):
                bpy.data.objects.remove(ob, do_unlink=True)
    return images


def main():
    c, stale = read_constants()
    report = measure(c)
    report["constants"] = {k: v for k, v in c.items() if k != "gaze"}
    report["gaze"] = c["gaze"]
    report["stale_literals"] = stale
    if stale:
        report["checks"].append({"name": "this gate still matches main.js", "ok": False,
                                "measured": "%d lines it was copied from are gone: %s"
                                            % (len(stale), stale[:3])})
    else:
        report["checks"].append({"name": "this gate still matches main.js", "ok": True,
                                "measured": "all %d source lines it was copied from are still there"
                                            % len(LITERALS)})

    report["images"] = {}
    if "--no-render" in sys.argv:
        report["images_note"] = "measurements only; pass no --no-render to get the pictures"
    elif not HAS_BLENDER:
        report["images_note"] = "no Blender in this process: the numbers were measured, not drawn"
    else:
        report["images"] = render(report, c)

    fails = [k for k in report["checks"] if not k["ok"]]
    with open(os.path.join(HERE, "_figure_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    for k in report["checks"]:
        print("%s  %s  ::  %s" % ("PASS" if k["ok"] else "FAIL", k["name"], k["measured"]))
    print("FIGURE %s" % json.dumps({"checks": len(report["checks"]), "failed": len(fails),
                                    "images": sorted(report["images"].values())},
                                   separators=(",", ":")))
    if fails:
        raise SystemExit(1)


main()
