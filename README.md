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
release.js      pure logic: the release-quality table a human delivery is rolled against
serve.mjs       dev server: serves this folder over http:// and opens the page — not part of the game
play.cmd        the same thing as a double-click on Windows
assets/         six GLB assets + generated textures (assets/tex)
blender/        the authoring and visual-gate scripts, their reports, and the
                reference photograph the stone handle was measured from
tests/          four Node suites, plus svg_peek.py to look at the widget
```

`physics.js`, `track.js`, `ai.js` and `release.js` deliberately import nothing outside
this folder — no THREE, no DOM.
That is what makes the whole game verifiable from Node, and
[tests/uitest.mjs](tests/uitest.mjs) fails the suite if a forbidden constant
creeps into the renderer.

## Tests

```sh
node tests/selftest.mjs    # 78 checks — physics, calibration, rules, scoring, the weight meter, the brushing model, the release table
node tests/matchtest.mjs   # 29 checks — full matches, CPU strength ladder, timing, the two error models kept honest
node tests/uitest.mjs      # 123 checks — DOM ids, key map, phases, cameras, the weight miniature, where a release may be rolled, the sweeper's stance and limbs (its joint solver is run, and every part the pose names is one the rig builds), whose handle angle, end resets, asset paths, import boundary
node tests/glbtest.mjs     # 100 checks — the shipped GLBs against the game's coordinate contract, the handle's shape, and camera framing
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
  simulation *for the same inputs*: sampled endpoint error `0.000 m` over 210 samples,
  and the miniature's path ends on the pixel where `simulateDelivery` left the stone.
  A human delivery is then separated from that line by exactly one thing, the release
  roll described in [A delivery is a release](#a-delivery-is-a-release-the-called-line-vs-the-thrown-one).
- That roll is tested the same way: the four tiers and their exact spans, the
  frequencies over 40 000 draws of one fixed seed, no draw ever past its own tier,
  the angle conversions quoted above (`0.1910°`, `0.3820°`), the *measured* result on
  the ice — `0.0999 m` and `0.1998 m` of line error at 30 m and at 20 m, with and
  without a handle turn, `29 cm` from a handle error alone — `0.488 m` for the worst
  release whose two errors agree, and that even that worst case cannot by itself throw
  a called draw out of the house. The same seed replays the same release and the same
  rest position.
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
| `stone_red.glb`, `stone_yellow.glb` | 1596 each | granite body (0.29 m ⌀ × 0.114 m, roughness 0.90) + coloured plastic handle (roughness 0.50) on a node named `handle` — a moulded cap over the granite shoulder and a leaning gooseneck grip whose ends are joined into that cap, from the proportions measured off [blender/reference/handle_reference.webp](blender/reference/handle_reference.webp); origin at the bottom centre |
| `broom.glb` | 148 | 1.28 m broom for the sweeper avatar |
| `hack.glb` | 84 | the foot hack |
| `arena.glb` | 588 | dasher boards, decks, stands, banners, trusses and ceiling banks |

The six files come to 1.3 MB with their textures embedded, which is what the
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

### The handle was measured off a photograph, and says so

The handle is the one part of this set designed against a reference rather than from
memory: a product photograph of two real stones, kept in the repo at
[blender/reference/handle_reference.webp](blender/reference/handle_reference.webp)
so the comparison stays reproducible. Its proportions were read off that photo with
PIL and written into the build as numbers that carry their source: the cap spans
0.72-0.90 of the body's diameter, its lower edge sits at 0.91 of the granite's
height, the bar is 0.15-0.18 of the cap's width through (33-40 mm), and the arch
leans, because a handle is meant to be held from one side.

Where its two ends stop is not in the photograph, and it is the part that was wrong
once. The answer is the cap's own surface: `cap_top_z_at()` reads it out of
`HANDLE_CAP_PROFILE`, the spine places each end's *underside* on that surface, and
one more short point runs past each foot while `HANDLE_SECTION` thins the section to
a third of its grip width across it. That is the difference between a handle moulded
into the cap and a bar sawn off at an angle standing on top of it.
`HANDLE_CAP_PROFILE`, `HANDLE_SPINE` and `HANDLE_SECTION` in
[blender/build_assets.py](blender/build_assets.py) are those numbers; the grip is a
swept section (`sweep()`) along a spline, not a bent tube.

The build then measures what it made, off the evaluated mesh, and puts it in the
report under `handle`: the cap at 0.77 of the body diameter, the top of the handle
0.061 m above the granite, the bar 0.035 m through, both feet 10 mm into the cap's
surface while still standing 33-52 mm proud of it where they meet it, the arch
clearing the cap by 12 mm under its run so a hand fits under it, and both buried
tails ending at 0.65 and 0.81 of the cap's radius, so no part of the joint shows.

Two views judge the shape, because a handle lies in one plane and a game screenshot
almost never looks along it:

```sh
blender --background --factory-startup --python blender/preview_handle.py
python blender/check_handle.py            # needs Pillow and numpy
```

The first re-imports the shipped GLB and renders three frames into
`blender/preview/`: a true side elevation (looking along world X, the only direction
in which the gooseneck's profile is undistorted), the photograph's own low framing
with the handle's run lying across the frame, and a top view. The second segments
colour out of the reference and out of that render, reduces each handle to an
outline of 41 columns, and compares the model against *both* reference handles in
either facing. It measures the reference against itself too — the two handles in
that photo differ from each other by 0.022 of their own height, which is the floor
under any threshold used here — and refuses the comparison outright if the render is
not looking at the stone from near the same angle the photo was taken at (the
body's projected height in frame says whether it is).

Fourteen checks pass, and the script is explicit about which of them mean what. The
outline comparison is the coarse one, and its own header says so: it compares a
single coloured blob, and the height of that blob is set mostly by the cap's
projected ellipse — a disc 0.223 m across seen at 20 degrees adds 76 mm of
silhouette, which is more than the entire rise of the bar. Lifting both ends out of
the stone moved that number by one hundredth (0.107 to 0.117, against a limit set at
0.16 for exactly that reason), while the reference's own two handles sit 0.022 apart.
It is therefore only asked whether the handle reads as a leaning gooseneck rather
than a knob, and the ends are held by the mesh checks instead, which need no camera
at all: the version that was wrong here scored 19 mm of material buried under the
cap's surface and stood 16 mm proud of it at its free end, and the profile showed
exactly that.
[tests/glbtest.mjs](tests/glbtest.mjs) holds the shipped file to the coarse version
of the same claims — the handle standing 0.04-0.08 m clear of the granite, and the
grip reaching across the cap rather than sitting on it as a knob — so a future
rebuild that turns it back into a stub fails a suite rather than a taste test.

### One stone's spin belongs to that stone

The handle node exists at runtime for one reason: turning it about Y is how the game
shows spin. The first version kept that angle in the shared game state and wrote it
to every stone in the scene, so delivering one stone turned the handles of every
other stone standing on the ice — the whole rink spinning around a single throw,
which is what it looked like and what it was.

The angle now lives on the stone's own view. Only the stone actually in flight has
its angle advanced. A struck stone keeps the angle it had, which is consistent with
the physics: `physics.js` carries no spin through contact. A stone that is simply
standing on the ice has an angle hashed from its id — varied across the sheet the
way a real rink is, but identical from frame to frame and reload to reload, so a
handle that is not turning cannot appear to turn. The HUD dial asks which stone it
is describing instead of reading shared state, and while aiming there is no handle to
turn at all, because the delivered stone's view only comes into being at the
release; the aiming indication is the dial, the level dots and the arc's colour.

Group 4b of [tests/uitest.mjs](tests/uitest.mjs) holds that shape: no shared angle
may be written onto a handle, a resting angle may not come from `Math.random`, and a
late asset load must hand back the angle a standing stone was already holding.

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

### The sweeper is drawn in the game layer, not modelled

The six GLBs above cover the sheet, the stones, the broom, the hack and the arena. There
is no player model, because none was ever asked for: the figure that runs beside a moving
stone is built out of capsules, spheres and boxes in `main.js`, and it is the one thing in
the frame the brief lets the renderer invent. The broom in its hands is the real
`broom.glb`, and that is what the pose is measured against — the shaft is 1.28 m with the
pad at the origin, and the two heights the hands go to are read from that shaft, which holds
for the procedural fallback broom too.

What it may not be is a person running face-first down the line. Sweepers work *beside* the
line, square to it: feet apart along the path with the toes pointing across it, body bent
over the broom, both hands on the shaft, eyes on the stone. `updateSweeper` turns the body a
quarter turn off the direction of travel, which is what makes it read side-on from the camera
that follows the play; `poseSweeper` is then written in that turned frame, where local −X is
the path and local +Z is the ice lane, filling in the hip, knee, spine, shoulder and hand
joints per frame and aiming the limbs between them — which is also what lets the feet shuffle
sideways while the body stays square. The broom keeps a holder of its own whose yaw cancels
the body's turn, so the brush head stays on the line: 0.52 m of reach to match the 0.52 m the
body stands off it, which is also where the chippings come off rather than beside the stone.
The jacket takes `TEAM_COLOR` for whichever team is throwing. Group 2d of
[tests/uitest.mjs](tests/uitest.mjs) pins all of it, including that the reach and the standing
offset are the same number.

The hands go near the top of the handle — 0.85 m and 1.18 m up a 1.28 m shaft — because that
is where a broom is held, and gripping lower would leave the only way to keep the brush on the
ice to be squatting. That in turn is why the arms are two segments each: a shoulder and a grip
0.95 m apart along a tilted shaft cannot be spanned by one straight capsule without stretching
it to more than twice its length, and a stretched capsule reads as a plank, not an arm. The
same is true of a hip 0.70 m above a planted foot. So `twoSeg` solves the knee and the elbow
with the cosine rule and pushes the joint off the straight line in a chosen direction — which
is also what makes a joint visible at all. The direction is a matter of camera as much as
anatomy: a knee that points toward the ice lane points at the lens of the camera that follows
the play, and the legs read as a scatter of dots.

Checking a procedural figure without a browser was worth doing anyway, and it is now a script
rather than a one-off: [blender/preview_figure.py](blender/preview_figure.py) rebuilds the same
joints through the conversion `B(x, y, z) = (x, −z, y)` — a quarter turn about X, determinant
+1, which means a rotation about the game's Y is a rotation about Blender's Z with the same
sign — and measures 82 claims about them: that the brush head is on the stone's line and ahead
of it, that the body is off the line and on the far side from the camera that follows, that the
feet are apart along the path with the toes square across it, that the head clears the
shoulders and is turned toward the stone, and that every limb reaches its joints without being
stretched while its knee or elbow actually bends. It reads those numbers out of `main.js`
rather than restating them, and refuses to run at all if the source lines it was copied from
have moved — a pose check that quietly goes stale is worse than none. `python
blender/preview_figure.py --no-render` runs the arithmetic in a second; the full run renders
the same figure through the game's own track camera into
[blender/preview](blender/preview/fig_mid_stroke_follow.png) with the numbers beside it in
[blender/_figure_report.json](blender/_figure_report.json). That is how the stance was
measured against the real broom and the real camera before any of it went into the shot loop.

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

### A delivery is a release: the called line vs the thrown one

The interface lets a player set three numbers exactly. If the stone obeyed all three
every time, the preview would be a promise instead of a call, aiming would have no
consequence beyond the number selected, and the only imprecision in the game would be
the CPU's. So a human delivery carries one roll, made once, at the moment of release —
in [release.js](release.js), a pure module, which is why the whole table is testable
from Node.

| release | weight | handle error | line error at the end of this throw |
|---|---|---|---|
| good | 50 | ±0.10 of a turn | none |
| ok | 25 | ±0.20 | ±10 cm |
| mediocre | 12 | ±0.40 | ±10 cm |
| bad | 12 | ±0.40 | ±20 cm |

Those weights sum to 99, so they are used as *weights* and normalised rather than read
as percentages: the ratio is exactly the intended one and no unclaimed 1% lands
somewhere. The spans are a separate decision, and they were raised on purpose: the first
version of this table (±0.1 of a handle, ±5 cm, ±10 cm) turned out to be a difference
nobody could feel against a house 3.66 m wide, so every span on a tier below a clean
release was doubled. The clean tier keeps its small handle jitter and no line error at
all — the distance between "clean" and "merely acceptable" is the whole point of the
table, so it is deliberately wide.

**The centimetres, as an angle.** physics.js states its own sensitivity in `solveAim`:
`dx/daim ≈ −run length`. The angle for a wanted offset is therefore
`atan(offset / run)`, and at the standard line — a 30 m draw, hack to button — 10 cm is
**0.1910°** and 20 cm is **0.3820°**. On a raise the same tier is larger in degrees and
identical in centimetres: 0.2865° and 0.5729° at 20 m are the same 10 cm and 20 cm at
the end of *that* line. The `run` used is the unbrushed distance of the weight being
thrown (`distanceForPower`, the inverse of `powerForDistance`), because that is the line
the preview and the miniature draw. That the model delivers what it promises is measured
rather than claimed in prose: at 30 m and at 20 m, with and without a ±2 turn, a 10 cm
error moves the resting point by `0.0999 m` and a 20 cm error by `0.1998 m`.

**The handle half is the larger half, and that is a property of curl.** One handle level
is worth 0.724 m of arc at draw weight — the calibrated 1.45 m of a ±2 turn, measured as
`0.7242 m` per level — so ±0.2 of handle is `14.5 cm` of line by itself and ±0.4 is
`29 cm`. Both halves of the table agreeing put the worst release the game can roll
**0.488 m** off the line at a draw; in opposite directions they very nearly cancel —
`0.09 m`. That is not a defect in the model, it is what a release is: sometimes the two
errors are the same error. The handle error is capped at the
calibrated range rather than left to run past it, because the curl law is stated *per
turn*: a stone already asked for ±3 can therefore only be delivered with less handle
than the player asked for, which is also the honest direction for a maximum turn.

**What it does to a shot, measured.** 4 000 rolls of a called button draw, measured
against where the clean delivery would have stopped: mean miss `7.9 cm`, `84%` inside
15 cm (the button itself), `97%` inside 30 cm, nothing worse than `50 cm`. Even the
worst release the table can produce cannot, on its own, throw a called draw out of the
house — its whole cost is in *precision*: whether a freeze freezes, whether a raise
slips a guard by ten centimetres or by twenty, whether a hit lands on the nose. That
boundary is asserted (`0.488 m` against a house radius of `1.83 m`), because a release
table that decided results by itself would be commentating on the wrong thing.

**What it never touches is the weight.** No tier has a power term; the stone goes
exactly as far as the meter stopped. That is deliberate — weight is the one part of the
shot the interface can measure *for* you — and the brief's acceptance item 2 asks only
that the arc "roughly predicts" the path, which 20 cm at 30 m does.

**This is not the CPU's error model, and the expected comparison is the one that
matters.** A CPU throw is made imprecise by `DIFFICULTY` in ai.js — aim noise, weight
noise, a chance of the wrong handle — which models a plan chosen as well as a stone
thrown. [tests/matchtest.mjs](tests/matchtest.mjs) group 9 keeps the two honest about
each other on the only basis that is fair to both: a player's *expected* line error
across a match of throws is about `8 cm` at 30 m (line and handle together, using the
measured 0.724 m per level), where a NORMAL CPU is off its line by `13 cm` on every
single throw, and the weight noise belongs to the CPU alone. The table's *worst* line
(0.382°) is now wider than a NORMAL CPU's per-throw aim noise (±0.24°) — a direct
consequence of doubling the spans, and recorded by an assertion so that it is met as a
decision rather than as a surprise. Without these checks, "NORMAL loses to a determined
human" would quietly become a claim about a superhuman stand-in.

**Determinism is not lost.** The world still has no random term, and the fixed-step
simulation still replays bit for bit — that is asserted, not assumed. The roll comes
from the match's seeded generator and draws in a fixed order (tier, then line, then
handle), so a seed replays a match including its releases. What is random is the input;
the ice is not.

**What the player sees.** The preview, the miniature and the HUD keep showing the shot
that was *called*: `G.shot` is never written at the release, and the stone that leaves
the hack is the one carrying the difference. A release that was not clean says so next
to the result (`— slightly off`); a clean one says nothing, because an apology every
third throw stops meaning anything. The SHOT LOG gains a row in the same signed units
the HUD uses — `loose release · handle −0.14 · line +6.2 cm`.
[tests/uitest.mjs](tests/uitest.mjs) group 2c pins *where* the roll may happen: one
call site in the whole game, inside `launchShot`, never in the aiming code, never a
second time on a CPU delivery, and never while the miniature is being fed.

## Known limitations

- There is no browser in this environment, so the visual verification is the
  Blender preview renders of the shipped GLBs through the game's own cameras, plus a
  raster of the weight miniature ([tests/track_preview.svg](tests/track_preview.svg)
  drawn by [tests/svg_peek.py](tests/svg_peek.py) from the markup the tests
  generate), not a screenshot of the running game. Everything else — rules, physics,
  UI wiring, asset contract — is covered by the Node suites.
  The one thing that remains unverified by eye is the orientation of the *scene*
  the miniature is aligned with (the miniature itself is rastered, and its agreement
  with the cameras is proved by rebuilding the screen bases from the vectors in
  `main.js`). Everything else in that list turned out to be measurable rather than
  merely visible, and is now: what the plan view frames, and what hangs between it
  and the ice, is measured against `assets/arena.glb` itself and rendered through its
  pose; whether the view actually holds still when the stones stop is answered by
  running the shipped camera code twice and comparing the coordinates, then rendering
  the one pose that is only ever reached once a stone has left the sheet; and the
  stance of the sweeper figure — square to the path, broom on the stone's own line,
  limbs that reach their joints — is rebuilt in Blender from the numbers read out of
  `main.js` and rendered through the camera that follows the play
  ([blender/preview_figure.py](blender/preview_figure.py)). Each of those is a firmer
  claim about those views than a screenshot of the running game would be.
- The procedural fallback textures are generated at startup (ice at 140 px/m). It is
  a heavier texture than the GLB path needs; it is only used when `assets/` is empty.
- The CPU plays a legal, sensible shot rather than a perfect one: difficulty scales
  aim error, weight error, spin mistakes, whether it brushes at all and how early it
  commits to a window, and Normal is set to be beatable by a determined human who
  holds Space along the whole delivery. `matchtest` models exactly that stand-in
  — it picks the obvious shot, chases the game, calibrates its weight and line
  against its own brushed delivery, and takes three of the twelve matches it plays; it
  never runs a shot search, which is the difference the ladder measures. The human at
  the other end of that claim is no longer exempt either — a delivery in the game
  carries the release spread described above — which is why group 9 asserts the
  comparison that actually matters instead of trusting it: a player's *expected* line
  error across a match of throws (about 8 cm at 30 m, line and handle together) against
  a NORMAL CPU's on every throw (13 cm).
