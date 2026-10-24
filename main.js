/* ==========================================================================
 * main.js — 1v1 curling, keyboard only (Space + arrows; R on the game-over
 * screen). Rendering, camera, HUD and the control state machine live here;
 * rules, physics and the CPU live in physics.js / ai.js so they can be tested
 * outside the browser.
 *
 * Coordinate contract (shared with physics.js):
 *   X lateral (centre line X = 0), +Z down-ice toward the house, Y up.
 *   Hack at Z = -15, tee/button at Z = +15, hog lines, back line Z = 18.4.
 *   aim > 0 and spin > 0 both bias the stone toward -X (the thrower's right),
 *   so from behind the hack the arrow keys read exactly as you would expect.
 *
 * Assets are GLBs authored in Blender (see README.md). Every asset has a
 * procedural stand-in, so an empty assets/ folder still plays identically.
 * ========================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import {
  SHEET, RULES, PHYS, CAL,
  StoneWorld, makeStone, cloneStones, launchSpeed, simulateDelivery,
  powerForDistance, meterTravel,
  describeShot, scoreEnd, distanceToButton, inHouse,
  createMatch, startEnd, currentThrower, adjudicateDelivery, finishEnd,
} from './physics.js';
import { chooseShot, makeRng } from './ai.js';
import { rollRelease, applyRelease, describeRelease } from './release.js';
import { TRACK, buildStaticSvg, buildDynamicSvg, weightReadout } from './track.js';

// Reaching this line means the whole module graph loaded. index.html watches for
// it and, if it never happens, explains why on screen instead of leaving a black
// canvas: a page opened as a file:// URL cannot load ES modules at all.
window.__curlingBoot = true;

/* ---------------------------------------------------------------- helpers */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const $ = id => document.getElementById(id);
const TEAM_NAME = { A: 'RED', B: 'YELLOW' };
const TEAM_COLOR = { A: 0xff4b4b, B: 0xffd83d };
const hexColor = c => '#' + c.toString(16).padStart(6, '0');   // for SVG fills
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ scene */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b11);
scene.fog = new THREE.Fog(0x070b11, 26, 78);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 220);
const camLook = new THREE.Vector3(0, 0.2, 0);          // damped look-at target
const camPos = new THREE.Vector3(0, 2, -18);
camera.position.copy(camPos);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ---------------------------------------------------------------- lights */
// Cold, even arena light: a wide key from above the house, a cool fill from the
// far end, and a hemisphere to keep the ice from going flat.
//
// The intensities are matched to blender/preview_assets.py, which renders the
// shipped GLBs through these same cameras and measures the frames: an ice-region
// mean of 0.31-0.46 with zero clipped pixels. The sheet's albedo is a mid tone
// (0.46, 0.57, 0.68) on purpose, so if the ice ever reads as a white floor in
// the browser, lower these first rather than darkening the material — the
// material values are the ones the asset tests check.
{
  const hemi = new THREE.HemisphereLight(0xdceaf6, 0x1a2634, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(6, 14, 6);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fc7ff, 0.45);
  fill.position.set(-8, 9, -20);
  scene.add(fill);

  // Two sheet lamps for the specular sheen that sells "wet ice".
  for (const z of [-6, 10]) {
    const p = new THREE.PointLight(0xdfeeff, 15, 26, 2.0);
    p.position.set(0, 6.4, z);
    scene.add(p);
  }
  // Stands are darker than the ice: a dim wash so the arena reads as a space.
  const stand = new THREE.DirectionalLight(0x22405f, 0.25);
  stand.position.set(0, 3, 30);
  scene.add(stand);
}

/* ------------------------------------------------------- asset management */
const assets = {           // name -> {source:'glb'|'procedural', obj}
  sheet: null, stone_red: null, stone_yellow: null, broom: null, hack: null, arena: null,
};
const loader = new GLTFLoader();

function loadGLB(url) {
  return new Promise((res, rej) => loader.load(url, g => res(g.scene || g.scenes[0]), undefined, rej));
}

/**
 * Find a named part inside a loaded asset (the prompt requires a named `handle`
 * part on the stones so the game can show spin).
 */
function findPart(root, needle) {
  let hit = null;
  root.traverse(o => { if (!hit && o.name && o.name.toLowerCase().includes(needle)) hit = o; });
  return hit;
}

/**
 * Make an asset upright in *our* coordinate frame regardless of how it was
 * exported: the sheet's long axis must be Z, a stone's short axis (its height)
 * must be Y, a broom's long axis must be Y. Cheap insurance against an export
 * flag being flipped in the authoring file.
 */
function orient(obj, mode) {
  obj.updateMatrixWorld(true);
  const ext = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  const order = ['x', 'y', 'z'].sort((a, b) => ext[b] - ext[a]);
  const biggest = order[0], smallest = order[2];

  if (mode === 'longZ' && biggest !== 'z') {
    if (biggest === 'x') obj.rotation.y = -Math.PI / 2;
    else obj.rotation.x = Math.PI / 2;            // Y-long -> tip onto Z
  } else if (mode === 'longY' && biggest !== 'y') {
    if (biggest === 'z') obj.rotation.x = -Math.PI / 2;
    else obj.rotation.z = -Math.PI / 2;           // X-long -> tip onto Y
  } else if (mode === 'shortY' && smallest !== 'y') {
    if (smallest === 'z') obj.rotation.x = Math.PI / 2;
    else obj.rotation.z = Math.PI / 2;
  }
  // Re-centre only where the asset spec says the origin is the object's own
  // centre of extent (a stone: bottom centre of the body). The sheet's origin
  // is the centre of the *ice*, and its apron is deliberately one-sided, so
  // recentring it by its bounding box would slide the house off its tee.
  if (mode === 'shortY') {
    obj.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(obj);
    const c2 = b2.getCenter(new THREE.Vector3());
    obj.position.x -= c2.x; obj.position.z -= c2.z;
    obj.position.y -= b2.min.y;
  }
  return obj;
}

/** Wrap an object so its local origin is where our physics wants it. */
function pivot(obj, { bottom = false } = {}) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(obj);
  if (bottom) {
    const b = new THREE.Box3().setFromObject(obj);
    inner.position.y -= b.min.y;
  }
  g.add(inner);
  return g;
}

/* ---- procedural stand-ins: the game must be identical with assets/ empty -- */
function iceTexture(pxPerM = 140) {
  const W = Math.round(SHEET.width * pxPerM), H = Math.round(SHEET.length * pxPerM);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sx = x => (x + SHEET.width / 2) * pxPerM;
  const sz = z => (z + SHEET.length / 2) * pxPerM;   // -17..+17 -> 0..H

  // ice base: cold, slightly bluish, with the subtle sheet-long banding
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#dfeaf3'); grad.addColorStop(0.45, '#eaf3fa'); grad.addColorStop(1, '#d6e3ef');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {                      // sheet flooding streaks
    g.globalAlpha = 0.05;
    g.fillStyle = i % 2 ? '#ffffff' : '#b9cfe2';
    const x = Math.random() * W;
    g.fillRect(x, 0, Math.random() * 3 + 1, H);
  }
  g.globalAlpha = 1;

  const ring = (r, fill) => {
    g.beginPath(); g.arc(sx(0), sz(SHEET.teeZ), r * pxPerM, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
  };
  // House: 12 ft blue outside, then white, red, then the button.
  // https://en.wikipedia.org/wiki/Curling#House
  ring(SHEET.rings.twelve, '#2f6fb8');
  ring(SHEET.rings.eight, '#e9f2f9');
  ring(SHEET.rings.four, '#c8352f');
  ring(SHEET.rings.button, '#e9f2f9');

  const line = (z, w, col = 'rgba(24,38,52,.75)') => {
    g.fillStyle = col; g.fillRect(0, sz(z) - w * pxPerM / 2, W, Math.max(1, w * pxPerM));
  };
  line(SHEET.backLineZ, 0.05);
  line(SHEET.hogFarZ, 0.10, 'rgba(190,40,40,.85)');   // the hog line is red
  line(SHEET.teeLineZ, 0.05, 'rgba(24,38,52,.55)');
  line(SHEET.hogNearZ, 0.10, 'rgba(190,40,40,.85)');
  // Centre line + hack marks.
  g.fillStyle = 'rgba(24,38,52,.45)';
  g.fillRect(sx(0) - 1, sz(SHEET.hogFarZ), 2, sz(SHEET.backLineZ) - sz(SHEET.hogFarZ));
  g.fillRect(sx(0) - 1, sz(SHEET.hackZ) - 6, 2, 12);

  // Pebbled ice: the tiny droplets that make ice look like an ice sheet and
  // catch the arena lights.
  const pebble = g.getImageData(0, 0, W, H);
  const d = pebble.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] = clamp(d[i] + n, 0, 255); d[i + 1] = clamp(d[i + 1] + n, 0, 255); d[i + 2] = clamp(d[i + 2] + n * 0.8, 0, 255);
  }
  g.putImageData(pebble, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function buildProceduralSheet() {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    map: iceTexture(), roughness: 0.22, metalness: 0.0,
    clearcoat: 0.7, clearcoatRoughness: 0.25, sheen: 0.25, sheenColor: new THREE.Color(0xbcd6ea),
  });
  const ice = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.width, SHEET.length), mat);
  ice.rotation.x = -Math.PI / 2;
  g.add(ice);

  // Ice beyond the back line, so the area the camera looks at during an end
  // summary is ice and not void.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(SHEET.width, (SHEET.backLineZ - SHEET.teeZ) + 1.0),
    new THREE.MeshPhysicalMaterial({ color: 0xe6f0f7, roughness: 0.3, clearcoat: 0.5 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.z = (SHEET.backLineZ + SHEET.teeZ + 1.0) / 2;
  g.add(apron);
  return g;
}

/**
 * A curling stone: granite body from a lathe profile plus a coloured handle.
 * Real stones are ~19 cm wide and ~11 cm tall, 17-20 kg of Ailsa Craig granite.
 * https://en.wikipedia.org/wiki/Curling#Equipment
 */
function buildProceduralStone(colorHex) {
  const R = SHEET.stoneRadius, H = SHEET.stoneHeight;
  const prof = [];
  // Bottom edge -> widest belly -> top, in a rounded granite silhouette.
  const pts = [
    [0.00, 0.000], [0.62, 0.000], [0.80, 0.015], [0.94, 0.055], [1.00, 0.30],
    [0.985, 0.55], [0.90, 0.78], [0.70, 0.94], [0.42, 1.00], [0.00, 1.00],
  ];
  for (const [k, t] of pts) prof.push(new THREE.Vector2(k * R, t * H));
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(prof, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x8d9299, roughness: 0.9, metalness: 0.04, clearcoat: 0.12 }));

  const handle = new THREE.Group();
  const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.46, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: colorHex, roughness: 0.5, metalness: 0.05, clearcoat: 0.5 }));
  cap.position.y = H * 0.98; cap.scale.y = 0.55;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.12, R * 0.14, H * 0.3, 12), cap.material);
  stem.position.y = H * 0.88;
  const grip = new THREE.Mesh(new THREE.TorusGeometry(R * 0.4, R * 0.075, 10, 28, Math.PI), cap.material);
  grip.rotation.x = Math.PI / 2; grip.rotation.z = Math.PI;
  grip.position.y = H * 1.06;
  handle.add(cap, stem, grip);
  handle.name = 'handle';

  const g = new THREE.Group();
  g.add(body, handle);
  g.userData.handle = handle;
  return pivot(g, { bottom: true });
}

function buildProceduralBroom() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 1.25, 12),
    new THREE.MeshPhysicalMaterial({ color: 0x2b3440, roughness: 0.45, metalness: 0.6 }));
  shaft.position.y = 0.62;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.05, 0.16),
    new THREE.MeshPhysicalMaterial({ color: 0xf2b705, roughness: 0.5 }));
  head.position.set(0, 0.045, 0.1);
  g.add(shaft, head);
  g.userData.head = head;
  return g;
}

function buildProceduralHack() {
  const g = new THREE.Group();
  const m = new THREE.MeshPhysicalMaterial({ color: 0x1c2430, roughness: 0.6 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.16), m);
  base.position.y = 0.01;
  const pad1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.05), m);
  const pad2 = pad1.clone();
  pad1.position.set(-0.18, 0.05, 0); pad2.position.set(0.18, 0.05, 0);
  pad1.rotation.x = -0.35; pad2.rotation.x = -0.35;
  g.add(base, pad1, pad2);
  return g;
}

/** Stands, dasher boards and banners: the mood the prompt asks for. */
function buildProceduralArena() {
  const g = new THREE.Group();
  const half = SHEET.width / 2;

  const boardMat = new THREE.MeshPhysicalMaterial({ color: 0xf4f7fa, roughness: 0.5 });
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, SHEET.length + 2), boardMat);
    b.position.set(side * (half + 0.04), 0.21, 0);
    g.add(b);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, SHEET.length + 2),
      new THREE.MeshPhysicalMaterial({ color: 0x0f3a66, roughness: 0.55 }));
    kick.position.set(side * (half + 0.16), 0.05, 0);
    g.add(kick);
  }
  // Dashers behind the hack and behind the house.
  for (const z of [-(SHEET.length / 2) - 0.04, (SHEET.length / 2) + 0.04]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(SHEET.width + 0.6, 0.42, 0.1), boardMat);
    d.position.set(0, 0.21, z);
    g.add(d);
  }
  // Stands: dark stepped blocks with a scattering of cold "crowd" speckles.
  const standMat = new THREE.MeshStandardMaterial({ color: 0x101d2b, roughness: 0.95 });
  for (const side of [-1, 1]) {
    for (let step = 0; step < 4; step++) {
      const h = 1.2 + step * 1.05, depth = 1.6;
      const s = new THREE.Mesh(new THREE.BoxGeometry(depth, h, SHEET.length * 0.92), standMat);
      s.position.set(side * (half + 1.4 + depth * (step + 0.5)), h / 2, 0);
      g.add(s);
      const cc = new THREE.Mesh(new THREE.BoxGeometry(depth * 0.85, 0.5, SHEET.length * 0.9),
        new THREE.MeshStandardMaterial({ color: 0x1b2c3f, roughness: 1, emissive: 0x0a1622, emissiveIntensity: 0.6 }));
      cc.position.set(side * (half + 1.4 + depth * (step + 0.5)), h + 0.28, 0);
      g.add(cc);
    }
  }
  // Banners behind both ends: the arena identity, kept dark and out of the way.
  for (const z of [-(SHEET.length / 2) - 1.6, (SHEET.length / 2) + 1.6]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.width + 3, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x12365c, roughness: 0.85, side: THREE.DoubleSide }));
    banner.position.set(0, 1.6, z);
    banner.rotation.y = z > 0 ? Math.PI : 0;
    g.add(banner);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(SHEET.width + 3, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x2f6fb8, emissive: 0x123a63, emissiveIntensity: 1.2, roughness: 0.6, side: THREE.DoubleSide }));
    strip.position.set(0, 0.4, z + (z > 0 ? -0.01 : 0.01));
    strip.rotation.y = z > 0 ? Math.PI : 0;
    g.add(strip);
  }
  // Ceiling trusses for depth when the camera looks up during tracking.
  const truss = new THREE.MeshStandardMaterial({ color: 0x131c26, roughness: 1 });
  for (let i = 0; i < 9; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(9, 0.18, 0.18), truss);
    t.position.set(0, 7.4, -18 + i * 4.5);
    g.add(t);
  }
  return g;
}

/* -------------------------------------------------- build / replace scene */
const sheetGroup = new THREE.Group();      // sheet + arena dressing
const stoneGroup = new THREE.Group();      // live stones
const fxGroup = new THREE.Group();         // preview arc, highlight rings, measure lines
scene.add(sheetGroup, stoneGroup, fxGroup);

const previewLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.22, gapSize: 0.18, transparent: true, opacity: 0.85 }));
previewLine.frustumCulled = false;
fxGroup.add(previewLine);

const highlightRings = [];
const measureLines = [];

function placeSheet(obj) {
  sheetGroup.add(obj);
}

/* ------------------------------------------------------- stone appearance */
/**
 * A stable, varied handle angle for a stone nobody is throwing.
 *
 * Hashed from the stone id, never drawn from Math.random: an angle that changed
 * between frames, camera moves, or reloads would look like a stone turning while
 * nothing is touching it. It is not zero, because stones already standing on the
 * ice when an end opens have handles at all angles — and a stationary handle is
 * information, it says which way that stone came in.
 */
function restHandleAngle(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
}

class StoneView {
  constructor(stone, root) {
    this.stone = stone;
    this.root = root;                      // origin at the bottom centre
    this.handle = root.userData.handle || findPart(root, 'handle') || null;
    // The angle belongs to this stone. See the note in frameLoop where it is
    // advanced: a stone is spun once, at delivery, and stops turning when it
    // stops sliding, so no other stone on the ice has any reason to share it.
    this.handleAngle = restHandleAngle(stone.id);
    if (this.handle) this.handle.rotation.y = this.handleAngle;
    this.root.position.set(stone.x, 0, stone.z);
  }
  sync(stone) {
    this.stone = stone;
    this.root.visible = !stone.removed;
    if (stone.removed) return;
    // A curling stone *slides*; it does not roll end over end, and the handle
    // stays upright. Only the handle turns (about Y) to show the throw's spin.
    this.root.position.set(stone.x, 0, stone.z);
  }
}

const stoneViews = new Map();

function stoneRoot(team) {
  const cached = assets[team === 'A' ? 'stone_red' : 'stone_yellow'];
  const proto = cached && cached.obj;
  if (proto) {
    const c = proto.clone(true);
    c.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); } });
    return c;
  }
  return buildProceduralStone(TEAM_COLOR[team]);
}

function ensureStoneView(stone) {
  if (stoneViews.has(stone.id)) return stoneViews.get(stone.id);
  const v = new StoneView(stone, stoneRoot(stone.team));
  stoneViews.set(stone.id, v);
  stoneGroup.add(v.root);
  return v;
}

function clearStoneViews() {
  for (const v of stoneViews.values()) stoneGroup.remove(v.root);
  stoneViews.clear();
}

/**
 * The angle the HUD dial should show: the live stone's own while one is
 * running, otherwise the aiming indication. Per-stone angles are not
 * interchangeable, so the dial asks which stone it is describing instead of
 * reading state shared between stones.
 */
function spinDialAngle() {
  if (G.phase === 'INFLIGHT' && G.live) {
    const v = stoneViews.get(G.live.delivered.id);
    if (v) return v.handleAngle;
  }
  return G.handleAngle;
}

/* --------------------------------------------------------- sweeper avatar
 * A stand-in drawn from primitives, not an asset — the broom in its hands is the
 * real broom.glb. The figure is written in the frame updateSweeper turns it into:
 * local +Z toward the line and the stone, local -X along the direction of travel,
 * +Y up. That is because it is the shape a sweeper has. Nobody works a line
 * face-first; they stand beside it and work side-on, feet apart along the path
 * with their toes pointing across it, body square to the ice lane and bent over
 * the broom, both hands on the shaft, eyes on the stone. So every joint below is
 * written in that frame and the limbs are aimed between the joints each frame —
 * which is also what lets the figure step, since a sweeper's feet shuffle along
 * the path while the body stays square to the line. The broom is the exception:
 * it is a real model, so it keeps a holder of its own whose yaw cancels the
 * body's turn and whose position the hands are read from.
 */
const sweeper = new THREE.Group();
const broomHolder = new THREE.Group();
// 'YXZ' keeps that composition in the order the pose is written in, so the
// broom's world pose stays axis-aligned and its head stays on the line no matter
// what the figure is doing with its feet.
broomHolder.rotation.order = 'YXZ';
sweeper.add(broomHolder);
sweeper.visible = false;
fxGroup.add(sweeper);

// The broom works on the line itself, not beside it: the figure stands off the
// path and reaches across, which is the only way a broom head ends up in front
// of a stone without the body standing on the line. The two grips are heights up
// the shaft, and both the hands and the arms follow them, so the grip holds
// while the broom strokes. The top hand goes near the top of the handle, as it
// does on a real broom: gripping well below the end would leave both hands at
// hip height and the only way to keep the brush on the ice would be to squat.
const SWEEP_REACH = 0.52;
const BROOM_GRIP = { upper: 1.18, lower: 0.85 };
// A sweeper watches their own stone, which from this frame is up-ice and toward
// the ice lane, and looks down at the ice while brushing. Turned relative to the
// body, not along it: the body faces the lane, the head looks back at the play.
const SWEEP_GAZE = new THREE.Vector3(0.60, -0.55, 0.58).normalize();
const HEAD_FORWARD = new THREE.Vector3(0, 0, 1);   // the face, in the figure's frame
// Bone lengths of the stand-in, and which way each joint bends. Neither is free:
// a segment shorter than the distance between its own joints gets stretched, and
// a stretched capsule stops reading as a limb; a joint that bends the wrong way
// puts the figure in a pose no knee or elbow can hold. The reach is measured at
// both extremes of the stroke by blender/preview_figure.py.
const LIMB = { thigh: 0.40, shin: 0.40, upper: 0.30, lower: 0.34 };
const LIMB_BEND = {
  // Knees along the path, leading the direction of travel, not toward the ice
  // lane: the camera that follows the play looks in from the lane, so a limb
  // pointing that way points at the lens and the legs read as scattered dots.
  // Both knees go the same way — a crouch driving the same direction, the near
  // one a touch deeper than the far one — because two knees bending opposite ways
  // reads as a zig-zag of separate bars at the size this figure is seen at.
  kneeL: [-0.95, 0.0, 0.35], kneeR: [-0.8, 0.0, 0.35],
  armTop: [0.45, -0.85, 0.2],   // elbows hang rather than wing out; the steering arm
  armBot: [-0.45, -0.85, 0.2],  // leads a little up-ice and the driving arm down-ice
};

// 0 while jogging with the stone, 1 while the ice is being swept. Eased, because
// bending over the broom should not be a snap.
let sweepPose = 0;

function buildSweeperRig() {
  const mat = {
    // the jacket carries the team, so the figure is obviously the one whose
    // stone is being swept; everything else stays dark against the ice
    jacket: new THREE.MeshPhysicalMaterial({ color: TEAM_COLOR.A, roughness: 0.72 }),
    trousers: new THREE.MeshPhysicalMaterial({ color: 0x1b222c, roughness: 0.75 }),
    // Socks a shade lighter than the trousers: at the size this figure is seen
    // at, one dark colour for a whole leg reads as a bar, and the bend at the
    // knee is the thing that has to be visible.
    socks: new THREE.MeshPhysicalMaterial({ color: 0x2c3644, roughness: 0.78 }),
    skin: new THREE.MeshPhysicalMaterial({ color: 0xd8b48c, roughness: 0.8 }),
    hair: new THREE.MeshPhysicalMaterial({ color: 0x2c2119, roughness: 0.9 }),
    sole: new THREE.MeshPhysicalMaterial({ color: 0x12161b, roughness: 0.9 }),
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const d = new THREE.Vector3(), n = new THREE.Vector3();
  const u = new THREE.Vector3(), pp = new THREE.Vector3(), bb = new THREE.Vector3();

  function limb(radius, length, material) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
    m.userData.rest = length;   // so aim() can stretch it to reach a joint
    return m;
  }
  /** Stretch a limb along its own Y and point it from one joint to the next. */
  function aim(part, a, b) {
    d.subVectors(b, a);
    const len = Math.max(1e-4, d.length());
    n.copy(d).multiplyScalar(1 / len);
    part.quaternion.setFromUnitVectors(UP, n);
    part.position.copy(a).addScaledVector(n, len * 0.5);
    part.scale.set(1, len / part.userData.rest, 1);
  }
  /**
   * Place the joint in the middle of a two-segment limb. A hip 0.70 m above a
   * planted foot and a grip 0.95 m up a tilted shaft are not distances a single
   * straight capsule spans: drawn that way it stretches to twice its length and
   * reads as a plank instead of an arm, which is what the first version of this
   * figure did. So the knee and the elbow are solved for. The cosine rule gives
   * the angle at the upper joint; `bend` says which side the joint goes to, off
   * the straight line rather than along the limb. Returns whether the chain can
   * reach at all — blender/preview_figure.py measures that every frame, because
   * a hand that cannot reach its grip comes off the broom.
   */
  function twoSeg(a, b, l1, l2, bend, out) {
    d.subVectors(b, a);
    const raw = Math.max(1e-4, d.length());
    const reach = Math.min(raw, l1 + l2 - 1e-3);
    u.copy(d).multiplyScalar(1 / raw);
    const cos = clamp((l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach), -1, 1);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    bb.set(bend[0], bend[1], bend[2]);
    pp.copy(bb).addScaledVector(u, -bb.dot(u));
    if (pp.lengthSq() < 1e-6) pp.set(u.y, -u.x, u.z); else pp.normalize();
    out.copy(a).addScaledVector(u, cos * l1).addScaledVector(pp, sin * l1);
    return raw <= l1 + l2 - 1e-3;
  }

  const P = {
    pelvis: limb(0.13, 0.18, mat.trousers),
    thighL: limb(0.085, LIMB.thigh, mat.trousers), shinL: limb(0.070, LIMB.shin, mat.socks),
    thighR: limb(0.085, LIMB.thigh, mat.trousers), shinR: limb(0.070, LIMB.shin, mat.socks),
    footL: new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.22), mat.sole),
    footR: new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.22), mat.sole),
    torso: limb(0.155, 0.32, mat.jacket),
    // Two arms, each in two segments, each ending on a different grip: the top
    // hand on a broom is the one that steers it and sits up-ice in this frame,
    // the bottom hand drives along the shaft and sits down-ice. Keeping them on
    // opposite sides of the body is what keeps both of them visible in profile.
    upperArmTop: limb(0.052, LIMB.upper, mat.jacket), foreArmTop: limb(0.044, LIMB.lower, mat.jacket),
    upperArmBot: limb(0.052, LIMB.upper, mat.jacket), foreArmBot: limb(0.044, LIMB.lower, mat.jacket),
    handTop: new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), mat.skin),
    handBot: new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), mat.skin),
  };
  // The head is a group, not a sphere: it has to look where a sweeper looks,
  // which is not where the body faces. The face is local +Z of this group, so
  // the hair and the knot sit behind it.
  const head = new THREE.Group();
  head.add(
    new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), mat.skin),
  );
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.112, 16, 12), mat.hair);
  hair.position.set(0, 0.025, -0.05);
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), mat.hair);
  knot.position.set(0, 0.03, -0.14);
  head.add(hair, knot);

  sweeper.add(P.pelvis, P.thighL, P.shinL, P.footL, P.thighR, P.shinR, P.footR,
    P.torso, P.upperArmTop, P.foreArmTop, P.handTop,
    P.upperArmBot, P.foreArmBot, P.handBot, head);

  const J = {};
  for (const k of ['hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR', 'waist',
    'chest', 'skull', 'shoulderTop', 'shoulderBot', 'elbowTop', 'elbowBot',
    'handTop', 'handBot']) {
    J[k] = new THREE.Vector3();
  }
  return { P, J, head, aim, twoSeg, mat };
}
const rig = buildSweeperRig();

/**
 * The stance, written in the figure's frame. `step` drives the side-step and
 * `brush` is the eased sweeping state: while the ice is being swept the body
 * bends lower over the broom; between strokes it stands a little taller and the
 * broom comes up off the ice. The hands are read from the broom holder, which
 * the caller has already posed, so the grip holds through the stroke instead of
 * the arms waving next to it — and because the holder moves, the elbows and
 * knees are solved for against the hands and feet as they actually end up.
 */
function poseSweeper(step, brush) {
  const { P, J, aim, twoSeg } = rig;
  const shuffle = Math.sin(step);
  const hips = 0.70 + 0.02 * Math.abs(shuffle);          // weight rising as it shifts
  const lean = 0.56 + 0.16 * brush;                      // bend over the broom
  const sLean = Math.sin(lean), cLean = Math.cos(lean);
  const slide = 0.16 * shuffle;                          // both feet move together: a shuffle
  const lift = 0.05;

  // Feet apart along the path — that is the stance, not a stride across it.
  J.hipL.set(-0.12, hips, 0); J.hipR.set(0.12, hips, 0);
  J.footL.set(-0.30 + slide, 0.05 + (shuffle > 0 ? shuffle * lift : 0), 0);
  J.footR.set(0.30 + slide, 0.05 + (shuffle < 0 ? -shuffle * lift : 0), 0);
  twoSeg(J.hipL, J.footL, LIMB.thigh, LIMB.shin, LIMB_BEND.kneeL, J.kneeL);
  twoSeg(J.hipR, J.footR, LIMB.thigh, LIMB.shin, LIMB_BEND.kneeR, J.kneeR);

  // Spine along the lean. The head sits a neck and a half-head beyond the
  // shoulders, not inside them: bent over, the head still rides above the
  // shoulder line, which is what makes the posture read as a person rather than
  // a leaning mass.
  J.waist.set(0, hips + 0.03, 0);
  J.chest.set(0, J.waist.y + 0.32 * cLean, 0.32 * sLean);
  J.skull.set(0, J.waist.y + 0.50 * cLean, 0.50 * sLean);
  J.shoulderBot.set(-0.17, J.chest.y + 0.02, J.chest.z + 0.02);
  J.shoulderTop.set(0.17, J.chest.y + 0.02, J.chest.z + 0.02);

  // Hands on the shaft, wherever the stroke has just taken it.
  const grip = (s, out) => out.set(0, s, 0).applyEuler(broomHolder.rotation).add(broomHolder.position);
  grip(BROOM_GRIP.upper, J.handTop);
  grip(BROOM_GRIP.lower, J.handBot);
  twoSeg(J.shoulderTop, J.handTop, LIMB.upper, LIMB.lower, LIMB_BEND.armTop, J.elbowTop);
  twoSeg(J.shoulderBot, J.handBot, LIMB.upper, LIMB.lower, LIMB_BEND.armBot, J.elbowBot);

  aim(P.pelvis, J.hipR, J.hipL);
  aim(P.thighL, J.hipL, J.kneeL); aim(P.shinL, J.kneeL, J.footL);
  aim(P.thighR, J.hipR, J.kneeR); aim(P.shinR, J.kneeR, J.footR);
  aim(P.torso, J.waist, J.chest);
  aim(P.upperArmTop, J.shoulderTop, J.elbowTop); aim(P.foreArmTop, J.elbowTop, J.handTop);
  aim(P.upperArmBot, J.shoulderBot, J.elbowBot); aim(P.foreArmBot, J.elbowBot, J.handBot);
  P.handTop.position.copy(J.handTop); P.handBot.position.copy(J.handBot);
  // Toes pointing across the path while the feet sit along it: read as a body
  // turned square to the ice lane from any angle the camera comes in at.
  P.footL.position.set(J.footL.x, J.footL.y - 0.02, J.footL.z + 0.07);
  P.footR.position.set(J.footR.x, J.footR.y - 0.02, J.footR.z + 0.07);
  rig.head.position.copy(J.skull);
  rig.head.quaternion.setFromUnitVectors(HEAD_FORWARD, SWEEP_GAZE);
}

// ice chippings
const SPRAY_MAX = 220;
const sprayGeo = new THREE.BufferGeometry();
const sprayPos = new Float32Array(SPRAY_MAX * 3);
sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.035, transparent: true, opacity: 0.75,
  blending: THREE.AdditiveBlending, depthWrite: false,
}));
spray.frustumCulled = false;
fxGroup.add(spray);
const sprayParts = [];
function spawnSpray(p) {
  if (sprayParts.length >= SPRAY_MAX) return;
  sprayParts.push({ x: p.x, y: 0.01, z: p.z, vx: (Math.random() - 0.5) * 1.4, vy: 0.6 + Math.random(), vz: (Math.random() - 0.5) * 1.4, t: 0 });
}
function updateSpray(dt) {
  for (let i = sprayParts.length - 1; i >= 0; i--) {
    const p = sprayParts[i];
    p.t += dt; if (p.t > 0.55) { sprayParts.splice(i, 1); continue; }
    p.vy -= 9 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < 0.005) { p.y = 0.005; p.vy = 0; }
  }
  for (let i = 0; i < SPRAY_MAX; i++) {
    const p = sprayParts[i];
    sprayPos[i * 3] = p ? p.x : 0; sprayPos[i * 3 + 1] = p ? p.y : -99; sprayPos[i * 3 + 2] = p ? p.z : 0;
  }
  sprayGeo.attributes.position.needsUpdate = true;
  sprayGeo.setDrawRange(0, Math.max(0, sprayParts.length));
}

/* ---------------------------------------------------------------- input */
const keys = new Set();
// Enter is the one addition to the brief's Space + four arrows, and it is a view
// control only: it asks to see the plan of the house. It never commits a shot.
const KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'space', Space: 'space', Enter: 'enter' };

addEventListener('keydown', e => {
  const k = KEYMAP[e.key] || (e.key === 'r' || e.key === 'R' ? 'r' : null);
  if (!k) return;
  e.preventDefault();
  if ((k === 'space' || k === 'r' || k === 'enter') && e.repeat) return;
  if (!keys.has(k)) { pressed.add(k); }
  keys.add(k);
}, { passive: false });
addEventListener('keyup', e => {
  const k = KEYMAP[e.key]; if (!k) return; e.preventDefault(); keys.delete(k);
}, { passive: false });
addEventListener('blur', () => keys.clear());
const pressed = new Set();          // edge-triggered, consumed by the state machine
const consume = k => { if (pressed.has(k)) { pressed.delete(k); return true; } return false; };
/** Aim/step keys repeat while held, at a controlled rate. */
const repeatTimers = {};
function heldRepeat(key, cb, firstDelay = 0.28, rate = 0.055) {
  if (!keys.has(key)) { repeatTimers[key] = { t: 0, first: true }; return false; }
  const st = (repeatTimers[key] ||= { t: 0, first: true });
  if (consume(key)) { cb(); st.t = 0; st.first = false; return true; }
  st.t += G.dt;
  const wait = st.first ? firstDelay : rate;
  if (st.t >= wait) { st.t = 0; st.first = false; cb(); return true; }
  return false;
}

/* -------------------------------------------------------------------- HUD */
const hud = {
  board: $('board'), endNo: $('endNo'), vsLine: $('vsLine'),
  score: { A: $('scoreA'), B: $('scoreB') }, pips: { A: $('pipsA'), B: $('pipsB') },
  hammer: { A: $('hammerA'), B: $('hammerB') }, team: { A: $('teamA'), B: $('teamB') },
  callout: $('callout'), telemetry: $('telemetry'),
  prompt: $('prompt'),
  powerVal: $('powerVal'), weightName: $('weightName'),
  track: {
    svg: $('sheetTrack'), static: $('trackStatic'), stones: $('trackStones'),
    ghosts: $('trackGhosts'), fgz: $('trackFgz'), path: $('trackPath'),
    stop: $('trackStop'), stopDot: $('trackStop').querySelector('circle'),
  },
  spinIcon: $('spinIcon'), spinLevels: [...document.querySelectorAll('.slev')],
  sweepFill: $('sweepFill'), sweepVal: $('sweepVal'), sweepState: $('sweepState'), sweepTrack: $('sweepTrack'),
  powerBox: $('powerBox'), spinBox: $('spinBox'), sweepBox: $('sweepBox'),
  title: $('title'), summary: $('summary'), gameover: $('gameover'), hint: $('hint'),
};
// (The weight control is not a bar any more — see "weight track" below, which
// draws a to-scale miniature of the sheet and is built from SHEET at boot.)

/* The weight *readout* is track.js's weightReadout(): the number that matters is
 * the endpoint of the simulated preview, with the distance the stone would run if
 * nothing stopped it as the fallback. updateHUD calls it directly. */

let calloutTimer = 0;
function callout(text, ms = 2200) {
  hud.callout.textContent = text;
  hud.callout.classList.remove('hidden');
  calloutTimer = ms / 1000;
}
function telemetry(html) {
  if (!html) { hud.telemetry.classList.add('hidden'); return; }
  hud.telemetry.innerHTML = html;
  hud.telemetry.classList.remove('hidden');
}
let promptHtml = '';
function setPrompt(html) {
  if (html === promptHtml) return;
  promptHtml = html;
  hud.prompt.innerHTML = html;
  hud.prompt.classList.toggle('hidden', !html);
}

function updateHUD() {
  const m = G.match;
  if (!m) return;
  hud.endNo.innerHTML = `END <b>${Math.min(m.end, m.ends)}</b> / ${m.ends}${m.extraEnds ? `  (+${m.extraEnds})` : ''}`;
  hud.vsLine.textContent = m.mode === 'cpu' ? `vs CPU · ${m.difficulty}` : 'hotseat · two players';
  hud.score.A.textContent = m.score.A; hud.score.B.textContent = m.score.B;
  for (const t of ['A', 'B']) {
    hud.hammer[t].classList.toggle('off', m.hammer !== t);
    hud.team[t].classList.toggle('active', !G.over && currentThrower(m) === t && G.phase !== 'END_SUMMARY' && G.phase !== 'GAME_OVER');
    const pips = hud.pips[t];
    if (pips.childElementCount !== RULES.STONES_PER_PLAYER_PER_END) {
      pips.innerHTML = '';
      for (let i = 0; i < RULES.STONES_PER_PLAYER_PER_END; i++) { const d = document.createElement('div'); d.className = 'pip'; pips.appendChild(d); }
    }
    [...pips.children].forEach((el, i) => el.classList.toggle('left', i < m.stonesLeft[t]));
  }

  // phase visibility of the meters
  const aiming = G.phase === 'AIM' || G.phase === 'POWER';
  hud.powerBox.classList.toggle('hidden', !aiming);
  hud.spinBox.classList.toggle('hidden', !aiming);
  hud.sweepBox.classList.toggle('hidden', G.phase !== 'INFLIGHT');

  if (aiming) {
    const p = G.previewPower();   // the meter while sweeping, a draw while reading line
    // Read weight the way a skip names it — the metres the stone would run, then
    // what that weight is called. The percentage is an implementation detail and
    // the player never aims at it.
    const travel = Math.pow(launchSpeed(p), 2) / (2 * PHYS.A_BASE);
    hud.powerVal.textContent = `${travel.toFixed(1)} m`;
    hud.weightName.textContent = weightReadout(G.previewSim, SHEET.hackZ + travel);
  }
  hud.spinLevels.forEach(el => el.classList.toggle('on', +el.dataset.s === G.shot.spin));
  hud.spinIcon.style.color = G.shot.spin > 0 ? '#4aa8ff' : G.shot.spin < 0 ? '#ffb454' : '#93a7b8';
  hud.spinIcon.style.transform = `rotate(${spinDialAngle() * 57.3}deg)`;

  // Brushing has no budget, so the bar is not a countdown: it shows the share of
  // this delivery that has been brushed, which is the number that explains why the
  // stone is running farther and straighter than the line you aimed at.
  const flight = G.live && G.live.world ? G.live.world.time : 0;
  const share = flight > 0.2 ? clamp(G.sweepUsed / flight, 0, 1) : 0;
  hud.sweepFill.style.width = (share * 100) + '%';
  hud.sweepVal.textContent = `${G.sweepUsed.toFixed(1)} s brushed${flight > 0.2 ? ` of ${flight.toFixed(1)} s` : ''}`;
  hud.sweepState.textContent = G.phase === 'INFLIGHT' ? (G.sweeping ? 'BRUSHING' : 'not brushing') : 'idle';
  hud.sweepTrack.classList.toggle('busy', G.sweeping);
}

/* ----------------------------------------------- camera director / framing */
/**
 * What the tracking view is pointed at. While a stone is in flight it is that
 * stone. When the shot ends it is wherever that stone finished, which is what
 * makes "stay with the play" work without a special case: the camera is already
 * there. A stone that left the sheet — out of play, hogged, taken in for an
 * illegal take-in — leaves nothing out there to look at, so the view stays on
 * the house instead. There is deliberately no third kind of answer: a default
 * framing of the middle of the rink is a cut, and that was the reported bug.
 */
function trackFocus() {
  const live = G.live && G.live.delivered;
  if (live) return live;
  return G.camHold || { x: 0, z: SHEET.teeZ };
}

const CAM = {
  title: { pos: () => new THREE.Vector3(6.4 + Math.sin(G.now * 0.08) * 1.4, 3.6, -9.5), look: () => new THREE.Vector3(0, 0.35, 7.5), tau: 1.2, fov: 40 },
  hack: { pos: () => new THREE.Vector3(1.15, 1.85, SHEET.hackZ - 2.6), look: () => new THREE.Vector3(-0.35, 0.12, 4.0), tau: 0.30, fov: 40 },
  track: {
    pos: () => {
      const s = trackFocus();
      // "like a sweeper": low, off to the side, slightly behind the stone,
      // with the house kept in frame so weight reads. The same formula serves the
      // held view after the shot, because the focus is the only thing that changed.
      const x = clamp(s.x + 2.5, -3.4, 3.4);
      const z = clamp(s.z - 3.6, SHEET.hackZ - 2.4, SHEET.backLineZ + 1.2);
      return new THREE.Vector3(x, 2.15, z);
    },
    look: () => {
      const s = trackFocus();
      return new THREE.Vector3(s.x * 0.6, 0.1, lerp(s.z, SHEET.teeZ, 0.32));
    },
    tau: 0.22, fov: 42,
  },
  skip: {
    pos: () => new THREE.Vector3(0.9, 2.9, SHEET.teeZ + 6.2),
    look: () => new THREE.Vector3(0, 0.12, 4.0),
    tau: 0.26, fov: 40,
  },
  plan: {
    // Straight above the tee, framed on the house: what Enter gives you, to read the
    // situation. Two properties of this view are not free, and both are measured
    // against the shipped arena by tests/glbtest.mjs rather than assumed.
    //
    // Height. The arena hangs a light bank at y = 7.04..7.16 directly over the tee
    // line, so a camera above it looks *through* the fitting and the house is
    // obscured by a lamp. The eye therefore sits below everything that hangs into the
    // sheet's footprint — here 0.8 m under the lowest lamp. Below that plane nothing
    // suspended can be in frame at all, whatever the framing turns out to be. (With
    // assets/ empty the stand-in arena hangs its trusses at y 7.31, so the eye is
    // below those too; only the GLB path is covered by the test.)
    //
    // Orientation. The ice runs up the screen, so the boards are the bands down the
    // left and right, which is how a sheet is drawn. That choice is not arbitrary
    // either: the delivery camera looks along +Z, so its screen-right is -X, and a
    // camera straight above the tee with camera.up = +Z keeps -X on the right and
    // puts down-ice up the screen — the same view from above, not a new frame of
    // reference. The weight miniature is this frame turned anticlockwise through 90°
    // (its right is +Z, its up is +X, so turning it sends +X to the left), which is
    // the same picture rather than a mirror of it.
    //
    // The along-ice half-field is H·tan(fov/2) = 3.6 m, which frames the house with
    // about 1.6 m of ice around it — enough to see a stone lying just outside the
    // rings — and at a square window it still spans the full 4.88 m width of the
    // sheet, since the lateral half-field is this number times the aspect ratio.
    pos: () => new THREE.Vector3(0, 6.2, SHEET.teeZ),
    look: () => new THREE.Vector3(0, 0, SHEET.teeZ),
    up: new THREE.Vector3(0, 0, 1),
    tau: 0.30, fov: 60,
  },
};
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let camMode = 'title';
let camUp = WORLD_UP.clone();
function setCameraMode(mode) { camMode = mode; }
function updateCamera(dt) {
  // Enter overrides the director for as long as the player wants the plan.
  const c = CAM[G.planView ? 'plan' : camMode] || CAM.hack;
  const a = 1 - Math.exp(-dt / c.tau);
  // Looking straight down, the frame's up has to be an axis of the ice rather than
  // the sky. The up vector is eased with everything else, so opening a plan view
  // rolls the frame over instead of snapping it a quarter turn.
  camUp.lerp(c.up || WORLD_UP, a).normalize();
  camera.up.copy(camUp);
  camera.fov = lerp(camera.fov, c.fov, 1 - Math.exp(-dt / 0.4));
  camera.updateProjectionMatrix();
  camPos.lerp(c.pos(), a);
  camLook.lerp(c.look(), a);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

/* ------------------------------------------------------- preview geometry */
function clearPreview() {
  previewLine.geometry.dispose();
  previewLine.geometry = new THREE.BufferGeometry();
  G.previewSim = null;
  hideTrackPrediction();
}
function setPreviewFromShot() {
  const sim = simulateDelivery(G.stones, { ...G.shot, power: G.previewPower() }, { id: 'preview', path: true });
  G.previewSim = sim;                 // the weight track draws from this same result
  const pts = (sim.path || []).map(p => new THREE.Vector3(p.x, 0.02, p.z));
  if (sim.delivered && !sim.delivered.removed) pts.push(new THREE.Vector3(sim.delivered.x, 0.02, sim.delivered.z));
  if (pts.length < 2) { clearPreview(); return; }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  previewLine.geometry.dispose();
  previewLine.geometry = geo;
  previewLine.computeLineDistances();
  // The geometry is always the projected path of the current shot; the colour
  // only says which of the two things you are reading. With no handle on the
  // stone the path is straight, so it reads as a sighting line; as soon as there
  // is handle, the same line is the arc the stone will curl.
  previewLine.material.color.set(G.shot.spin === 0 ? 0xdfe9f2 : 0xffe08a);
  updateTrackPrediction(sim);
}

/* ------------------------------------------- weight track: a to-scale sheet
 * The control itself lives in track.js (pure geometry, no DOM, so the tests can
 * check where the painted landmarks sit). All that is here is the plumbing: hand
 * it the same simulateDelivery() result that feeds the 3D preview line, and put
 * the strings it returns into the matching <g> elements of index.html.
 */
const TRACK_COLORS = { A: hexColor(TEAM_COLOR.A), B: hexColor(TEAM_COLOR.B) };

hud.track.static.innerHTML = buildStaticSvg();
hud.track.svg.setAttribute('viewBox', TRACK.viewBox);

function hideTrackPrediction() {
  hud.track.path.setAttribute('points', '');
  hud.track.stop.setAttribute('visibility', 'hidden');
  hud.track.stones.innerHTML = '';
  hud.track.ghosts.innerHTML = '';
  hud.track.fgz.setAttribute('visibility', 'hidden');
}

/**
 * Paint the predicted shot on the miniature: the arc, the point the stone stops
 * at, and where this delivery would leave the stones already on the sheet.
 */
function updateTrackPrediction(sim) {
  if (!sim) return hideTrackPrediction();
  const T = hud.track;
  const view = buildDynamicSvg(sim, G.stones, TRACK_COLORS,
    G.match ? RULES.GUARD_ZONE_SHOTS - G.match.throwIndex : 0);

  T.path.setAttribute('points', view.path);
  if (view.stop) {
    T.stopDot.setAttribute('cx', view.stop.x);
    T.stopDot.setAttribute('cy', view.stop.y);
    T.stopDot.setAttribute('r', view.stop.r);
    T.stopDot.setAttribute('fill', view.stop.fill);
    T.stop.setAttribute('visibility', 'visible');
  } else {
    T.stop.setAttribute('visibility', 'hidden');
  }
  T.stones.innerHTML = view.stones;
  T.ghosts.innerHTML = view.ghosts;
  if (view.fgz) {
    T.fgz.setAttribute('x', view.fgz.x);
    T.fgz.setAttribute('y', view.fgz.y);
    T.fgz.setAttribute('width', view.fgz.w);
    T.fgz.setAttribute('height', view.fgz.h);
    T.fgz.setAttribute('visibility', 'visible');
  } else {
    T.fgz.setAttribute('visibility', 'hidden');
  }
}

/* ---------------------------------------- highlight counting stones, etc. */
function clearFx() {
  for (const r of highlightRings) fxGroup.remove(r);
  highlightRings.length = 0;
  for (const l of measureLines) fxGroup.remove(l);
  measureLines.length = 0;
}
function highlightStone(stone, color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SHEET.stoneRadius + 0.06, SHEET.stoneRadius + 0.16, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(stone.x, 0.012, stone.z);
  fxGroup.add(ring); highlightRings.push(ring);
  return ring;
}
function measureLine(from, to, color) {
  const a = new THREE.Vector3(from.x, 0.014, from.z);
  const b = new THREE.Vector3(to.x, 0.014, to.z);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, len, 8),
    new THREE.MeshBasicMaterial({ color }));
  // A cylinder is built along +Y, so rotate that axis onto the line.
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  mesh.position.copy(a).lerp(b, 0.5);
  fxGroup.add(mesh); measureLines.push(mesh);
  return mesh;
}

/* ------------------------------------------------------------- game state */
const G = {
  phase: 'TITLE',
  match: null,
  stones: [],                 // logical stones, in sync with physics
  live: null,                 // {world, delivered, index} during a shot
  camHold: { x: 0, z: SHEET.teeZ },   // where the view stays once no stone is in flight
  shot: { aimDeg: 0, spin: 0, power: 0.7 },
  release: null,              // this delivery's roll against release.js; null until the stone is thrown
  meter: { value: 0, t: 0, running: false },
  sweepUsed: 0, sweeping: false, sweepArmed: false,
  planView: false,              // Enter: a plan of the house, view only — never an input to the shot
  dt: 0, now: 0, frame: 0,
  acc: 0,
  handleAngle: 0,
  over: false,
  setupInfo: null,
  aiPlan: null,
  rng: makeRng((Date.now() & 0xffff) | 1),
  summary: null,
  titleOpts: { mode: 'hotseat', difficulty: 'normal', first: 'random' },
};
G.previewPower = () => (G.phase === 'POWER' ? G.meter.value : CAL.drawPower);

const titleState = { i: 0, keys: ['mode', 'difficulty', 'first'] };
function renderTitle() {
  const o = G.titleOpts;
  $('optMode').innerHTML = opt(['LOCAL HOTSEAT', 'VS CPU'], o.mode === 'hotseat' ? 0 : 1);
  $('optDifficulty').innerHTML = opt(['EASY', 'NORMAL', 'HARD'], ['easy', 'normal', 'hard'].indexOf(o.difficulty));
  $('optFirst').innerHTML = opt(['RANDOM', 'YOU GET THE HAMMER', 'CPU GETS THE HAMMER'],
    [0, 1, 2][['random', 'p1', 'p2'].indexOf(o.first)]);
  document.querySelectorAll('#titleOpts .opt').forEach((el, i) => el.classList.toggle('sel', i === titleState.i));
  function opt(labels, i) {
    return `<span class="arrow">◀</span> ${labels[i]} <span class="arrow">▶</span>`;
  }
}

function startMatch() {
  const o = G.titleOpts;
  const hammer = o.first === 'random' ? (Math.random() < 0.5 ? 'A' : 'B')
    : o.first === 'p1' ? 'A' : 'B';
  G.match = createMatch({ mode: o.mode, difficulty: o.difficulty, hammer, seed: (Date.now() & 0xffff) | 1 });
  startEnd(G.match);
  G.stones = [];
  clearStoneViews();
  clearFx();
  G.over = false;
  hud.title.classList.add('hidden');
  hud.summary.classList.add('hidden');
  hud.gameover.classList.add('hidden');
  telemetry(null);
  G.match.startedAt = performance.now();
  beginSetup();
}

const isHuman = t => G.match.mode === 'hotseat' || t === 'A';
const isCPU = t => G.match.mode === 'cpu' && t === 'B';

function beginSetup() {
  const m = G.match;
  const t = currentThrower(m);
  G.phase = 'SETUP';
  // No camera change here. This is the moment a player reads the ice — what the last
  // stone did, what guards stand, who has the hammer — and cutting to the hack before
  // they have looked at it throws that away. The prompt says "press Space to step up
  // to the hack", and the camera does that when they do, in beginAim().
  G.planView = false;
  G.shot = { aimDeg: 0, spin: 0, power: CAL.drawPower };
  G.release = null;          // the last delivery's roll belongs to that delivery
  G.sweepUsed = 0; G.sweeping = false;
  clearPreview();
  G.aiPlan = null;

  if (isCPU(t)) {
    // Let the CPU think here so no big hitch happens mid-shot.
    G.aiPlan = chooseShot({
      stones: G.stones, team: t, shotIndex: m.throwIndex, score: m.score,
      end: m.end, hammer: m.hammer, order: m.order, difficulty: m.difficulty, rng: G.rng,
    });
    setPrompt(`<div class="big">CPU (${m.difficulty.toUpperCase()}) is throwing ${STONE_WORD(t, m.throwIndex)}</div>
      <div class="sub">shot: ${G.aiPlan.name}</div>`);
    G.setupTimer = 1.05;
  } else {
    setPrompt(`<div class="big">${TEAM_NAME[t]} — press <kbd>Space</kbd> to step up to the hack</div>
      <div class="sub">stone ${Math.floor(m.throwIndex / 2) + 1} of ${RULES.STONES_PER_PLAYER_PER_END}${m.hammer === t ? ' · you have the <b>hammer</b>, you throw last' : ''}</div>
      <div class="sub">the view stays on the play so you can read the ice — <kbd>Enter</kbd> takes you over the house.</div>`);
    G.setupTimer = null;
  }
}
const STONE_WORD = (t, i) => `${TEAM_NAME[t]}'s stone ${Math.floor(i / 2) + 1}`;

function beginAim() {
  G.phase = 'AIM';
  // Stepping up to the hack is the move the SETUP prompt promised, so it happens here
  // and not a moment earlier. Any plan view the player had opened is closed with it.
  G.planView = false;
  setCameraMode('hack');
  setPreviewFromShot();
}

function shotPrompt() {
  const m = G.match, t = currentThrower(m);
  const guard = m.throwIndex < RULES.GUARD_ZONE_SHOTS;
  const guardCue = guard
    ? `<div id="guardcue">⚑ Guard zone — take-ins not allowed for the first ${RULES.GUARD_ZONE_SHOTS} stones of the end</div>` : '';
  const who = isCPU(t) ? 'CPU' : `PLAYER ${t === 'A' ? 1 : 2} (${TEAM_NAME[t]})`;
  const maxSpin = Math.max(...RULES.SPIN_LEVELS.map(Math.abs));
  const spinWord = G.shot.spin > 0 ? `handle clockwise +${G.shot.spin} — the stone curls right`
    : G.shot.spin < 0 ? `handle counter-clockwise ${G.shot.spin} — the stone curls left`
      : 'no handle yet — the stone runs straight';
  // Enter is a view, so it gets its own line only when it is on: otherwise the
  // prompt would describe a control the player is not using right now.
  const planCue = G.planView
    ? `<div class="sub"><b>plan view</b> — <kbd>Enter</kbd> goes back to the ice</div>`
    : `<div class="sub"><kbd>Enter</kbd> shows the same line from above the house.</div>`;
  if (G.phase === 'AIM') {
    // One phase reads line *and* handle, which is how a skip actually works: the
    // two are chosen together and the arc in the preview is the feedback for both.
    setPrompt(`<div class="big">${who}</div>
      <div class="big">LINE <kbd>←</kbd><kbd>→</kbd> &nbsp;HANDLE <kbd>↑</kbd><kbd>↓</kbd> &nbsp;<kbd>Space</kbd> WEIGHT</div>
      <div class="sub">line &plusmn;${RULES.AIM_MAX_DEG}&deg; in ${RULES.AIM_STEP_DEG}&deg; steps, hold to repeat.<br>
        ${spinWord}. &plusmn;${maxSpin} turns are available and the projected arc grows with them.</div>
      <div class="sub">the arc is the line you <i>call</i>. How close the stone comes to it is settled when you let go,
        and the shot log says by how much.</div>
      ${planCue}
      ${guardCue}`);
  } else if (G.phase === 'POWER') {
    setPrompt(`<div class="big">WEIGHT — <kbd>Space</kbd> lets go</div>
      <div class="sub">the marker runs along the miniature at a steady speed: where it is, is where the stone stops.
        the green band is a button draw.</div>
      <div class="sub">line and handle can still be changed while the meter runs.</div>
      ${planCue}
      ${guardCue}`);
  }
}

/* --------------------------------------------------------------- the shot */
let shotCounter = 0;
function launchShot() {
  const m = G.match, t = currentThrower(m);
  const world = new StoneWorld(cloneStones(G.stones));
  // The release is not the preview. A CPU delivery already carries the noise of its
  // difficulty ladder, which ai.js put into the plan; a human delivery is rolled
  // here, once, against the table in release.js — never while aiming, or the preview
  // would change under the player's eye. G.shot keeps the intent that the preview,
  // the miniature and the HUD show; only the stone leaving the hack carries the
  // error. There is deliberately no error in the weight: the stone goes as far as
  // the meter said it would.
  G.release = isCPU(t) ? null : rollRelease(G.rng, G.shot);
  const shot = G.release ? applyRelease(G.shot, G.release) : G.shot;
  const v0 = launchSpeed(shot.power);
  const aim = shot.aimDeg * DEG;
  const dir = { x: -Math.sin(aim), z: Math.cos(aim) };
  const id = `s${++shotCounter}-${t}-${m.end}-${m.throwIndex}`;
  const delivered = makeStone({
    id, team: t, x: 0, z: SHEET.hackZ, vx: dir.x * v0, vz: dir.z * v0,
    spin: shot.spin, delivered: true,
  });
  world.stones.push(delivered);
  G.live = { world, delivered, index: world.stones.length - 1, steps: 0, started: false };
  G.sweepUsed = 0; G.sweeping = false;
  // The weight is let go with the same key that brushes the ice, so brushing has to
  // be re-armed by releasing it first — otherwise every delivery would start already
  // being brushed by the hand that just pressed Space.
  G.sweepArmed = !keys.has('space');
  G.planView = false;         // the delivery is watched from the ice, not from above
  ensureStoneView(delivered);
  setCameraMode('track');
  clearPreview();
  G.phase = 'INFLIGHT';
  G.sweepWindow = { start: -1, end: -1 };
  if (isCPU(t) && G.aiPlan && G.aiPlan.sweep) G.sweepWindow = { start: G.aiPlan.sweep.startT, end: G.aiPlan.sweep.endT };
}

function stepShot() {
  const L = G.live; if (!L) return;
  const world = L.world;

  // sub-step the fixed-timestep simulation so what you see == what was scored
  let steps = 0;
  while (G.acc >= PHYS.DT && steps < 8) {
    G.acc -= PHYS.DT; steps++;
    let sweepOn = false;
    if (isCPU(currentThrower(G.match))) {
      const w = G.sweepWindow;
      sweepOn = w.start >= 0 && world.time >= w.start && world.time < w.end;
    } else if (G.sweepArmed) {
      // Brushing is allowed for the whole path: from delivery until the stone stops.
      // There is no budget to run out — the cost of brushing is that it adds distance
      // and straightens the arc, and the preview and the miniature show the unbrushed
      // line, so what you give up is the line you aimed at.
      sweepOn = keys.has('space');
    } else if (!keys.has('space')) {
      G.sweepArmed = true;    // the key was let go after the delivery; now it can brush
    }
    if (sweepOn) G.sweepUsed += PHYS.DT;
    G.sweeping = sweepOn && !G.live.delivered.removed && Math.hypot(G.live.delivered.vx, G.live.delivered.vz) > 0.1;
    world.step(PHYS.DT, G.sweeping ? L.index : -1);
    L.steps++;
  }

  for (const s of world.stones) {
    const v = stoneViews.get(s.id);
    if (v) v.sync(s);
  }
  updateSweeper();

  if (!world.anyMoving() || world.time > PHYS.MAX_SHOT_TIME) settleShot();
}

function updateSweeper() {
  const d = G.live && G.live.delivered;
  const show = !!d && !d.removed && Math.hypot(d.vx, d.vz) > 0.05;
  sweeper.visible = show;
  broomHolder.visible = show;
  // Off-screen is also the reset point: a new flight starts with the figure
  // upright, not still bent over from the last one.
  if (!show) { sweepPose = 0; return; }
  const sp = Math.hypot(d.vx, d.vz);
  const dir = new THREE.Vector3(d.vx / sp, 0, d.vz / sp);
  const right = new THREE.Vector3(-dir.z, 0, dir.x);      // right of travel
  const pos = new THREE.Vector3(d.x, 0, d.z).addScaledVector(dir, 0.85).addScaledVector(right, 0.52);
  sweeper.position.copy(pos);
  // A sweeper never runs face-first down the line. The body is turned 90 degrees
  // off the direction of travel and works across it, so from the play it is
  // always seen side-on; in the frame that leaves, local -X is along the path
  // and local +Z is toward the stone, and that is the frame poseSweeper writes.
  sweeper.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2;
  rig.mat.jacket.color.setHex(TEAM_COLOR[d.team] || TEAM_COLOR.A).multiplyScalar(0.82);
  if (!broomHolder.userData.built && assets.broom && assets.broom.obj) {
    const b = assets.broom.obj.clone(true);
    broomHolder.add(b); broomHolder.userData.built = true;
  }
  const t = G.now * (G.sweeping ? 13 : 3);
  const swing = Math.sin(t) * (G.sweeping ? 0.36 : 0.06);
  sweepPose += ((G.sweeping ? 1 : 0) - sweepPose) * 0.1;
  // Undo the body's turn so the broom keeps an axis-aligned world pose.
  broomHolder.rotation.y = -Math.PI / 2;
  broomHolder.rotation.x = -0.55;
  // A little wrist in the stroke. Kept small on purpose: the broom head stays
  // flat on the ice in the game, and every degree of roll moves a grip a metre up
  // the shaft by more than it looks, which the arms then have to follow.
  broomHolder.rotation.z = swing * 0.25;
  // The broom works out in front of the figure, the way a stroke actually runs:
  // the brush head lands on the line ahead of the stone, and the hands stay
  // between the two shoulders so neither arm has to reach across the body. Set
  // that offset too short and the near end of the stroke puts a hand outside the
  // arm's reach — the reach is measured, see the note on LIMB.
  const stroke = 0.44 + swing * 0.25;
  broomHolder.position.set(-stroke, (1 - sweepPose) * 0.03, SWEEP_REACH);
  poseSweeper(G.now * (G.sweeping ? 5 : 3), sweepPose);
  const broomHead = pos.clone().addScaledVector(dir, stroke).addScaledVector(right, -SWEEP_REACH);
  if (G.sweeping) {
    spawnSpray(broomHead); if (Math.random() < 0.6) spawnSpray(broomHead);
  }
}

function settleShot() {
  const m = G.match, L = G.live, world = L.world, delivered = L.delivered;
  const before = cloneStones(G.stones);
  const verdict = adjudicateDelivery({ before, world, delivered, shotIndexInEnd: m.throwIndex });
  G.phase = 'SETTLE';
  // The camera does not cut. The tracking view has been following this stone and is
  // already looking at where it finished; pulling away to the far side the moment the
  // stones stop is exactly when the player wants to see the result. What it is
  // looking at is handed over at the bottom of this function, so the framing holds
  // through the wait for the next delivery rather than falling back to a default.
  const scoring = scoreEnd(world.stones);
  const label = describeShot({ before, world, delivered, scored: scoring });
  // A release the player could not see coming says so on the screen where the result
  // is explained. A clean one stays silent: quiet is the right report for most shots,
  // and a callout that apologises every third throw stops meaning anything.
  const flub = G.release && G.release.tier !== 'good' ? ` — ${G.release.label}` : '';
  callout((verdict.guardZone ? 'TAKE-IN NOT ALLOWED' : label) + flub, 2400);

  // Rule notes for the player: what happened and why.
  const rows = [];
  const t = delivered.team;
  if (verdict.guardZone) {
    rows.push(['guard protected', verdict.guardZone.illegal.join(', ')]);
    rows.push(['delivery', 'removed (illegal take-in)']);
  } else if (verdict.hogged) {
    rows.push(['hog line', 'stone stopped short — removed']);
  } else if (delivered.removed) {
    rows.push(['out of play', delivered.outReason]);
  } else {
    const d = distanceToButton(delivered);
    if (inHouse(delivered)) rows.push(['distance to button', `${d.toFixed(2)} m`]);
    else if (delivered.z > SHEET.hogFarZ && delivered.z < SHEET.teeZ) rows.push(['position', 'guard']);
    else rows.push(['position', `z ${delivered.z.toFixed(1)} m`]);
  }
  for (const o of world.outs) rows.push(['removed', `${TEAM_NAME[o.team]} — ${o.reason}`]);
  // The row that explains the difference between the line you aimed and the line you
  // got. Signed the same way the aim readout is signed, so it can be read against it.
  if (G.release) rows.push(['release', describeRelease(G.release)]);
  rows.push(['travel', `${world.time.toFixed(1)} s · ${Math.round(G.sweepUsed * 10) / 10} s of brushing`]);
  telemetry(`<h4>SHOT LOG</h4>` + rows.map(r => `<div class="row"><span>${r[0]}</span><span>${r[1]}</span></div>`).join(''));

  // commit logical stones
  G.stones = world.stones.filter(s => !s.removed).map(s => ({ ...s, delivered: false, vx: 0, vz: 0 }));
  for (const s of world.stones) if (s.removed) { const v = stoneViews.get(s.id); if (v) v.root.visible = false; }
  sweeper.visible = false;

  m.stonesLeft[t] = Math.max(0, m.stonesLeft[t] - 1);
  m.throwIndex++;
  // Hand the held view over to wherever this stone finished. If it left the sheet
  // there is nothing out there left to look at, so the view stays on the house.
  G.camHold = delivered.removed
    ? { x: 0, z: SHEET.teeZ }
    : { x: delivered.x, z: delivered.z };
  G.live = null;
  G.settleTimer = 1.9;
}

function afterSettle() {
  const m = G.match;
  if (m.throwIndex >= m.order.length) return showEndSummary();
  beginSetup();
}

/**
 * A new end starts on a clean sheet — the previous end's stones are gone and so
 * are their meshes. finishEnd() has already advanced the match itself (score,
 * hammer, throw order, stones left); this is the view half of that same
 * boundary, and without it the old end's stones sit on the ice while the new
 * end is played. https://en.wikipedia.org/wiki/Curling#Scoring
 */
function clearSheetForNewEnd() {
  G.stones = [];
  G.live = null;
  G.camHold = { x: 0, z: SHEET.teeZ };   // a swept sheet has one thing worth looking at
  G.summary = null;
  G.settleTimer = null;
  G.sweepUsed = 0; G.sweeping = false;
  clearStoneViews();
  clearFx();            // counting rings and measure-up lines belong to the end that just finished
  clearPreview();
  telemetry(null);
  callout('NEW END — sheet swept clean', 1700);
}

function showEndSummary() {
  const m = G.match;
  const summary = finishEnd(m, G.stones);
  G.summary = summary;
  G.phase = 'END_SUMMARY';
  setCameraMode('skip');
  clearPreview();

  // Highlight counting stones and draw the measure-up from the button to the
  // closest stone of each colour — the "counting" part of the rules made visible.
  clearFx();
  const byId = {}; for (const s of G.stones) byId[s.id] = s;
  for (const id of summary.counting) { const s = byId[id]; if (s) highlightStone(s, 0x7ee787); }
  const button = { x: 0, z: SHEET.teeZ };
  for (const t of ['A', 'B']) {
    const b = summary.best[t];
    if (b) measureLine(button, b, TEAM_COLOR[t]);
  }

  const pts = summary.scoreA || summary.scoreB;
  $('sumTitle').textContent = `END ${summary.end}`;
  $('sumLead').innerHTML = summary.blank
    ? 'Blank end — nobody scored. The hammer stays with the same team.'
    : `<span class="counting">${TEAM_NAME[summary.scoringTeam]} scores ${pts} (${summary.counting.length} counter${pts > 1 ? 's' : ''})</span> — only stones touching the 12-foot house count. The scorer gives the hammer away.`;
  const rows = m.history.map(h => `<tr><td class="who">End ${h.end}</td><td><span class="dot r"></span>${h.scoreA || '·'}</td><td><span class="dot y"></span>${h.scoreB || '·'}</td></tr>`).join('');
  $('sumBody').innerHTML = `<table class="tally"><tr><th></th><th>RED</th><th>YELLOW</th></tr>${rows}</table>`;
  $('sumHammer').innerHTML = m.over
    ? `Match decided — <b>${TEAM_NAME[m.winner]}</b> wins ${Math.max(m.score.A, m.score.B)}–${Math.min(m.score.A, m.score.B)}`
    : `HAMMER for the next end: <b>${TEAM_NAME[m.hammer]}</b>`;
  hud.summary.classList.remove('hidden');
}

function showGameOver() {
  const m = G.match;
  G.phase = 'GAME_OVER';
  G.over = true;
  hud.summary.classList.add('hidden');
  const w = m.winner;
  $('goTitle').textContent = m.mode === 'cpu'
    ? (w === 'A' ? 'YOU WIN' : 'CPU WINS')
    : `${TEAM_NAME[w]} WINS`;
  $('goLead').textContent = `${m.ends} ends${m.extraEnds ? ` + ${m.extraEnds} extra` : ''} · final score ${m.score.A} – ${m.score.B}`;
  const rows = m.history.map(h => `<tr><td class="who">End ${h.end}</td><td><span class="dot r"></span>${h.scoreA || '·'}</td><td><span class="dot y"></span>${h.scoreB || '·'}</td></tr>`).join('');
  $('goBody').innerHTML = `<table class="tally"><tr><th></th><th>RED</th><th>YELLOW</th></tr>${rows}</table>`;
  $('goWinner').textContent = `Winner: ${TEAM_NAME[w]}${w === 'A' ? ' (P1)' : m.mode === 'cpu' ? ' (CPU)' : ' (P2)'}`;
  hud.gameover.classList.remove('hidden');
  setCameraMode('skip');
}

/* ---------------------------------------------------------- the main loop */
let last = performance.now();
function frameLoop(nowWall) {
  const dt = Math.min(0.05, (nowWall - last) / 1000);
  last = nowWall;
  G.dt = dt; G.now = nowWall / 1000; G.frame++;

  if (calloutTimer > 0) { calloutTimer -= dt; if (calloutTimer <= 0) hud.callout.classList.add('hidden'); }

  // ---------------- title screen -----------------------------------------
  if (G.phase === 'TITLE') {
    if (consume('left')) { adjustTitle(-1); renderTitle(); }
    if (consume('right')) { adjustTitle(+1); renderTitle(); }
    if (consume('up')) { titleState.i = (titleState.i + 2) % 3; renderTitle(); }
    if (consume('down')) { titleState.i = (titleState.i + 1) % 3; renderTitle(); }
    if (consume('space')) { startMatch(); }
  }

  // ---------------- setup interstitial -----------------------------------
  else if (G.phase === 'SETUP') {
    if (G.aiPlan) { G.setupTimer -= dt; if (G.setupTimer <= 0) { applyCPUPlan(); } }
    else {
      // Reading the ice from above before stepping into the hack: the camera is
      // already on the play, Enter takes you over the house.
      if (consume('enter')) G.planView = !G.planView;
      if (consume('space')) beginAim();
    }
  }

  // ---------------- CPU wind-up ------------------------------------------
  else if (G.phase === 'WINDUP') {
    setPrompt(`<div class="big">CPU throws ${G.aiPlan.name.toUpperCase()}</div>
      <div class="sub">aim ${G.shot.aimDeg.toFixed(1)}° · spin ${G.shot.spin > 0 ? '+' : ''}${G.shot.spin} · ${Math.round(G.shot.power * 100)}% weight${G.aiPlan.sweep ? ' · will brush the ice' : ''}</div>`);
    G.windupTimer -= dt;
    if (G.windupTimer <= 0) launchShot();
  }

  // ---------------- AIM: line and handle together -------------------------
  // There is no separate spin phase. A skip decides the line and the handle in
  // one motion, and the projected arc is the feedback for both, so the arrow
  // keys stay in one place: left/right for the line, up/down for the handle.
  // Space commits to the weight, which is the only second step.
  else if (G.phase === 'AIM') {
    shotPrompt();
    heldRepeat('left', () => nudgeAim(-1));
    heldRepeat('right', () => nudgeAim(+1));
    if (consume('up')) stepSpin(+1);
    if (consume('down')) stepSpin(-1);
    if (consume('enter')) G.planView = !G.planView;    // look at the house from above
    if (consume('space')) {
      G.phase = 'POWER';
      // The meter starts at the lightest selectable weight — the left edge of
      // the miniature — so it is moving the moment it appears.
      G.meter = {
        value: powerForDistance(RULES.POWER_MIN_TRAVEL),
        travel: RULES.POWER_MIN_TRAVEL, t: 0, running: true,
      };
    }
  }

  // ---------------- POWER -----------------------------------------------
  else if (G.phase === 'POWER') {
    shotPrompt();
    heldRepeat('left', () => nudgeAim(-1));
    heldRepeat('right', () => nudgeAim(+1));
    if (consume('up')) stepSpin(+1);
    if (consume('down')) stepSpin(-1);
    if (consume('enter')) G.planView = !G.planView;
    // The meter sweeps *metres of travel along the sheet* at a constant rate and
    // converts that to power — see meterTravel() in physics.js. A power needle is
    // the wrong shape for this: it stalls at light weights and sprints through
    // the house, which is exactly what players mean by "it hesitates, then too
    // fast". Distance is what the miniature shows, so distance is what moves.
    G.meter.t += dt;
    const travel = meterTravel(G.meter.t);
    G.meter.travel = travel;
    G.meter.value = powerForDistance(travel);
    G.shot.power = G.meter.value;
    // The projected path follows the meter, so weight is visible before you
    // commit. Throttled: a full forward simulation every frame is wasted work.
    if (G.frame++ % 3 === 0) setPreviewFromShot();
    if (consume('space')) { G.shot.power = G.meter.value; launchShot(); }
  }

  // ---------------- INFLIGHT --------------------------------------------
  else if (G.phase === 'INFLIGHT') {
    const extra = Math.round((PHYS.A_BASE / PHYS.A_SWEEP - 1) * 100);
    setPrompt(`<div class="big">Brush? Hold <kbd>Space</kbd> — the whole path is yours</div>
      <div class="sub">brushing carries the stone a little farther (about ${extra}% if you brush all the way)
        and flattens its curl. The line you were shown is the unbrushed one, so brushing early changes your
        line as much as your distance — that is the decision, not a meter to spend.</div>`);
    G.acc += dt;
    stepShot();
  }

  // ---------------- SETTLE ----------------------------------------------
  else if (G.phase === 'SETTLE') {
    G.settleTimer -= dt;
    if (G.settleTimer <= 0) afterSettle();
  }

  // ---------------- END SUMMARY -----------------------------------------
  else if (G.phase === 'END_SUMMARY') {
    setPrompt(G.match.over
      ? '<div class="big">Press <kbd>Space</kbd> for the final result</div>'
      : '<div class="big">Press <kbd>Space</kbd> for the next end</div>');
    // gentle pulse of the counting rings while the summary is up
    const k = 1 + Math.sin(G.now * 3) * 0.06;
    for (const r of highlightRings) r.scale.set(k, k, 1);
    if (consume('space')) {
      hud.summary.classList.add('hidden');
      clearFx();
      if (G.match.over) showGameOver();
      else { clearSheetForNewEnd(); beginSetup(); }
    }
  }

  // ---------------- GAME OVER -------------------------------------------
  else if (G.phase === 'GAME_OVER') {
    setPrompt('');
    if (consume('r')) {
      hud.gameover.classList.add('hidden');
      hud.title.classList.remove('hidden');
      G.phase = 'TITLE'; setCameraMode('title');
      G.match = null; G.stones = []; clearStoneViews(); clearFx(); clearPreview();
      telemetry(null); setPrompt('');
      renderTitle();
    }
  }

  // Handle rotation, per stone.
  //
  // This used to be one angle on G, written to every view in the scene, so a
  // thrown stone turned the handles of every other stone standing on the ice —
  // the whole rink spinning around a single delivery. A stone is spun once, at
  // delivery, and stops turning the moment it stops sliding; a struck stone is
  // not spun up either, because the physics does not carry spin through contact.
  // So each view carries its own angle: only the stone actually in flight has
  // its angle advanced, and every other stone keeps what it was left with.
  //
  // While aiming there is nothing to turn — the delivered stone's view is created
  // at the release — so the aiming angle drives the HUD dial only.
  if (['AIM', 'POWER', 'WINDUP'].includes(G.phase) && G.shot.spin) {
    G.handleAngle -= G.shot.spin * 1.6 * dt;
  } else if (G.phase === 'INFLIGHT' && G.live) {
    const v = stoneViews.get(G.live.delivered.id);
    if (v) v.handleAngle -= (G.sweeping ? 7 : 3.2) * (G.live.delivered.spin || 0) * dt;
  }
  for (const v of stoneViews.values()) if (v.handle) v.handle.rotation.y = v.handleAngle;

  updateSpray(dt);
  updateCamera(dt);
  updateHUD();
  pressed.clear();
  renderer.render(scene, camera);
  requestAnimationFrame(frameLoop);
}

function nudgeAim(sign) {
  G.shot.aimDeg = clamp(G.shot.aimDeg + sign * RULES.AIM_STEP_DEG, -RULES.AIM_MAX_DEG, RULES.AIM_MAX_DEG);
  setPreviewFromShot();
}
/**
 * Step the handle up or down through RULES.SPIN_LEVELS and re-predict.
 *
 * The order here is the whole point: the preview must be simulated from the
 * spin the player now has, not the one they had. The first version of this
 * returned the new level and let the caller assign it, which meant every
 * prediction was one keypress behind the value in the HUD.
 */
function stepSpin(dir) {
  const L = RULES.SPIN_LEVELS;
  G.shot.spin = L[clamp(L.indexOf(G.shot.spin) + dir, 0, L.length - 1)];
  setPreviewFromShot();
}
function adjustTitle(d) {
  const k = titleState.keys[titleState.i], o = G.titleOpts;
  if (k === 'mode') o.mode = o.mode === 'hotseat' ? 'cpu' : 'hotseat';
  if (k === 'difficulty') {
    const L = ['easy', 'normal', 'hard'];
    o.difficulty = L[clamp(L.indexOf(o.difficulty) + d, 0, 2)];
  }
  if (k === 'first') {
    const L = ['random', 'p1', 'p2'];
    o.first = L[clamp(L.indexOf(o.first) + d, 0, 2)];
  }
}
function applyCPUPlan() {
  // The CPU's chosen line and weight become the visible shot, so a player can
  // read what the computer decided to do before it happens.
  const p = G.aiPlan;
  G.shot = { aimDeg: p.aimDeg, spin: p.spin, power: p.power };
  setPreviewFromShot();
  G.phase = 'WINDUP';
  // The CPU's wind-up is where the player's view moves to the hack: they were left
  // looking at the play for as long as they liked, and now the delivery starts.
  setCameraMode('hack');
  G.windupTimer = 0.6;
}

/* ------------------------------------------------------------- boot assets */
async function boot() {
  renderTitle();
  setCameraMode('title');
  requestAnimationFrame(frameLoop);

  // Try the Blender-authored GLBs first; fall back to procedural stand-ins.
  const wanted = [
    ['sheet', 'assets/sheet.glb', buildProceduralSheet, 'longZ'],
    ['stone_red', 'assets/stone_red.glb', () => buildProceduralStone(TEAM_COLOR.A), 'shortY'],
    ['stone_yellow', 'assets/stone_yellow.glb', () => buildProceduralStone(TEAM_COLOR.B), 'shortY'],
    ['broom', 'assets/broom.glb', buildProceduralBroom, 'longY'],
    ['hack', 'assets/hack.glb', buildProceduralHack, 'shortY'],
    ['arena', 'assets/arena.glb', buildProceduralArena, 'longZ'],
  ];
  const built = {};
  for (const [name, url, factory, mode] of wanted) {
    let obj = null, source = 'procedural';
    try {
      const g = await loadGLB(url);
      if (g) {
        obj = g;
        // A GLB stone must expose its handle; if the authoring file forgot the
        // name we fall back rather than lose the spin indication.
        if (name.startsWith('stone_') && !findPart(obj, 'handle')) {
          console.warn(`${url} has no named "handle" part — using the procedural stone`);
          obj = null;
        }
        if (obj) { orient(obj, mode); source = 'glb'; }
      }
    } catch (e) {
      console.info(`${url} not available — using the procedural stand-in for ${name}`);
    }
    if (!obj) { obj = factory(); source = 'procedural'; }
    assets[name] = { source, obj };
    built[name] = true;
    if (name === 'sheet') placeSheet(obj);
    else if (name === 'arena') sheetGroup.add(obj);
    else if (name === 'hack') {
      const h = obj; h.position.set(0, 0, SHEET.hackZ);
      sheetGroup.add(h);
    }
  }
  updateStoneRoots();

  const used = Object.entries(assets).map(([k, v]) => `${k}:${v.source}`);
  hud.hint.textContent = 'assets: ' + used.join('  ');
  console.info('asset sources →', used.join(' '));
}

/** Rebuild any stone already in the scene once assets arrive. */
function updateStoneRoots() {
  for (const [id, v] of stoneViews) {
    const team = id.includes('-A-') ? 'A' : 'B';
    const fresh = stoneRoot(team);
    stoneGroup.remove(v.root);
    v.root = fresh; v.handle = fresh.userData.handle || findPart(fresh, 'handle');
    // The swapped-in handle inherits the angle this stone was holding: assets can
    // arrive after the stones are already on the ice, and a stone that was
    // standing still must not appear to have turned when the real model loads.
    if (v.handle) v.handle.rotation.y = v.handleAngle;
    stoneGroup.add(fresh);
  }
}

boot().catch(err => {
  console.error(err);
  hud.hint.textContent = 'startup error: ' + err.message;
});
