// release.js — how far a thrown stone may be from the shot that was called.
//
// Nothing here adds a random force to the world; physics.js stays deterministic and
// the fixed-step sim stays replayable. What is random is the *input*, and it is
// drawn once, at the release: a handle load and a weight are rolled against a table of
// release quality, because a delivery is a physical act. A game in which every delivery
// is exactly what the interface selected asks the player for a precision no thrower
// has, and it makes the preview a promise instead of a call.
//
// The four tiers arrive at the frequencies the game asks for — 50% good, 25% ok, 12%
// mediocre, 12% bad. Those weights add to 99, so they are used as *weights* and
// normalised rather than read as percentages: the ratio stays exactly as specified and
// no unclaimed 1% quietly lands in some tier.
//
// Two things can go wrong, and they are different in kind:
//
//   handle   the stone is turned a little too hard or too little. This is a fraction
//            of a handle level, which is how curl is parameterized at all (it is
//            linear in spin), so it is the natural unit for the error.
//   weight   the stone goes a little too far or not far enough. This is where a
//            delivery is really made or missed: the release either carries the stone
//            the distance that was called or it does not, and the miss is along the
//            line the player already sighted, which is the direction that decides
//            whether a stone is scoring.
//
// The weight span is expressed as a fraction of *the delivery that was called* — 0.15
// means up to fifteen per cent long or short of the distance the meter and the weight
// miniature were showing, measured against the unbrushed run, because that is what the
// preview promised and brushing is a separate effect the player chose. It is
// deliberately not a percentage of the meter value, and the difference is large:
// travel is quadratic in speed — it is the stopping law physics.js states and which
// `distanceForPower` implements — so a percentage of the
// power number is about 2.2 times the same percentage of the distance. Measured on this
// game's own calibration — a 30 m draw sits at power 0.700 — ±2% of the meter value is
// ±1.21 m long / −1.19 m short, and ±15% is +9.68 m / −8.32 m. Read that way, even a
// clean release would miss by two thirds of the house and a bad one would leave the
// sheet, so the two ends of the scale the game asks for would be indistinguishable.
// Read as a share of the called delivery, the same tiers mean 0.60 m and 4.50 m at a
// 30 m draw: a difference a player would still call a good draw, and one that carries
// the stone through the house and out past the back line at Z = 18.4 m.
//
// That reading also sizes the error to the shot, which is the other half of what makes
// a weight error real. At a 20 m raise 15% is 3.00 m, which stops the stone at
// Z = +1.97 m, short of the far hog line the delivered stone must fully pass
// (`SHEET.hogFarZ`, enforced at rest by `hogViolation` in physics.js) — the delivery is
// taken out of play, which is the thing that really does happen to a bad release. At a
// 12 m raise 15% is 1.80 m, and at a 30 m draw it is 4.50 m, which carries the stone
// through the house and out past the back line. A hard takeout and a soft guard are
// wrong by the same share of what they were asked to be, not by the same amount.
//
// The conversion is delegated, not invented: `powerForDistance` is the rules module's
// own inverse stopping law, so the share becomes the power that produces it and no new
// constant enters the world — the same discipline the curl calibration follows. The
// power is then kept inside the calibrated range: `launchSpeed` clamps there and the
// whole deceleration/curl calibration is stated in it. Inside the meter's own travel
// band the clamp never binds — the heaviest thing the meter can select is 36 m of
// travel, and fifteen per cent past that is power 0.822 — so it is defensive, and it is
// there because a shot built by hand, or by a test, is not obliged to stay inside that
// band. The metre figure reported afterwards is computed from the power that was
// actually applied, so the shot log describes the delivery that happened rather than the
// one that was intended.
//
// There is no line error. A player's aim is exactly the line they sighted, and the
// uncertainty in a human delivery now sits entirely in weight and handle. That is a
// deliberate consequence of the change above, and it is also the point at which the two
// error models in this game stop being symmetric: the CPU's aim noise is its difficulty
// ladder (DIFFICULTY in ai.js), which models a plan chosen badly as well as a delivery
// thrown badly, and it has an aim error because it has a plan. tests/matchtest.mjs
// group 9 is where that asymmetry is written down and measured, so neither side can
// drift without someone noticing.
//
// Pure module: no THREE, no DOM, no timers — the same reason physics.js and track.js
// import nothing, and why this file can be tested from Node at all.

import { RULES, distanceForPower, powerForDistance } from './physics.js';

/**
 * The table. `spin` is a ± span in handle levels. `power` is a ± span in the *called
 * delivery*: 0.02 is up to two per cent long or short of the distance that was set,
 * 0.15 up to fifteen per cent — not a percentage of the meter value, see above.
 * `weight` is a draw weight, not a probability; the four sum to 99 by construction and
 * are normalised below.
 */
export const RELEASE_TIERS = [
  { name: 'good',     label: 'clean release', weight: 50, spin: 0.10, power: 0.02 },
  { name: 'ok',       label: 'slightly off',  weight: 25, spin: 0.20, power: 0.05 },
  { name: 'mediocre', label: 'loose release', weight: 12, spin: 0.40, power: 0.09 },
  { name: 'bad',      label: 'bad release',   weight: 12, spin: 0.40, power: 0.15 },
];

const TOTAL_WEIGHT = RELEASE_TIERS.reduce((s, t) => s + t.weight, 0);
const SPAN = Math.max(...RULES.SPIN_LEVELS.map(Math.abs));   // the handle range that is calibrated

/** Power is the calibrated range: outside it the game has no tested stopping law. */
function clampPower(p) {
  return Math.max(0, Math.min(1, p));
}

/**
 * Draw one release. The generator is the match's own seeded one and the three draws
 * below happen in a fixed order, so a seed replays a match exactly even though a
 * roll sits inside every delivery.
 *
 * @param {()=>number} rng        seeded generator (makeRng in ai.js)
 * @param {{power:number}} shot   the shot as selected; its weight is the reference
 * @returns {{tier,label,runM,metres,pct,powerErr,spinErr}}  metres/pct describe the
 *          delivery that will actually be thrown, after the clamp above
 */
export function rollRelease(rng, shot) {
  let r = rng() * TOTAL_WEIGHT;
  let tier = RELEASE_TIERS[RELEASE_TIERS.length - 1];
  for (const t of RELEASE_TIERS) {
    r -= t.weight;
    if (r < 0) { tier = t; break; }
  }

  const runM = Math.max(1, distanceForPower(shot.power));    // unbrushed: what the preview showed
  const share = tier.power * (rng() * 2 - 1);                // signed share of the called delivery
  const power = clampPower(powerForDistance(runM * (1 + share)));
  const powerErr = power - shot.power;
  const spinErr = tier.spin * (rng() * 2 - 1);

  // Reported from the power that will actually be launched, so that a share folded back
  // by the clamp above is described the way the ice will see it, not as it was asked.
  const metres = distanceForPower(shot.power + powerErr) - runM;

  return {
    tier: tier.name, label: tier.label, runM,
    metres, pct: metres / runM, powerErr, spinErr,
  };
}

/**
 * The selected shot with this release applied. The selection is never mutated — the
 * preview, the miniature and the HUD keep showing what was asked for, which is the
 * whole point of rolling at the release instead of at the aiming.
 */
export function applyRelease(shot, r) {
  return {
    ...shot,
    // The share was resolved into a power through the rules module's own inverse law,
    // so applying it is arithmetic, not a second interpretation of the roll.
    power: clampPower(shot.power + r.powerErr),
    // The handle *is* capped: the curl calibration in CAL is stated per level, so
    // a load beyond the strongest handle the game models is outside what is tested.
    spin: Math.max(-SPAN, Math.min(SPAN, shot.spin + r.spinErr)),
    // The line is not touched: see the note above on there being no aim error.
  };
}

/**
 * One line for the shot log, exactly as printed:
 * `loose release · handle −0.14 · weight −9% · 2.1 m short`. Under a decimetre of
 * error the delivery made its distance, and the word for that is dead weight.
 */
export function describeRelease(r) {
  const sgn = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
  const weight = Math.abs(r.metres) < 0.1
    ? 'dead weight'
    : `weight ${r.pct >= 0 ? '+' : '−'}${Math.abs(r.pct * 100).toFixed(0)}% · ${Math.abs(r.metres).toFixed(1)} m ${r.metres >= 0 ? 'long' : 'short'}`;
  return `${r.label} · handle ${sgn(r.spinErr)} · ${weight}`;
}
