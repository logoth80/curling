/*
 * Render quality: what the game stops paying for when a device says it cannot keep up.
 *
 * Nothing here touches the DOM or THREE. main.js measures frame intervals and applies
 * these numbers to the renderer; the decision itself is pure, so tests/selftest.mjs can
 * hold it to numbers. A threshold no test runs is a figure someone made up.
 *
 * What the levers are, and what each one is actually worth on a budget phone or tablet.
 * The counts were read out of the shipped files with Node (meshes, triangles and image
 * sizes from the GLB chunk headers), not estimated:
 *
 *   pixelRatioCap - the number of fragments to shade. Everything else here is smaller
 *     than this. A 1280x800 tablet at devicePixelRatio 2 fills 2.05M CSS pixels times
 *     four = 4.1M fragments a frame; a cap of 1.25 asks for 1.6M. The game has no
 *     shadow maps and no post-processing, so fragment shading *is* the frame.
 *
 *   dressing - the arena's stands, crowd, banners, banner strips, trusses and lamps:
 *     39 of the 49 meshes in arena.glb, and 588 triangles across the whole file, so
 *     they are worth nothing as triangles. They are worth what they *cover*: they are
 *     big quads standing behind the play, and they fill most of a screen that is
 *     already full of ice. A phone pays for every one of those pixels more than once.
 *     The boards, kicks, dashers and the rubber deck stay at every tier - they are 10
 *     meshes, and the cameras are written around them: the end-summary view stands at
 *     Z=21.2 and looks over the far dasher, and without the deck the rink floats.
 *
 *   sheetLamps - the two point lights that put a specular sheen on the ice. Light
 *     count is per-fragment work on every material in the scene; changing it
 *     recompiles the shaders once, at the tier change, not every frame.
 *
 *   pebbleNormal - the ice normal map (276 KB of the 408 KB sheet.glb; arena.glb
 *     carries no images at all). The sheet is the largest object on screen, so its
 *     material is the most expensive surface shader in the game, and the pebble
 *     texture is what that map is buying.
 *
 * Antialiasing is deliberately *not* in the ladder. It is a context flag that has to be
 * chosen before the WebGL context exists, so it cannot be a runtime lever: main.js sets
 * it once at startup from the same pointer probe it already makes for the controls, and
 * a touchscreen starts without it. That is also why MSAA does not appear here as a
 * saving the watchdog can reach for later - by the time frames are being measured, the
 * choice is already in the context.
 *
 * The ladder goes down and never up, which is a fact about the code, not a policy: a
 * phone that hit 60 fps during the title screen does not stay there once 16 stones are
 * on the ice and the camera is moving, and a player should not watch the arena
 * flicker back into existence to find that out.
 */

export const QUALITY_TIERS = [
  {
    id: 'full',
    note: 'everything the desktop game draws',
    pixelRatioCap: 2.0,
    dressing: true,
    sheetLamps: 2,
    pebbleNormal: true,
  },
  {
    id: 'lean',
    note: 'the arena dressing goes: 39 of 49 arena meshes, and the overdraw behind the play',
    pixelRatioCap: 1.25,
    dressing: false,
    sheetLamps: 2,
    pebbleNormal: true,
  },
  {
    id: 'poor',
    note: 'one sheet lamp and no ice normal map: the flat look, for a device that is trying',
    pixelRatioCap: 1.0,
    dressing: false,
    sheetLamps: 1,
    pebbleNormal: false,
  },
];

/**
 * The median frame interval at which the ladder steps down. 22 ms is about 45 fps:
 * high enough that a device holding a steady 60 (16.7 ms) is never touched, low
 * enough that a phone visibly stuttering at 30 (33 ms) is. The median, not the mean,
 * because one 200 ms frame during a texture upload must not cost a player the arena.
 */
export const FRAME_BUDGET_MS = 22;

/** Frame intervals per decision. Short enough to react inside a second, long enough
 *  that a hitch cannot carry it. */
export const SAMPLE_FRAMES = 45;

export function medianMs(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The whole of the automatic decision: given the frame intervals since the last
 * decision and the tier in force, return the tier to use. One-way by construction -
 * there is no branch that returns a smaller index - and it refuses to go past the
 * last tier, where there is nothing left to give up. The incoming tier is clamped
 * first, so a caller that has lost count cannot be handed a rung that does not exist.
 */
export function decideTier(samples, current) {
  const at = Math.max(0, Math.min(QUALITY_TIERS.length - 1, Math.round(current) || 0));
  if (at === QUALITY_TIERS.length - 1) return at;
  if (!Array.isArray(samples) || samples.length < SAMPLE_FRAMES) return at;
  return medianMs(samples) > FRAME_BUDGET_MS ? at + 1 : at;
}

/**
 * Where to start, before any frame has been drawn. This is a guess and only a guess;
 * the frame intervals decide after it. It exists because the first second of a match
 * is the impression a player keeps.
 *
 *   - few reported cores, or little reported memory: the browser has already told us
 *     the device is modest. An *absent* value is not evidence the other way - Safari
 *     reports no deviceMemory at all - so unknowns do not push the tier down.
 *   - a touchscreen whose drawing buffer is already large: that is the fragment
 *     count, and on a tablet it is the thing that will not be forgiven.
 */
export function startingTier(env) {
  const coarse = !!(env && env.coarsePointer);
  const cores = typeof env.cores === 'number' ? env.cores : 0;
  const memory = typeof env.memoryGB === 'number' ? env.memoryGB : 0;
  const pixels = typeof env.bufferPixels === 'number' ? env.bufferPixels : 0;
  if ((cores > 0 && cores <= 4) || (memory > 0 && memory <= 2)) return 1;
  if (coarse && pixels >= 2.5e6) return 1;
  return 0;
}

/** `?tier=lean` on a tablet is how a player forces a level to compare them by hand.
 *  Anything unrecognised, and `auto`, mean "let the frame intervals decide". */
export function parseTierParam(search) {
  let raw = '';
  try { raw = new URLSearchParams(String(search || '')).get('tier') || ''; } catch (e) { return null; }
  raw = String(raw).trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  const i = QUALITY_TIERS.findIndex(t => t.id === raw);
  return i >= 0 ? i : null;
}
