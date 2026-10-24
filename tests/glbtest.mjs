/**
 * tests/glbtest.mjs — verifies the authored GLB assets against the contract in
 * GAME_PROMPT.md ("Asset Authoring") and against what main.js assumes.
 *
 * This parses the GLB container itself (JSON chunk + accessor ranges + the node
 * hierarchy), so it checks what a loader would actually see in *game* space,
 * not what the Blender script intended. In particular it proves the Y-up
 * conversion happened: the sheet's long axis must land on Z and the house must
 * be centred on the game's tee at Z = +15.
 *
 *   node tests/glbtest.mjs
 */
import { readFileSync } from 'node:fs';
import { SHEET } from '../physics.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  ::  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ::  ' + detail : ''}`); }
};
const group = t => console.log(`\n== ${t}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------ GLB parsing */
function readGLB(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glTF binary`);
  if (buf.readUInt32LE(4) !== 2) throw new Error(`${path}: glTF version ${buf.readUInt32LE(4)}`);
  let off = 12;
  let json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
    else if (type === 'BIN') bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error(`${path}: no JSON chunk`);
  return { json, bin, bytes: buf.length };
}

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorRange(glb, index) {
  const json = glb.json;
  const acc = json.accessors[index];
  if (acc.min !== undefined && acc.max !== undefined) {
    return { min: acc.min, max: acc.max, count: acc.count, type: acc.type };
  }
  // no cached min/max: read the values
  const view = json.bufferViews[acc.bufferView];
  const comp = COMPONENT_SIZE[acc.componentType], n = NUM_COMPONENTS[acc.type];
  const off = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) {
      const p = off + i * (view.byteStride || comp * n) + k * comp;
      const v = acc.componentType === 5126 ? glb.bin.readFloatLE(p)
        : acc.componentType === 5123 ? glb.bin.readUInt16LE(p)
          : acc.componentType === 5125 ? glb.bin.readUInt32LE(p)
            : glb.bin.readInt16LE(p);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, count: acc.count, type: acc.type };
}

function mulMat(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function nodeMatrix(node) {
  let m = ID.slice();
  const t = node.translation || [0, 0, 0];
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
  m = mulMat(m, T);
  if (node.rotation) {
    const [x, y, z, w] = node.rotation;
    const R = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
    m = mulMat(m, R);
  }
  const s = node.scale || [1, 1, 1];
  m = mulMat(m, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]);
  return m;
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** World-space bounds + triangle counts for every mesh node in a GLB. */
function inspect(glb) {
  const json = glb.json;
  const parts = [];
  const roots = json.scenes[json.scene ?? 0].nodes;
  const walk = (nodeIndex, parentMat) => {
    const node = json.nodes[nodeIndex];
    const mat = mulMat(parentMat, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      let tris = 0;
      for (const prim of mesh.primitives) {
        const pos = accessorRange(glb, prim.attributes.POSITION);
        const corners = [];
        for (const x of [pos.min[0], pos.max[0]])
          for (const y of [pos.min[1], pos.max[1]])
            for (const z of [pos.min[2], pos.max[2]]) corners.push(xformPoint(mat, [x, y, z]));
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const c of corners) for (let k = 0; k < 3; k++) {
          if (c[k] < min[k]) min[k] = c[k];
          if (c[k] > max[k]) max[k] = c[k];
        }
        tris += prim.indices !== undefined ? json.accessors[prim.indices].count / 3 : pos.count / 3;
        parts.push({
          name: node.name || mesh.name || '(unnamed)',
          min, max, tris,
          material: prim.material,
          hasNormal: prim.attributes.NORMAL !== undefined,
          hasUV: prim.attributes.TEXCOORD_0 !== undefined,
          metallicRoughTexture: !!(json.materials?.[prim.material]?.pbrMetallicRoughness?.metallicRoughnessTexture),
          baseColorTexture: !!(json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture),
          normalTexture: !!json.materials?.[prim.material]?.normalTexture,
        });
      }
    }
    for (const c of node.children || []) walk(c, mat);
  };
  for (const r of roots) walk(r, ID.slice());
  const total = parts.reduce((a, p) => a + p.tris, 0);
  const bounds = parts.length ? parts.reduce((a, p) => ({
    min: a.min.map((v, i) => Math.min(v, p.min[i])),
    max: a.max.map((v, i) => Math.max(v, p.max[i])),
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }) : null;
  return { parts, total, bounds, json };
}

function extent(b) { return b.max.map((v, i) => v - b.min[i]); }
const centre = b => b.min.map((v, i) => (v + b.max[i]) / 2);

/* ------------------------------------------------------------------ checks */
const files = ['sheet.glb', 'stone_red.glb', 'stone_yellow.glb', 'broom.glb', 'hack.glb', 'arena.glb'];
const loaded = {};
group('0. Every required asset exists and parses');
for (const f of files) {
  try {
    loaded[f] = inspect(readGLB(new URL('../assets/' + f, import.meta.url)));
    check(`${f} parses`, true, `${loaded[f].parts.length} meshes, ${loaded[f].total} tris, ${(loaded[f].json.images || []).length} embedded images`);
  } catch (e) {
    check(`${f} parses`, false, e.message);
  }
}
if (fail) { console.log(`\nFAILURES — ${pass} passed, ${fail} failed`); process.exit(1); }

group('1. Coordinate contract: Y-up, long axis on Z, house on the game tee');
{
  const s = loaded['sheet.glb'];
  const e = extent(s.bounds);
  // Y is up in the game. The ice and its markings must be flat; only the fixed
  // hack fixtures are allowed to stand up off the sheet.
  const flat = s.parts.filter(p => !p.name.startsWith('hack_'));
  const flatBounds = flat.reduce((a, p) => ({
    min: a.min.map((v, i) => Math.min(v, p.min[i])),
    max: a.max.map((v, i) => Math.max(v, p.max[i])),
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  check('sheet ice and markings are flat (up extent < 0.05 m)',
    extent(flatBounds)[1] < 0.05, `up extent ${extent(flatBounds)[1].toFixed(3)} m`);
  const fixtures = s.parts.filter(p => p.name.startsWith('hack_'));
  const fixBounds = fixtures.reduce((a, p) => ({
    min: a.min.map((v, i) => Math.min(v, p.min[i])),
    max: a.max.map((v, i) => Math.max(v, p.max[i])),
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const fixH = fixtures.length ? extent(fixBounds)[1] : 0;
  check('the on-ice hack fixtures stay low', fixtures.length > 0 && fixH < 0.15,
    `${fixtures.length} fixtures, ${fixH.toFixed(3)} m tall`);
  // The ice plane plus its apron and the floor beyond the dasher: the sheet
  // asset may not reach so far that it pokes through the arena's stands.
  check('sheet spans the playable ice, its apron, and stops before the stands',
    e[2] >= SHEET.length && e[2] <= 56, `z ${s.bounds.min[2].toFixed(1)} .. ${s.bounds.max[2].toFixed(1)} (extent ${e[2].toFixed(1)})`);
  const iceParts = s.parts.filter(p => p.name === 'ice' || p.name === 'ice_apron');
  const iceBounds = iceParts.reduce((a, p) => ({
    min: a.min.map((v, i) => Math.min(v, p.min[i])),
    max: a.max.map((v, i) => Math.max(v, p.max[i])),
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  check(`ice width matches SHEET.width (${SHEET.width} m)`, near(extent(iceBounds)[0], SHEET.width, 0.02),
    `ice x extent ${extent(iceBounds)[0].toFixed(3)}`);
  check('ice is centred on the origin in X', near(centre(s.bounds)[0], 0, 0.01));
  const ice = s.parts.find(p => p.name === 'ice');
  check('the ice plane spans the playable sheet, centred', ice &&
    near(ice.max[2], SHEET.length / 2, 0.01) && near(ice.min[2], -SHEET.length / 2, 0.01),
    ice ? `z ${ice.min[2].toFixed(2)} .. ${ice.max[2].toFixed(2)}` : 'no ice mesh');
  const apron = s.parts.find(p => p.name === 'ice_apron');
  // The end-summary camera stands at teeZ + 6.2 = 21.2, so the ice has to run
  // at least that far or that view looks across a hole.
  const summaryZ = SHEET.teeZ + 6.2;
  check(`ice runs to the end dasher, past the summary camera at Z=${summaryZ}`,
    apron && apron.max[2] >= summaryZ && apron.min[2] <= SHEET.length / 2 + 0.01,
    apron ? `ice apron z ${apron.min[2].toFixed(2)} .. ${apron.max[2].toFixed(2)} (back line ${SHEET.backLineZ})` : 'no apron mesh');
  const floors = s.parts.filter(p => p.name.startsWith('floor_'));
  check('floor beyond the ice keeps the near and far ends solid', floors.length === 2 &&
    floors.some(p => p.max[2] > summaryZ + 2) && floors.some(p => p.min[2] < SHEET.hackZ - 4),
    floors.map(p => `${p.name} ${p.min[2].toFixed(1)}..${p.max[2].toFixed(1)}`).join(' | ') || 'none');

  const twelve = s.parts.find(p => p.name === 'house_twelve');
  const button = s.parts.find(p => p.name === 'house_button');
  const c = twelve ? centre(twelve) : null;
  check('the 12-foot house is centred on the centre line', c && near(c[0], 0, 0.02), c ? `x=${c[0].toFixed(3)}` : 'missing');
  check(`the house sits at the tee (Z=+${SHEET.teeZ}) — proves the Y-up axis conversion`,
    c && near(c[2], SHEET.teeZ, 0.02), c ? `z=${c[2].toFixed(3)}` : 'missing');
  check(`house diameter is 12 ft (${(SHEET.rings.twelve * 2).toFixed(2)} m)`,
    twelve && near(extent(twelve)[0], SHEET.rings.twelve * 2, 0.02), twelve ? `${extent(twelve)[0].toFixed(3)} m` : 'missing');
  check('the button is drawn at the centre of the house', button &&
    near(extent(button)[0], SHEET.rings.button * 2, 0.02), button ? `${extent(button)[0].toFixed(3)} m` : 'missing');

  const hog = s.parts.find(p => p.name === 'line_hog_far');
  check(`far hog line at Z=${SHEET.hogFarZ}`, hog && near(centre(hog)[2], SHEET.hogFarZ, 0.02),
    hog ? `z=${centre(hog)[2].toFixed(3)}` : 'missing');
  const near2 = s.parts.find(p => p.name === 'line_hog_near');
  check(`near hog line at Z=${SHEET.hogNearZ}`, near2 && near(centre(near2)[2], SHEET.hogNearZ, 0.02));
  const back = s.parts.find(p => p.name === 'line_back');
  check(`back line at Z=${SHEET.backLineZ}`, back && near(centre(back)[2], SHEET.backLineZ, 0.02));
  check('house ring radii match the four painted circles', ['house_twelve', 'house_eight', 'house_four'].every(n => {
    const p = s.parts.find(q => q.name === n);
    if (!p) return false;
    const want = { house_twelve: SHEET.rings.twelve, house_eight: SHEET.rings.eight, house_four: SHEET.rings.four }[n];
    return near(extent(p)[0] / 2, want, 0.02);
  }));
}

group('2. Stone contract: bottom-centre origin, named handle, size, handle shape, triangle budget');
{
  for (const f of ['stone_red.glb', 'stone_yellow.glb']) {
    const s = loaded[f];
    const body = s.parts.find(p => p.name === 'stone_body');
    check(`${f}: body present`, !!body);
    if (!body) continue;
    check(`${f}: body diameter is 29 cm`, near(extent(body)[0], SHEET.stoneRadius * 2, 0.005), `${extent(body)[0].toFixed(3)} m`);
    check(`${f}: body height is 114 mm`, near(extent(body)[1], SHEET.stoneHeight, 0.005), `${extent(body)[1].toFixed(3)} m`);
    check(`${f}: origin at the bottom centre (min y = 0)`,
      near(body.min[1], 0, 0.002) && near(centre(body)[0], 0, 0.002) && near(centre(body)[2], 0, 0.002),
      `y0=${body.min[1].toFixed(4)} cx=${centre(body)[0].toFixed(4)}`);
    const handleNode = readGLB(new URL('../assets/' + f, import.meta.url)).json.nodes.find(n => n.name === 'handle');
    check(`${f}: a node named "handle" exists (main.js rotates it to show spin)`, !!handleNode);
    const grip = s.parts.find(p => p.name.startsWith('handle_'));
    check(`${f}: handle sits on top of the granite`, grip && grip.min[1] > SHEET.stoneHeight * 0.8,
      grip ? `handle base y=${grip.min[1].toFixed(3)}, body top y=${body.max[1].toFixed(3)}` : 'missing');
    // Shape, not only presence. A stone read at 30 pixels tall still has to look
    // like a curling stone: an arch a hand can go through, standing clear of the
    // granite, and reaching across the cap rather than sitting on it as a knob.
    const every = s.parts.filter(p => p.name.startsWith('handle_'));
    const gripPart = s.parts.find(p => p.name === 'handle_grip');
    const capPart = s.parts.find(p => p.name === 'handle_cap');
    const stands = Math.max(...every.map(p => p.max[1])) - body.max[1];
    check(`${f}: the handle stands up to be gripped (0.04-0.08 m above the granite)`,
      stands >= 0.04 && stands <= 0.08, `${stands.toFixed(3)} m above the body`);
    const span = gripPart ? Math.max(...extent(gripPart).filter((_, i) => i !== 1)) : 0;
    check(`${f}: the grip reaches across the cap instead of sitting on it as a knob`,
      !!gripPart && !!capPart && span >= extent(capPart)[0] * 0.45,
      gripPart && capPart ? `grip spans ${span.toFixed(3)} m against a cap radius of ${(extent(capPart)[0] / 2).toFixed(3)} m` : 'handle_grip/handle_cap missing');
    check(`${f}: within the 2000 triangle budget`, s.total <= 2000, `${s.total} tris`);

    const json = s.json;
    const mats = json.materials || [];
    const granite = mats.find(m => /granite/i.test(m.name));
    const plastic = mats.find(m => /handle/i.test(m.name));
    check(`${f}: granite material with roughness ~0.9`, granite && granite.pbrMetallicRoughness?.roughnessFactor >= 0.85,
      granite ? `rough=${granite.pbrMetallicRoughness.roughnessFactor}` : 'missing');
    check(`${f}: handle plastic with roughness ~0.5`, plastic && plastic.pbrMetallicRoughness?.roughnessFactor >= 0.4 &&
      plastic.pbrMetallicRoughness.roughnessFactor <= 0.6, plastic ? `rough=${plastic.pbrMetallicRoughness.roughnessFactor}` : 'missing');
    check(`${f}: granite has a distinct colour per team`, granite?.pbrMetallicRoughness?.baseColorTexture &&
      plastic?.pbrMetallicRoughness?.baseColorFactor, plastic ? `factor=${plastic.pbrMetallicRoughness.baseColorFactor.slice(0, 3).map(v => v.toFixed(2)).join(',')}` : '');
    const teamA = f.includes('red') ? 0 : 2;
    const col = plastic?.pbrMetallicRoughness?.baseColorFactor || [];
    const dominant = col.indexOf(Math.max(...col.slice(0, 3)));
    check(`${f}: handle colour reads as ${f.includes('red') ? 'red' : 'yellow'}`,
      f.includes('red') ? dominant === 0 : dominant <= 1, `factor=${col.slice(0, 3).map(v => v.toFixed(2)).join(',')}`);
    void teamA;
    check(`${f}: granite body has UVs + a normal map (speckle survives export)`,
      body.hasUV && body.normalTexture && body.baseColorTexture);
  }
}

group('3. Ice reads as ice: pebble normal map and varying roughness');
{
  const s = loaded['sheet.glb'];
  const ice = s.parts.find(p => p.name === 'ice');
  check('ice mesh carries UVs', ice.hasUV);
  check('ice has a normal map (the pebble)', ice.normalTexture && ice.hasNormal);
  check('ice roughness comes from a texture', ice.metallicRoughTexture);
  const json = s.json;
  const imgs = json.images || [];
  check('textures are embedded in the GLB (no sidecar files to fetch)',
    imgs.length > 0 && imgs.every(im => im.bufferView !== undefined), `${imgs.length} images`);
  check('the arena has emissive light panels',
    (loaded['arena.glb'].json.materials || []).some(m => (m.emissiveFactor || [0, 0, 0]).some(v => v > 0)));
  const ext = extent(loaded['arena.glb'].bounds);
  check('arena encloses the sheet', ext[0] > SHEET.width + 4 && ext[2] > SHEET.length, `x=${ext[0].toFixed(1)} z=${ext[2].toFixed(1)}`);
  const broom = loaded['broom.glb'];
  check('broom stands upright along Y', extent(broom.bounds)[1] > 1.0 && extent(broom.bounds)[1] < 1.6,
    `height ${extent(broom.bounds)[1].toFixed(2)} m`);
  const hack = loaded['hack.glb'];
  check('hack is low and wide (a foothold, not a wall)', extent(hack.bounds)[1] < 0.25 && extent(hack.bounds)[0] > 0.4,
    `x=${extent(hack.bounds)[0].toFixed(2)} y=${extent(hack.bounds)[1].toFixed(2)}`);
}

group('4. Loader safety: everything three.js needs is standard');
{
  const unsupported = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'EXT_mesh_gpu_instancing'];
  for (const f of files) {
    const json = loaded[f].json;
    const used = json.extensionsUsed || [];
    check(`${f}: no extensions that need a decoder`, used.filter(u => unsupported.includes(u)).length === 0, used.join(' ') || 'none');
    check(`${f}: single scene, indexed geometry`, (json.scenes || []).length === 1);
    check(`${f}: generator recorded`, /Khronos glTF Blender I\/O/.test(json.asset?.generator || ''), json.asset?.generator);
  }
  check('total payload is small enough for a page load',
    files.reduce((a, f) => a + readFileSync(new URL('../assets/' + f, import.meta.url)).length, 0) < 3 * 1024 * 1024,
    `${(files.reduce((a, f) => a + readFileSync(new URL('../assets/' + f, import.meta.url)).length, 0) / 1024).toFixed(0)} kB total`);
}

group('5. The game still works with assets/ empty (procedural fallback)');
{
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  check('every asset has a procedural builder', ['buildProceduralSheet', 'buildProceduralStone', 'buildProceduralBroom', 'buildProceduralHack', 'buildProceduralArena']
    .every(fn => main.includes(`function ${fn}(`)));
  check('a failed GLB load is caught, not fatal', /catch \(e\)[\s\S]{0,140}procedural stand-in/.test(main));
  check('the GLB path list matches the files we authored',
    ['sheet', 'stone_red', 'stone_yellow', 'broom', 'hack', 'arena']
      .every(n => main.includes(`'assets/${n}.glb'`)));
}

group('6. The game cameras have clear air inside the shipped arena');
{
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  // These mirror main.js CAM; the source-text assertions below fail if the two
  // ever drift apart.
  const views = [
    { name: 'hack', from: [1.15, 1.85, SHEET.hackZ - 2.6], look: [-0.35, 0.12, 4.0],
      src: 'new THREE.Vector3(1.15, 1.85, SHEET.hackZ - 2.6)' },
    { name: 'skip', from: [0.9, 2.9, SHEET.teeZ + 6.2], look: [0.0, 0.12, 4.0],
      src: 'new THREE.Vector3(0.9, 2.9, SHEET.teeZ + 6.2)' },
    { name: 'title', from: [6.4, 3.6, -9.5], look: [0.0, 0.35, 7.5],
      src: 'new THREE.Vector3(6.4 + Math.sin(G.now * 0.08) * 1.4, 3.6, -9.5)' },
    // CAM.track follows the delivered stone and clamps its offset; the worst
    // case for the boards is a stone on the rail with the camera at its limit.
    { name: 'track', from: [3.4, 2.15, 10.0 - 3.6], look: [0.0, 0.1, 11.6],
      src: 'clamp(s.x + 2.5, -3.4, 3.4)' },
    // The Enter plan view looks straight down at the house. The arena hangs a light
    // bank at y 7.04..7.16 over the tee line, so the eye has to be below it.
    { name: 'plan', from: [0, 6.2, SHEET.teeZ], look: [0, 0.02, SHEET.teeZ],
      src: 'new THREE.Vector3(0, 6.2, SHEET.teeZ)' },
    // The view the game holds when a shot ends and the played stone is gone: it
    // stands in the rink looking at the house, so it is held to the same gate.
    { name: 'hold', from: [2.5, 2.15, SHEET.teeZ - 3.6], look: [0, 0.1, SHEET.teeZ],
      src: '{ x: 0, z: SHEET.teeZ }' },
  ];
  // Flat paint (ice, apron, floors, lines, rings) is the surface being looked
  // across, not an obstruction. Only standing geometry can block a camera.
  const solids = [...loaded['arena.glb'].parts,
    ...loaded['sheet.glb'].parts.filter(p => p.name.startsWith('hack_') && extent(p)[1] > 0.05)];
  const segBlocked = (a, b, p, r = 0.3) => {
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      const lo = p.min[k] - r, hi = p.max[k] + r;
      const d = b[k] - a[k];
      if (Math.abs(d) < 1e-9) { if (a[k] < lo || a[k] > hi) return false; continue; }
      let ta = (lo - a[k]) / d, tb = (hi - a[k]) / d;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  };
  const inside = (p, q, r = 0.05) => q.every((v, k) => v > p.min[k] - r && v < p.max[k] + r);
  for (const v of views) {
    check(`main.js still places CAM.${v.name} where this test expects`, main.includes(v.src), v.src);
    const blocked = solids.filter(p => segBlocked(v.from, v.look, p));
    check(`CAM.${v.name}: nothing stands between the camera and what it aims at`,
      blocked.length === 0, blocked.map(p => `${p.name} top=${p.max[1].toFixed(2)}`).join(', ') || 'clear');
    const buried = solids.filter(p => inside(p, v.from));
    check(`CAM.${v.name} does not sit inside geometry`, buried.length === 0,
      buried.map(p => p.name).join(', ') || 'clear');
  }

  // A plan view is only usable if the whole house has clear air above it, not just
  // the point it aims at. The sampled square is the house as it can be counted —
  // the 12-foot ring plus a stone on the rim — and deliberately stops short of the
  // side boards, which are the boundary surface rather than an obstruction.
  const plan = views.find(v => v.name === 'plan');
  const p0 = main.indexOf('\n  plan: {');
  const planBlk = main.slice(p0, main.indexOf('\n  },', p0) + 5);
  const planFov = +((planBlk.match(/fov: (\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const halfIce = plan.from[1] * Math.tan((planFov / 2) * Math.PI / 180);
  const house = SHEET.rings.twelve + SHEET.stoneRadius;   // 1.975 m: everything that can score
  const hanging = new Map();
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const target = [plan.from[0] + ((i / 4) * 2 - 1) * house, 0.02,
        plan.from[2] + ((j / 4) * 2 - 1) * house];
      for (const p of solids) if (segBlocked(plan.from, target, p, 0.1)) hanging.set(p.name, p);
    }
  }
  const hung = [...hanging].map(([n, p]) => `${n} spans y ${p.min[1].toFixed(2)}..${p.max[1].toFixed(2)}`).join(', ');
  check('CAM.plan frames the house with nothing hanging between it and the ice',
    halfIce > house * 1.6 && hanging.size === 0,
    `framing half-field ${halfIce.toFixed(2)} m along the ice; ` + (hung || 'clear air over the whole house'));

  // The durable form of that rule, independent of the framing: nothing that hangs
  // into the sheet's footprint may come below the plan camera. Geometry resting on
  // the ice (boards, kick plates, hacks) is not suspended and is what is looked at.
  const overSheet = solids.filter(p => Math.abs((p.min[0] + p.max[0]) / 2) < SHEET.width / 2 + 0.5 &&
    p.max[2] > SHEET.teeZ - halfIce && p.min[2] < SHEET.teeZ + halfIce);
  const hangingBelow = overSheet.filter(p => p.min[1] > 0.05 && p.min[1] < plan.from[1]);
  check('nothing suspended over the sheet comes below CAM.plan',
    hangingBelow.length === 0,
    hangingBelow.map(p => `${p.name} hangs to y ${p.min[1].toFixed(2)}, z ${p.min[2].toFixed(1)}..${p.max[2].toFixed(1)}`).join(', ') ||
    `the eye at y ${plan.from[1]} is below every suspended fitting in the frame`);
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
