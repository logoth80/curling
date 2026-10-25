/**
 * tests/uitest.mjs — static checks on the browser layer.
 *
 * There is no browser in this environment, so these checks guard the failure
 * modes that would otherwise only show up as a blank screen at runtime:
 *   · main.js referencing a DOM id that index.html does not define
 *   · the keyboard contract drifting beyond Space + the four arrows (+R on the
 *     game-over screen), which GAME_PROMPT.md forbids
 *   · the asset paths drifting away from the files the game expects
 *   · the release roll moving out of the throw and into the aiming, which would
 *     make the preview disagree with itself (group 2c)
 *
 *   node tests/uitest.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RULES, SHEET, CAL, makeStone, simulateDelivery, powerForDistance, meterTravel } from '../physics.js';
import {
  TRACK, buildStaticSvg, buildDynamicSvg, weightReadout,
  trackX, trackY, trackD, D_HOG, D_TEE, D_BACK,
} from '../track.js';
import { solveAim } from '../ai.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  ::  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ::  ' + detail : ''}`); }
};
const group = t => console.log(`\n== ${t}`);

/**
 * One top-level function's source, braces balanced enough for this file's style.
 * Proximity windows like "inside the next 1500 characters" go stale the moment a
 * function gains a comment, and they say less than this does: the statement is in
 * this function, wherever in it.
 */
const bodyOf = (name) => (js.match(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`)) || [''])[0];

group('1. Every DOM id main.js touches exists in index.html');
{
  const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set();
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) used.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) used.add(m[1]);
  const missing = [...used].filter(id => !defined.has(id));
  check(`all ${used.size} ids referenced by main.js are defined`, missing.length === 0, missing.join(', '));

  // querySelectorAll targets must exist as selectors in the markup.
  const selectors = [...js.matchAll(/querySelectorAll\('([^']+)'\)/g)].map(m => m[1]);
  const classRefs = selectors.flatMap(s => [...s.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]));
  const missingCls = classRefs.filter(c => !html.includes(`class="${c}"`) && !html.includes(`class="${c} `) && !new RegExp(`class="[^"]*\\b${c}\\b`).test(html));
  check(`querySelectorAll class selectors resolve: ${classRefs.join(', ') || 'none'}`, missingCls.length === 0, missingCls.join(', '));
}

group('2. Keyboard contract: Space + arrows, plus Enter as a view only (R on game over)');
{
  const keymap = js.match(/const KEYMAP = \{([^}]*)\}/);
  check('a single KEYMAP table defines the input surface', !!keymap);
  const entries = keymap ? keymap[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const allowed = /^(Arrow(Left|Right|Up|Down)|' '|Space|Enter):/;
  const bad = entries.filter(e => !allowed.test(e));
  check('the map contains only the four arrows, Space and Enter', bad.length === 0, entries.join(' | '));

  const otherKeys = [...js.matchAll(/e\.key\s*===\s*'([^']+)'/g)].map(m => m[1]).filter(k => !['r', 'R'].includes(k));
  check('no other key is read anywhere in the game', otherKeys.length === 0, otherKeys.join(', '));

  // Enter is the one key the brief's control list does not have, and it is allowed
  // here only because it cannot touch a shot: every read of it toggles a camera.
  const enterReads = [...js.matchAll(/consume\('enter'\)\)\s*([^\n]*)/g)].map(m => m[1].trim());
  check('every Enter press only opens or closes the plan view',
    enterReads.length >= 3 && enterReads.every(t => /^G\.planView = !G\.planView;/.test(t)),
    `${enterReads.length} reads: ${enterReads.join(' | ') || 'none'}`);
  check('the plan view is closed when a delivery starts, so the shot is watched from the ice',
    /G\.planView = false;[\s\S]{0,300}?setCameraMode\('track'\)/.test(bodyOf('launchShot')));

  // The brief's state machine has a separate SPIN phase. The game folds line and
  // handle into one on purpose: a skip chooses them together, and the projected
  // arc is the feedback for both, so the arrow keys stay in one place.
  const phases = ['TITLE', 'SETUP', 'AIM', 'POWER', 'INFLIGHT', 'SETTLE', 'END_SUMMARY', 'GAME_OVER'];
  const present = phases.filter(p => js.includes(`'${p}'`));
  check('the control state machine is implemented', present.length === phases.length,
    `found ${present.length}/${phases.length}: ${present.join(' ')}`);
  check('no separate spin phase survives', !/'SPIN'/.test(js),
    'line + handle are one phase; Space is the only second step');
  check('Space is pressed twice in a shot: start the sweep, then let go',
    /consume\('space'\)\)\s*\{\s*G\.phase = 'POWER'/.test(js) && /consume\('space'\)\)\s*\{\s*G\.shot\.power = G\.meter\.value; launchShot\(\)/.test(js));
  check('R restarts only from GAME_OVER', /else if \(G\.phase === 'GAME_OVER'\)[\s\S]{0,200}consume\('r'\)/.test(js));
}

group('2b. The view stays with the play until someone asks for the hack');
{
  // Sliced out rather than pattern-guessed: the point is that these two functions
  // contain no camera move at all.
  const bodyOf = name => {
    const i = js.indexOf(`function ${name}(`);
    if (i < 0) return null;
    const j = js.indexOf('\nfunction ', i + 1);
    return js.slice(i, j < 0 ? js.length : j);
  };
  for (const name of ['settleShot', 'beginSetup']) {
    const body = bodyOf(name);
    check(`${name} does not move the camera`, body !== null && !/setCameraMode/.test(body),
      body === null ? 'function not found' : (body.match(/setCameraMode\('\w+'\)/g) || []).join(' '));
  }

  /* "Does not cut" is a claim about numbers, so the framing is evaluated rather than
   * described: CAM.track's pos/look bodies and settleShot's handover line are the
   * shipped code, run here with the game's own helpers and a Vector3 that is just an
   * array. What is being compared is where the camera stands a moment before the
   * stones stop and a moment after.
   */
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerpN = (a, b, t) => a + (b - a) * t;
  const fmt = v => (v ? v.map(n => n.toFixed(2)).join(', ') : 'null');
  const sameVec = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const tfSrc = (js.match(/function trackFocus\(\)[\s\S]*?\n\}/) || [''])[0];
  // Anchored on the pos builder, because `track:` also names the HUD widget.
  const trackStart = js.search(/\n {2}track: \{\n {4}pos: \(\) => \{/);
  const trackBlk = trackStart < 0 ? '' : js.slice(trackStart, js.indexOf('\n  },', trackStart) + 5);
  const runTrack = (kind, state) => {
    const body = (trackBlk.match(new RegExp(`${kind}: \\(\\) => \\{([\\s\\S]*?)\\n    \\},`)) || [])[1];
    if (!body || !tfSrc) return null;
    try {
      return Function('SHEET', 'G', 'clamp', 'lerp', 'THREE', `${tfSrc}\nreturn () => {${body}};`)(
        SHEET, state, clampN, lerpN,
        { Vector3: function (x, y, z) { return [x, y, z]; } })();   // new THREE.Vector3 -> a plain array
    } catch { return null; }
  };
  const holdLine = (js.match(/G\.camHold = delivered\.removed[\s\S]{0,200}?;/) || [''])[0];
  const holdFor = delivered => {
    if (!holdLine) return null;
    try { return Function('SHEET', 'delivered', `let G = {}; ${holdLine} return G.camHold;`)(SHEET, delivered); } catch { return null; }
  };

  const resting = { id: 'r', x: 0.42, z: 15.28, removed: false };
  const inFlight = runTrack('pos', { live: { delivered: resting } });
  const inFlightLook = runTrack('look', { live: { delivered: resting } });
  const held = runTrack('pos', { live: null, camHold: holdFor(resting) });
  const heldLook = runTrack('look', { live: null, camHold: holdFor(resting) });
  check('the view does not move when a stone comes to rest in play',
    sameVec(inFlight, held) && sameVec(inFlightLook, heldLook),
    `in flight ${fmt(inFlight)}/${fmt(inFlightLook)} -> held ${fmt(held)}/${fmt(heldLook)}`);
  check('and it holds on that stone, not on some fixed distance from the tee',
    !!heldLook && Math.abs(heldLook[0] - resting.x * 0.6) < 1e-9 &&
    Math.abs(heldLook[2] - lerpN(resting.z, SHEET.teeZ, 0.32)) < 1e-9,
    `looking at ${fmt(heldLook)} for a stone at (${resting.x}, ${resting.z})`);

  const gone = { id: 'g', x: 3.10, z: 20.4, removed: true, outReason: 'out of bounds' };
  const goneHold = holdFor(gone);
  const gonePos = runTrack('pos', { live: null, camHold: goneHold });
  const goneLook = runTrack('look', { live: null, camHold: goneHold });
  check('a stone that left the sheet leaves the view on the house, not on what used to be there',
    !!goneHold && goneHold.x === 0 && goneHold.z === SHEET.teeZ &&
    !!goneLook && goneLook[0] === 0 && Math.abs(goneLook[2] - SHEET.teeZ) < 1e-9,
    `hold ${JSON.stringify(goneHold)} -> camera ${fmt(gonePos)} at ${fmt(goneLook)}`);
  check('the held view stands on the sheet, short of the house, at player height',
    !!gonePos && Math.abs(gonePos[0]) < SHEET.width / 2 + 1.5 && gonePos[1] > 1.0 && gonePos[1] < 3.5 &&
    gonePos[2] < SHEET.teeZ && gonePos[2] > SHEET.teeZ - 8,
    fmt(gonePos));
  check('the tracking view has no default framing to fall back to',
    trackBlk !== '' && !/if \(!s\) return/.test(trackBlk) && /const s = trackFocus\(\);/.test(trackBlk),
    'a pose of the middle of the rink is a cut wearing a different name');
  for (const name of ['beginSetup', 'afterSettle']) {
    const body = bodyOf(name);
    check(`${name} does not clear the held view`, body !== null && !/G\.camHold/.test(body),
      (body || '').match(/G\.camHold[^\n]*/g)?.join(' ') || 'function not found');
  }

  // ...and the camera does move exactly when the player steps up to the hack, or when
  // the CPU's delivery is about to start.
  check('the view moves to the hack when the player presses Space into the hack',
    /function beginAim\(\)[\s\S]{0,300}?setCameraMode\('hack'\)/.test(js));
  check('and to the hack when the CPU winds up, not while it is still being thought about',
    /function applyCPUPlan\(\)[\s\S]{0,600}?setCameraMode\('hack'\)/.test(js) &&
    /G\.phase = 'WINDUP';[\s\S]{0,200}?setCameraMode\('hack'\)/.test(js));
  check('the flight still hands the camera to the tracking view',
    /setCameraMode\('track'\)/.test(bodyOf('launchShot')));
  check('the end summary is allowed its scoring diagram view',
    /setCameraMode\('skip'\)/.test(js));
}

group('2c. The release belongs to the throw, not to the aim');
{
  // The release roll is the one place where a player's delivery stops being a copy
  // of the preview. That is a contract about *where* it happens, and the failure
  // mode is invisible in Node — a roll made while aiming would make the preview
  // shuffle under the player's eye, and a roll made twice would stack two errors on
  // a CPU shot that already carries the noise of its difficulty ladder.
  const releaseSrc = readFileSync(new URL('../release.js', import.meta.url), 'utf8');
  const launch = bodyOf('launchShot'), preview = bodyOf('setPreviewFromShot');
  const settle = bodyOf('settleShot'), setup = bodyOf('beginSetup');
  const aiming = [bodyOf('beginAim'), bodyOf('nudgeAim'), bodyOf('stepSpin')].join('\n');
  const rolls = (js.match(/rollRelease\(/g) || []).length;
  const widgetCalls = (js.match(/updateTrackPrediction\(/g) || []).length - 1;   // minus its definition

  check('the release is rolled in exactly one place in the whole game', rolls === 1, `${rolls} call sites`);
  check('and that place is the release itself, inside launchShot',
    /rollRelease\(/.test(launch) && /G\.release = /.test(launch),
    (launch.match(/G\.release = [^\n]*/) || ['no roll statement in launchShot'])[0].trim());
  check('never while aiming or stepping the handle, so the preview cannot change under the player\'s eye',
    !/rollRelease|applyRelease|G\.release/.test(aiming), aiming.match(/.{0,30}(rollRelease|applyRelease|G\.release).{0,30}/)?.[0] || 'clean');
  check('the preview keeps drawing the line that was asked for, at the preview weight',
    /\{ \.\.\.G\.shot, power: G\.previewPower\(\) \}/.test(preview) && !/rollRelease|applyRelease|G\.release/.test(preview));
  check('the intent survives the throw: launchShot reads G.shot but never writes it',
    !/G\.shot(\.[A-Za-z]+)?\s*=[^=]/.test(launch) && /applyRelease\(G\.shot, G\.release\)/.test(launch),
    launch.match(/G\.shot[^\n]{0,40}/g)?.slice(0, 4).join(' | '));
  check('a CPU delivery is not rolled a second time on top of its own difficulty ladder',
    /isCPU\(t\) \? null :/.test(launch));
  check('a release the player could not see says so alongside the result, and a clean one stays silent',
    /tier !== 'good'/.test(settle) && /G\.release\.label/.test(settle));
  check('the shot log reports the line and the handle, in centimetres and handle levels',
    /rows\.push\(\['release', describeRelease\(G\.release\)\]\)/.test(settle));
  check('a roll belongs to one delivery: it is cleared when the next shot is set up',
    /G\.release = null/.test(setup) && /G\.shot = \{/.test(setup));
  check('the miniature is still fed only by the preview, never by a thrown stone',
    widgetCalls === 1 && /function setPreviewFromShot[\s\S]*?updateTrackPrediction\(sim\);/.test(js),
    `${widgetCalls} call sites`);
  check('release.js stays pure — no THREE, no DOM, and it imports only the rules module',
    !/from ['"]three|three@|\bdocument\.|\bwindow\.|requestAnimationFrame|Date\.now|performance\.now/.test(releaseSrc) &&
    /^import \{[^}]*\} from '\.\/physics\.js';$/m.test(releaseSrc),
    (releaseSrc.match(/^import .*?;/ms) || ['no import statement'])[0].replace(/\s+/g, ' '));
  check('and it asks the rules module how far a weight runs rather than restating the stopping law',
    /distanceForPower/.test(releaseSrc) && !/V_MAX|A_BASE|Math\.sqrt|2 \* a/.test(releaseSrc));
}

group('2d. The sweeper works the line side-on, not face-first');
{
  // The figure is a stand-in drawn with primitives in the game layer (there is no
  // sweeper asset, and the asset list above pins that), which means its shape is
  // code and can be pinned like any other contract. The reported bug was that it
  // read as a person running face-first down the line. What makes a sweeper read
  // as a sweeper is written here: the body turned a quarter turn off the travel,
  // feet apart along the path with the toes across it, hands on the broom that
  // works the stone's own line, eyes on the stone.
  const rig = bodyOf('buildSweeperRig'), pose = bodyOf('poseSweeper'), upd = bodyOf('updateSweeper');
  const reach = +(js.match(/const SWEEP_REACH = ([\d.]+);/) || [])[1];
  const standOff = +(upd.match(/addScaledVector\(right, ([\d.]+)\)/) || [])[1];
  const gripHeights = js.match(/const BROOM_GRIP = \{ upper: ([\d.]+), lower: ([\d.]+) \}/);
  const upper = gripHeights && +gripHeights[1], lower = gripHeights && +gripHeights[2];
  const gaze = (js.match(/const SWEEP_GAZE = new THREE\.Vector3\(([-\d., ]+)\)/) || [])[1];
  const gazeVec = gaze ? gaze.split(',').map(s => +s.trim()) : [];

  check('the body is turned a quarter turn off the direction of travel, and only ever there',
    /sweeper\.rotation\.y = Math\.atan2\(dir\.x, dir\.z\) \+ Math\.PI \/ 2;/.test(upd) &&
    (js.match(/sweeper\.rotation\.y =/g) || []).length === 1,
    `${(js.match(/sweeper\.rotation\.y =/g) || []).length} places set the figure's turn`);
  check('feet apart along the path — that is the stance, not a stride across it',
    /J\.footL\.set\(-0\.30 \+ slide/.test(pose) && /J\.footR\.set\(0\.30 \+ slide/.test(pose));
  check('feet apart along the path and feet that move along it: a side-step cycle, not a frozen pose',
    /const slide = 0\.\d+ \* shuffle/.test(pose) && /Math\.sin\(step\)/.test(pose) &&
    /poseSweeper\(G\.now \* \(/.test(upd));
  check('toes pointing across the path, which is what reads as a body square to the ice from any angle',
    /BoxGeometry\(0\.10, 0\.06, 0\.22\)/.test(rig) &&
    /P\.footL\.position\.set\(J\.footL\.x, J\.footL\.y - 0\.02, J\.footL\.z \+ 0\.07\)/.test(pose));
  check('the broom works the stone\'s own line, so the spray lands where the sweeping is',
    Number.isFinite(reach) && Number.isFinite(standOff) && Math.abs(reach - standOff) < 1e-9 && reach >= 0.3,
    `reach ${reach} m against a body standing ${standOff} m off the line`);
  check('both hands stay on the shaft, in order, well clear of the head of the broom',
    upper > lower && lower > 0.3, `grips at ${lower} m and ${upper} m up the shaft`);
  check('the arms follow the broom as it strokes, instead of hanging beside it',
    /applyEuler\(broomHolder\.rotation\)/.test(pose) &&
    /aim\(P\.upperArmTop, J\.shoulderTop, J\.elbowTop\)/.test(pose) &&
    /grip\(BROOM_GRIP\.upper, J\.handTop\)/.test(pose));

  // A capsule between two joints gets stretched when the joints are further apart
  // than the capsule is long, and a stretched limb reads as a plank. So the knee
  // and the elbow are solved for, and the bones have to be longer than the
  // distance they are asked to span. blender/preview_figure.py measures this
  // through the stroke; this pins that the code still asks the question.
  const bones = js.match(/const LIMB = \{ thigh: ([\d.]+), shin: ([\d.]+), upper: ([\d.]+), lower: ([\d.]+) \}/);
  const hipHeight = +(pose.match(/const hips = ([\d.]+)/) || [])[1];
  check('knees and elbows are solved by geometry, not placed by hand',
    /function twoSeg\(a, b, l1, l2, bend, out\)/.test(rig) &&
    /const cos = clamp\(/.test(rig) &&
    /twoSeg\(J\.hipL, J\.footL, LIMB\.thigh, LIMB\.shin, LIMB_BEND\.kneeL, J\.kneeL\)/.test(pose) &&
    /twoSeg\(J\.shoulderTop, J\.handTop, LIMB\.upper, LIMB\.lower, LIMB_BEND\.armTop, J\.elbowTop\)/.test(pose) &&
    !/J\.knee[LR]\.set\(/.test(pose) && !/J\.elbow(Top|Bot)\.set\(/.test(pose),
    'a joint set by hand is a joint that does not follow the broom');
  check('the legs have more bone than the crouch asks them to span, and the knee is a visible seam',
    bones && hipHeight && +bones[1] + +bones[2] > hipHeight + 0.05 &&
    /thighL: limb\(0\.085, LIMB\.thigh, mat\.trousers\)/.test(rig) &&
    /shinL: limb\(0\.070, LIMB\.shin, mat\.socks\)/.test(rig),
    `hip at ${hipHeight} m on ${bones ? +bones[1] + +bones[2] : '?'} m of leg`);

  // Run the shipped solver rather than reading it. A joint placed by a formula
  // that is subtly wrong looks plausible in a still frame and comes off the broom
  // the moment the broom moves. What Blender measures is the whole figure through
  // a stroke; what is worth pinning here is the arithmetic itself: a solved joint
  // keeps both bones exactly their own length, bends toward the direction it was
  // handed, and reports when the chain simply cannot reach.
  const solver = (js.match(/function twoSeg\(a, b, l1, l2, bend, out\) \{[\s\S]*?\n  \}/) || [''])[0];
  const clampSrc = (js.match(/const clamp = \(v, a, b\) => [^;]+;/) || [''])[0];
  const vec = ([x, y, z]) => {
    const o = { x, y, z };
    o.subVectors = (p, q) => vecSet(o, p.x - q.x, p.y - q.y, p.z - q.z);
    o.copy = (p) => vecSet(o, p.x, p.y, p.z);
    o.multiplyScalar = (s) => vecSet(o, o.x * s, o.y * s, o.z * s);
    o.addScaledVector = (p, s) => vecSet(o, o.x + p.x * s, o.y + p.y * s, o.z + p.z * s);
    o.set = (x2, y2, z2) => vecSet(o, x2, y2, z2);
    o.normalize = () => { const l = o.length() || 1; return vecSet(o, o.x / l, o.y / l, o.z / l); };
    o.lengthSq = () => o.x * o.x + o.y * o.y + o.z * o.z;
    o.length = () => Math.sqrt(o.lengthSq());
    o.dot = (p) => o.x * p.x + o.y * p.y + o.z * p.z;
    return o;
  };
  const vecSet = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  let solve = null;
  try {
    solve = Function('d', 'u', 'pp', 'bb', `${clampSrc}\n${solver}\nreturn twoSeg;`)(
      vec([0, 0, 0]), vec([0, 0, 0]), vec([0, 0, 0]), vec([0, 0, 0]));
  } catch { /* reported by the check below */ }
  const kneeOut = vec([0, 0, 0]);
  // a real case from the stance: the far hip with that foot shuffled toward it
  const hip = vec([0.12, 0.70, 0]), foot = vec([-0.14, 0.10, 0]);
  const canReach = solve && solve(hip, foot, 0.40, 0.40, [-0.95, 0.0, 0.35], kneeOut);
  const kneeOnLine = vec([0, 0, 0]);
  const tooFar = vec([0.12, -1.20, 0]);
  const canReachFar = solve && solve(hip, tooFar, 0.40, 0.40, [-0.95, 0.0, 0.35], kneeOnLine);
  check('the shipped joint solver keeps both bones their own length, in reach and out of it',
    solver && clampSrc && solve &&
    Math.abs(dist(kneeOut, hip) - 0.40) < 1e-6 && Math.abs(dist(foot, kneeOut) - 0.40) < 1e-6 &&
    Math.abs(dist(kneeOnLine, hip) - 0.40) < 1e-6,
    `${solver ? 'upper bone ' + dist(kneeOut, hip).toFixed(4) + ' m, lower ' + dist(foot, kneeOut).toFixed(4) : 'solver not found'}`);
  // How far the joint sits off the straight hip-to-foot line, and which way.
  const alongFoot = vec([foot.x - hip.x, foot.y - hip.y, foot.z - hip.z]);
  const toKnee = vec([kneeOut.x - hip.x, kneeOut.y - hip.y, kneeOut.z - hip.z]);
  const tParam = (toKnee.x * alongFoot.x + toKnee.y * alongFoot.y + toKnee.z * alongFoot.z) / alongFoot.lengthSq();
  const offLine = vec([
    toKnee.x - alongFoot.x * tParam,
    toKnee.y - alongFoot.y * tParam,
    toKnee.z - alongFoot.z * tParam,
  ]);
  const handedBend = vec([-0.95, 0.0, 0.35]);
  const bendOnLine = (handedBend.x * alongFoot.x + handedBend.y * alongFoot.y + handedBend.z * alongFoot.z) / alongFoot.lengthSq();
  const bendAside = vec([
    handedBend.x - alongFoot.x * bendOnLine,
    handedBend.y - alongFoot.y * bendOnLine,
    handedBend.z - alongFoot.z * bendOnLine,
  ]);
  check('and it bends the joint off the line in the direction it was handed, keeps it under the hip, and says when the chain cannot reach',
    canReach === true && canReachFar === false &&
    offLine.length() > 0.15 && offLine.dot(bendAside) > 0 && kneeOut.y < hip.y,
    `knee ${(offLine.length() * 100).toFixed(0)} cm off the hip-to-foot line, on the side it was asked for; reach ${canReach}, and ${canReachFar} for a 1.9 m hip-to-foot`);
  check('every arm is two segments joined at a solved elbow, ending on a grip',
    /upperArmTop: limb\(0\.052, LIMB\.upper, mat\.jacket\)/.test(rig) &&
    /foreArmTop: limb\(0\.044, LIMB\.lower, mat\.jacket\)/.test(rig) &&
    /upperArmBot: limb\(0\.052, LIMB\.upper, mat\.jacket\)/.test(rig) &&
    /foreArmBot: limb\(0\.044, LIMB\.lower, mat\.jacket\)/.test(rig) &&
    /aim\(P\.foreArmTop, J\.elbowTop, J\.handTop\)/.test(pose) &&
    /aim\(P\.foreArmBot, J\.elbowBot, J\.handBot\)/.test(pose) &&
    bones && +bones[3] + +bones[4] > 0.5,
    `${bones ? +bones[3] + +bones[4] : '?'} m of arm for a grip ${upper} m up the shaft`);
  // A misspelled part or joint name is a crash inside the render loop, and the
  // parts exist only as keys of two dictionaries built at startup, so nothing else
  // here would notice one being invented by the pose code.
  const declared = new Set();
  const pDict = rig.match(/const P = \{([\s\S]*?)\n  \};/);
  if (pDict) for (const km of pDict[1].matchAll(/(?:^|[,{\s])([A-Za-z]\w*)\s*:/g)) declared.add('P.' + km[1]);
  const jList = rig.match(/const J = \{\};\s*for \(const k of \[([\s\S]*?)\]\)/);
  if (jList) for (const nm of jList[1].matchAll(/'([A-Za-z]\w*)'/g)) declared.add('J.' + nm[1]);
  const reached = new Set();
  for (const src of [rig, pose, upd]) {
    for (const mm of src.matchAll(/[^.\w](P|J)\.([A-Za-z]\w*)/g)) reached.add(mm[1] + '.' + mm[2]);
  }
  const undeclared = [...reached].filter(k => !declared.has(k));
  check('every part and joint the pose reaches for is one the rig builds, so the render loop is never handed a typo',
    pDict && jList && declared.size >= 30 && reached.size >= 25 && undeclared.length === 0,
    undeclared.length ? 'not built: ' + undeclared.join(', ') : `${declared.size} declared, ${reached.size} reached, none missing`);
  check('a knee that bends straight at the camera reads as a dot: the joints bend where the camera can see them',
    /const LIMB_BEND = \{/.test(js) &&
    /kneeL: \[-[\d.]+, 0\.0, [\d.]+\], kneeR: \[-[\d.]+, 0\.0, [\d.]+\]/.test(js) &&
    /armTop: \[[\d.]+, -[\d.]+, [\d.]+\]/.test(js) && /armBot: \[-[\d.]+, -[\d.]+, [\d.]+\]/.test(js));
  check('limbs are aimed between joints every frame, which is what lets the figure step at all',
    /part\.quaternion\.setFromUnitVectors\(UP, n\)/.test(rig) &&
    /aim\(P\.thighL, J\.hipL, J\.kneeL\)/.test(pose) &&
    /part\.scale\.set\(1, len \/ part\.userData\.rest, 1\)/.test(rig));
  check('the head looks back at the stone and down the ice, not along the body',
    gazeVec.length === 3 && gazeVec[1] < 0 && gazeVec[2] > 0 && gazeVec[0] > 0 &&
    Math.hypot(...gazeVec) > 0 && gazeVec[2] / Math.hypot(...gazeVec) <= Math.cos(Math.PI / 6) &&
    /const HEAD_FORWARD = new THREE\.Vector3\(0, 0, 1\)/.test(js) &&
    /rig\.head\.quaternion\.setFromUnitVectors\(HEAD_FORWARD, SWEEP_GAZE\)/.test(pose),
    `gaze ${gazeVec}, ${(Math.acos(Math.min(1, gazeVec[2] / Math.hypot(...gazeVec))) * 180 / Math.PI).toFixed(0)}° off the body's facing`);
  check('the bend belongs to the brushing, and does not carry over into the next delivery',
    /const lean = 0\.56 \+ 0\.16 \* brush/.test(pose) &&
    /\(1 - sweepPose\) \* 0\.03/.test(upd) &&
    /if \(!show\) \{ sweepPose = 0; return; \}/.test(upd));
  check('the figure wears the throwing team\'s colour, so whose sweeper it is is not a guess',
    /rig\.mat\.jacket\.color\.setHex\(TEAM_COLOR\[d\.team\]/.test(upd));
  check('and it is a stand-in drawn in the game layer: no sweeper asset, no new manifest entry',
    !/assets\.sweeper|sweeper_[a-z]*\.glb/i.test(js) && /new THREE\.CapsuleGeometry/.test(rig));
}

group('3. HUD values agree with the rules module');
{
  const spinBtns = [...html.matchAll(/class="slev" data-s="(-?\d+)"/g)].map(m => +m[1]);
  check(`the spin indicator exposes exactly SPIN_LEVELS ${RULES.SPIN_LEVELS}`, JSON.stringify(spinBtns) === JSON.stringify(RULES.SPIN_LEVELS),
    `markup has ${JSON.stringify(spinBtns)}`);
  const stonePips = /for \(let i = 0; i < RULES\.STONES_PER_PLAYER_PER_END/.test(js);
  check('stone pips are driven by RULES, not a hard-coded 4', stonePips);
  // Brushing is not rationed, so nothing in the player's layer may treat it as a
  // budget; the CPU's planned window lives in ai.js and must stay there.
  check('the shot loop gates brushing on the key alone, with no seconds to run out',
    /sweepOn = keys\.has\('space'\);/.test(js) && !/G\.sweepUsed\s*[<>]=?/.test(js));
  check('the press that lets go of the weight does not also start the brushing',
    /G\.sweepArmed = !keys\.has\('space'\);/.test(js) &&
    /else if \(G\.sweepArmed\) \{/.test(js) && /G\.sweepArmed = true;/.test(js));
  check('the HUD reports how much of the path has been brushed, not time left',
    /\} s brushed/.test(js) && !/\} s left/.test(js));
  check('the CPU-only brushing window never leaks into the player-facing code', !/CPU_SWEEP_WINDOW/.test(js));
  // The meter is not a timing loop in the renderer: its shape is a rule, in
  // physics.js, parameterized in metres of travel so the player can aim at it.
  check('the weight meter is parameterized in metres of travel, not in percent',
    /const travel = meterTravel\(G\.meter\.t\)/.test(js) && /powerForDistance\(travel\)/.test(js));
  check('the renderer does not roll its own meter timing', !/G\.meter\.t % |ph < 0\.5/.test(js));
  check('the HUD reads weight as distance, not as a percentage',
    !/Math\.round\(p \* 100\)/.test(js) && /hud\.powerVal\.textContent = `\$\{travel\.toFixed\(1\)\} m`/.test(js));
  check('the meter spans exactly the metres the miniature draws',
    RULES.POWER_MIN_TRAVEL === TRACK.dMin && RULES.POWER_MAX_TRAVEL === TRACK.dMax,
    `meter ${RULES.POWER_MIN_TRAVEL}-${RULES.POWER_MAX_TRAVEL} m, widget ${TRACK.dMin}-${TRACK.dMax} m`);
  check('changing the handle re-predicts from the new value, never the old one',
    /G\.shot\.spin = L\[clamp\(L\.indexOf\(G\.shot\.spin\) \+ dir, 0, L\.length - 1\)\];\s*\n\s*setPreviewFromShot\(\);/.test(js)
      && !/nextSpin\(/.test(js));
  check('the aim readout uses RULES.AIM_STEP_DEG/AIM_MAX_DEG', /RULES\.AIM_STEP_DEG/.test(js) && /RULES\.AIM_MAX_DEG/.test(js));
  // Item of play: the explanation is read while the weight control is being
  // aimed, so it lives in the left gutter and the control keeps the middle.
  check('the phase explanation never sits on top of the weight control',
    /#prompt \{[^}]*left: 16px; bottom: 44px/.test(html) && /#prompt \{[^}]*max-width: min\(340px, 30vw\)/.test(html)
      && !/#prompt \{[^}]*translateX\(-50%\)/.test(html));
  check('when the window is too narrow to sit beside it, the explanation moves below the scoreboard, never over the control',
    /@media \(max-width: 1200px\)\s*\{[^}]*#prompt \{ bottom: auto; top: 114px/.test(html));
  const guardCue = /Guard zone — take-ins not allowed/.test(js) && /RULES\.GUARD_ZONE_SHOTS/.test(js);
  check('the guard-zone cue is shown for the first RULES.GUARD_ZONE_SHOTS stones', guardCue);
}

group('3b. The weight control is a to-scale miniature of the sheet');
{
  const xm = px => (px - TRACK.pad) / TRACK.S + TRACK.dMin;      // widget px -> travel m
  const at = (cls, attr) => {
    const m = buildStaticSvg().match(new RegExp(`class="${cls}"[^>]*${attr}="(-?[\\d.]+)"`));
    return m ? +m[1] : NaN;
  };
  const vb = html.match(/id="sheetTrack"[^>]*viewBox="([^"]+)"/);
  check('index.html declares the viewBox track.js computes', !!vb && vb[1] === TRACK.viewBox,
    `${vb && vb[1]} vs ${TRACK.viewBox}`);
  check('the drawn window contains every landmark it has to show',
    TRACK.dMin < D_HOG && D_BACK < TRACK.dMax && TRACK.band >= SHEET.width,
    `span ${TRACK.dMin}..${TRACK.dMax} m, band ${TRACK.band} m vs sheet ${SHEET.width} m`);
  check('the hog marker sits at the distance physics.js enforces',
    Math.abs(xm(at('hog', 'x1')) - (SHEET.hogFarZ - SHEET.hackZ + SHEET.stoneRadius)) < 0.02,
    `drawn ${xm(at('hog', 'x1')).toFixed(2)} m, rule ${D_HOG.toFixed(2)} m`);
  check('the tee line sits 30 m from the hack — the draw the physics is calibrated on',
    Math.abs(xm(at('tee', 'x1')) - (SHEET.teeZ - SHEET.hackZ)) < 0.02, `drawn ${xm(at('tee', 'x1')).toFixed(2)} m`);
  check('the back-line marker sits where a stone stops being in play',
    Math.abs(xm(at('back', 'x1')) - (SHEET.backLineZ - SHEET.hackZ + SHEET.stoneRadius)) < 0.02);
  check('the too-light shading stops exactly at the hog line, so it cannot mislead',
    Math.abs(at('deadzone', 'width') - at('hog', 'x1')) < 0.05,
    `shade ${at('deadzone', 'width')} vs line ${at('hog', 'x1')}`);
  check('the 12-foot ring is drawn at its true radius',
    Math.abs(at('r12', 'r') / TRACK.S - SHEET.rings.twelve) < 0.02, `drawn ${(at('r12', 'r') / TRACK.S).toFixed(2)} m`);

  /* --- the orientation of the picture, which is part of "to scale" ------------
   * The miniature is read beside the 3D view, so it cannot be a mirrored one. The
   * delivery camera sits behind the hack and looks along +Z, which for any camera
   * puts its screen-right at -X. The miniature is that frame turned 90° clockwise —
   * down-ice to the right — so -X lands at the bottom and world +X must be drawn
   * ABOVE the centre line. With the other sign a clockwise come-around reads as a
   * counter-clockwise one, which is the bug this guards.
   */
  check('the miniature is not mirrored: world +X is drawn above the centre line',
    trackY(1) < trackY(0) && trackY(-1) > trackY(0),
    `y(+1)=${trackY(1).toFixed(1)} centre=${trackY(0).toFixed(1)} y(-1)=${trackY(-1).toFixed(1)}`);

  /* The camera side of that contract, read out of main.js rather than assumed here.
   * The screen basis is derived the way Three.js derives it (Matrix4.lookAt:
   * z = eye - target, x = up × z, y = z × x), so a claim about what a camera shows
   * is arithmetic on the vectors in the source, not a description of them.
   */
  const worldNum = expr => {
    try { return Function('SHEET', `"use strict"; return (${expr});`)(SHEET); } catch { return NaN; }
  };
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = v => { const m = Math.hypot(...v) || 1; return v.map(x => x / m); };
  const show = v => v.map(x => x.toFixed(2)).join(', ');
  const viewOf = name => {
    const start = js.search(new RegExp(`\\n *${name}: \\{`));
    if (start < 0) return null;
    const end = js.indexOf('\n  },', start);
    const blk = js.slice(start, end < 0 ? js.length : end + 5);
    const pos = blk.match(/pos: \(\) => new THREE\.Vector3\(([^)]*)\)/);
    const look = blk.match(/look: \(\) => new THREE\.Vector3\(([^)]*)\)/);
    if (!pos || !look) return null;
    const vec = s => s.split(',').map(worldNum);
    const up = blk.match(/up: new THREE\.Vector3\(([^)]*)\)/);
    return { pos: vec(pos[1]), look: vec(look[1]), up: up ? vec(up[1]) : [0, 1, 0], blk };
  };
  const basis = v => {
    const z = unit(sub(v.pos, v.look));
    const x = unit(cross(v.up, z));
    return { right: x, upScreen: cross(z, x) };
  };

  const hackView = viewOf('hack');
  const hackBasis = hackView && basis(hackView);
  check('the delivery camera looks down-ice and therefore shows -X on the right',
    !!hackBasis && hackView.pos[2] < hackView.look[2] && hackBasis.right[0] < -0.9,
    hackBasis ? `z ${hackView.pos[2]} -> ${hackView.look[2]}, screen-right = (${show(hackBasis.right)})` : 'no hack camera');

  const planView = viewOf('plan');
  check('Enter gives a true top-down view, centred on the house',
    !!planView && planView.pos[0] === 0 && planView.pos[2] === SHEET.teeZ &&
    planView.look[0] === 0 && planView.look[1] === 0 && planView.look[2] === SHEET.teeZ,
    planView ? JSON.stringify({ pos: planView.pos, look: planView.look }) : 'no plan camera');

  const planBasis = planView && basis(planView);
  // The reported bug: the plan view had its bands top and bottom, i.e. the ice lying
  // across the screen. A sheet is drawn and watched with the ice running away from
  // you, so the boards belong on the left and right.
  check('the plan view runs the ice up the screen, so the boards are the bands left and right',
    !!planBasis && planBasis.upScreen[2] > 0.9 && Math.abs(planBasis.upScreen[0]) < 0.1 &&
    Math.abs(planBasis.right[2]) < 0.1,
    planBasis ? `screen-up = (${show(planBasis.upScreen)}), screen-right = (${show(planBasis.right)})` : 'no plan camera');
  check('the plan view is the delivery view seen from above, not a mirrored frame',
    !!planBasis && !!hackBasis && planBasis.right[0] < -0.9 && hackBasis.right[0] < -0.9,
    planBasis ? `plan screen-right = (${show(planBasis.right)}), delivery screen-right = (${show(hackBasis.right)})` : 'no basis');
  check('the miniature is that same frame turned anticlockwise, never mirrored',
    trackY(1) < trackY(0) && !!planBasis && planBasis.upScreen[2] > 0.9 && planBasis.right[0] < -0.9,
    'turning the miniature 90° anticlockwise sends its +X-up axis to the left, which is exactly the plan view reading -X to the right');

  const planFov = +((planView?.blk.match(/fov: (\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const halfIce = planView ? planView.pos[1] * Math.tan((planFov / 2) * Math.PI / 180) : NaN;
  const house = SHEET.rings.twelve + SHEET.stoneRadius;
  check('the plan view frames the house with working room around it, and no more of the rink than that',
    halfIce > house * 1.5 && halfIce < 8,
    `along-ice half-field ${halfIce && halfIce.toFixed(2)} m; the house as it can be counted is ${house} m across`);
  check('even a square window still shows the full width of the sheet in the plan view',
    halfIce >= SHEET.width / 2,
    `the lateral half-field is half-field × aspect, so a 1:1 window needs half-field >= ${SHEET.width / 2} m`);
  check('a straight-down camera declares its own up, and the up is eased rather than snapped',
    /up: new THREE\.Vector3\(0, 0, 1\)/.test(planView?.blk || '') &&
    /camUp\.lerp\(c\.up \|\| WORLD_UP, a\)\.normalize\(\);\s*\n\s*camera\.up\.copy\(camUp\)/.test(js),
    'with no sky above the tee the frame needs an axis of the ice as its up, and it has to roll over rather than jump');
  check('a plan view is only a camera: nothing about the shot depends on it',
    /CAM\[G\.planView \? 'plan' : camMode\]/.test(js) &&
    (js.match(/consume\('enter'\)\)\s*G\.planView = !G\.planView;/g) || []).length >= 3 &&
    !/G\.planView/.test(js.match(/function stepShot\(\)[\s\S]*?\n}/)?.[0] || ''),
    'Enter must be read as a view toggle in the player phases only, and never inside the shot simulation');

  // The picture must be the simulation, not a drawing of it: same call, same end.
  const guard = makeStone({ id: 'G', team: 'B', x: 0.8, z: 8 });
  const counter = makeStone({ id: 'Y', team: 'B', x: 0.4, z: SHEET.teeZ + 0.8 });
  const sheet = [guard, counter];
  // a come-around, the way a player would actually aim it: compensate for the
  // curl with the same solver the CPU uses, then throw
  const spin = 2, power = CAL.drawPower;
  const solved = solveAim(sheet, { team: 'A', spin, power }, { tx: 0.15, tz: SHEET.teeZ });
  const sim = simulateDelivery(sheet, { team: 'A', aimDeg: solved.aim, spin, power },
    { id: 'preview', path: true });
  const view = buildDynamicSvg(sim, sheet, { A: '#ff4b4b', B: '#ffd83d' }, RULES.GUARD_ZONE_SHOTS);
  const pts = view.path.split(' ').map(s => s.split(',').map(Number));
  const end = pts[pts.length - 1];
  check('the path ends exactly where the simulation left the stone',
    Math.abs(end[0] - trackX(trackD(sim.delivered.z))) < 0.02 && Math.abs(end[1] - trackY(sim.delivered.x)) < 0.02,
    `path end ${end}, stone z=${sim.delivered.z.toFixed(2)} x=${sim.delivered.x.toFixed(2)}`);
  check('the stop marker is that same point',
    view.stop && Math.hypot(end[0] - view.stop.x, end[1] - view.stop.y) < 0.02);
  const drawnStones = [...view.stones.matchAll(/cx="(-?[\d.]+)" cy="(-?[\d.]+)"/g)].map(m => [+m[1], +m[2]]);
  const stillInPlay = sim.world.stones.filter(s => s.id !== 'preview' && !s.removed);
  check('every stone still in play is drawn at its real position, and nothing else',
    drawnStones.length === stillInPlay.length && stillInPlay.every(s => drawnStones.some(p =>
      Math.abs(p[0] - trackX(trackD(s.z))) < 0.02 && Math.abs(p[1] - trackY(s.x)) < 0.02)),
    `drawn ${drawnStones.length}, expected ${stillInPlay.length}`);
  check('the free guard zone band runs hog line to tee line, only while protected',
    Math.abs(xm(view.fgz.x) - (SHEET.hogFarZ - SHEET.hackZ)) < 0.05 &&
    Math.abs(xm(view.fgz.x + view.fgz.w) - (SHEET.teeZ - SHEET.hackZ)) < 0.05 &&
    buildDynamicSvg(sim, [], { A: '#fff', B: '#fff' }, 0).fgz === null);
  check('a stone short of the hog is reported as removed, not as a percentage',
    /HOGGED/.test(weightReadout(simulateDelivery([], { team: 'A', aimDeg: 0, spin: 0, power: 0.42 }, { id: 'preview' }), 0)));
  check('the calibrated draw power reads as a button draw',
    /ON THE BUTTON/.test(weightReadout(simulateDelivery([], { team: 'A', aimDeg: 0, spin: 0, power: CAL.drawPower }, { id: 'preview' }), 0)));
  check('hitting through the house is reported as out of play',
    /OUT OF PLAY/.test(weightReadout(simulateDelivery([], { team: 'A', aimDeg: 0, spin: 0, power: 0.95 }, { id: 'preview' }), 0)));

  // A picture to look at: two states of the same widget (an aimed come-around
  // with the guard zone still in play, and a hit that moves a stone), styled by
  // index.html's own CSS so the artifact cannot drift from what the browser paints.
  const css = [...html.matchAll(/(#sheetTrack[^{]*\{[^}]*\})/g)].map(m => m[1]).join('\n');
  const panel = (label, stones, shot, guardLeft, dy) => {
    const s = simulateDelivery(stones, shot, { id: 'preview', path: true });
    const v = buildDynamicSvg(s, stones, { A: '#ff4b4b', B: '#ffd83d' }, guardLeft);
    const band = v.fgz ? `<rect class="fgz" x="${v.fgz.x}" y="${v.fgz.y}" width="${v.fgz.w}" height="${v.fgz.h}"></rect>` : '';
    const marker = v.stop ? `<circle class="stop" cx="${v.stop.x}" cy="${v.stop.y}" r="${v.stop.r}" fill="${v.stop.fill}"></circle>` : '';
    return `<g transform="translate(0 ${dy})"><g id="sheetTrack">` +
      `${buildStaticSvg()}${band}${v.stones}${v.ghosts}<polyline class="path" points="${v.path}"></polyline>${marker}</g>` +
      `<text class="lab" x="0" y="${TRACK.h + 11}">${label}</text></g>`;
  };
  const gap = 26;
  const takeout = (t, bias) => ({
    team: 'A', spin: 0,
    power: Math.min(1, powerForDistance(Math.hypot(t.x, t.z - SHEET.hackZ)) + bias),
    aimDeg: solveAim(sheet, { team: 'A', spin: 0, power: 0.9 }, { tx: t.x, tz: t.z }).aim,
  });
  // The meter itself, frozen at equal steps of time. Equal *spacing* on the sheet
  // is the whole property: a power-parameterized needle bunches the markers up at
  // light weights and throws them across the house, which is what "it hesitates,
  // then it moves too fast" describes.
  const P = RULES.POWER_METER_SECONDS, stepMs = Math.round(P / 8 * 1000);
  const xs = [0, 1, 2, 3, 4].map(i => trackX(meterTravel(P * i / 8)));
  const deltas = xs.slice(1).map((x, i) => x - xs[i]);
  check('the marker lands equal distances apart on the widget — constant speed, no dwell at either end',
    Math.max(...deltas) - Math.min(...deltas) < 0.01,
    `${deltas.map(d => d.toFixed(1)).join(' / ')} px per ${stepMs} ms`);
  const dots = xs.map(x => `<circle class="stop" cx="${x.toFixed(1)}" cy="${trackY(0).toFixed(1)}" r="4.5" fill="#ffe08a"></circle>`).join('');
  const meterPanel = dy => `<g transform="translate(0 ${dy})"><g id="sheetTrack">${buildStaticSvg()}${dots}</g>` +
    `<text class="lab" x="0" y="${TRACK.h + 11}">the weight meter frozen ${stepMs} ms apart: equal spacing along the sheet is the point</text></g>`;
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${TRACK.w}" height="${TRACK.h * 3 + gap * 2 + 16}"` +
    ` viewBox="0 0 ${TRACK.w} ${TRACK.h * 3 + gap * 2 + 16}">
<style>svg{background:#05080d}
${css}
</style>
${panel('aimed come-around, guard zone still in play', sheet, { team: 'A', aimDeg: solved.aim, spin, power }, RULES.GUARD_ZONE_SHOTS, 0)}
${panel('a hit: motion and removal are drawn, not described', sheet, takeout(counter, 0.06), 0, TRACK.h + gap)}
${meterPanel((TRACK.h + gap) * 2)}
</svg>`;
  writeFileSync(new URL('../tests/track_preview.svg', import.meta.url), doc);
  check('a reviewable SVG of the widget was written next to the tests', true, 'tests/track_preview.svg');
  check('the widget is built by the pure module, never inline in the renderer',
    /from '\.\/track\.js'/.test(js) && !/class="r12"|trackX\(|trackY\(/.test(js));
}

group('3c. A new end starts on a swept-clean sheet');
{
  // The bug this guards: beginSetup() left the previous end's stones on the ice,
  // so a new end was played on top of the old one.
  const clearFn = js.match(/function clearSheetForNewEnd\(\) \{([\s\S]*?)\n\}/);
  check('one reset function empties the model stone list', !!clearFn && /G\.stones = \[\]/.test(clearFn[1]));
  check('it drops the meshes, the preview and the end-summary graphics with it',
    !!clearFn && ['clearStoneViews()', 'clearFx()', 'clearPreview()'].every(c => clearFn[1].includes(c)));
  check('the reset is on the Space path out of the end summary',
    /consume\('space'\)[\s\S]{0,200}clearSheetForNewEnd\(\)/.test(js));
  check('the sheet is cleared before the next end is set up, not after',
    /clearSheetForNewEnd\(\); beginSetup\(\)/.test(js));
  check('the player is told the sheet was swept', /callout\('NEW END — sheet swept clean'/.test(js));
}

group('4. Assets: GLB first, procedural stand-in always');
{
  const paths = [...js.matchAll(/'(assets\/[a-z_]+\.glb)'/g)].map(m => m[1]);
  const expected = ['assets/sheet.glb', 'assets/stone_red.glb', 'assets/stone_yellow.glb', 'assets/broom.glb', 'assets/hack.glb', 'assets/arena.glb'];
  check('loads the asset set named in GAME_PROMPT.md', expected.every(p => paths.includes(p)), paths.join(' '));
  check('a missing GLB falls back to a procedural stand-in', /catch \(e\)[\s\S]{0,120}procedural stand-in/.test(js));
  check('every asset has a procedural builder', ['buildProceduralSheet', 'buildProceduralStone', 'buildProceduralBroom', 'buildProceduralHack', 'buildProceduralArena']
    .every(fn => js.includes(`function ${fn}(`)));
  check('the stone handle is looked up by name so spin still shows', /findPart\(root, 'handle'\)/.test(js));
  check('a GLB stone without a named handle falls back', /no named "handle" part/.test(js));
  check('assets are only requested, never required, at boot', !/throw new Error\(.*asset/.test(js));
}

group('4b. Spin belongs to the stone: one delivery must not turn every handle on the ice');
{
  const loop = bodyOf('frameLoop');
  check('the frame loop advances the in-flight stone\'s own view angle',
    /stoneViews\.get\(G\.live\.delivered\.id\)/.test(loop) && /v\.handleAngle -=/.test(loop));
  check('it never writes one shared angle to every handle',
    !/rotation\.y = G\.handleAngle/.test(js) && /v\.handle\.rotation\.y = v\.handleAngle/.test(loop),
    'a single angle on G is what made the whole rink spin with a single delivery');
  check('each stone is seeded with its own resting angle, hashed from its id',
    /this\.handleAngle = restHandleAngle\(stone\.id\)/.test(js)
    && /charCodeAt/.test(bodyOf('restHandleAngle'))
    && !/Math\.random/.test(bodyOf('restHandleAngle')),
    'deterministic, so a handle that is standing still cannot appear to turn');
  check('the HUD dial asks which stone it is describing',
    /spinDialAngle\(\)/.test(bodyOf('updateHUD'))
    && /stoneViews\.get\(G\.live\.delivered\.id\)/.test(bodyOf('spinDialAngle')));
  check('loading the real models under a standing stone keeps the angle it held',
    /v\.handle\.rotation\.y = v\.handleAngle/.test(bodyOf('updateStoneRoots')));
}

group('4c. The page declares its icon, and the .ico is readable by a browser and by Windows');
{
  const link = html.match(/<link[^>]+rel=["']icon["'][^>]*>/);
  check('index.html declares an icon link', !!link, link ? link[0] : 'no rel="icon" link');
  const href = link ? ((link[0].match(/href=["']([^"']+)["']/) || [])[1] || '') : '';
  check('the href is relative, so the icon still loads when the game is served from a subpath',
    href.includes('favicon.ico') && !href.startsWith('/'), href || 'no href');

  let ico = null;
  try { ico = readFileSync(new URL('../' + href.replace('./', ''), import.meta.url)); } catch { /* the next check reports it */ }
  const kind = ico ? ico.readUInt16LE(2) : -1;
  const count = ico ? ico.readUInt16LE(4) : 0;
  check('the file is an icon directory rather than a renamed PNG',
    !!ico && kind === 1 && count > 0, ico ? `${count} images in ${ico.length} bytes` : 'the declared icon is not on disk');

  // The sizes the Windows icon decoder asks for. A .ico whose entries are all PNG
  // compressed reads fine in a browser and is what this file shipped first; the
  // shell path is the one that wants the classic uncompressed DIB.
  const DIB_SIZES = [16, 24, 32, 48, 64];
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;   // ICONDIR is 6 bytes, ICONDIRENTRY is 16
    const px = ico.readUInt8(at) || 256;   // 0 in this field means 256
    const bytes = ico.readUInt32LE(at + 8), off = ico.readUInt32LE(at + 12);
    const blob = ico.subarray(off, off + bytes);
    const e = { px, bytes, off, blob, png: blob.subarray(0, 4).toString('latin1') === '\x89PNG' };
    if (!e.png) {
      // A classic DIB entry: BI_RGB, 32 bpp, and biHeight is *twice* the image
      // height because the AND mask follows the pixels. A set bit in that mask
      // means "transparent", so it has to agree with the alpha channel: code that
      // reads the mask instead of the alpha draws a solid black square when the
      // mask is left empty, and code that reads the alpha draws a hole where the
      // mask lies.
      e.dib = blob.readUInt32LE(0) === 40 && blob.readInt32LE(8) === 2 * px
        && blob.readUInt16LE(12) === 1 && blob.readUInt16LE(14) === 32 && blob.readUInt32LE(16) === 0;
      const maskRow = Math.floor((px + 31) / 32) * 4;
      const maskAt = 40 + px * px * 4;
      e.mask = maskAt + maskRow * px <= blob.length;
      let agree = e.mask;
      for (let r = 0; r < px && agree; r++) {
        for (let x = 0; x < px; x++) {
          const alpha = blob[40 + (r * px + x) * 4 + 3];
          const bit = (blob[maskAt + r * maskRow + (x >> 3)] >> (7 - (x % 8))) & 1;
          if (Boolean(bit) !== (alpha < 128)) { agree = false; break; }
        }
      }
      e.maskOk = agree;
    }
    entries.push(e);
  }
  const sizes = entries.map(e => e.px);
  const kinds = entries.map(e => `${e.px}:${e.png ? 'png' : 'dib'}`).join(' ');
  check(`every entry points at a complete payload (${sizes.join('/')})`,
    entries.every(e => e.off + e.bytes <= ico.length && (e.png || e.dib)), kinds);
  check('the sizes Windows asks for are stored as classic 32-bit DIBs, not PNG',
    DIB_SIZES.every(s => { const e = entries.find(x => x.px === s); return e && e.dib && !e.png; }), kinds);
  check('every DIB mask agrees with its alpha channel, so no path draws a black square',
    entries.filter(e => !e.png).every(e => e.mask && e.maskOk), kinds);
  check('the sizes only browsers ask for stay PNG, which is what keeps the file small',
    [128, 256].every(s => { const e = entries.find(x => x.px === s); return e && e.png; }), kinds);
}

group('4d. The icon is drawn out of the sheet, so it cannot quietly drift away from it');
{
  let gen = '';
  try { gen = readFileSync(new URL('../tools/make_favicon.py', import.meta.url), 'utf8'); } catch { /* reported below */ }
  check('a generator owns the icon, so it can be rebuilt rather than redrawn by hand', !!gen);
  check('it reads the ring radii out of physics.js instead of restating them',
    gen.includes('physics.js') && /rings:\\s\*/.test(gen));
  check('it reads the four sheet colours out of the asset builder',
    ['COL_BLUE', 'COL_WHITE', 'COL_RED', 'COL_LINE'].every(n => gen.includes(n)));
  check('it does not copy any of those colours into itself',
    !/0\.05,\s*0\.24/.test(gen) && !/0\.72,\s*0\.80/.test(gen) && !/0\.62,\s*0\.08/.test(gen));
  check('it proves what it drew by reading the pixels back',
    /getpixel/.test(gen) && /sampled_ring_pixels_off_by_at_most/.test(gen));
}

group('5. Three.js wiring');
{
  check('index.html uses an import map for three + addons', /"imports"/.test(html) && /three@0\.\d+\.\d+\/build\/three\.module\.js/.test(html) && /three\/addons\//.test(html));
  check('main.js is loaded as an ES module', /<script type="module" src="\.\/main\.js">/.test(html));
  // ES modules cannot load from a file:// URL, and when that happens no module
  // code runs to say so. The page has to explain itself.
  check('main.js announces that its module graph loaded', /window\.__curlingBoot = true/.test(js) && /window\.__curlingBoot = false/.test(html));
  check('opening the page from disk is explained, not left blank',
    /location\.protocol === 'file:'/.test(html) && /id = 'bootfail'/.test(html) && /python -m http\.server/.test(html));
  check('the renderer is created against the canvas in the page', /new THREE\.WebGLRenderer\(\{ canvas/.test(js));
  check('fixed-timestep accumulator drives the physics', /G\.acc >= PHYS\.DT/.test(js) && /world\.step\(PHYS\.DT/.test(js));
  check('the preview arc uses the same simulation as the shot', /simulateDelivery\(G\.stones,[\s\S]{0,120}path: true/.test(js));
  check('counting stones are highlighted and a measure-up is drawn', /highlightStone\(s, 0x7ee787\)/.test(js) && /measureLine\(button, b, TEAM_COLOR\[t\]\)/.test(js));
}

group('6. Nothing in the game layer reaches into physics internals it should not');
{
  const imported = [...js.matchAll(/import \{([^}]*)\} from '\.\/physics\.js'/gs)][0][1]
    .split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
  // SHEET/RULES/PHYS/CAL are the intended public tuning surface: the HUD shows
  // weight as metres, how much of the delivery has been brushed, and the aim step,
  // all of it straight from them, which is what keeps the meters honest. The raw
  // derived constants are not.
  const forbidden = ['V0_DRAW', 'A_DRAW', 'V_MAX', 'TIME_SCALE', 'CURL_C'];
  const leaked = imported.filter(n => forbidden.includes(n));
  check('main.js never reaches for a derived physics constant', leaked.length === 0, imported.join(' '));
  check('main.js does not implement any rules of its own (no scoring maths)', !/scoreEnd\(|points =/.test(js.replace(/scoreEnd\(world\.stones\)/g, '')));
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
