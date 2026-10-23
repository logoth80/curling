# Curling Web Game — Build Prompt

**How to use:** paste everything between the `PROMPT START` / `PROMPT END` markers into a capable code-generation agent (e.g. one with Three.js + Blender tooling). Copy `assets/` conventions as-is if you already have GLB assets; otherwise the agent must generate stand-ins.

---
**——— PROMPT START ———**

## Role & Goal

Build a playable, browser-based **1v1 curling game** as a single-page web app using **Three.js**, loading **GLB assets authored in Blender** (with procedural stand-ins as fallback so it runs without assets). The entire game must be playable with **only the Space key and the four arrow keys**.

Rules and strategy are adapted from curling as documented on Wikipedia ([Curling](https://en.wikipedia.org/wiki/Curling), [Glossary of curling](https://en.wikipedia.org/wiki/Glossary_of_curling)) — faithful in spirit and mechanics, but scaled down for a ~3-minute web match. Marked "ADAPTED" items are deliberate simplifications, not mistakes.

## Match Format (ADAPTED for web scale)

- 2 players, one color each (team A = **red handles**, team B = **yellow handles** — like real play; render stones with distinct granite + handle colors).
- **4 ends**; each end each player throws **4 stones**, alternating throws, starting player alternating per end as described below. (Real curling: 8 stones, 8–10 ends.)
- **Hammer** (last-stone advantage): End 1 hammer is chosen/random; after each end, the player who **scored** loses the hammer to the opponent; a **blank end** (nobody scores) means the hammer is **retained** by the same player — matching the real rule described on Wikipedia.
- After 4 ends: highest total score wins. **Tied → play extra ends** until someone scores.
- Modes: **local hotseat (default)** and **vs CPU** (CPU described below).

## Scoring (faithful)

- Points are decided after both players finish an end. **Only stones touching the 12-foot house ring count** (a stone just biting the outer edge — a real "biter" — counts).
- The player with a stone closer to the button than **any** opponent stone scores **1 point per such stone** ("counters"). Only one player scores per end; 0–0 is a blank end.
- On the end-summary overlay, visually highlight the counting stones and draw a line from the button to the closest of each color.

## Deliberate Stones & Lines (faithful, simplified)

- A delivered stone must come to rest **fully beyond the far hog line**, otherwise it is removed from play.
- A stone that **completely crosses the back line** (real rule per the glossary) or the sideline is removed. A struck stone carried out of play is removed the same way.
- Stones that stop in play remain on the sheet for the rest of the end.

## Free Guard Zone (ADAPTED)

- For the **first 3 stones of each end**, the delivered stone **may not remove from play** an opponent guard lying between the far hog line and the tee line and outside the 8-foot ring. If it does, undo the shot (return the removed guard, remove the delivered stone). Display a clear "Guard zone — take-ins not allowed" cue on the HUD during those stones. (Real rule covers more stones; scale is adapted.)

## Shot Control Model — the core of the game

Each stone uses a 4-phase state machine. **Only Space + arrows are used anywhere in the game.**

1. **AIM (← →)** — aim the line down the sheet. ←/→ nudge the aim angle in 0.2° steps (hold to repeat, max ±6° from center). A dashed preview line shows the initial line from the hack.
2. **SPIN / ROTATION (↑ ↓)** — set handle rotation and curl: ↑ = clockwise (stone curls to the **right** from the thrower's view), ↓ = counter-clockwise (curls **left**). Each press steps through spin levels −2, −1, 0, +1, +2 (default 0). The preview updates into a **live curved arc** showing the projected path (no sweeping assumed) — like the real skip reading the ice.
3. **POWER (Space, two taps)** — first Space starts an oscillating power meter (0–100%, ~1.6 s per sweep); second Space locks the value. Release speed is derived from locked power. This is the "how hard" skill.
4. **IN FLIGHT — BRUSH THE ICE OR NOT (hold Space)** — while the stone travels, **holding Space sweeps**: the stone travels noticeably farther and curls less (per Wikipedia: sweeping makes a stone travel farther with less curl). Sweeping uses a per-shot **sweep meter** (3.0 s max, no recharge mid-shot). Releasing stops sweeping. Sweeping early mainly adds distance; this is the "brush or not" tactical decision: sweep to reach the house, or don't sweep to let the curl finish around a guard.

Confirm phases with clear on-screen prompts and a persistent key legend (bottom of screen). The stone's handle visibly rotates to show chosen spin. After the stone stops, show result telemetry: "distance to button" / "out of play" / "guard".

## Physics Model (simple, deterministic, fixed-timestep 120 Hz)

No physics engine needed; implement directly:

- Stone as a circle (radius 0.145 m). Speed decays via constant deceleration `a`; stopping distance `s = v0² / (2a)`.
- Base deceleration `a = 0.11 m/s²`; **while sweeping** use `0.09 m/s²` (≈18% more distance).
- **Curl:** lateral acceleration perpendicular to velocity: `a⊥ = C * spin_level * (v/ vmax)` (curl grows as the stone slows — matches real curl), with `C ≈ 0.05 m/s²` at spin level 2; **sweeping halves the curl force**. Direction: clockwise spins curl right (thrower's view).
- Collisions: equal-mass elastic circle-circle impulse with restitution ≈ 0.95; friction applies to struck stones the same way.
- **Calibration target (must tune to this):** from the hack at **power ~70%, spin 0, no sweep**, the stone should stop near the button (draw weight); power ~95% no-sweep should sail past the house off the back line unless swept hard or it should stop just past the tee (takeout weight). Max lateral curl deviation over the full sheet at spin ±2, no sweep: **1.2–1.8 m**. Shot travel time to the house: **6–9 s** at draw weight.

### Sheet Geometry & Coordinates (game scale, meters, Y-up)

- Sheet length 34, width 4.88. `Z` = down-ice, `X` = lateral. Center line at X=0.
- Hack at `Z = -15`; house center (tee) at `Z = +15`; tee line across the sheet; back line at `Z = +18.4`; far hog line at `Z = +3`; near hog line at `Z = -8` (release must be before it — always automatic in our controls).
- House rings (radius): 12-ft = **1.83**, 8-ft = **1.22**, 4-ft = **0.61**, button = **0.15**. Draw with distinct ring colors (blue/white/red/white button) like real sheets. Ice surface shows pebble subtly (normal map or noise).
- Stone: 0.29 m diameter, 0.114 m tall, granite body + colored handle on top.

## Blender Assets (GLB via glTF exporter)

Load from `assets/` with these names; **if a file is missing, build a decent procedural stand-in** (lathe stone + colored handle, plane sheet with canvas-drawn line/ring texture) so the game is always playable:

| File | Contents | Notes |
|---|---|---|
| `sheet.glb` | Ice plane + line/house rings (baked texture or separate thin meshes) | 34 × 4.88 m, origin at sheet center, +Y up in engine (export +Y up or rotate on load) |
| `stone_red.glb`, `stone_yellow.glb` | Granite body + colored handle as a separate named part `handle` so it can rotate with spin | origin at stone bottom center; body PBR granite (rough ~0.9), handle plastic (colored, rough 0.5) |
| `broom.glb` | Simple broom/brush head + shaft | used by the sweeper avatar/particles anchor |
| `hack.glb` | Foot hack at the delivery end | small prop |
| optional `arena.glb` | Side boards, banner wall, simple stands | mood only; keep < 20k tris total |

Author conventions (when creating assets in Blender): 1 unit = 1 m, stone ≤ 2k tris, textures ≤ 2048px embedded in GLB, single scene, apply transforms, Y-up export.

## Camera

- **Aim/aiming phases:** behind-the-hack over-shoulder view looking down the sheet (this is where the game lives — the player must judge line from this view).
- **Release:** camera smoothly dollies/tracks alongside the stone (like a sweeper), keeping the stone and house in frame.
- **Stone stops / end summary:** cut (with a short ease, not a teleport) to a skip's-view from behind the house looking back down the sheet — the classic curling TV angle for judging counters.
- No mouse/camera controls (keyboard-only purity).

## HUD / UI

- Top scoreboard: end number (1–4), per-player points, remaining stones as pip icons, **hammer indicator** (a broom icon next to the throwing-last player).
- Center-bottom contextual prompts per phase ("← → to aim, Space to set power…").
- Power meter with moving needle + lock zone; spin indicator (rotating handle icon with arrows); sweep meter bar that drains while Space is held.
- End summary overlay (score, counting-stone highlight, who has hammer next end), title screen with mode select navigable with arrows + Space.
- Optional but nice: shot name callout based on outcome ("TAKEOUT", "DRAW", "GUARD", "RAISE TAKEOUT", "OUT OF PLAY!") — vocabulary straight from the curling glossary.

## Strategy Layer & CPU Opponent

Expose shot names in post-shot feedback so players learn the real strategy vocabulary, and implement the CPU using it (adapted from Wikipedia's Strategy/Types of shots sections):

- Without hammer, CPU opens with a **center guard**, then tries **come-arounds** and **draws to the button**; with hammer it plays a **corner guard** and hunts multi-point scores, or **blanks the end** to keep hammer when trailing late.
- CPU evaluates a small menu of candidate shots (guard, draw to button, draw around a cover, takeout of best counter, hit-and-roll) by coarse forward simulation, scores each by resulting counters, then executes the best with aim/spin/power noise that scales with difficulty (Easy/Normal/Hard selectable at title).
- CPU may choose to sweep or not based on whether simulated stop position needs the extra distance/straightening.

## Technical Constraints

- Single `index.html` + ES-module Three.js (CDN import map is fine) + `main.js`, `physics.js`, `ai.js`, `assets/`. No bundler required.
- Keyboard only: `Space`, `ArrowLeft/Right/Up/Down` (`preventDefault` to stop page scroll). Allow `R` → restart only on game-over screen (ADAPTED convenience).
- Deterministic fixed-timestep simulation decoupled from render; must run 60 fps on a laptop iGPU.
- Clean state machine (`TITLE → SETUP → AIM → SPIN → POWER → INFLIGHT → SETTLE → (next shot | END_SUMMARY) → GAME_OVER`) — no ad-hoc booleans.
- Code commented with links to the Wikipedia rule each mechanic models.

## Acceptance Checklist (verify before claiming done)

1. A full 4-end match plays start-to-finish using **only** Space + arrows, hotseat.
2. Curl direction reverses with spin sign; sweeping visibly adds distance and straightens path; the arc preview roughly predicts the unswept path.
3. Scoring is correct on: counters, blank ends, a biter touching the 12-ft ring, hog-line removal, back-line removal, and hammer retention on a blank.
4. Guard-zone rule enforces correctly for the first 3 stones and lifts after.
5. Takeouts knock opponent stones out (and those are removed if carried past the back line).
6. CPU beats an Easy setting and loses to a determined human sometimes on Normal; CPU plays guards/draws/takeouts sensibly.
7. Game runs with GLB assets present, and identically playable with procedural stand-ins when `assets/` is empty.

## Sources for rules/strategy (adapt, do not invent)

- https://en.wikipedia.org/wiki/Curling — gameplay, delivery, sweeping ("travel farther and curl less"), scoring, strategy, sheet dimensions, stones.
- https://en.wikipedia.org/wiki/Glossary_of_curling — house rings (12/8/4-ft, button), back line, hog line, blank end + hammer retention, guard/center guard/corner guard, takeout/draw/hit-and-roll/come-around, biter.
- https://simple.wikipedia.org/wiki/Curling — plain-language summary of skip's choices (hardness, direction, curl amount) that maps directly to the three control phases.

**——— PROMPT END ———**
