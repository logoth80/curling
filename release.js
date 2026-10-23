// release.js — how far a thrown stone may be from the shot that was called.
//
// Nothing here adds a random force to the world; physics.js stays deterministic and
// the fixed-step sim stays replayable. What is random is the *input*, and it is
// drawn once, at the release: a handle load and a line angle are rolled against a
// table of release quality, because a delivery is a physical act. A game in which
// every delivery is exactly what the interface selected asks the player for a
// precision no thrower has, and it makes the preview a promise instead of a call.
//
// The four tiers are the ones the game asks for: 50% good, 25% ok, 12% mediocre,
// 12% bad. Those weights add to 99, so they are used as *weights* and normalised
// rather than read as percentages — the ratio stays exactly as specified and no
// unclaimed 1% quietly lands in some tier.
//
// Two things can go wrong, and they are different in kind:
//
//   handle   the stone is turned a little too hard or too little. This is a
//            fraction of a handle level, which is how curl is parameterized at all
//            (it is linear in spin), so it is the natural unit for the error.
//   line     the stone is released a fraction of a degree off the line it was
//            sighted along. It is specified in centimetres at the end of the line
//            this throw is aiming at, because that is what a player actually
//            notices, and converted here — physics.js states its own sensitivity
//            in solveAim (dx/daim ~= -run length), so
//
//                angle_rad = atan(offset_m / run_m)
//
//            At the standard line — a 30 m draw, hack to button — that is
//            atan(0.05/30) = 0.0955 degrees for five centimetres and 0.191 for
//            ten. Those are the figures quoted in the README. What gets applied to
//            a throw is derived against that throw's own unbrushed run, so a raise
//            gets the same centimetres at *its* end rather than a smaller share of
//            them, and the run used is the unbrushed one because that is the line
//            the preview and the weight miniature show.
//
// The CPU does not come through this table. Its inaccuracy is its difficulty ladder
// (DIFFICULTY in ai.js), which models something else: a plan chosen badly as well as
// thrown badly. The ladder and this table are checked against each other in
// tests/matchtest.mjs so they cannot drift apart unnoticed.
//
// Pure module: no THREE, no DOM, no timers — the same reason physics.js and track.js
// import nothing, and why this file can be tested from Node at all.

import { RULES, distanceForPower } from './physics.js';

/**
 * The table. `spin` is a ± span in handle levels, `line` is a ± span in metres at
 * the end of this throw. `weight` is a draw weight, not a probability; the four
 * sum to 99 by construction and are normalised below.
 */
export const RELEASE_TIERS = [
  { name: 'good',     label: 'clean release', weight: 50, spin: 0.10, line: 0.00 },
  { name: 'ok',       label: 'slightly off',  weight: 25, spin: 0.10, line: 0.05 },
  { name: 'mediocre', label: 'loose release', weight: 12, spin: 0.20, line: 0.05 },
  { name: 'bad',      label: 'bad release',   weight: 12, spin: 0.20, line: 0.10 },
];

const TOTAL_WEIGHT = RELEASE_TIERS.reduce((s, t) => s + t.weight, 0);
const SPAN = Math.max(...RULES.SPIN_LEVELS.map(Math.abs));   // the handle range that is calibrated
const RAD2DEG = 180 / Math.PI;

/** The line angle, in degrees, that puts `metres` of error at `runM` metres out. */
export function angleForOffset(metres, runM) {
  return Math.atan(metres / Math.max(1, runM)) * RAD2DEG;
}

/**
 * Draw one release. The generator is the match's own seeded one and the three draws
 * below happen in a fixed order, so a seed replays a match exactly even though a
 * roll sits inside every delivery.
 *
 * @param {()=>number} rng        seeded generator (makeRng in ai.js)
 * @param {{power:number}} shot   the shot as selected; only its weight decides the
 *                                reference distance
 * @returns {{tier,label,runM,offCm,spinErr,aimDegErr}}
 */
export function rollRelease(rng, shot) {
  let r = rng() * TOTAL_WEIGHT;
  let tier = RELEASE_TIERS[RELEASE_TIERS.length - 1];
  for (const t of RELEASE_TIERS) {
    r -= t.weight;
    if (r < 0) { tier = t; break; }
  }

  const runM = Math.max(1, distanceForPower(shot.power));  // unbrushed: what the preview showed
  const lineM = tier.line * (rng() * 2 - 1);
  const spinErr = tier.spin * (rng() * 2 - 1);
  // Exactly zero for a clean release: a good delivery must not drift at all, and
  // rounding a zero through atan() would make "clean" mean "slightly off".
  const aimDegErr = lineM === 0 ? 0 : angleForOffset(lineM, runM);

  return { tier: tier.name, label: tier.label, runM, offCm: lineM * 100, spinErr, aimDegErr };
}

/**
 * The selected shot with this release applied. The selection is never mutated — the
 * preview, the miniature and the HUD keep showing what was asked for, which is the
 * whole point of rolling at the release instead of at the aiming.
 */
export function applyRelease(shot, r) {
  return {
    ...shot,
    // Not clamped to RULES.AIM_MAX_DEG on purpose: that limit belongs to the
    // control surface, not to the ice, and folding a release back at the edge would
    // quietly make the worst shots at full aim better than the worst shots at zero.
    aimDeg: shot.aimDeg + r.aimDegErr,
    // The handle *is* capped: the curl calibration in CAL is stated per level, so
    // a load beyond the strongest handle the game models is outside what is tested.
    spin: Math.max(-SPAN, Math.min(SPAN, shot.spin + r.spinErr)),
  };
}

/** One line for the shot log, exactly as printed: `loose release · handle −0.14 · line +6.2 cm`. */
export function describeRelease(r) {
  const sgn = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
  return `${r.label} · handle ${sgn(r.spinErr)} · line ${sgn(r.offCm, 1)} cm`;
}
