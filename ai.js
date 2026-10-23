/**
 * ai.js — the CPU skip.
 *
 * Strategy vocabulary and priorities are taken from
 *  - https://en.wikipedia.org/wiki/Curling#Strategy_and_tactics
 *  - https://en.wikipedia.org/wiki/Glossary_of_curling#Types_of_shots
 * (centre guard, corner guard, come-around, draw, freeze, takeout, hit-and-roll,
 * blanking the end to keep the hammer).
 *
 * Method, exactly as GAME_PROMPT.md describes it: enumerate a small menu of
 * candidate shots, forward-simulate each with the *same* deterministic physics
 * the game uses, score the resulting sheet, and play the best one with
 * aim/spin/power noise scaled by the selected difficulty. The aim is solved by
 * Newton steps against the simulated curl — the digital equivalent of a skip
 * "aiming off the broom".
 *
 * No THREE.js / DOM here, so this module is testable in node.
 */

import {
  SHEET, RULES, otherTeam, throwingOrder,
  simulateDelivery, powerForDistance, distanceToButton, inHouse,
  inFreeGuardZone, guardZoneViolation, scoreEnd, sheetValue, cloneStones,
} from './physics.js';

/** Difficulty = execution noise + how well the CPU uses sweeping. */
export const DIFFICULTY = {
  // "Easy: beats nobody, hits the hog line often" — it can still find a guard.
  easy:   { aimDeg: 0.60, power: 0.055, spinMistake: 0.45, sweepSkill: 0.25, label: 'EASY' },
  normal: { aimDeg: 0.24, power: 0.024, spinMistake: 0.15, sweepSkill: 0.80, label: 'NORMAL' },
  hard:   { aimDeg: 0.07, power: 0.010, spinMistake: 0.00, sweepSkill: 1.00, label: 'HARD' },
};

/** Deterministic PRNG so a match can be replayed from a seed (mulberry32). */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HACK = { x: 0, z: SHEET.hackZ };
const R = SHEET.stoneRadius;
const DMIN = 2 * R;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** Straight-line aim (deg, +ve = thrower's right) that points at (tx,tz). */
function aimToward(tx, tz) {
  const d = dist(HACK.x, HACK.z, tx, tz);
  if (d < 0.5) return 0;
  // dir.x = -sin(aim) so a target at -X (thrower's right) needs aim > 0.
  return (Math.asin(clamp(-tx / d, -1, 1)) * 180) / Math.PI;
}

/**
 * Solve for the aim that lands near (tx,tz) despite the simulated curl, using
 * one Newton step on the measured lateral error (dx/daim ~= -run length).
 * Exported because the tests use it to drive a "competent human" stand-in and
 * the UI reuses it to explain where the player should aim.
 */
export function solveAim(stones, shot, target, iters = 2) {
  let aim = aimToward(target.tx, target.tz);
  let best = { sim: null, err: Infinity, aim };
  for (let i = 0; i <= iters; i++) {
    const sim = simulateDelivery(stones, { ...shot, aimDeg: aim }, { id: shot.id, path: true, sampleEvery: 6 });
    const s = sim.delivered;
    // Error measured at the target's Z (or at the final rest if it fell short).
    let px = s.x, pz = s.z;
    if (sim.path && sim.path.length) {
      let pick = null;
      for (const p of sim.path) if (p.z >= target.tz && !pick) pick = p;
      if (pick) { px = pick.x; pz = pick.z; }
    }
    const err = Math.hypot(px - target.tx, pz - target.tz);
    if (err < best.err) best = { sim, err, aim };
    if (i === iters) break;
    const run = Math.max(4, dist(HACK.x, HACK.z, px, pz));
    const dErr = (px - target.tx);
    aim = clamp(aim + (dErr * 180) / (Math.PI * run), -8, 8);
    if (Math.abs(dErr) < 0.06) break;
  }
  return best;
}

/**
 * The brushing a CPU considers. A player holds a key for as long as they like; a
 * CPU has to plan a window, so it considers the whole run, or the first/last
 * RULES.CPU_SWEEP_WINDOW seconds of it. Which window is worth anything is decided by
 * simulating them (chooseShot scores every candidate with every window), not by
 * guesswork — on this curl law brushing early is where both the distance and the
 * straightening come from, and the tail window is nearly free of both, which is
 * exactly the kind of thing a menu should not have to know in advance.
 */
function sweepOptions(shot, travelTime) {
  const T = travelTime || 9;
  const w = RULES.CPU_SWEEP_WINDOW;
  const opts = [null, { startT: 0, endT: T + 10 }];      // not at all / the whole run
  if (T > w) { opts.push({ startT: 0, endT: w }); opts.push({ startT: T - w, endT: T }); }
  return opts;
}

/**
 * Build the candidate menu from the current sheet + situation.
 * Mirrors the priorities in GAME_PROMPT.md "Strategy Layer & CPU Opponent":
 * no hammer -> open with a centre guard, then come-arounds and draws;
 * with hammer -> corner guard and hunt a multiple, or blank to keep the hammer.
 */
export function candidateMenu(ctx) {
  const { stones, team, shotIndex, score, end, hammer } = ctx;
  const opp = otherTeam(team);
  const live = stones.filter(s => !s.removed);
  const mine = live.filter(s => s.team === team);
  const theirs = live.filter(s => s.team === opp);
  const inHouseMine = mine.filter(inHouse).sort((a, b) => distanceToButton(a) - distanceToButton(b));
  const theirCounters = theirs.filter(inHouse).sort((a, b) => distanceToButton(a) - distanceToButton(b));
  const guards = live.filter(inFreeGuardZone);
  const myGuards = guards.filter(s => s.team === team);
  const theirGuards = guards.filter(s => s.team === opp);
  const cands = [];
  const order = ctx.order || throwingOrder(hammer);
  const hasHammer = hammer === team;          // NOTE: `hammer` is a team id, always truthy
  // GAME_PROMPT: "without hammer opens with a centre guard; with hammer plays a
  // corner guard". By the rules the hammer team throws its first stone of the
  // end second, so this keys on *our* first throw of the end, not shotIndex 0.
  const myFirstThrowOfEnd = order.slice(0, shotIndex).filter(t => t === team).length === 0;
  const trailingLate = score[team] < score[opp] && end >= RULES.ENDS - 1;
  const stonesLeft = RULES.STONES_PER_PLAYER_PER_END - Math.floor(shotIndex / 2); // my stones left incl. this one

  const push = (c) => { cands.push(c); return c; };

  // --- Opening stone for this team: the prompt prescribes the shape, so the
  //     menu is restricted to guards; the search still decides *which* guard
  //     (line, distance, curl) suits the sheet and the score.
  if (myFirstThrowOfEnd) {
    if (hasHammer) {
      // With the hammer: a corner guard, hunting a multiple later in the end.
      for (const x of [1.4, 1.7, 2.0]) {
        for (const z of [8.5, 9.5, 10.5]) push({ kind: 'GUARD', label: 'CORNER GUARD', tx: x, tz: z, spins: [0, -1, 1], bonus: 20 });
      }
    } else {
      for (const z of [7.0, 8.0, 9.0, 10.0]) push({ kind: 'GUARD', label: 'CENTRE GUARD', tx: 0, tz: z, spins: [0], bonus: 24 });
      // A "come around later" setup: a slightly offset guard that leaves a lane.
      push({ kind: 'GUARD', label: 'CENTRE GUARD', tx: 0.35, tz: 9.0, spins: [-1, 1], bonus: 16 });
    }
    return cands;
  }

  // --- always-available attacking and defensive shapes
  push({ kind: 'DRAW', label: 'DRAW TO THE BUTTON', tx: 0, tz: SHEET.teeZ, spins: [0, 1, -1, 2, -2], bonus: 10 });
  push({ kind: 'DRAW', label: 'DRAW AROUND', tx: 0.75, tz: SHEET.teeZ, spins: [1, 2, 3], bonus: 6 });
  push({ kind: 'DRAW', label: 'DRAW AROUND', tx: -0.75, tz: SHEET.teeZ, spins: [-1, -2, -3], bonus: 6 });
  push({ kind: 'DRAW', label: 'SHOOT THE CORNER', tx: 1.0, tz: SHEET.teeZ - 0.4, spins: [1, 2, 3], bonus: 0 });
  push({ kind: 'DRAW', label: 'SHOOT THE CORNER', tx: -1.0, tz: SHEET.teeZ - 0.4, spins: [-1, -2, -3], bonus: 0 });
  push({ kind: 'RAISE', label: 'HIT AND ROLL', tx: 0, tz: SHEET.teeZ + 1.1, spins: [1, -1], weightBias: 0.14, bonus: 2 });

  // come-around: bend around an existing guard to the button (Wikipedia:
  // "a come-around is a draw shot that curves around a guard"). The heaviest
  // handle turn is the whole point of the shot, so ±3 is in the menu here.
  for (const g of myGuards.concat(theirGuards)) {
    const side = g.x >= 0 ? 1 : -1;
    push({ kind: 'DRAW', label: 'COME AROUND', tx: 0.5 * side, tz: SHEET.teeZ,
      spins: side > 0 ? [1, 2, 3] : [-1, -2, -3], bonus: 14 });
  }

  // cover the button (defensive: stop in front of the button, inside the house
  // so the guard zone does not apply).
  if (theirCounters.length) {
    push({ kind: 'DRAW', label: 'COVER THE BUTTON', tx: 0, tz: SHEET.teeZ - 1.1, spins: [0], bonus: 8 });
  }

  // --- takeouts
  for (const t of theirCounters.slice(0, 3)) {
    push({ kind: 'TAKEOUT', label: 'TAKE OUT', tx: t.x, tz: t.z, spins: [0], weightBias: 0.30, bonus: 6 });
    // freeze: stop touching it rather than hitting it through.
    const back = norm(t.x - HACK.x, t.z - HACK.z);
    push({ kind: 'DRAW', label: 'FREEZE ON IT', tx: t.x - back.x * (DMIN + 0.03), tz: t.z - back.z * (DMIN + 0.03),
      spins: [0, 1, -1], bonus: 4 });
  }
  if (theirCounters.length >= 2) {
    const front = theirCounters[theirCounters.length - 1];
    push({ kind: 'TAKEOUT', label: 'RUN THROUGH', tx: front.x, tz: front.z, spins: [0], weightBias: 0.45, bonus: 4 });
  }
  // clear my own mess if my own stones are the counters (bad for me with the
  // opponent unable to score? only relevant if I am scoring — leave the search).
  if (theirCounters.length === 0 && inHouseMine.length && score[team] >= score[opp] && !hammer) {
    push({ kind: 'TAKEOUT', label: 'CLEAR MY OWN STONE', tx: inHouseMine[0].x, tz: inHouseMine[0].z, spins: [0], weightBias: 0.30, bonus: 2 });
  }

  // --- blank the end to keep the hammer (Wikipedia: "a team may deliberately
  //     blank an end to retain the hammer"), only when it is worth it.
  if (hasHammer && trailingLate && stonesLeft <= 2) {
    push({ kind: 'TAKEOUT', label: 'BLANK THE END', tx: 0, tz: SHEET.teeZ, spins: [0], weightBias: 0.55, bonus: 30 });
    push({ kind: 'TAKEOUT', label: 'CLEAR THE HOUSE', tx: 0, tz: SHEET.teeZ - 0.5, spins: [0], weightBias: 0.55, bonus: 24 });
  }
  return cands;
}

function norm(x, z) { const d = Math.hypot(x, z) || 1; return { x: x / d, z: z / d }; }

/**
 * Choose the CPU's shot.
 * @param ctx {{stones, team, shotIndex, score, end, hammer, difficulty, seed}}
 * @returns {{name,aimDeg,spin,power,sweep,note,value,evaluations}}
 */
export function chooseShot(ctx) {
  const diff = DIFFICULTY[ctx.difficulty || 'normal'];
  const rng = ctx.rng || makeRng(ctx.seed ?? 7);
  const stones = cloneStones(ctx.stones);
  const shotId = 'cpu-shot';

  // How many of the opponent's stones are still to come in this end: the single
  // most important piece of context for a skip (the hammer decides the end).
  const order = ctx.order || throwingOrder(ctx.hammer);
  const oppLeft = order.slice(ctx.shotIndex + 1).filter(t => t !== ctx.team).length;
  const evalCtx = { oppThrowsLeft: oppLeft };

  // Value the sheet from the CPU's point of view; the opponent's perspective is
  // handled by sheetValue's sign flip.
  const baseValue = sheetValue(stones, ctx.team, ctx.hammer === ctx.team ? ctx.team : null, evalCtx);

  const seen = new Map();      // sim cache keyed by the executed parameters
  let best = null;
  const evaluations = [];

  const menu = candidateMenu(ctx);
  for (const cand of menu) {
    const straight = dist(HACK.x, HACK.z, cand.tx, cand.tz);
    let power = powerForDistance(straight);
    if (cand.kind === 'TAKEOUT') power = Math.max(power, 0.80 + cand.weightBias * 0.3);
    power = clamp(power + (cand.weightBias || 0), 0.30, 1.0);

    for (const spin of cand.spins) {
      const shot0 = { team: ctx.team, id: shotId, aimDeg: 0, spin, power };
      const solved = solveAim(stones, shot0, cand);
      const aimDeg = solved.aim;
      const sweepList = cand.kind === 'TAKEOUT' ? [null] : sweepOptions(shot0, solved.sim && solved.sim.travelTime);
      for (const sw of sweepList) {
        // The unswept variant is exactly the simulation the aim solve already ran.
        let sim = sw === null ? solved.sim : null;
        const key = sw === null ? null
          : `${aimDeg.toFixed(2)}|${spin}|${power.toFixed(3)}|${sw.startT.toFixed(2)}-${sw.endT.toFixed(2)}`;
        if (!sim) {
          const cached = seen.get(key);
          sim = cached || simulateDelivery(stones, { team: ctx.team, id: shotId, aimDeg, spin, power, sweep: sw }, { id: shotId });
          seen.set(key, sim);
        }
        // The adapted free guard zone: an illegal take-in would be undone by the
        // game, so the CPU simply does not play it.
        const after = {}; for (const s of sim.world.stones) after[s.id] = s;
        if (guardZoneViolation(stones, after, sim.delivered, ctx.shotIndex).length) continue;

        let v = sheetValue(sim.world.stones.filter(s => !s.removed), ctx.team,
          ctx.hammer === ctx.team ? ctx.team : null, evalCtx);
        // Prefer shots that keep our stone in play near the house, and penalise
        // burning a stone out of play outright.
        if (sim.delivered.removed) v -= 18;
        else if (inHouse(sim.delivered) && sim.delivered.team === ctx.team) v += 6;
        v += cand.bonus || 0;
        // Blanking intentionally: reward the blank itself, since keeping the
        // hammer is the point of the shot.
        if (cand.label === 'BLANK THE END') {
          const res = scoreEnd(sim.world.stones);
          if (res.blank) v += 26; else v -= 8;
        }
        evaluations.push({ label: cand.label, kind: cand.kind, value: v, aimDeg, spin, power, sweep: sw });
        if (!best || v > best.value) {
          best = { name: cand.label, kind: cand.kind, aimDeg, spin, power, sweep: sw, value: v };
        }
      }
    }
  }

  if (!best) {
    // Nothing legal at all (shouldn't happen): throw a plain house guard.
    best = { name: 'SAFE GUARD', kind: 'GUARD', aimDeg: 0, spin: 0, power: powerForDistance(23), sweep: null, value: 0 };
  }

  // --- execution noise scaled by difficulty: the CPU plays the shot it picked,
  //     imperfectly, exactly like a human skip under pressure.
  const aimJitter = (rng() * 2 - 1) * diff.aimDeg;
  const powerJitter = (rng() * 2 - 1) * diff.power;
  let spin = best.spin;
  if (diff.spinMistake > 0 && rng() < diff.spinMistake) {
    const steps = RULES.SPIN_LEVELS;
    const i = clamp(steps.indexOf(spin) + (rng() < 0.5 ? -1 : 1), 0, steps.length - 1);
    spin = steps[i];
  }
  const aimDeg = clamp(best.aimDeg + aimJitter, -RULES.AIM_MAX_DEG, RULES.AIM_MAX_DEG);
  const power = clamp(best.power + powerJitter, 0.30, 1.0);

  // Brushing discipline: a weaker CPU is worse at judging whether brushing helps at
  // all, and starts late when it does. (It no longer has a budget to clip — the
  // player does not either.)
  let sweep = best.sweep;
  if (sweep && rng() > diff.sweepSkill) sweep = null;
  if (sweep) {
    const hesitate = (1 - diff.sweepSkill) * 0.8;          // seconds of dithering
    sweep = { startT: sweep.startT + rng() * hesitate, endT: sweep.endT };
  }

  return {
    name: best.name, kind: best.kind, aimDeg, spin, power, sweep,
    intendedAim: best.aimDeg, intendedPower: best.power, intendedSpin: best.spin,
    value: best.value, baseValue, planEvaluations: evaluations.length,
  };
}
