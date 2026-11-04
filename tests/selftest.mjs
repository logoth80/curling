/**
 * tests/selftest.mjs — node-run verification of the GAME_PROMPT.md acceptance
 * checklist items that are pure logic: physics calibration, curl direction,
 * sweeping, takeouts, scoring (counters / blank / biter), hog + back-line
 * removal, the adapted free-guard-zone rule, and the release roll that separates
 * a thrown stone from a called one.
 *
 *   node tests/selftest.mjs
 */
import {
  SHEET, PHYS, RULES, StoneWorld, makeStone, cloneStones,
  simulateDelivery, powerForDistance, distanceForPower, launchSpeed, distanceToButton, meterTravel,
  scoreEnd, hogViolation, inHouse, inFreeGuardZone, guardZoneViolation,
} from '../physics.js';
import { makeRng } from '../ai.js';
import { RELEASE_TIERS, rollRelease, applyRelease, describeRelease } from '../release.js';

let pass = 0, fail = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DEG = Math.PI / 180;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  ::  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ::  ' + detail : ''}`); }
}
function group(t) { console.log(`\n== ${t}`); }

/** Deliver one stone from the hack on an empty sheet and return the result. */
function solo(shot, opts) {
  return simulateDelivery([], shot, { id: 'S', ...opts });
}

// ---------------------------------------------------------------------------
group('1. Calibration targets (GAME_PROMPT "must tune to this")');
// "power ~70%, spin 0, no sweep → stop near the button (draw weight)"
{
  const r = solo({ team: 'A', aimDeg: 0, spin: 0, power: 0.70 });
  const s = r.world.stones.find(x => x.id === 'S');
  const d = Math.hypot(s.x, s.z - SHEET.teeZ);
  check('70% power stops on the button (<0.5 m)', d < 0.5, `dist=${d.toFixed(2)} m  z=${s.z.toFixed(2)}  t=${r.travelTime.toFixed(1)}s`);
  check('shot travel time to the house is 6-9 s at draw weight', r.travelTime >= 6 && r.travelTime <= 9, `t=${r.travelTime.toFixed(1)} s`);
}
// "power ~95% no-sweep should sail past the house off the back line"
{
  const r = solo({ team: 'A', aimDeg: 0, spin: 0, power: 0.95 });
  const s = r.world.stones.find(x => x.id === 'S');
  check('95% power is takeout weight: stone crosses the back line', s.removed && s.outReason === 'back line',
    `removed=${s.removed} reason=${s.outReason}`);
}
// "Max lateral curl deviation over the full sheet at spin ±2, no sweep: 1.2-1.8 m"
{
  const at = (spin) => {
    const r = solo({ team: 'A', aimDeg: 0, spin, power: 0.70 });
    const s = r.world.stones.find(x => x.id === 'S');
    return { x: s.x, z: s.z };
  };
  const cw = at(2), ccw = at(-2);
  const mag = Math.abs(cw.x);
  check('spin +2 no-sweep lateral curl is 1.2-1.8 m', mag >= 1.2 && mag <= 1.8, `|dx|=${mag.toFixed(2)} m`);
  check('clockwise (up-arrow) curls to the thrower right (-X)', cw.x < 0, `dx=${cw.x.toFixed(2)}`);
  check('spin sign reverses curl direction', Math.abs(cw.x + ccw.x) < 0.02 && ccw.x > 0,
    `+2 dx=${cw.x.toFixed(2)}  -2 dx=${ccw.x.toFixed(2)}`);
  check('curl scales linearly with spin level', Math.abs(Math.abs(at(1).x) * 2 - mag) < 0.02,
    `spin1=${Math.abs(at(1).x).toFixed(2)} spin2=${mag.toFixed(2)}`);

  // The handle turn now runs to ±3. Linearity must hold there too, and the
  // heaviest turn must still leave the stone on the sheet when thrown from the
  // centre line — otherwise the extra range would just be a way to lose a stone.
  check('spin levels run -3..+3', JSON.stringify(RULES.SPIN_LEVELS) === JSON.stringify([-3, -2, -1, 0, 1, 2, 3]),
    JSON.stringify(RULES.SPIN_LEVELS));
  const big = at(3), bigMag = Math.abs(big.x);
  check('the heaviest handle turn is 1.5x the ±2 arc', Math.abs(bigMag - mag * 1.5) < 0.02,
    `spin3=${bigMag.toFixed(2)} m vs spin2=${mag.toFixed(2)} m`);
  check('a max-handle draw from the centre line stays on the sheet',
    bigMag + SHEET.stoneRadius < SHEET.width / 2,
    `|dx|=${bigMag.toFixed(2)} m, half-sheet=${(SHEET.width / 2).toFixed(2)} m`);

  // Sweep the whole legal power range at the *calibrated* ±2 setting: nothing may
  // exceed the 1.8 m ceiling the brief's calibration block asks for. (±3 is a
  // deliberate 1.5x over that band and is checked separately above.)
  let maxSeen = 0, atHouse = 0;
  for (let p = 0.45; p <= 0.99; p += 0.02) {
    const r = simulateDelivery([], { team: 'A', aimDeg: 0, spin: 2, power: p }, { id: 'S', path: true, sampleEvery: 3 });
    let peak = 0;
    for (const q of r.path) peak = Math.max(peak, Math.abs(q.x));
    maxSeen = Math.max(maxSeen, peak);
    const s = r.world.stones.find(x => x.id === 'S');
    if (Math.abs(p - 0.7) < 0.02 || Math.abs(p - 0.95) < 0.02) atHouse = Math.max(atHouse, Math.abs(s.x));
  }
  check('no power setting exceeds the 1.8 m curl ceiling', maxSeen <= 1.8, `max |dx| over full sheet = ${maxSeen.toFixed(2)} m`);
  check('draw and takeout weights both bend >=1.2 m around the house', atHouse >= 1.2, `best = ${atHouse.toFixed(2)} m`);
}
group('2. Brushing adds a little distance and flattens the path (Wikipedia: farther, less curl — the effect is ADAPTED down, see README)');
{
  const noSweep = solo({ team: 'A', spin: 0, power: 0.60 });
  const swept = solo({ team: 'A', spin: 0, power: 0.60, sweep: { startT: 0, endT: 99 } });
  const a = noSweep.world.stones.find(s => s.id === 'S').z;
  const b = swept.world.stones.find(s => s.id === 'S').z;
  const gain = (b - a) / (a - SHEET.hackZ);
  // The brief specified 0.09 against 0.11 m/s^2 — ~18% over a window it capped at
  // 3.0 s. Brushing is now allowed for the whole path, so the per-second effect had
  // to come down for the whole-run effect to stay small. This asserts the *result*,
  // not the constant: a full-path brush is worth single-digit metres per tens of
  // metres, which is enough to change a line and not enough to undo a weight.
  check('brushing the whole run adds ~7% of distance (6-10% band)', gain >= 0.06 && gain <= 0.10, `+${(gain * 100).toFixed(1)}%  z ${a.toFixed(2)} -> ${b.toFixed(2)}`);

  // A partial window must be worth less than the whole run: that ordering is what
  // makes the CPU's choice of window a real decision (ai.js sweepOptions).
  const travel = (0.60 * PHYS.V_MAX) / PHYS.A_BASE;
  const early = solo({ team: 'A', spin: 0, power: 0.60, sweep: { startT: 0, endT: travel * 0.4 } });
  const e = early.world.stones.find(s => s.id === 'S').z;
  const eg = (e - a) / (a - SHEET.hackZ);
  check('brushing only the first 40% of the flight is worth less than the whole run', eg > 0.005 && eg < gain, `+${(eg * 100).toFixed(1)}% vs +${(gain * 100).toFixed(1)}%`);

  const ns = solo({ team: 'A', spin: 2, power: 0.70 });
  const ws = solo({ team: 'A', spin: 2, power: 0.70, sweep: { startT: 0, endT: 99 } });
  const d0 = Math.abs(ns.world.stones.find(s => s.id === 'S').x);
  const d1 = Math.abs(ws.world.stones.find(s => s.id === 'S').x);
  check('brushing the whole run flattens the curl without erasing it', d1 < d0 * 0.9 && d1 > d0 * 0.45, `curl ${d0.toFixed(2)} -> ${d1.toFixed(2)} m`);

  // When in the flight you brush matters, and on this curl law it is not the way the
  // brief's prose suggests: a⊥ = C·spin·(v/vmax) is *greatest at the start*, so
  // brushing early is where both the extra distance and the straightening come from,
  // and brushing the tail is worth very little of either. ai.js simulates every
  // window instead of assuming this; these two checks fail if the model ever makes a
  // late window meaningful again, which is when the docs and the option list should
  // be revisited.
  const t2 = (0.70 * PHYS.V_MAX) / PHYS.A_BASE;
  const late = solo({ team: 'A', spin: 0, power: 0.70, sweep: { startT: t2 * 0.55, endT: 99 } });
  const lz = late.world.stones.find(s => s.id === 'S').z;
  const bz = ns.world.stones.find(s => s.id === 'S').z;
  const lg = (lz - bz) / (bz - SHEET.hackZ);
  const earlyP = solo({ team: 'A', spin: 0, power: 0.70, sweep: { startT: 0, endT: t2 * 0.45 } });
  const ez = earlyP.world.stones.find(s => s.id === 'S').z;
  const egg = (ez - bz) / (bz - SHEET.hackZ);
  const lateC = solo({ team: 'A', spin: 2, power: 0.70, sweep: { startT: t2 * 0.55, endT: 99 } });
  const dLate = Math.abs(lateC.world.stones.find(s => s.id === 'S').x);
  check('brushing early buys far more than brushing the tail of the flight', lg > 0 && lg < egg * 0.5, `early +${(egg * 100).toFixed(1)}% vs late +${(lg * 100).toFixed(1)}%`);
  check('a late window does not undo the line the stone has already taken', dLate > d0 * 0.95, `curl ${d0.toFixed(2)} -> ${dLate.toFixed(2)} m`);
}
group('3. Preview arc predicts the actual unswept path (same deterministic sim)');
{
  const shot = { team: 'A', aimDeg: 1.6, spin: 2, power: 0.68 };
  const withPath = simulateDelivery([], shot, { id: 'S', path: true, sampleEvery: 4 });
  const plain = simulateDelivery([], shot, { id: 'S' });
  const last = withPath.path[withPath.path.length - 1];
  const real = plain.world.stones.find(s => s.id === 'S');
  const err = Math.hypot(last.x - real.x, last.z - real.z);
  check('sampled preview endpoint matches the settled stone', err < 0.05, `err=${err.toFixed(3)} m  samples=${withPath.path.length}`);
}
group('4. Collisions: takeouts knock opponents out of play');
{
  const target = makeStone({ id: 'T', team: 'B', x: 0.2, z: SHEET.teeZ });
  const r = simulateDelivery([target], { team: 'A', aimDeg: 0, spin: 0, power: 0.95 }, { id: 'S' });
  const t = r.world.stones.find(s => s.id === 'T'), s = r.world.stones.find(x => x.id === 'S');
  check('takeout carries the struck stone out of play', t.removed === true,
    `target z=${t.z.toFixed(2)} x=${t.x.toFixed(2)} reason=${t.outReason}`);
  check('a struck stone carried past the back line is removed',
    simulateDelivery([makeStone({ id: 'T2', team: 'B', x: 0, z: SHEET.teeZ })], { team: 'A', aimDeg: 0, spin: 0, power: 0.95 }, { id: 'S2' })
      .world.stones.find(x => x.id === 'T2').outReason === 'back line');
  check('delivered stone also finishes out of play at takeout weight', s.removed, `z=${s.z.toFixed(2)}`);
  check('collision event recorded', r.world.events.length >= 1, `events=${r.world.events.length}`);
}
{
  // elastic exchange sanity: head-on full hit with e=0.95 => shooter nearly stops
  const w = new StoneWorld([
    makeStone({ id: 'A1', team: 'A', x: 0, z: 0, vx: 0, vz: 6 }),
    makeStone({ id: 'B1', team: 'B', x: 0, z: 0.29, spin: 0 }),
  ]);
  for (let i = 0; i < 12; i++) w.step(PHYS.DT);
  const a = w.stones[0], b = w.stones[1];
  check('head-on collision transfers ~97.5% of speed to the object', b.vz > 5.7 && Math.abs(a.vz) < 0.35,
    `shooter vz=${a.vz.toFixed(2)}  object vz=${b.vz.toFixed(2)}`);
}
group('5. Scoring: counters, blank end, biter, hammer-neutral logic');
{
  const stones = [
    makeStone({ id: 'A1', team: 'A', x: 0.1, z: SHEET.teeZ + 0.2 }),
    makeStone({ id: 'A2', team: 'A', x: -0.4, z: SHEET.teeZ - 0.5 }),
    makeStone({ id: 'B1', team: 'B', x: 0.0, z: SHEET.teeZ + 1.0 }),
  ];
  const r = scoreEnd(stones);
  check('two counters score 2 for the closer team', r.team === 'A' && r.points === 2, `team=${r.team} pts=${r.points}`);
  check('counting ids are the shot-counting stones only', r.counting.length === 2 && !r.counting.includes('B1'), JSON.stringify(r.counting));
}
{
  const r = scoreEnd([makeStone({ id: 'A1', team: 'A', x: 3.0, z: 12 })]);
  check('blank end when nothing is in the house', r.team === null && r.points === 0 && r.blank === true, `pts=${r.points}`);
}
{
  // a "biter": centre just outside the 12-ft ring but the stone touches it
  const d = SHEET.rings.twelve + SHEET.stoneRadius * 0.4;
  const s = makeStone({ id: 'A1', team: 'A', x: d, z: SHEET.teeZ });
  check('a biter touching the 12-ft ring counts', inHouse(s) === true, `centre dist=${d.toFixed(3)} (ring ${SHEET.rings.twelve})`);
  const out = makeStone({ id: 'B1', team: 'B', x: SHEET.rings.twelve + SHEET.stoneRadius + 0.05, z: SHEET.teeZ });
  check('a stone wholly outside the 12-ft ring does not count', inHouse(out) === false);
  const r = scoreEnd([s, out]);
  check('only the biter scores when it is also closer', r.team === 'A' && r.points === 1, `team=${r.team} pts=${r.points}`);
}
group('6. Hog line and back line removal');
{
  const r = simulateDelivery([], { team: 'A', spin: 0, power: 0.45 }, { id: 'S' });
  const s = r.world.stones.find(x => x.id === 'S');
  check('short stone stops before the far hog line', !s.removed && s.z < SHEET.hogFarZ, `z=${s.z.toFixed(2)}`);
  check('hogViolation flags it so the game removes the delivered stone', hogViolation(s) === true);
  const good = simulateDelivery([], { team: 'A', spin: 0, power: 0.70 }, { id: 'S' }).world.stones.find(x => x.id === 'S');
  check('a proper draw is not a hog violation', hogViolation(good) === false && good.z - SHEET.stoneRadius > SHEET.hogFarZ);
}
group('7. Free guard zone (first RULES.GUARD_ZONE_SHOTS stones of an end)');
{
  // An opponent centre guard sitting between the far hog line and the tee line.
  const guard = makeStone({ id: 'G', team: 'B', x: 0, z: 8 });
  check('guard sits in the protected zone', inFreeGuardZone(guard) === true, `z=${guard.z}`);
  check('a stone inside the 8-ft ring is not a guard-zone stone',
    inFreeGuardZone(makeStone({ id: 'X', team: 'B', x: 0, z: SHEET.teeZ })) === false);

  const before = cloneStones([guard]);
  // A takeout at the guard while the FGZ is still active.
  const r = simulateDelivery([guard], { team: 'A', spin: 0, power: 0.9 }, { id: 'S' });
  const after = {}; for (const s of r.world.stones) after[s.id] = s;
  const delivered = r.world.stones.find(s => s.id === 'S');
  const N = RULES.GUARD_ZONE_SHOTS;
  check('the window is the WFG count for a full end (5 of 8 per side)',
    N === 5 && RULES.STONES_PER_PLAYER_PER_END === 8, `window=${N} perEnd=${RULES.STONES_PER_PLAYER_PER_END}`);
  check('shot #1 of the end: removing an opponent guard is a violation',
    guardZoneViolation(before, after, delivered, 0).length === 1);
  check(`the last protected delivery (#${N}) is still a violation`,
    guardZoneViolation(before, after, delivered, N - 1).length === 1);
  check(`#${N + 1} onward: the guard zone has lifted`,
    guardZoneViolation(before, after, delivered, N).length === 0,
    `bad=${guardZoneViolation(before, after, delivered, N).length}`);
  // A draw that leaves the guard in place is legal even during the FGZ.
  const r2 = simulateDelivery([guard], { team: 'A', spin: 0, power: 0.62 }, { id: 'S' });
  const after2 = {}; for (const s of r2.world.stones) after2[s.id] = s;
  check('a draw that leaves the guard standing is legal during the FGZ',
    guardZoneViolation(before, after2, r2.world.stones.find(s => s.id === 'S'), 0).length === 0,
    `guard still in play=${!after2['G'].removed}`);
}
group('8. Power model helpers');
{
  const p = powerForDistance(30);
  check('powerForDistance(30 m) ~= the 0.70 draw anchor', near(p, RULES.DRAW_POWER, 0.01), `p=${p.toFixed(3)}`);
  check('launch speed at 100% power equals V_MAX', launchSpeed(1) === PHYS.V_MAX);
  const stop = (power) => simulateDelivery([], { team: 'A', power }, { id: 'S' }).world.stones.find(s => s.id === 'S').z;
  const p1 = stop(0.5), p2 = stop(0.6);
  check('stopping distance scales with power^2 (s = v0^2/2a)', p2 - SHEET.hackZ > (p1 - SHEET.hackZ) * 1.25,
    `z(50%)=${p1.toFixed(1)} z(60%)=${p2.toFixed(1)}`);
  // The same law read the other way, which is what release.js asks a weight in
  // order to size a hand error against the line being thrown. It has to agree with
  // the forward one to the last decimal, or the roll would be sized against a
  // distance the stone does not actually travel.
  let worstRound = 0;
  for (const d of [RULES.POWER_MIN_TRAVEL, 20, 30, RULES.POWER_MAX_TRAVEL]) {
    worstRound = Math.max(worstRound, Math.abs(distanceForPower(powerForDistance(d)) - d));
  }
  check('distanceForPower inverts powerForDistance across the whole selectable range',
    worstRound < 1e-9, `worst error ${worstRound.toExponential(1)} m`);
  check('and it reports the unbrushed run by default, because that is the line the preview shows',
    distanceForPower(p) < distanceForPower(p, true),
    `unbrushed ${distanceForPower(p).toFixed(2)} m, brushed ${distanceForPower(p, true).toFixed(2)} m`);
  void distanceToButton;
}

group('9. The weight meter sweeps distance at a constant rate (the control the player actually uses)');
{
  const P = RULES.POWER_METER_SECONDS, lo = RULES.POWER_MIN_TRAVEL, hi = RULES.POWER_MAX_TRAVEL;
  check('it starts at the lightest weight the widget shows, already moving',
    near(meterTravel(0), lo, 1e-9) && meterTravel(0.02) > lo + 0.1,
    `start=${meterTravel(0).toFixed(2)} m, +20 ms=${meterTravel(0.02).toFixed(2)} m`);
  check('one sweep runs exactly to the far edge of the drawn sheet and back',
    near(meterTravel(P / 2), hi, 1e-9) && near(meterTravel(P), lo, 1e-9)
      && near(meterTravel(P * 1.25), meterTravel(P * 0.25), 1e-9),
    `period=${P} s, peak=${meterTravel(P / 2).toFixed(1)} m`);
  // What this replaces: a power needle. Because a stone stops at p^2*Vmax^2/2a, a
  // power ramp sits almost still for its first third and then tears through the
  // house — "it hesitates, then it is too fast". Sampled rates prove it does not.
  const step = P / 40, rates = [];
  for (let i = 0; i < 20; i++) rates.push((meterTravel((i + 1) * step) - meterTravel(i * step)) / step);
  check('the marker holds one speed for the whole sweep: no dwell at either end',
    rates.every(r => near(r, rates[0], 1e-6)),
    `speed=${rates[0].toFixed(2)} m/s, spread=${(Math.max(...rates) - Math.min(...rates)).toExponential(1)}`);
  const window = (2 * 1.2) / rates[0];          // ±1.2 m of draw tolerance / m per s
  // Same period, parameterized the usual way — in power — for the comparison.
  const k = PHYS.V_MAX * PHYS.V_MAX / (2 * PHYS.A_BASE);
  const oldWindow = (Math.sqrt(31.2 / k) - Math.sqrt(28.8 / k)) * (P / 2);
  check('a button draw gets a window you can actually hit', window >= 0.2 && window > oldWindow * 3,
    `${(window * 1000).toFixed(0)} ms per pass at ±1.2 m, against ${(oldWindow * 1000).toFixed(0)} ms for a power ramp at the same ${P} s`);
  // The ends of the range must mean what the widget labels them.
  const light = simulateDelivery([], { team: 'A', power: powerForDistance(lo) }, { id: 'L' });
  const heavy = simulateDelivery([], { team: 'A', power: powerForDistance(hi) }, { id: 'H' });
  check('the lightest selectable weight is hogged, as the red zone says',
    hogViolation(light.delivered) && light.delivered.z < SHEET.hogFarZ,
    `${lo} m of travel -> z=${light.delivered.z.toFixed(2)}, hog=${hogViolation(light.delivered)}`);
  check('the heaviest selectable weight carries through the house',
    heavy.delivered.z > SHEET.backLineZ && heavy.world.stones[0].removed,
    `${hi} m of travel -> z=${heavy.delivered.z.toFixed(2)}, out=${heavy.delivered.outReason}, power=${powerForDistance(hi).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
group('10. The release roll: the shot called vs the stone thrown (release.js)');
{
  const LINE = SHEET.teeZ - SHEET.hackZ;   // 30 m, hack to button — the line the bands are quoted against
  const draw = powerForDistance(LINE);

  // The bands are a share of *the delivery that was called*, not of the meter value.
  // That is the whole design decision in this file and it is worth a check, because the
  // two readings differ by about 2.2x (travel is quadratic in speed): read against the
  // meter, a 30 m draw sits at power 0.700 and ±2% of that number is ±1.2 m, so even a
  // clean release would miss by two thirds of the house and the bottom of the table
  // would leave the sheet. See the header of release.js.
  const shape = JSON.stringify(RELEASE_TIERS.map(t => [t.name, t.weight, t.spin, t.power]));
  check('the table is the one the game asks for: 50 clean, 25 slightly off, 12 loose, 12 bad, with those bands',
    shape === JSON.stringify([
      ['good', 50, 0.10, 0.02], ['ok', 25, 0.20, 0.05],
      ['mediocre', 12, 0.40, 0.09], ['bad', 12, 0.40, 0.15],
    ]), shape);
  check('the frequencies are untouched: only what the tiers are wrong *about* has changed',
    JSON.stringify(RELEASE_TIERS.map(t => t.weight)) === JSON.stringify([50, 25, 12, 12]),
    `weights ${RELEASE_TIERS.map(t => t.weight).join('/')}`);
  check('weight is wrong by 0-2% on the tiers that are not wrong, and by up to 15% on the one called bad, getting worse monotonically',
    RELEASE_TIERS[0].power <= 0.02 && RELEASE_TIERS[RELEASE_TIERS.length - 1].power === 0.15 &&
    RELEASE_TIERS.every((t, i) => i === 0 || t.power >= RELEASE_TIERS[i - 1].power),
    `bands ±${(RELEASE_TIERS.map(t => t.power * 100).join('/'))}%`);
  check('and no band is stated in degrees or centimetres any more: a release has no line error',
    !('line' in RELEASE_TIERS[0]) && !('aimDegErr' in RELEASE_TIERS[0]),
    Object.keys(RELEASE_TIERS[0]).join('/'));

  // Frequencies and bounds over a fixed seed, so a failure is reproducible.
  const rng = makeRng(20261023), N = 40000;
  const total = RELEASE_TIERS.reduce((s, t) => s + t.weight, 0);
  const counts = {}, overBand = [], unreachable = [], powerOutOfRange = [];
  for (const t of RELEASE_TIERS) counts[t.name] = 0;
  let widestReached = {};
  for (const t of RELEASE_TIERS) widestReached[t.name] = 0;
  for (let i = 0; i < N; i++) {
    const r = rollRelease(rng, { power: draw });
    counts[r.tier]++;
    const t = RELEASE_TIERS.find(x => x.name === r.tier);
    if (Math.abs(r.pct) > t.power + 1e-12 || Math.abs(r.spinErr) > t.spin + 1e-12) {
      overBand.push(`${r.tier} weight ${(r.pct * 100).toFixed(1)}% handle ${r.spinErr.toFixed(3)}`);
    }
    widestReached[r.tier] = Math.max(widestReached[r.tier], Math.abs(r.pct));
    const p = draw + r.powerErr;
    if (p < 0 || p > 1) powerOutOfRange.push(`${r.tier} power ${p.toFixed(4)}`);
  }
  const freq = RELEASE_TIERS.map(t =>
    `${t.name} ${(100 * counts[t.name] / N).toFixed(2)}% vs ${t.weight}/${total} = ${(100 * t.weight / total).toFixed(2)}%`);
  check('the draws land on the table, read as weights and normalised rather than as percentages',
    RELEASE_TIERS.every(t => Math.abs(100 * counts[t.name] / N - 100 * t.weight / total) < 1),
    freq.join('  '));
  check('no draw goes past its own band, on either axis', overBand.length === 0, overBand.slice(0, 3).join(' | '));
  check('every band is reachable, including the 15% one — a band nobody can roll is dead code',
    RELEASE_TIERS.every(t => t.power === 0 || widestReached[t.name] >= t.power * 0.98),
    RELEASE_TIERS.map(t => `${t.name} reached ${(widestReached[t.name] * 100).toFixed(1)}% of ±${t.power * 100}%`).join('  '));
  check('the applied power always stays inside the calibrated range', powerOutOfRange.length === 0,
    powerOutOfRange.slice(0, 3).join(' | '));

  // A generator whose answers are known, so a check can ask for one tier and one place
  // inside that tier's band and still exercise the real rollRelease. The three draws are
  // tier, share, handle: -1 and +1 are the ends of the band, 0 is dead on, and the
  // third at 0.5 means handle 0, which keeps the two axes separable.
  const CUM = []; { let acc = 0; for (const t of RELEASE_TIERS) { acc += t.weight; CUM.push(acc); } }
  const TOTAL = CUM[CUM.length - 1];
  const rigged = (name, dir, handle = 0.5) => {
    const i = RELEASE_TIERS.findIndex(t => t.name === name);
    const pick = (CUM[i] - RELEASE_TIERS[i].weight / 2) / TOTAL;   // safely inside that tier
    let n = 0;
    return () => [pick, (dir + 1) / 2, handle][n++];
  };

  // What a band means as a distance, against the rules module's own stopping law. The
  // figures come from the table, so this can never pass against a table the game no
  // longer rolls.
  for (const run of [LINE, 20, 12]) {
    const p = powerForDistance(run);
    const worst = [];
    for (const t of RELEASE_TIERS) for (const sign of [1, -1]) {
      const share = t.power * sign;
      const r = rollRelease(rigged(t.name, sign), { power: p });
      const g = applyRelease({ aimDeg: 0, spin: 0, power: p }, r);
      const want = run * (1 + share);
      if (!near(distanceForPower(g.power), want, 1e-9)) worst.push(`${t.name} ${sign > 0 ? 'long' : 'short'} ran ${distanceForPower(g.power).toFixed(3)} m, wanted ${want.toFixed(3)}`);
      if (!near(r.metres, want - run, 1e-9)) worst.push(`${t.name} ${sign > 0 ? 'long' : 'short'} reported ${r.metres.toFixed(3)} m, wanted ${(want - run).toFixed(3)}`);
      if (!near(r.pct, share, 1e-12)) worst.push(`${t.name} reported ${(r.pct * 100).toFixed(2)}%, wanted ${(share * 100).toFixed(2)}%`);
    }
    check(`at a called ${Math.round(run)} m delivery every band becomes exactly that share of the run, both directions`,
      worst.length === 0, worst.slice(0, 3).join(' | ') ||
      `±${RELEASE_TIERS.map(t => `${t.name} ${(t.power * run).toFixed(2)} m`).join(' ')}`);
  }

  // And what it does on the ice, measured against the same delivery thrown clean. The
  // short direction is always still in play, so it measures the whole error.
  const atRest = (shot, id) => simulateDelivery([], { team: 'A', ...shot }, { id }).delivered;
  for (const run of [LINE, 20, 12]) {
    const p = powerForDistance(run);
    const clean = atRest({ aimDeg: 0, spin: 0, power: p }, 'clean');
    const bad = RELEASE_TIERS[RELEASE_TIERS.length - 1];
    const r = rollRelease(rigged(bad.name, -1), { power: p });
    const g = atRest(applyRelease({ aimDeg: 0, spin: 0, power: p }, r), 'badshort');
    const short = clean.z - g.z;
    check(`the worst band on the table actually leaves the stone ${(bad.power * run).toFixed(2)} m short at a called ${Math.round(run)} m`,
      near(short, bad.power * run, 0.01),
      `measured ${short.toFixed(3)} m short (clean rest Z=${clean.z.toFixed(2)}, this one Z=${g.z.toFixed(2)})`);
  }

  // The two ends of the table now reach two different rules outcomes, which is the
  // point of the change: a bad release is not a small miss, it is a delivery that costs
  // you the stone. Both are measured rather than asserted from the arithmetic.
  {
    const p = powerForDistance(LINE);
    const bad = RELEASE_TIERS[RELEASE_TIERS.length - 1];
    const long = atRest(applyRelease({ aimDeg: 0, spin: 0, power: p },
      rollRelease(rigged(bad.name, 1), { power: p })), 'badlong');
    check('a bad release long at a draw carries the stone through the house and out past the back line',
      long.removed && long.outReason === 'back line',
      `Z=${long.z.toFixed(2)} out=${long.outReason}`);

    const p20 = powerForDistance(20);
    const short = atRest(applyRelease({ aimDeg: 0, spin: 0, power: p20 },
      rollRelease(rigged(bad.name, -1), { power: p20 })), 'hogged');
    const clean20 = atRest({ aimDeg: 0, spin: 0, power: p20 }, 'clean20');
    check('a bad release short of a raise does not make the far hog line, which is what a bad release does to a raise',
      hogViolation(short) && !hogViolation(clean20),
      `stopped Z=${short.z.toFixed(2)} against hogFarZ=${SHEET.hogFarZ}; the same raise thrown clean stops at Z=${clean20.z.toFixed(2)}`);
  }

  // Across a match the model still has to leave the player scoring most of the time.
  // These are the balance numbers for the change, measured from real rolls.
  {
    const rng2 = makeRng(20261104), M = 2000;
    const base = { aimDeg: 0, spin: 0, power: draw };
    const clean = atRest(base, 'cleanbalance');
    const offs = [];
    let lost = 0;
    for (let i = 0; i < M; i++) {
      const g = atRest(applyRelease(base, rollRelease(rng2, base)), `b${i}`);
      if (g.removed) lost++;
      offs.push(Math.hypot(g.x - clean.x, g.z - clean.z));
    }
    offs.sort((a, b) => a - b);
    const mean = offs.reduce((a, b) => a + b, 0) / M;
    const median = offs[M >> 1];
    check('the expected delivery is still an attempt to score: the mean miss sits inside the eight-foot radius, not near the twelve-foot one',
      mean < SHEET.rings.eight,
      `mean ${mean.toFixed(3)} m, median ${median.toFixed(3)} m, p95 ${offs[Math.floor(M * 0.95)].toFixed(3)} m against eight-foot ${SHEET.rings.eight} m / twelve-foot ${SHEET.rings.twelve} m`);
    check('and it costs the stone on about one delivery in a hundred, not one in ten',
      lost / M < 0.03,
      `${lost} of ${M} called draws finished out of play (${(100 * lost / M).toFixed(2)}%)`);
  }

  // The handle half of the table, in the units the game already calibrates curl in —
  // unchanged by this, and still worth pinning next to the new half.
  const straight = atRest({ aimDeg: 0, spin: 0, power: draw }, 'h0');
  const perLevel = Math.abs(atRest({ aimDeg: 0, spin: 2, power: draw }, 'h2').x - straight.x) / 2;
  const widestSpin = Math.max(...RELEASE_TIERS.map(t => t.spin));
  const h1 = atRest(applyRelease({ aimDeg: 0, spin: 0, power: draw }, { powerErr: 0, spinErr: 0.1 }), 'h1');
  check('a tenth of a handle is a tenth of the measured arc per level — no new constant enters the world',
    near(Math.abs(h1.x - straight.x), 0.1 * perLevel, 0.004),
    `handle +0.1 = ${(Math.abs(h1.x - straight.x) * 100).toFixed(1)} cm, one level = ${(perLevel * 100).toFixed(1)} cm`);
  const hMax = atRest(applyRelease({ aimDeg: 0, spin: 0, power: draw }, { powerErr: 0, spinErr: widestSpin }), 'hmax');
  check(`the widest handle the table rolls is that fraction of a turn of line by itself, which is why the handle half still matters`,
    near(Math.abs(hMax.x - straight.x), widestSpin * perLevel, 0.004),
    `±${widestSpin} of handle = ${(Math.abs(hMax.x - straight.x) * 100).toFixed(1)} cm at draw weight`);

  // What the change took away, stated as a check so it cannot come back unnoticed.
  const untouched = applyRelease({ aimDeg: 3.4, spin: -1, power: draw },
    rollRelease(rigged('bad', 1), { power: draw }));
  check('a release never moves the line: the player is exactly on the line they sighted',
    untouched.aimDeg === 3.4, `aimDeg stayed ${untouched.aimDeg}`);
  check('but it does move the weight: the meter value is the intent, not the launch',
    applyRelease({ aimDeg: 0, spin: 0, power: draw },
      rollRelease(rigged('ok', 1), { power: draw })).power !== draw,
    `called power ${draw.toFixed(4)} of full power, launched at ${applyRelease({ aimDeg: 0, spin: 0, power: draw }, rollRelease(rigged('ok', 1), { power: draw })).power.toFixed(4)}`);

  // The share is sized against the unbrushed run, because that is what the preview and
  // the miniature showed; brushing is a separate effect the player asked for.
  {
    const r = rollRelease(rigged('ok', 1), { power: draw });
    check('the band is measured against the unbrushed distance the preview promised, not against swept ice',
      near(r.runM, distanceForPower(draw), 1e-12) && distanceForPower(draw, true) > r.runM,
      `unbrushed ${distanceForPower(draw).toFixed(2)} m, swept ${distanceForPower(draw, true).toFixed(2)} m, roll used ${r.runM.toFixed(2)} m`);
  }

  // The clamp is defensive: inside the meter's own travel band it never binds, and the
  // log then describes the folded delivery rather than the intended one.
  {
    const inBand = [powerForDistance(RULES.POWER_MIN_TRAVEL), powerForDistance(RULES.POWER_MAX_TRAVEL)];
    const bound = inBand.map(p => applyRelease({ aimDeg: 0, spin: 0, power: p },
      rollRelease(rigged('bad', 1), { power: p })).power).filter(p => p >= 1);
    const hand = applyRelease({ aimDeg: 0, spin: 0, power: 1 },
      rollRelease(rigged('bad', 1), { power: 1 }));
    check('within the meter band nothing is ever clamped; beyond it the fold is honest about what will happen',
      bound.length === 0 && hand.power === 1 && near(rollRelease(rigged('bad', 1), { power: 1 }).metres, 0, 1e-12),
      `at 14 m and 36 m the launched powers were ${inBand.map(p => p.toFixed(3)).join(' / ')} -> never reached; at power 1.000 a +15% ask folds to power 1 and reports ${rollRelease(rigged('bad', 1), { power: 1 }).metres.toFixed(3)} m`);
  }

  // The line the player reads in the shot log. It describes the delivery that happened.
  {
    const longR = { label: 'loose release', runM: LINE, metres: 2.07, pct: 0.069, powerErr: 0.03, spinErr: -0.24 };
    const shortR = { ...longR, metres: -4.20, pct: -0.14, label: 'bad release' };
    const dead = { label: 'clean release', runM: LINE, metres: 0.04, pct: 0.0013, powerErr: 0, spinErr: 0.02 };
    const a = describeRelease(longR), b = describeRelease(shortR), c = describeRelease(dead);
    check('the shot log reports the handle and the weight, with the share and the metres it cost, and says which way',
      /loose release · handle −0\.24 · weight \+7% · 2\.1 m long/.test(a) &&
      /bad release · handle −0\.24 · weight −14% · 4\.2 m short/.test(b), `${a}  //  ${b}`);
    check('a delivery that made its distance is called what curlers call it, not rounded to zero per cent',
      /dead weight/.test(c) && !/weight dead weight/.test(c), c);
  }

  const r1 = rollRelease(makeRng(4242), { power: draw }), r2 = rollRelease(makeRng(4242), { power: draw });
  check('the same seed is the same release, so a match is still replayable from its seed',
    JSON.stringify(r1) === JSON.stringify(r2), `${r1.tier} ${(r1.pct * 100).toFixed(1)}%`);
  check('a different seed is a different release',
    JSON.stringify(r1) !== JSON.stringify(rollRelease(makeRng(4243), { power: draw })));
  const twice = atRest(applyRelease({ aimDeg: 0, spin: 1, power: draw }, r1), 'd1');
  const twice2 = atRest(applyRelease({ aimDeg: 0, spin: 1, power: draw }, r1), 'd2');
  check('the world stays deterministic about it: that release replays to the centimetre',
    twice.x === twice2.x && twice.z === twice2.z, `x ${twice.x.toFixed(5)} z ${twice.z.toFixed(5)}`);
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
