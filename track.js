/**
 * track.js — the weight control, drawn as a to-scale miniature of the sheet.
 *
 * Pure geometry and SVG text: no THREE, no DOM, no game state. main.js feeds it
 * the same simulateDelivery() result that drives the 3D preview line and assigns
 * the returned strings to the matching <g> elements in index.html; tests/uitest
 * imports it directly and can therefore assert where the painted landmarks land.
 *
 * Why not a 0-100% bar: weight in curling *is* a distance (a stone travels
 * v0^2 / 2a), and the player's actual question is "will this stop on the
 * button?". A bar expresses that as a number to be converted mentally; a
 * miniature of the rink expresses it as the thing the player is aiming at.
 *
 * Every landmark is derived from the SHEET constants in physics.js, so the
 * drawing cannot drift away from the simulation it stands in for. The two axes
 * share one scale, which is what makes the house read as a house.
 *
 * Coordinates: the widget's X is metres of travel from the hack (the delivery
 * direction), its Y is the sheet's lateral X — a top-down view rotated so the
 * throw always runs left to right.
 */
import { SHEET, RULES } from './physics.js';

/** Widget layout. `S` is the single px-per-metre scale used on both axes. */
export const TRACK = {
  S: 20,                       // px per metre at 1x; CSS scales the whole svg
  // The drawn span *is* the selectable weight range: RULES.POWER_MIN_TRAVEL ..
  // POWER_MAX_TRAVEL is what meterTravel() sweeps, so the marker traverses this
  // picture from edge to edge at a constant speed and is never clamped. uitest
  // fails if the two ever disagree.
  dMin: RULES.POWER_MIN_TRAVEL, dMax: RULES.POWER_MAX_TRAVEL,
  pad: 6, top: 12, foot: 24,   // margins: labels above, a ruler and its caption below
  band: 5.6,                   // metres of sheet width shown
  drawTol: 1.2,                // m either side of the button a draw still counts
};
TRACK.w = TRACK.pad * 2 + (TRACK.dMax - TRACK.dMin) * TRACK.S;
TRACK.h = TRACK.top + TRACK.band * TRACK.S + TRACK.foot;
TRACK.viewBox = `0 0 ${TRACK.w} ${TRACK.h}`;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** travel metres from the hack -> widget x (clamped to the drawn span) */
export const trackX = d => TRACK.pad + (clamp(d, TRACK.dMin, TRACK.dMax) - TRACK.dMin) * TRACK.S;
/** sheet lateral X (metres) -> widget y
 *  The sign here is not a free choice: this picture is read next to the 3D view
 *  and has to be the same picture. The delivery camera looks along +Z, and for a
 *  camera whose forward is +Z the screen-right direction is -X. Turn that frame
 *  90 degrees clockwise to put down-ice to the right and -X lands at the bottom —
 *  so a positive world X belongs ABOVE the centre line. With the other sign the
 *  miniature is a mirror of the ice and every arc reads the wrong way round. */
export const trackY = lat => TRACK.top + (TRACK.band * TRACK.S) / 2 - lat * TRACK.S;
/** a stone's game Z -> travel metres from the hack */
export const trackD = z => z - SHEET.hackZ;

/**
 * Where the rules bite, in travel metres. A stone is a disc, so "must be over
 * the hog line" is judged by its far edge and "through the house" by its near
 * edge — the same tests physics.js applies (hogViolation, the back-line check).
 */
export const D_HOG  = SHEET.hogFarZ - SHEET.hackZ + SHEET.stoneRadius;
export const D_TEE  = SHEET.teeZ - SHEET.hackZ;
export const D_BACK = SHEET.backLineZ - SHEET.hackZ + SHEET.stoneRadius;

const n2 = v => (Math.round(v * 100) / 100).toString();
// The band is symmetric about the centre line, so take the extremes rather than
// assuming which sign of the lateral maps to the top of the picture (trackY does
// the mapping, and its sign is fixed by the orientation comment above).
const iceTop = () => Math.min(trackY(-SHEET.width / 2), trackY(SHEET.width / 2));
const iceBottom = () => Math.max(trackY(-SHEET.width / 2), trackY(SHEET.width / 2));

/**
 * The unchanging part: ice, boards, the four rings, the painted lines, the two
 * zones that remove a stone, the draw window, and a ruler in metres.
 * @returns {string} SVG markup for #trackStatic
 */
export function buildStaticSvg() {
  const y0 = iceTop(), y1 = iceBottom(), ice = y1 - y0;
  const cx = trackX(D_TEE), cy = trackY(0);
  const s = [];
  s.push(`<rect class="ice" x="0" y="${n2(y0)}" width="${TRACK.w}" height="${n2(ice)}"/>`);
  for (const y of [y0 - 2.5, y1]) s.push(`<rect class="board" x="0" y="${n2(y)}" width="${TRACK.w}" height="2.5"/>`);
  // the house, at its real radii: 12-foot, 8-foot, 4-foot and the button
  for (const [cls, r] of [['r12', SHEET.rings.twelve], ['r8', SHEET.rings.eight],
                          ['r4', SHEET.rings.four], ['rb', SHEET.rings.button]]) {
    s.push(`<circle class="${cls}" cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r * TRACK.S)}"/>`);
  }
  // the two ways a delivered stone stops being in play, shaded on the ice
  s.push(`<rect class="deadzone" x="0" y="${n2(y0)}" width="${n2(trackX(D_HOG))}" height="${n2(ice)}"/>`);
  const xb = trackX(D_BACK);
  s.push(`<rect class="outzone" x="${n2(xb)}" y="${n2(y0)}" width="${n2(TRACK.w - xb)}" height="${n2(ice)}"/>`);
  // the window a button draw actually lands in
  const zl = trackX(D_TEE - TRACK.drawTol), zr = trackX(D_TEE + TRACK.drawTol);
  s.push(`<rect class="drawzone" x="${n2(zl)}" y="${n2(y0)}" width="${n2(zr - zl)}" height="${n2(ice)}"/>`);
  // painted lines, at their real distances
  s.push(`<line class="hog" x1="${n2(trackX(D_HOG))}" y1="${n2(y0)}" x2="${n2(trackX(D_HOG))}" y2="${n2(y1)}"/>`);
  s.push(`<line class="tee" x1="${n2(cx)}" y1="${n2(y0)}" x2="${n2(cx)}" y2="${n2(y1)}"/>`);
  s.push(`<line class="back" x1="${n2(xb)}" y1="${n2(y0)}" x2="${n2(xb)}" y2="${n2(y1)}"/>`);
  // ruler: what a weight is actually worth, in metres travelled from the hack
  for (let d = 16; d <= 34; d += 2) {
    const x = trackX(d);
    s.push(`<line class="tick" x1="${n2(x)}" y1="${n2(y1)}" x2="${n2(x)}" y2="${n2(y1 + 4)}"/>`);
    if (d % 4 === 0) s.push(`<text class="lab" x="${n2(x)}" y="${n2(y1 + 11)}" text-anchor="middle">${d}m</text>`);
  }
  s.push(`<text class="lab" x="${TRACK.w - 3}" y="${n2(y1 + 20)}" text-anchor="end">metres from the hack</text>`);
  // landmark labels in the strip above the ice
  s.push(`<text class="lab warn" x="3" y="9">TOO LIGHT</text>`);
  s.push(`<text class="lab warn" x="${n2(trackX(D_HOG) - 3)}" y="9" text-anchor="end">HOG</text>`);
  s.push(`<text class="lab hot" x="${n2((zl + zr) / 2)}" y="9" text-anchor="middle">DRAW ZONE</text>`);
  s.push(`<text class="lab" x="${n2(TRACK.w - 3)}" y="9" text-anchor="end">OUT OF PLAY</text>`);
  return s.join('');
}

/**
 * Everything that moves with the shot being aimed.
 *
 * @param {object} sim     a simulateDelivery() result — the same object that
 *                         feeds the 3D preview line, so the two cannot disagree
 * @param {Array} stones   the stones as they lie on the sheet right now
 * @param {object} colors  { A: '#rrggbb', B: '#rrggbb' } — passed in so this
 *                         module stays free of view constants
 * @param {number} guardLeft  protected deliveries still left in this end, or 0
 * @returns {{stones:string, ghosts:string, fgz:{x:number,y:number,w:number,h:number}|null,
 *            path:string, stop:{x:number,y:number,r:number,fill:string}|null}}
 */
export function buildDynamicSvg(sim, stones, colors, guardLeft) {
  const stoneR = Math.max(3.2, SHEET.stoneRadius * TRACK.S);
  const out = { stones: '', ghosts: '', fgz: null, path: '', stop: null };

  const before = {}; for (const s of stones) before[s.id] = s;
  const held = [], moved = [];
  const ring = (s, cls) => `<circle class="${cls}" cx="${n2(trackX(trackD(s.z)))}" cy="${n2(trackY(s.x))}"` +
    ` r="${n2(stoneR)}"${colors[s.team] ? ` fill="${colors[s.team]}"` : ''}></circle>`;
  const track = (a, b) => `<line class="ghost" x1="${n2(trackX(trackD(a.z)))}" y1="${n2(trackY(a.x))}"` +
    ` x2="${n2(trackX(trackD(b.z)))}" y2="${n2(trackY(b.x))}"></line>`;

  // Stones already thrown, and what this delivery would do to them. Motion is
  // drawn as a line to a hollow ring, so a hit-and-roll reads as work — which is
  // the part a percentage bar has never been able to show.
  for (const s of sim.world.stones) {
    if (s.id === 'preview') continue;
    const b = before[s.id];
    if (s.removed) {
      if (b) {
        moved.push(track(b, s) +
          `<path class="gone" d="M ${n2(trackX(trackD(s.z)) - 3.5)} ${n2(trackY(s.x) - 3.5)} l 7 7` +
          ` M ${n2(trackX(trackD(s.z)) + 3.5)} ${n2(trackY(s.x) - 3.5)} l -7 7"></path>`);
      }
      continue;
    }
    held.push(ring(b || s, 'live'));
    if (b && Math.hypot(s.x - b.x, s.z - b.z) > 0.05) moved.push(track(b, s) + ring(s, 'ghost'));
  }
  out.stones = held.join('');
  out.ghosts = moved.join('');

  // The delivered stone: the arc it would take, and the point it stops at.
  out.path = [{ x: 0, z: SHEET.hackZ }, ...(sim.path || [])]
    .map(p => `${n2(trackX(trackD(p.z)))},${n2(trackY(p.x))}`).join(' ');
  const d = sim.delivered;
  if (d && !d.removed) {
    out.stop = {
      x: trackX(trackD(d.z)), y: trackY(d.x),
      r: Math.max(4.5, SHEET.stoneRadius * TRACK.S), fill: colors[d.team] || '#ffffff',
    };
  }

  // The free guard zone exists only for the first stones of an end. Geometry,
  // not markup: the element itself is part of index.html and keeps its id.
  if (guardLeft > 0) {
    const x0 = trackX(trackD(SHEET.hogFarZ)), x1 = trackX(D_TEE);
    out.fgz = { x: x0, y: iceTop(), w: x1 - x0, h: SHEET.width * TRACK.S };
  }
  return out;
}

/**
 * The sentence next to the percentage: where this weight actually leaves the
 * stone. With a simulation it reports the real endpoint (after contact); the
 * fallback distance is the textbook v^2/2a one, used only if there is no preview.
 */
export function weightReadout(sim, fallbackZ) {
  const end = sim && sim.delivered;
  if (end && end.removed) return `OUT OF PLAY — ${String(end.outReason).toUpperCase()}`;
  const to = end ? end.z : fallbackZ;
  const gap = to - SHEET.teeZ;                        // >0 = past the button
  const where = () => `${Math.abs(gap).toFixed(1)} m ${gap >= 0 ? 'past' : 'short of'} the button`;
  if (to - SHEET.stoneRadius < SHEET.hogFarZ) {
    return `HOGGED — ${(SHEET.hogFarZ - to).toFixed(1)} m short of the hog line`;
  }
  if (gap < -2.2) return `GUARD WEIGHT — ${where()}`;
  if (Math.abs(gap) <= 0.5) return `ON THE BUTTON — draw weight`;
  if (to < SHEET.backLineZ) return `TOO MUCH — ${where()}`;
  return `HACK WEIGHT — through the house`;
}
