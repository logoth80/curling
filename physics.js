/**
 * physics.js — curling rules + deterministic fixed-timestep stone physics.
 *
 * This module is deliberately free of THREE.js and DOM code so it can be unit
 * tested in plain Node (`node tests/selftest.mjs`) and reused by ai.js.
 *
 * Rules modelled (adapted from the GAME_PROMPT.md sources):
 *  - Sheet / house rings / hack / hog line / back line:
 *    https://en.wikipedia.org/wiki/Curling  and  https://en.wikipedia.org/wiki/Glossary_of_curling
 *  - Scoring "counters", blank ends, the 12-foot house and biters:
 *    https://en.wikipedia.org/wiki/Curling#Scoring
 *  - Deliberate stone must fully pass the far hog line; stones completely
 *    past the back line / sideline are removed:
 *    https://en.wikipedia.org/wiki/Glossary_of_curling#Hog_line, #Back_line
 *  - Free Guard Zone (the real rule: the first five stones delivered in an end):
 *    https://en.wikipedia.org/wiki/Glossary_of_curling#Free_guard_zone
 *  - Sweeping = "travel farther and curl less":
 *    https://en.wikipedia.org/wiki/Curling#Sweeping
 *
 * Coordinate contract (game scale, metres, Y-up engine axis):
 *   X = lateral (centre line at X = 0), Z = down-ice (+Z toward the house).
 *   A player throws from Z = -15 toward +Z, so "the thrower's right" is -X.
 */

// ---------------------------------------------------------------------------
// Sheet geometry (GAME_PROMPT.md "Sheet Geometry & Coordinates")
// ---------------------------------------------------------------------------
export const SHEET = {
  length: 34,            // Z extent of the sheet mesh (ice is extended behind the back line by the asset)
  width: 4.88,           // real sheet width — https://en.wikipedia.org/wiki/Curling#Sheet
  hackZ: -15,            // delivery point
  teeZ: 15,              // house centre ("tee")
  backLineZ: 18.4,
  hogFarZ: 3,
  hogNearZ: -8,
  teeLineZ: 15,
  rings: { twelve: 1.83, eight: 1.22, four: 0.61, button: 0.15 }, // 12/8/4-ft rings + button
  stoneRadius: 0.145,    // 0.29 m diameter
  stoneHeight: 0.114,
};

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------

/**
 * Calibration anchors — the prompt's "must tune to this" block is the source of
 * truth, and every physics constant below is DERIVED from it.
 *
 * The prompt also quotes `a = 0.11 m/s^2` (a regulation-ice value), but that
 * value is incompatible with its own targets: a 30 m draw (hack at -15 to the
 * button at +15) under a = 0.11 needs v0 = 2.57 m/s and takes t = v0/a = 23 s,
 * while the prompt demands 6-9 s. The two targets that actually matter for play
 * are "70% power stops on the button" and "6-9 s travel", which jointly fix
 * v0 and a. So the deceleration is scaled up by TIME_SCALE ≈ 10.5 from the
 * quoted value and the *ratios* the prompt cares about are preserved where the
 * control design still matches it:
 *   - curl stays proportional to spin * (v / v_max), reduced while sweeping
 *   - the brief's swept : base deceleration of 0.09 : 0.11 (~18% more distance
 *     over a 3 s swept window) is NOT kept: the game lets a player brush the
 *     whole path, so a per-second effect sized for a 3 s window would be several
 *     times too large over a 7 s draw. See PHYS.A_SWEEP (~7% over a full run) and
 *     the deviations section of README.md.
 *
 * See tests/selftest.mjs — every derived constant below is asserted against the
 * prompt's acceptance numbers.
 */
export const CAL = {
  drawDistance: 30,     // hack (-15) -> button (+15): the 70%-power anchor
  drawTime: 7.2,        // centre of the mandated 6-9 s travel window (s)
  drawPower: 0.70,      // power that must produce the button draw
  curlTarget: 1.45,     // centre of the mandated 1.2-1.8 m curl band (spin ±2)
};

// s = v0*t/2 for constant deceleration, and a = v0/t:
export const V0_DRAW = (2 * CAL.drawDistance) / CAL.drawTime;        // 8.33 m/s
export const A_DRAW = V0_DRAW / CAL.drawTime;                        // 1.157 m/s^2
export const V_MAX = V0_DRAW / CAL.drawPower;                        // 11.90 m/s at 100% power
export const TIME_SCALE = A_DRAW / 0.11;                             // 10.52x the quoted deceleration

/**
 * CURL_C. With a⊥ = C*spin*(v/vmax) the heading turns at a constant rate
 * dθ/dt = a⊥/v = C*spin/vmax, and the sideways offset of a stone that runs the
 * whole sheet is exactly
 *      dx = C * spin * v0^3 / (6 * vmax * a^2)
 * (the naive "fixed acceleration direction" estimate is twice this — the
 * perpendicular direction rotates with the velocity; the sim and the closed
 * form agree in tests/selftest.mjs).
 *
 * The prompt's nominal C = 0.05 cannot meet its own curl band: at the draw
 * anchor it gives 0.61 m here, and on the prompt's unscaled numbers
 * (a = 0.11, v0 = 2.57, vmax = 3.67) it gives 6.4 m. The band is the binding
 * requirement, so C is solved from it. Result: a ±2 spin arc bends ~1.45 m over
 * 30 m, which the ±6° aim range can fully compensate (30 m · tan 6° = 3.1 m).
 */
export const CURL_C =
  (6 * V_MAX * CAL.curlTarget * A_DRAW * A_DRAW) / (V0_DRAW * V0_DRAW * V0_DRAW * 2);

export const PHYS = {
  DT: 1 / 120,                          // fixed 120 Hz simulation step
  A_BASE: A_DRAW,                       // base deceleration (0.11 * TIME_SCALE)
  // Brushing the ice does reduce friction and curl
  // (https://en.wikipedia.org/wiki/Sweeping_(curling)) — how much is the adaptation.
  // The player may now brush for the whole path, so the per-second effect has to be
  // small: a factor that mattered over 3 s would be absurd over a 7 s draw. 0.93 on
  // the deceleration buys ~7% of extra distance over an entire run — about 2 m on a
  // 30 m delivery — which changes whether a stone holds the line without making the
  // weight you chose meaningless.
  A_SWEEP: A_DRAW * 0.93,
  CURL_C,                               // derived above (~0.12 on this time base)
  // "Sweep it straight" is real, and with unlimited brushing the previous half-force
  // dominated the shot. 0.7 keeps the choice meaningful and the arc still yours.
  CURL_SWEEP_FACTOR: 0.7,
  RESTITUTION: 0.95,                    // equal-mass elastic circle-circle impulse
  V_MAX,                                // speed at power = 100%
  STOP_EPS: 0.02,                       // below this a stone is considered stopped
  MAX_SHOT_TIME: 40,                    // safety cap (s)
};

export const RULES = {
  // Eight stones per player per end is the real format
  // (https://en.wikipedia.org/wiki/Curling#Play:_teams_and_positions); the brief's
  // four was a shortening, and it has now been lifted back to the real number.
  STONES_PER_PLAYER_PER_END: 8,
  ENDS: 4,                              // adapted from 8-10
  DRAW_POWER: CAL.drawPower,            // 70% -> button draw, kept for tests/UI labels
  // The WFG free guard zone protects the first five stones delivered in an end
  // (https://en.wikipedia.org/wiki/Curling#Free_guard_zone). With eight stones a
  // side that is now the real count, so the brief's shortening to 3 is dropped.
  GUARD_ZONE_SHOTS: 5,
  // Brushing is allowed anywhere along the path — from delivery until the stone
  // stops (https://en.wikipedia.org/wiki/Sweeping_(curling)); there is no budget.
  // The cost is not time but line: brushing adds distance and straightens the arc,
  // and both the preview and the weight miniature show the *unbrushed* path, so
  // brushing is a deviation you manage rather than a resource to spend.
  // The number below belongs to the CPU only: a CPU cannot hold a key, it plans a
  // window, and this is how long a partial window it considers.
  CPU_SWEEP_WINDOW: 3.0,
  // --- the weight control ---------------------------------------------------
  // Weight is distance, not effort, so the meter is parameterized in metres of
  // unobstructed travel from the hack and the miniature in track.js draws exactly
  // that range. See meterTravel() below for why a *power* ramp is the wrong
  // control surface (the stone stops at p²·V_MAX²/2a, so a power needle crawls at
  // light weights and leaps through the draw window).
  //   14 m  — the lightest thing worth selecting: anything under the far hog line
  //           (18.1 m) is hogged anyway, and it is the left edge of the widget.
  //   36 m  — the heaviest thing that changes an outcome: the back line is 33.4 m
  //           away, so a stone that would travel 36 m leaves it at 2.5 m/s and is
  //           out of play; anything heavier lands in the same place. That caps the
  //           selectable weight at 77% power, which is a firm takeout.
  POWER_MIN_TRAVEL: 14.0,
  POWER_MAX_TRAVEL: 36.0,
  // One full traverse there and back. The brief said 1.6 s; the needle now moves
  // at a constant 11 m/s of marker speed, so a button draw (2.4 m wide) gets
  // ~0.4 s on each pass — against ~0.09 s from the old power ramp at 1.6 s.
  POWER_METER_SECONDS: 4.0,
  AIM_STEP_DEG: 0.2,
  AIM_MAX_DEG: 6,
  // Real curling has no discrete handle-spin levels — the thrower turns the handle
  // as hard as they like — so these are the game's discrete version of that
  // effort. ±3 is now available; curl scales linearly with the level, so ±3 is
  // ~1.5x the calibrated ±2 arc (see CAL.curlTarget and the curl tests).
  SPIN_LEVELS: [-3, -2, -1, 0, 1, 2, 3],
};

export const TEAMS = { A: 'red', B: 'yellow' }; // real curling: red & yellow handles

const R = SHEET.stoneRadius;

// ---------------------------------------------------------------------------
// Stone + world
// ---------------------------------------------------------------------------

/** @returns a new stone record. `spin` is one of RULES.SPIN_LEVELS (-3..+3). */
export function makeStone({ id, team, x = 0, z = 0, vx = 0, vz = 0, spin = 0, delivered = false }) {
  return { id, team, x, z, vx, vz, spin, radius: R, delivered, removed: false, outReason: null };
}

export function cloneStones(stones) {
  return stones.filter(s => !s.removed).map(s => ({ ...s }));
}

export function speed(s) { return Math.hypot(s.vx, s.vz); }
export function atRest(s) { return !s.removed && speed(s) <= 1e-9; }

/**
 * World of stones stepped at a fixed dt. Deterministic: iteration order is
 * array order and no randomness or wall-clock time is used.
 */
export class StoneWorld {
  constructor(stones = []) {
    this.stones = stones;
    this.time = 0;
    this.events = [];   // collision events, for shot callouts + telemetry
    this.outs = [];     // {stone, reason} removals during this shot
  }

  indexOf(id) { return this.stones.findIndex(s => s.id === id); }

  /**
   * One fixed step. `sweptIndex` = index of the stone currently being swept
   * (or -1). Sweeping lowers deceleration and halves curl.
   * https://en.wikipedia.org/wiki/Curling#Sweeping
   */
  step(dt = PHYS.DT, sweptIndex = -1) {
    const S = this.stones;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (s.removed) continue;
      let sp = Math.hypot(s.vx, s.vz);
      if (sp > PHYS.STOP_EPS) {
        const swept = i === sweptIndex;
        const decel = swept ? PHYS.A_SWEEP : PHYS.A_BASE;
        // Curl: a_perp = C * spin * (v / v_max), perpendicular to velocity.
        // Curvature = a_perp/v^2 grows as the stone slows — "curl grows as the
        // stone slows" (https://en.wikipedia.org/wiki/Curling#Delivery).
        // Positive spin = clockwise = curls to the thrower's right = -X.
        const k = (PHYS.CURL_C * s.spin / PHYS.V_MAX) * (swept ? PHYS.CURL_SWEEP_FACTOR : 1);
        let vx = s.vx + (-k * s.vz) * dt;   // right-of-travel of (vx,vz) is (-vz,vx)
        let vz = s.vz + (k * s.vx) * dt;
        const newSp = Math.max(0, sp - decel * dt);
        const cur = Math.hypot(vx, vz);
        if (newSp <= PHYS.STOP_EPS || cur < 1e-9) { vx = 0; vz = 0; }
        else { const f = newSp / cur; vx *= f; vz *= f; }
        s.vx = vx; s.vz = vz;
        s.x += vx * dt; s.z += vz * dt;
      } else if (sp > 0) { s.vx = 0; s.vz = 0; }
    }

    this.resolveCollisions();
    this.checkOutOfBounds();
    this.time += dt;
  }

  /** Equal-mass circle-circle impulse, restitution ~0.95. */
  resolveCollisions() {
    const S = this.stones, e = PHYS.RESTITUTION, dmin = 2 * R;
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < S.length; i++) {
        const a = S[i]; if (a.removed) continue;
        for (let j = i + 1; j < S.length; j++) {
          const b = S[j]; if (b.removed) continue;
          let dx = b.x - a.x, dz = b.z - a.z;
          let d = Math.hypot(dx, dz);
          if (d >= dmin) continue;
          if (d < 1e-9) { dx = 0; dz = dmin; d = dmin; }
          const nx = dx / d, nz = dz / d;
          const overlap = dmin - d;
          a.x -= nx * overlap * 0.5; a.z -= nz * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.z += nz * overlap * 0.5;
          const vn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz; // >0 == approaching
          if (vn > 0) {
            const imp = (1 + e) * vn / 2; // equal masses -> /(1/m1+1/m2) = /2
            a.vx -= imp * nx; a.vz -= imp * nz;
            b.vx += imp * nx; b.vz += imp * nz;
            if (iter === 0) this.events.push({ t: this.time, a: a.id, b: b.id, speed: vn });
          }
        }
      }
    }
  }

  /**
   * A stone that completely crosses the back line or a sideline is out of play.
   * https://en.wikipedia.org/wiki/Glossary_of_curling#Back_line
   * (The hog-line rule is checked at rest only, because only the *delivered*
   * stone is subject to it — see `hogViolation`.)
   */
  checkOutOfBounds() {
    for (const s of this.stones) {
      if (s.removed) continue;
      if (s.z - R > SHEET.backLineZ) this.removeStone(s, 'back line');
      else if (Math.abs(s.x) + R > SHEET.width / 2) this.removeStone(s, 'sideline');
    }
  }

  removeStone(s, reason) {
    s.removed = true; s.outReason = reason; s.vx = 0; s.vz = 0;
    this.outs.push({ id: s.id, team: s.team, reason });
  }

  anyMoving() {
    return this.stones.some(s => !s.removed && speed(s) > PHYS.STOP_EPS);
  }

  /** Convenience headless runner (the game itself steps the world live). */
  runUntilRest(maxTime = PHYS.MAX_SHOT_TIME, sweepPlan = null, sampleEvery = 0) {
    const path = sampleEvery ? [] : null;
    const sweptIdx = sweepPlan ? this.indexOf(sweepPlan.id) : -1;
    const startT = sweepPlan ? sweepPlan.startT : 0;
    const endT = sweepPlan ? sweepPlan.endT : -1;
    let n = 0;
    while (this.anyMoving() && this.time < maxTime) {
      const sweeping = sweptIdx >= 0 && this.time >= startT && this.time < endT;
      this.step(PHYS.DT, sweeping ? sweptIdx : -1);
      n++;
      if (path && n % sampleEvery === 0) {
        const s = this.stones[sweptIdx];
        if (s) path.push({ x: s.x, z: s.z, t: this.time });
      }
    }
    return path;
  }
}

// ---------------------------------------------------------------------------
// Shot plans, prediction, delivery
// ---------------------------------------------------------------------------

/**
 * A shot = aim angle + spin level + power, plus an optional sweep window.
 * aimDeg > 0 aims to the thrower's right; spin > 0 curls to the thrower's
 * right (clockwise handle), matching the control contract in GAME_PROMPT.md.
 */
export function makeShot({ team, aimDeg = 0, spin = 0, power = 0.5, sweep = null }) {
  return { team, aimDeg, spin, power, sweep };
}

export function launchSpeed(power) { return Math.max(0, Math.min(1, power)) * PHYS.V_MAX; }

/** Inverse of the stopping-distance law: what power is needed to travel `dist` metres. */
export function powerForDistance(dist, swept = false) {
  const a = swept ? PHYS.A_SWEEP : PHYS.A_BASE;
  return Math.sqrt(2 * a * Math.max(0.05, dist)) / PHYS.V_MAX;
}

/**
 * The weight meter, as a rule rather than as pixels.
 *
 * It sweeps *metres of travel* across the sheet at a constant rate and the caller
 * converts that into power with powerForDistance(). Parameterizing it in power is
 * the usual implementation and the wrong control surface: because a stone stops at
 * d = p²·V_MAX²/(2a), a power needle sits almost still for the first third of its
 * travel (light weights all stop in the same few metres) and then tears through
 * the house. Players read that as "it hesitates, then it is too fast", and the
 * button draw — the single most useful weight in curling — gets ~2 frames.
 *
 * Distance is what the miniature in track.js shows and what the player is aiming
 * at, so distance is what moves evenly. The range is exactly the range the widget
 * draws (RULES.POWER_MIN_TRAVEL..POWER_MAX_TRAVEL), so the marker traverses the
 * whole picture, never clamps, and is under the player's eye the entire time.
 *
 * @param {number} t seconds since the first Space press
 * @returns {number} metres of unobstructed travel to aim for
 */
export function meterTravel(t) {
  const period = RULES.POWER_METER_SECONDS;
  const ph = (t % period) / period;
  const tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;   // linear 0->1->0: no easing, no dwell
  return RULES.POWER_MIN_TRAVEL + tri * (RULES.POWER_MAX_TRAVEL - RULES.POWER_MIN_TRAVEL);
}

/**
 * Forward-simulate a delivery over a snapshot of stones.
 * @returns {{world, path, delivered, travelTime, stoppedAt}}
 */
export function simulateDelivery(stones, shot, opts = {}) {
  const world = new StoneWorld(cloneStones(stones));
  const v0 = launchSpeed(shot.power);
  const aim = ((shot.aimDeg || 0) * Math.PI) / 180;
  // aim 0 = straight down-ice (0,1); aim>0 rotates toward -X (thrower's right).
  const dir = { x: -Math.sin(aim), z: Math.cos(aim) };
  const id = opts.id ?? 'shot';
  const stone = makeStone({
    id, team: shot.team, x: opts.x ?? 0, z: SHEET.hackZ,
    vx: dir.x * v0, vz: dir.z * v0, spin: shot.spin || 0, delivered: true,
  });
  world.stones.push(stone);
  const idx = world.stones.length - 1;

  const sweep = shot.sweep;
  const path = opts.path ? [] : null;
  const sample = opts.sampleEvery ?? 8;
  let guard = 0;
  const maxSteps = Math.ceil(PHYS.MAX_SHOT_TIME / PHYS.DT);
  while (world.anyMoving() && world.time < PHYS.MAX_SHOT_TIME && guard < maxSteps) {
    const sweeping = !!(sweep && world.time >= sweep.startT && world.time < sweep.endT);
    world.step(PHYS.DT, sweeping ? idx : -1);
    guard++;
    if (path && guard % sample === 0) path.push({ x: stone.x, z: stone.z, t: world.time });
  }
  if (path && guard % sample !== 0) path.push({ x: stone.x, z: stone.z, t: world.time });
  return { world, path, delivered: stone, travelTime: world.time, stoneId: id };
}

// ---------------------------------------------------------------------------
// Rules: hog line, guard zone, scoring
// ---------------------------------------------------------------------------

/**
 * Delivered stone must come to rest fully beyond the far hog line.
 * https://en.wikipedia.org/wiki/Glossary_of_curling#Hog_line
 */
export function hogViolation(stone) {
  return stone.delivered && stone.z - R < SHEET.hogFarZ;
}

/** True when a stone lies in the protected free-guard-zone region. */
export function inFreeGuardZone(stone) {
  if (stone.removed) return false;
  const dz = stone.z - SHEET.teeZ;
  const inBand = stone.z > SHEET.hogFarZ && stone.z < SHEET.teeLineZ;
  const outsideEight = Math.hypot(stone.x, dz) > SHEET.rings.eight + R;
  return inBand && outsideEight;
}

/**
 * Free Guard Zone: for the first RULES.GUARD_ZONE_SHOTS stones delivered in an
 * end the delivered stone may not remove an opponent guard from that zone. Five
 * is the WFG number for a full end; the prompt shortened it for a short end.
 * https://en.wikipedia.org/wiki/Curling#Free_guard_zone
 * @returns string[] ids of opponent guards that were illegally removed ([]) if fine.
 */
export function guardZoneViolation(before, afterById, deliveredStone, shotIndexInEnd) {
  if (shotIndexInEnd >= RULES.GUARD_ZONE_SHOTS) return [];
  const bad = [];
  for (const b of before) {
    if (b.team === deliveredStone.team) continue;   // only opponent stones are protected
    if (!inFreeGuardZone(b)) continue;
    const now = afterById[b.id];
    if (!now || now.removed) bad.push(b.id);
  }
  return bad;
}

/** Distance from the tee (button) centre, used for counting and drawing lines. */
export function distanceToButton(s) { return Math.hypot(s.x, s.z - SHEET.teeZ); }

/**
 * A stone counts if it is touching the 12-foot house ring. A "biter" — a stone
 * just biting the outer edge — counts (Glossary of curling #Biter), so the test
 * uses stone centre within ring radius + stone radius.
 */
export function inHouse(s) {
  return !s.removed && distanceToButton(s) <= SHEET.rings.twelve + R;
}

/**
 * Scoring: only one team scores per end, one point per own stone closer to the
 * button than the opponent's best ("counters"). 0-0 == blank end.
 * https://en.wikipedia.org/wiki/Curling#Scoring
 */
export function scoreEnd(stones) {
  const live = stones.filter(s => !s.removed && inHouse(s));
  const best = { A: null, B: null };
  for (const s of live) {
    const d = distanceToButton(s);
    if (!best[s.team] || d < best[s.team].d) best[s.team] = { id: s.id, d, x: s.x, z: s.z };
  }
  if (!best.A && !best.B) return { team: null, points: 0, counting: [], best, blank: true };
  if (!best.A) return tally('B', best, live);
  if (!best.B) return tally('A', best, live);
  return best.A.d < best.B.d ? tally('A', best, live) : tally('B', best, live);
}

function tally(team, best, live) {
  const other = best[team === 'A' ? 'B' : 'A'];
  const oppBest = other ? other.d : Infinity;   // nothing of theirs in the house
  const mine = live.filter(s => s.team === team).sort((p, q) => distanceToButton(p) - distanceToButton(q));
  const counting = mine.filter(s => distanceToButton(s) < oppBest);
  return { team, points: counting.length, counting: counting.map(s => s.id), best, blank: false };
}

/**
 * Shot vocabulary for the callout, straight from the glossary
 * (https://en.wikipedia.org/wiki/Glossary_of_curling#Types_of_shots):
 * TAKEOUT / DRAW / GUARD / RAISE TAKEOUT / HIT AND ROLL / OUT OF PLAY.
 */
export function describeShot({ before, world, delivered, scored }) {
  if (delivered.removed) return 'OUT OF PLAY!';
  if (delivered.outReason === 'hog line') return 'HOGGED — removed, short of the hog line';

  const id = delivered.id;
  const struckIds = new Set();
  for (const e of world.events) { if (e.a === id) struckIds.add(e.b); if (e.b === id) struckIds.add(e.a); }
  const madeContact = struckIds.size > 0;

  const afterById = {}; for (const s of world.stones) afterById[s.id] = s;
  const isRemoved = id => { const s = afterById[id]; return !s || s.removed; };

  const removedOpponent = before.filter(s => s.team !== delivered.team && isRemoved(s.id));
  // A raise takeout: the delivery also "raises" a stationary partner out of play.
  const raisedOwn = before.filter(s => s.team === delivered.team && !s.delivered && isRemoved(s.id));

  if (raisedOwn.length && madeContact) return 'RAISE TAKEOUT';
  if (removedOpponent.length >= 2) return 'DOUBLED TAKEOUT';
  if (removedOpponent.length === 1) return 'TAKEOUT';
  if (madeContact && inHouse(delivered)) return 'HIT AND ROLL';
  if (madeContact) return 'HIT AND STAY';
  if (inHouse(delivered)) return scored && !scored.blank && scored.counting.includes(id) ? 'COUNTING DRAW' : 'DRAW';
  if (inFreeGuardZone(delivered)) return 'GUARD';
  return 'BACK LINE GUARD';
}

// ---------------------------------------------------------------------------
// State evaluation (shared by the CPU and the end-summary UI)
// ---------------------------------------------------------------------------

/**
 * Points that would be awarded if the end ended right now, from `forTeam`'s
 * perspective (positive == forTeam is scoring). Used by ai.js as the leaf value.
 */
export function evaluateState(stones, forTeam) {
  const r = scoreEnd(stones);
  if (!r.team) return 0;
  return (r.team === forTeam ? 1 : -1) * r.points;
}

/**
 * Heuristic sheet value for the CPU: counters, stones near the button, guards in
 * front of the house, and not hanging stones. Adapted from
 * https://en.wikipedia.org/wiki/Curling#Strategy_and_tactics
 *
 * `ctx.oppThrowsLeft` is what makes this a real skip's read rather than a
 * greedy one: counting right now is worth almost nothing while the opponent
 * still has most of their stones to shoot it out, and everything at the end of
 * the end. (Wikipedia: the hammer exists precisely because the last stone
 * decides the end — so late stones carry the scoring value.)
 *
 * Both thresholds below are fractions of an end, not absolute counts, so the
 * same read works whether a side throws four stones or the real eight.
 */
export function sheetValue(stones, forTeam, hammerForTeam, ctx = {}) {
  const oppThrowsLeft = ctx.oppThrowsLeft ?? 0;
  const perEnd = RULES.STONES_PER_PLAYER_PER_END;
  // 0 left -> 1.0 (the end is decided), perEnd left -> 0.10 (a "score" now is a
  // free target for the opponent to remove).
  const countWeight = Math.max(0.10, 1 - (0.90 * oppThrowsLeft) / perEnd);
  const duckWeight = oppThrowsLeft > perEnd / 2 ? 1 : 0;

  let v = evaluateState(stones, forTeam) * 100 * countWeight;
  for (const s of stones) {
    if (s.removed) continue;
    const d = distanceToButton(s);
    const mine = s.team === forTeam;
    const sign = mine ? 1 : -1;
    if (d <= SHEET.rings.four) v += sign * 26;
    else if (d <= SHEET.rings.eight) v += sign * 16;
    else if (d <= SHEET.rings.twelve) v += sign * 7;
    else if (inFreeGuardZone(s) && mine) v += 12;          // own guard protects the house
    else if (inFreeGuardZone(s)) v -= 12;                  // opponent guard clogs it up
    // A stone in front of the house that is not a guard is a "hanging" stone.
    if (d > SHEET.rings.twelve && d < SHEET.rings.twelve + 1.2 && !inFreeGuardZone(s)) v -= sign * 6;
  }
  // A lone occupant of the house with the opponent still holding most of their
  // stones is a sitting duck — they will shoot it out and take over.
  const mineInHouse = stones.filter(s => !s.removed && s.team === forTeam && inHouse(s)).length;
  const theirsInHouse = stones.filter(s => !s.removed && s.team !== forTeam && inHouse(s)).length;
  if (duckWeight && mineInHouse === 1 && theirsInHouse === 0) v -= 14;
  // With the hammer we prefer an open house we can shoot at later in the end.
  if (hammerForTeam === forTeam && theirsInHouse === 0 && mineInHouse === 0) v += 6;
  return v;
}

// ---------------------------------------------------------------------------
// Match flow — pure rules, no DOM. main.js only renders and handles input.
// ---------------------------------------------------------------------------

/**
 * Create a match. Hammer for end 1 is picked by the caller (coin toss / random,
 * as in real curling).
 * https://en.wikipedia.org/wiki/Curling#Hammer
 */
export function createMatch({ mode = 'hotseat', difficulty = 'normal', hammer = 'A', seed = 1 } = {}) {
  return {
    mode, difficulty, seed,
    ends: RULES.ENDS,
    end: 1,
    score: { A: 0, B: 0 },
    hammer,                    // team that throws the LAST stone of this end
    order: [],                 // throwing order for this end
    throwIndex: 0,
    stonesLeft: { A: RULES.STONES_PER_PLAYER_PER_END, B: RULES.STONES_PER_PLAYER_PER_END },
    history: [],               // per-end summaries for the overlays / game over
    over: false,
    winner: null,
    extraEnds: 0,
  };
}

export const otherTeam = (t) => (t === 'A' ? 'B' : 'A');

/**
 * Build the throwing order for an end: the team WITHOUT the hammer throws first,
 * so hammer throws last (https://en.wikipedia.org/wiki/Curling#Hammer). The
 * starting player therefore alternates whenever the hammer changes hands and
 * stays the same on a blank end, exactly as the prompt requires.
 */
export function throwingOrder(hammer) {
  const first = otherTeam(hammer);
  const order = [];
  for (let i = 0; i < RULES.STONES_PER_PLAYER_PER_END * 2; i++) {
    order.push(i % 2 === 0 ? first : hammer);
  }
  return order;
}

export function startEnd(match) {
  match.order = throwingOrder(match.hammer);
  match.throwIndex = 0;
  match.stonesLeft = { A: RULES.STONES_PER_PLAYER_PER_END, B: RULES.STONES_PER_PLAYER_PER_END };
  return match;
}

export function currentThrower(match) { return match.order[match.throwIndex]; }
export function throwsThisEnd(match) { return match.order.length; }

/**
 * Resolve one delivered stone against the rules, returning what the game should
 * do about hog-line and free-guard-zone offences.
 * @returns {{removedDelivered:boolean, hogged:boolean, guardZone:null|{illegal:boolean, restored:string[]}}}
 */
export function adjudicateDelivery({ before, world, delivered, shotIndexInEnd }) {
  const out = { removedDelivered: false, hogged: false, guardZone: null };
  const byId = {}; for (const s of world.stones) byId[s.id] = s;

  const illegal = guardZoneViolation(before, byId, delivered, shotIndexInEnd);
  if (illegal.length) {
    // Undo the shot: put every stone back where it was, remove the delivered
    // stone (the prompt's ADAPTED take-in penalty).
    out.guardZone = { illegal, restored: [] };
    for (const b of before) {
      const s = byId[b.id];
      if (!s) continue;
      out.guardZone.restored.push(b.id);
      s.x = b.x; s.z = b.z; s.vx = 0; s.vz = 0;
      s.removed = false; s.outReason = null;
    }
    delivered.removed = true; delivered.outReason = 'guard zone';
    out.removedDelivered = true;
    return out;
  }
  if (!delivered.removed && hogViolation(delivered)) {
    world.removeStone(delivered, 'hog line');
    out.hogged = true; out.removedDelivered = true;
  }
  return out;
}

/**
 * Finish an end: award points, then move the hammer.
 * https://en.wikipedia.org/wiki/Curling#Scoring and #Hammer — "the team that
 * scores loses the hammer; a blank end means the hammer is retained".
 */
export function finishEnd(match, stones) {
  const result = scoreEnd(stones);
  match.score[result.team || 'A'] += result.team ? result.points : 0;
  const summary = {
    end: match.end,
    scoreA: result.team === 'A' ? result.points : 0,
    scoreB: result.team === 'B' ? result.points : 0,
    scoringTeam: result.team,
    blank: !!result.blank,
    counting: result.counting,
    best: result.best,
    scoreAfter: { ...match.score },
  };
  match.history.push(summary);
  if (result.team) match.hammer = otherTeam(result.team);   // scorer loses the hammer
  // blank end -> hammer retained (no change)

  if (match.end >= match.ends && (match.score.A !== match.score.B)) {
    match.over = true;
    match.winner = match.score.A > match.score.B ? 'A' : 'B';
  } else if (match.end >= match.ends) {
    match.extraEnds++;            // tied -> extra ends until someone scores
    match.end++;
    startEnd(match);
  } else {
    match.end++;
    startEnd(match);
  }
  return summary;
}
