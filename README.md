# Curling — 4 End

A keyboard-only 1v1 curling game for the browser. Four ends, eight stones each, the
hammer changes hands with the score, and every stone obeys the same deterministic
physics whether you are watching the aim preview, throwing the shot, or asking the
CPU to search its options.

Built to the spec in [GAME_PROMPT.md](GAME_PROMPT.md).

## Run it

```sh
node serve.mjs
```

That's the whole thing: it prints `http://127.0.0.1:8123/` and opens the page in the
default browser. On Windows, `play.cmd` does the same from a double-click. A port can be
named (`node serve.mjs 8000`), `--no-open` leaves the browser alone, `BROWSER=…` picks a
particular one, and if 8123 is already serving it takes a free port and says which, so
two checkouts can be open at once. [serve.mjs](serve.mjs) is a 113-line static file
server with no dependencies and no build step, and it sends `no-store`, which is why a
refresh after editing `main.js` shows the edit.

ES modules and `fetch` of the GLB assets need an `http://` origin — opening
`index.html` from the file system will not work; the page says so rather than showing a
black canvas, because browsers refuse to load ES modules from a `file://` origin (which
is also why the console error reads *"Cross origin requests are only supported for
protocol schemes …"*). Any other static server works too — `python -m http.server 8000`,
`npx serve`, `php -S` — the point of `serve.mjs` is that the right URL arrives without
being typed. The game loads `assets/*.glb` if they are present and falls back to
procedural stand-ins if the folder is empty — it must run either way, and
[tests/uitest.mjs](tests/uitest.mjs) asserts both paths exist.

Three.js comes from an import map in [index.html](index.html)
(`three@0.169.0` from jsDelivr), so the first load needs network access.

## Controls

Only <kbd>Space</kbd> and the four arrow keys play the game. <kbd>Enter</kbd> is a
view key — it shows the same line from above the house and touches nothing else —
and <kbd>R</kbd> works on the game-over screen. On the title screen the arrows
choose MODE (local hotseat / vs CPU), CPU STRENGTH (easy / normal / hard) and who
holds the hammer in end 1; <kbd>Space</kbd> throws the first stone.

| Phase | Keys | What happens |
| --- | --- | --- |
| AIM — line **and** handle | ← → ↑ ↓ | Line: 0.2° steps, hold to repeat, ±6° max. Handle: seven levels −3 −2 −1 0 +1 +2 +3. With no handle the preview is a white sighting line; with one it is the projected arc, in amber. Same simulation either way. |
| WEIGHT | Space, Space | First press starts the marker running along the miniature below, second press lets go. The marker *is* where the stone stops. Line and handle can still be changed while it runs. |
| IN FLIGHT | hold Space | Brush the ice, for as long as the stone is moving. There is no budget. Brushing adds a little distance and flattens the arc a little; see [brushing](#brushing-is-for-the-whole-path-and-it-is-weak). |
| any phase of your turn | Enter | A plan view, straight above the house, of the situation as it stands — the ice running up the screen, the boards down the left and right. Aim again with Enter open and the arc is drawn under it. It is a camera only: `tests/uitest.mjs` fails if anything about a shot ever depends on it. |

Line and handle are one phase, not two. A skip decides them together — the handle
is chosen *because* of the line it wants — and the arc in the preview is the
feedback for both, so splitting them into separate steps only asks the player to
press Space twice for no information. `Space` therefore has exactly two uses in a
delivery: start the weight, let go. (This is a deliberate departure from the brief's
`AIM → SPIN → POWER` machine; see [Deviations](#physics).) <kbd>Enter</kbd> is the
one key added to the brief's list, and it is allowed here precisely because it is
not an input to a shot.

### The camera stays with the play

When the stones stop, nothing cuts. The tracking view has been following that stone
and is already looking at where it finished, which is exactly the moment a player
wants to look at the result — so `settleShot()` and `beginSetup()` contain no camera
move, and the view only goes to the hack when the player presses Space *into the
hack*, or when a CPU winds up. The end summary is the one place that does move the
camera, because there is a scoring diagram to draw rather than a shot to watch.

That was not enough, and the reason is worth keeping straight. `settleShot()` clears
the shot state, and the tracking view derived its whole framing from the stone in
flight — with no stone in flight it fell back to a pose of the middle of the rink.
Deleting the cut had left a cut wearing a different name, and that is what was
reported: the view jumping during the wait for the next delivery. So the tracking view
now answers one question — `trackFocus()` — instead of two: the stone in flight, or
the point the last shot finished at, or the house when that stone left the sheet (out
of bounds, hogged, taken in for an illegal take-in). `settleShot()` hands that point
over before it clears the shot, and nothing in the wait for the next delivery takes it
away again.

This is measured rather than asserted, because "does not move" is a claim about
coordinates. [tests/uitest.mjs](tests/uitest.mjs) evaluates the shipped `pos`/`look`
bodies and the handover line — the actual source text, run with the game's own
`clamp`, `lerp` and a `THREE.Vector3` that is just an array — once while the stone is
still live and once after the shot is cleared and the point handed over. The two poses
come out equal to 1e-9:

```
stone resting at (0.42, 15.28)   in flight  2.92, 2.15, 11.68  at 0.25, 0.10, 15.19
                                 held       2.92, 2.15, 11.68  at 0.25, 0.10, 15.19
stone gone out of bounds         held       2.50, 2.15, 11.40  at 0.00, 0.10, 15.00
```

and [tests/glbtest.mjs](tests/glbtest.mjs) holds that last pose to the same geometry
gates as the cameras, so the held view cannot end up inside the boards or looking
through a stand.

The plan camera's height is not a number picked out of the air either. The shipped
arena hangs a light bank (`lamp_1`) at y = 7.04..7.16 directly above the tee line, and
at 9.4 m the first version of this view was a lamp with the house somewhere behind it.
[tests/glbtest.mjs](tests/glbtest.mjs) now holds that camera to the same geometry
gates as the others — nothing standing between it and what it aims at, and not sitting
inside geometry — plus the two that only a top-down view needs: a 5×5 grid of
sight-lines over the whole house (ring radius plus a stone on the rim, 1.975 m) has to
be clear, and no geometry hanging into the sheet's footprint may come below the eye.
The eye sits at 6.2 m, 0.8 m under the lowest lamp, so below that plane nothing
suspended can enter the frame whatever the framing turns out to be. The procedural
stand-in hangs its trusses at y 7.31, so it clears the same rule; that path is checked
by reading the
code, not by a test.

### The weight control is a miniature of the sheet, not a bar

A power percentage is useless for weight: the window that stops a stone on the
button is about 3% of the scale, and in curling weight is *distance*, not effort.
So the power control ([track.js](track.js)) draws the delivery to scale — one
scale on both axes, so the house really is a circle:

```
too light →  |  hog line |…………………… house …………| back line | out of play
             14 … 16 … 18.1 ………………… 30 (button) ……… 33.4 … 36 m from the hack
```

The meter is parameterized in the same units the picture uses. `meterTravel(t)`
in [physics.js](physics.js) returns metres of unobstructed travel — 14 m to 36 m,
exactly the span the widget draws — and the caller converts that to power with
`powerForDistance()`. A *power* ramp is the usual implementation and the wrong
shape: because a stone stops at `p²·V_MAX²/2a`, a power needle sits nearly still
for the first third of its sweep and then tears through the house, which is
precisely "it hesitates, then it moves too fast". Distance moves evenly, so the
marker crosses the whole picture at a steady 11 m/s, never clamps, and a button
draw gets **218 ms per pass** instead of the 56 ms a power ramp gives at the same
period. The two ranges being identical is an asserted invariant
([tests/uitest.mjs](tests/uitest.mjs)); the constants are
`RULES.POWER_MIN_TRAVEL`, `POWER_MAX_TRAVEL`, `POWER_METER_SECONDS`.

The picture is not mirrored, and the sign that decides it is not arbitrary. The
delivery camera stands behind the hack and looks along +Z, so world `-X` appears on
the *right* of the screen there. The miniature is that frame turned 90° clockwise to
put down-ice to the right, which sends `-X` to the bottom: it must draw world `+X`
above its centre line — the mapping `track.js` uses. Get it the other way and a
clockwise come-around reads as a counter-clockwise one, which is how this was
reported: the shot preview "mirrored top/down compared to the real view".

The plan view on <kbd>Enter</kbd> is a different framing and it took the same
deriving twice. A sheet is watched with the ice running away from you, so the plan
view keeps the ice vertical — boards down the left and right — and keeps `-X` on the
right, which makes it the delivery view seen from above rather than a second frame of
reference: `camera.up` is world `+Z`, because a camera straight above the tee has no
sky to point its head at. The miniature is *that* frame turned anticlockwise through
90°, which is why the two agree without either one copying the other. All of it is
arithmetic rather than prose: `tests/uitest.mjs` reads the camera vectors out of
`main.js`, rebuilds each screen basis the way Three.js does (`z = eye − target`,
`x = up × z`, `y = z × x`) and asserts the signs — delivery screen-right `(-1,0,0)`,
plan screen-right `(-1,0,0)`, plan screen-up `(0,0,1)`, miniature `+X` upward.

The marker's position is the endpoint of the *same* `simulateDelivery` result that
draws the dashed line on the ice, so the miniature cannot disagree with the game;
it also shows the stones already on the sheet, the arc, and where a hit would
leave them. The red band ends exactly at the hog line, the green band is a
button draw, and the readout beside it names the weight the way curling does —
`HOGGED — 0.4 m short of the hog line`, `ON THE BUTTON — draw weight`,
`HACK WEIGHT — through the house` — with the metres it would run on the left,
because that is the number being aimed at. The percentage is gone from the HUD;
the heaviest weight you can select is 77% power, which leaves the back line at
2.5 m/s, and anything heavier lands in the same place: out of play.
[tests/uitest.mjs](tests/uitest.mjs) checks the landmarks against `physics.js` and
the picture against the simulation; [tests/track_preview.svg](tests/track_preview.svg)
(rendered by [tests/svg_peek.py](tests/svg_peek.py)) is the artifact to look at —
its third panel freezes the meter five times, 500 ms apart, and the markers land
110 px apart every time.

The phase explanation sits in the left gutter for the same reason: it is read
*while* the weight is being aimed, and centred above the meters it covered the one
control that matters. Below 1200 px there is no room beside the control, so it
moves to the top-left gutter instead — never over it.

The HUD calls the shot it saw — DRAW, TAKEOUT, GUARD, RAISE TAKEOUT, OUT OF PLAY —
and shows distance-to-button, speed and time in flight.

## Rules as implemented

Sources are cited inline in [physics.js](physics.js); the short version:

- **Sheet** 34 × 4.88 m, hack at Z = −15, tee at Z = +15, back line Z = +18.4,
  far hog line Z = +3, near hog line Z = −8. House rings 1.83 / 1.22 / 0.61 / 0.15 m.
  ([Curling](https://en.wikipedia.org/wiki/Curling),
  [glossary](https://en.wikipedia.org/wiki/Glossary_of_curling))
- **Scoring** only stones touching the 12-foot house count, including biters
  (`inHouse` tests ring radius + stone radius). One point per closer counter.
- **Hammer** the scoring team loses it; a blank end keeps it; end 1 is chosen on the
  title screen; a tie plays extra ends.
- **Hog line** a delivered stone must come to rest fully beyond the far hog line
  ([Glossary: hog line](https://en.wikipedia.org/wiki/Glossary_of_curling#Hog_line)).
  Checked at rest, on the delivered stone only.
- **Out of play** a stone that *completely* crosses the back line or a sideline is
  removed, including a struck stone carried out
  ([Glossary: back line](https://en.wikipedia.org/wiki/Glossary_of_curling#Back_line)).
- **Free guard zone (ADAPTED)** for the first five stones delivered in an end — the
  real WFG count
  ([Curling: free guard zone](https://en.wikipedia.org/wiki/Curling#Free_guard_zone))
  — a delivered stone may not remove an opponent guard lying between the far hog line
  and the tee line outside the 8-foot ring. If it does, the shot is undone: the guard
  goes back, the delivered stone comes off. The HUD shows "Guard zone — take-ins not
  allowed" and the miniature shades the protected area while it lasts. What is still
  adapted is that the zone covers the whole sheet width rather than the 8-foot ring.
- **Between ends** the sheet is swept clean: the previous end's stones are removed
  before the first delivery of the next end, as in real play, and the HUD says
  "NEW END — sheet swept clean".
- The end summary highlights the counting stones and draws a line from the button to
  the closest stone of each colour, so the measure-up is visible rather than a text
  list.

## Layout

```
index.html      HUD, import map, one canvas
main.js         rendering, cameras, input, phases, HUD — the only file that touches THREE or the DOM
physics.js      pure logic: fixed-step world, rules, scoring, shot evaluation
track.js        pure logic: the weight miniature (geometry + SVG text), derived from SHEET
ai.js           candidate shots -> forward sim with physics.js -> endgame-weighted score
serve.mjs       dev server: serves this folder over http:// and opens the page — not part of the game
play.cmd        the same thing as a double-click on Windows
assets/         six GLB assets + generated textures (assets/tex)
blender/        the authoring and visual-gate scripts, plus their reports
tests/          four Node suites, plus svg_peek.py to look at the widget
```

`physics.js`, `track.js` and `ai.js` deliberately import nothing — no THREE, no DOM.
That is what makes the whole game verifiable from Node, and
[tests/uitest.mjs](tests/uitest.mjs) fails the suite if a forbidden constant
creeps into the renderer.

## Tests

```sh
node tests/selftest.mjs    # 48 checks — physics, calibration, rules, scoring, the weight meter, the brushing model
node tests/matchtest.mjs   # 24 checks — full matches, CPU strength ladder, timing
node tests/uitest.mjs      # 87 checks — DOM ids, key map, phases, cameras, the weight miniature, end resets, asset paths, import boundary
node tests/glbtest.mjs     # 96 checks — the shipped GLBs against the game's coordinate contract and camera framing
```

All four pass. Highlights of what they pin down:

- 70% power stops on the button (`dist=0.03 m, z=14.97, t=7.2 s`); 95% is takeout
  weight and crosses the back line. A ±2 handle turn with no brushing curls 1.45 m;
  the heaviest turn the game allows, ±3, is exactly 1.5× that (2.17 m) and a
  max-handle draw from the centre line still finishes on the sheet — stone edge
  2.315 m against a half-width of 2.44 m. Brushing the whole path adds 7.5% distance
  and takes the curl from 1.45 m to 1.17 m; brushing only the first 40% of the flight
  is worth +5.2% and the last 45% +1.7%, and that ordering is asserted rather than
  assumed (see [brushing](#brushing-is-for-the-whole-path-and-it-is-weak)).
- The dashed preview arc, the executed shot and the weight miniature are the same
  simulation: sampled endpoint error `0.000 m` over 210 samples, and the miniature's
  path ends on the pixel where `simulateDelivery` left the stone.
- The widget's landmarks are derived, not drawn: the hog marker sits at
  `hogFarZ - hackZ + stoneRadius`, the tee marker 30 m from the hack, the 12-foot
  ring at 1.83 m, and the "too light" shading stops exactly at the hog line.
- The miniature is not a mirror of the ice, and the plan view is not a mirrored frame
  either. The test reads the camera vectors out of `main.js`, rebuilds each screen
  basis the way Three.js does (`z = eye − target`, `x = up × z`, `y = z × x`), and
  asserts the result: the delivery camera looks down-ice and shows `(-1, 0, 0)` to the
  right; the Enter camera is straight above the tee, shows the same `(-1, 0, 0)` to
  the right and `(0, 0, 1)` up the screen — so the boards are the bands on the left
  and right — and the miniature, which puts world `+X` above its centre line, is that
  frame turned anticlockwise rather than reflected. Its along-ice half-field is
  checked against the house (must be ≥1.5× a counted house, must not be the rink), and
  the lateral coverage against the sheet width for the worst case of a square window.
- The plan camera is measured against the shipped geometry, not against a screenshot:
  clear air along its axis, over a 5×5 grid spanning the whole counted house, and no
  suspended arena geometry below the eye. This is the one case where the GLB tests say
  something a screenshot of the game would only show by accident.
- `settleShot()` and `beginSetup()` are sliced out of `main.js` and must contain no
  camera move; the hack view may only be entered from `beginAim()` (the player's
  Space) or `applyCPUPlan()` (the CPU's wind-up).
- That the held view is not a cut is evaluated, not asserted: the test runs the shipped
  `pos`/`look` bodies and `trackFocus` with the game's own helpers, once with the stone
  live and once with the shot cleared and the framing handed over, and requires the two
  poses to be equal to 1e-9. The handover line is run the same way for a stone that is
  still in play (must give that stone's coordinates) and one that is out of play (must
  give the tee), and neither pose may contain a fallback framing.
- Brushing is gated on the key alone: no seconds comparison anywhere in the shot loop,
  no ` s left` string in the HUD, and `CPU_SWEEP_WINDOW` never appearing in the
  player's file.
- The weight meter sweeps exactly the span the widget draws — `POWER_MIN_TRAVEL ==
  TRACK.dMin`, `POWER_MAX_TRAVEL == TRACK.dMax` — at a rate that is provably
  constant (sampled across 20 intervals, spread 0), it is already moving 20 ms after
  the key press, and it is tested at both ends of its range: the lightest selectable
  weight is a hog, the heaviest carries through the house and out the back.
- The handle cannot lag the prediction: the test pins the exact statement
  `G.shot.spin = …; setPreviewFromShot();`, which is the ordering that broke once.
- A biter at 1.888 m from the button counts; hammer transfers and blank-end
  retention are checked end to end.
- The CPU thinks in about 0.16 s per throw on this machine — the search is the
  expensive part, and it grows with the number of stones on the sheet, which is why it
  is measured (the gate is 0.2 s per turn). Widening the brushing options from three
  windows to four moved it from 0.153 s to 0.162 s, which is the cost of the menu and
  is why the gate exists. Over 12-match sets the ladder is monotone: NORMAL beats EASY
  12–0, HARD beats EASY 12–0 and NORMAL 12–0. A determined human stand-in takes 3 of
  12 against NORMAL (the gate is 3), and a sloppy human takes 8 of 12 against EASY.
- `glbtest` re-derives world bounds from the GLB node hierarchy and checks the
  contract the game relies on: stone origin at the bottom centre with a node named
  `handle`, the house at glTF Z = +15, granite roughness 0.90 / handle 0.50, the
  ice UVs and normal map present, and that no shipped geometry blocks any of the
  four game cameras.

## Assets

Six files, authored by [blender/build_assets.py](blender/build_assets.py) and
exported Y-up at 1 unit = 1 m:

| File | Tris | Notes |
| --- | ---: | --- |
| `sheet.glb` | 380 | ice, apron to the end dasher, floor decks, painted hog/tee/back/centre lines, four house discs, two hack fixtures |
| `stone_red.glb`, `stone_yellow.glb` | 876 each | granite body (0.29 m ⌀ × 0.114 m, roughness 0.90) + coloured plastic handle (roughness 0.50) on a node named `handle`, origin at the bottom centre |
| `broom.glb` | 148 | 1.28 m broom for the sweeper avatar |
| `hack.glb` | 84 | the foot hack |
| `arena.glb` | 588 | dasher boards, decks, stands, banners, trusses and ceiling banks |

The six files come to 1.2 MB with their textures embedded, which is what the
browser actually downloads; `glbtest` fails the suite above 3 MB. No non-standard
glTF extensions are used beyond `KHR_materials_clearcoat` on the ice and
`KHR_materials_emissive_strength` on the arena lamps, both of which Three.js
handles natively.

Rebuild them (Blender 5.2 LTS, background, no GUI needed — about 2 s):

```sh
blender --background --factory-startup --python blender/build_assets.py
```

This also regenerates the four image textures into `assets/tex/` (granite albedo +
normal, ice pebble normal + roughness). Blender's glTF exporter keeps image
textures and Principled values but drops procedural node chains, so every map is a
real image and every painted part carries an explicit UV layer — a mesh with a
texture and no UVs loses that texture on export. The script writes
`blender/_build_report.json` with triangle counts, part lists and byte sizes.

### Visual gate

[blender/preview_assets.py](blender/preview_assets.py) re-imports the six shipped
GLBs, places a realistic end (two yellow guards, a raised counter, a shot stone on
the button, the hammer just behind it), mirrors the game's five cameras *and* its
light rig, renders eight frames into `blender/preview/`, then samples those PNGs and
fails the run unless each frame is framed, shows ice, is not clipped to white and is
not a flat tone:

```sh
blender --background --factory-startup --python blender/preview_assets.py
```

The current run measures an ice-region mean of 0.31–0.45 with zero clipped pixels in
every view, and writes `blender/_look_report.json`. `main.js`'s light
intensities are set to land in that same band — if the ice ever reads as a white
floor in a browser, lower those intensities rather than darkening the material,
because the material values are what `glbtest` checks.

One of those eight is the held view after a shot whose stone left the sheet: a low
view standing short of the tee, looking at the house, with the stones that are still
in play in it. That is the frame the player is left with while the next delivery is
being set up, so it is rendered rather than reasoned about.

The plan view is in there twice on purpose. `glb_plan_over_house.png` is the view as
it now stands — house centred, ice running up the frame, the boards as the bands on
either side. `glb_plan_as_it_was.png` re-renders the pose that was reported broken,
above the arena's light bank, and is deliberately exempt from the gates because
failing them is the point: its ice-region mean is 0.97 against 0.40 for the current
pose, which is what "placed above a hanging light, it obscures the view" measures
like — the diffuser filled the whole frame. A camera whose roll is the whole question
cannot be aimed with a track-to constraint, so `add_camera` builds that basis with
the same arithmetic `Matrix4.lookAt` uses, from the same vectors
[tests/uitest.mjs](tests/uitest.mjs) asserts on.

One trap worth knowing: Blender's exporter maps `(x, y, z)` to `(x, z, −y)`, so the
house is authored at Blender Y = −15 to arrive at game Z = +15. That convention is
documented at the top of both scripts and asserted by the tests.

## Physics

Fixed 120 Hz step, no random term, so a prediction and a shot are the same numbers.
`physics.js` exposes one `StoneWorld` used by the live game, the aim preview and the
CPU search.

```js
A_BASE  = 1.157 m/s²        deceleration of an unbrushed stone
A_SWEEP = A_BASE * 0.93     brushing (ADAPTED — deviation 9, and the reason below)
CURL_C  = 0.12              a⊥ = C * spin * (v / vmax)
CURL_SWEEP_FACTOR = 0.7     brushing flattens the arc without erasing it
RESTITUTION = 0.95          equal-mass impulse + 2 relaxation passes
V_MAX   = 11.90 m/s         launch speed at 100% power
```

### Brushing is for the whole path, and it is weak

The brief gives `a = 0.11` normally and `0.09` while sweeping — about 18% more
distance — and caps the sweeping at 3.0 s per shot. Both halves of that go together:
a big per-second effect is only fair if the number of seconds is rationed. Brushing
here is allowed from delivery until the stone stops, so the per-second effect had to
come down: a full-path brush is now worth **+7.5% of the distance** (2.25 m on a
30 m draw) rather than the +22% the old model paid inside its 3 s window, and
`CURL_SWEEP_FACTOR` came down with it (0.5 → 0.7), flattening a ±2 arc from 1.45 m
to 1.17 m rather than halving it.

That is a smaller number than the brief quotes, and it is still a decision rather
than a free button, because the preview and the miniature show the **unbrushed**
line: brushing makes the stone arrive longer and straighter than the arc you aimed
along, so the cost is the line you gave up. *When* you brush is measurable too, and
not in the direction the brief's prose implies — `a⊥ = C·spin·(v/vmax)` is greatest
at the start of the flight, so on this model:

```
no brush                 +0 %      arc 1.45 m
first 40% of the flight  +5.2 %    arc 1.21 m
last 45% of the flight   +1.7 %    arc 1.46 m   (brushing late undoes nothing)
```

That ordering is why `ai.js` does not hard-code what a window is worth: `chooseShot()`
simulates every candidate with every window and scores the result, so if the curl law
ever changes, the menu follows it. `tests/selftest.mjs` group 2 asserts the ordering
and the sizes, and fails if it changes — which is exactly when these paragraphs would
need re-reading. The player's HUD therefore no longer counts a budget down; it reports
how much of the delivery has been brushed. `RULES.CPU_SWEEP_WINDOW` is how long a
*CPU* plans to brush, because a CPU cannot hold a key and must decide a window in
advance; it never appears in the player-facing code (asserted).

The sweeper avatar stands square to the stone's line rather than head-on down it —
body facing across the path, broom working in front of the stone — because that is
what sweeping looks like from the delivery camera. Only the body turns: the broom
carries the opposite yaw inside it (`broomHolder` gets an explicit `YXZ` order so
that undo composes first), which leaves the broom's world *orientation* exactly what
it was. Its offset is re-derived in the new local frame so the stroke runs fore and
aft along the line rather than side to side, and the ice spray is emitted at the
broom head, not at the body.

Three deliberate, documented deviations from the numbers quoted in `GAME_PROMPT.md`,
each because the brief's own targets contradict its constants:

1. **Time scale.** With `a = 0.11 m/s²` a 30 m draw takes ~23 s and reaches the
   house at 8 m/s. The brief also requires a draw at 70% power to stop on the button
   and 6–9 s of travel. `TIME_SCALE = 10.52` raises the deceleration to 1.157 while
   keeping the *ratios* the brief specifies that the control design still uses (the
   curl law, the power mapping). The swept : base friction ratio is no longer one of
   them — see deviation 9.
2. **Curl constant.** `C = 0.05` gives 0.67 m of curl at spin 2; the brief requires
   1.2–1.8 m. `CURL_C = 0.12` is solved from the required 1.45 m. Note the correct
   closed form for this curl law is `C·spin·v₀³/(6·vmax·a²)` — a constant heading
   rate; integrating with a fixed acceleration doubles it.
3. **Sweep distance — superseded.** Keeping the 0.09:0.11 ratio at the new
   deceleration yielded +22% rather than the brief's "~18%", because the ratio is
   scale-free and the brief's window was 3 s of a ~7 s flight. Once brushing was
   opened to the whole path that became far too much; deviation 9 replaces it.

Five further deviations are gameplay decisions made after the first build, listed so
nothing here is accidental:

4. **Eight stones per side per end** (the brief's four), which is the real format,
   and with it the **free guard zone moves to five delivered stones**, which is the
   real WFG count. `ENDS` stays 4.
5. **A 3.0 s power meter** instead of the brief's 1.6 s, and the weight control being
   a to-scale miniature rather than a bar. The button-draw window is ~3% of the power
   scale; at 1.6 s that is about two frames of timing, which is not a skill test. The
   meter period is one constant, `RULES.POWER_METER_SECONDS`.
6. **Handle turns up to ±3** rather than ±2. The curl law is linear in `spin`, so ±3
   is 1.5× the calibrated 1.45 m arc — 2.17 m — which still finishes inside the
   sheet. The heaviest turn is the whole point of a come-around, so it is in the
   menu; the AI uses it for `COME AROUND` and `SHOOT THE CORNER`, and still throws
   long guards with little handle.
7. **One aiming phase instead of two.** The brief's machine is
   `TITLE → SETUP → AIM → SPIN → POWER → INFLIGHT → SETTLE → …`; the handle lives in
   `AIM`, so the machine is `… → AIM → POWER → …`. It is still a state machine with
   no ad-hoc booleans — one fewer state, and the state that was removed existed only
   to move the same four arrow keys behind a second Space press.
8. **The weight control measures distance, and its span is the span of outcomes.**
   `meterTravel()` sweeps 14–36 m of unobstructed travel and converts to power, so
   the heaviest weight a player can select is 77% — a stone that leaves the back
   line at 2.5 m/s. Heavier weights exist in the simulation and the CPU uses them
   (it searches power directly, up to 100% = 61 m), but past ~36 m the difference
   is how violently a stone that is already out of play leaves the sheet. What is
   genuinely not reachable by a player is a *harder* hit, not a different result;
   every shot that changes a score — draw, come-around, hit-and-stay, raise, guard —
   sits inside the range the control offers.
9. **Brushing is allowed for the whole flight and its effect is much smaller than the
   brief's.** The brief pairs a 3.0 s per-shot budget with `0.09` against `0.11 m/s²`.
   The budget is gone — Space may be held from delivery until the stone stops — and
   with it the per-second effect: `A_SWEEP = A_BASE × 0.93` and
   `CURL_SWEEP_FACTOR = 0.7`, worth +7.5% of distance and a 1.45 m → 1.17 m arc over
   a full run. Rationale and the measured window table are in
   [Brushing is for the whole path](#brushing-is-for-the-whole-path-and-it-is-weak).
   What is kept is the decision the brief cares about ("sweep to reach the house, or
   don't sweep to let the curl finish around a guard") — it is simply no longer
   rationed in seconds, and the arc shown in the preview is the unbrushed one.
10. **<kbd>Enter</kbd> is a fifth key.** The brief limits input to Space and the four
    arrows. Enter opens a plan view — a camera straight above the house showing the
    situation and the arc — and it is the only key in the game that cannot be part of
    a shot: it is read in the player's own phases, it closes again when a delivery
    starts, and `tests/uitest.mjs` pins that every read of it is a camera toggle and
    that nothing in the shot simulation looks at it. It is here because what a skip
    actually does between stones is *read the ice*, and the earlier design cut that
    off: the moment the stones stopped, the view moved to the hack.

## Known limitations

- There is no browser in this environment, so the visual verification is the
  Blender preview renders of the shipped GLBs through the game's own cameras, plus a
  raster of the weight miniature ([tests/track_preview.svg](tests/track_preview.svg)
  drawn by [tests/svg_peek.py](tests/svg_peek.py) from the markup the tests
  generate), not a screenshot of the running game. Everything else — rules, physics,
  UI wiring, asset contract — is covered by the Node suites.
  The things that therefore remain unverified by eye are the ones that only exist in
  the rendered 3D view: the orientation of the *scene* the miniature is aligned with
  (the miniature itself is rastered, and its agreement with the cameras is proved by
  rebuilding the screen bases from the vectors in `main.js`), and the stance of the
  sweeper figure standing square to the path with the broom ahead of it. Two other
  things have moved the opposite way, because both turned out to be measurable rather
  than merely visible: what the plan view frames, and what hangs between it and the
  ice, is now measured against `assets/arena.glb` itself and rendered through its pose;
  and whether the view actually holds still when the stones stop is answered by running
  the shipped camera code twice and comparing the coordinates, then rendering the one
  pose that is only ever reached once a stone has left the sheet. Both are firmer
  claims about those views than a screenshot of the running game would be. The two
  above are pinned by reading the code, not by looking at them.
- The procedural fallback textures are generated at startup (ice at 140 px/m). It is
  a heavier texture than the GLB path needs; it is only used when `assets/` is empty.
- The CPU plays a legal, sensible shot rather than a perfect one: difficulty scales
  aim error, weight error, spin mistakes, whether it brushes at all and how early it
  commits to a window, and Normal is set to be beatable by a determined human who
  holds Space along the whole delivery. `matchtest` models exactly that stand-in
  — it picks the obvious shot, chases the game, calibrates its weight and line
  against its own brushed delivery, and takes three of the twelve matches it plays; it
  never runs a shot search, which is the difference the ladder measures.
