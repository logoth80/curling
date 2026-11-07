# Curling — 4 End

A keyboard-only 1v1 curling game for the browser. Four ends, eight stones each, the
hammer changes hands with the score, and every stone obeys the same deterministic
physics whether you are watching the aim preview, throwing the shot, or asking the
CPU to search its options.

Built to the spec in [GAME_PROMPT.md](GAME_PROMPT.md).

## Run it

**In a browser, right now:** <https://logoth80.github.io/curling/> — GitHub Pages
publishes this repository from `main`, and pushing `main` redeploys it a minute or two
later. Two things make that work, and group 4e of [tests/uitest.mjs](tests/uitest.mjs)
keeps them honest: every URL the page uses is relative to the page (a project page is
served under a `/curling/` subpath, so a path starting with `/` would resolve against
the host and find nothing), and `.nojekyll` is committed so Pages serves these bytes
rather than running a Jekyll build over them first — nothing here needs a build. What
the CDN hands back is byte-identical to what is in the repository, GLB hashes included,
because [.gitattributes](.gitattributes) marks the binaries as binary against the LF
catch-all and `assets/*.glb` are served as `model/gltf-binary`.

Or from a checkout, which is what you want while editing:

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

If it runs slowly on the device in your hand, the page can be told: append `?tier=lean`
or `?tier=poor` to the URL to ask for less, and on a phone or tablet the bottom-left
corner says which rung it is on, at what drawing-buffer ratio, at how many frames per
second, and how many objects it is handing the driver — `window.__curlingPerf()` in the
console gives the same numbers, exactly. What each rung stops drawing, and how the game
steps itself down when the frames say so, is in
[On a weak GPU](#on-a-weak-gpu-what-the-game-stops-drawing).

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

### On a phone: the same five controls, in the hand

A phone is not a smaller keyboard, it is a different hand. A thumb cannot find an
arrow key, but it can hold a button and drag across glass, and those two gestures are
worth the same five controls — so that is what they became. The state machine did not
change and no second set of rules was written: every touch writes into the input
vocabulary the keyboard uses (a held-key set plus a queue of counted press edges) or
calls the same function a key calls.

| What you do | Which control it is |
| --- | --- |
| Hold <b>◉</b>, let go | The weight. Holding is Space held down; letting go is queued as a press *only while the marker is running*, so one gesture is the whole two-press rhythm: hold to run the marker, release at the weight you want, tap in aiming to start it. The label on the button is rewritten from the phase every frame — START, STEP UP, HOLD, LET GO, BRUSH, NEXT END, PLAY AGAIN. `tests/uitest.mjs` fails if any phase ever lacks a label, because a button that lies about what it will do is a worse failure than a missing button. |
| Drag a finger across the ice | The line. A horizontal drag is turned into an angle by `physics.js` (`aimDragDeg`, `AIM_DRAG_SPAN`) — the same quantity ← → produce — and applied through the same clamped `adjustAim` the keys use. On a 390 px screen one degree is 29 px of finger and one key step is 6 px; a 120 px drag is 4.1°, about 2 m sideways at a house 30 m away, which is precisely why the *total* is clamped to ±6° and why the arc, not a number, is the feedback. The drag is a delta, not a tap position: where the finger lands means nothing, how far it travels means everything. |
| Tap a handle cell | The handle. The seven cells above the miniature are the widget the HUD already paints for the handle in hand; a tap is `setSpinLevel`, which is also the only writer of the handle for the keyboard. |
| Tap a title-card row | The setup options — a tap changes the option under the finger; a tap anywhere else on the card is the Space that starts the match. |
| Tap <b>◎</b> | The view: above the house, along the ice from the skipper's end, back at the hack, or the automatic one. A camera only, exactly like <kbd>Enter</kbd>. |

The one thing a phone has that a keyboard does not is the screen itself, so the aiming
control went onto the ice: the drag is not a slider, it is the sheet, and the arc on
the miniature is what answers it. The resolution is a rule in the rules layer, so it
does not drift with the device — `aimDragDeg(120, 500)` and `aimDragDeg(384, 1600)`
are the same angle, and `tests/selftest.mjs` measures what a phone-sized drag is worth
in metres on the ice.

The copy follows the instrument in hand: the sentence that names a key lives in
`.kbdonly`, the one that names the button in `.touchonly`, and `(any-pointer: coarse)`
picks which set is visible (a touchscreen laptop gets the layer the moment it is
touched). Where a prompt names a control it uses the mark printed on that control, and
`uitest` decodes both and compares them, because two spellings of one hint drift apart.
The page also owns its gestures now — `touch-action: none`, no overscroll, no tap
highlight — and sits clear of notches and home indicators with `viewport-fit=cover`
plus the safe-area insets. Landscape on a short screen splits the two: the miniature
keeps the middle, the button moves to the thumb at the right edge.

Two more rules came out of looking at the phone rather than reasoning about it. The
explanation panel is the biggest thing on that screen and it was covering the ice it
describes, so each phase's explanation is now written in two halves: the line that says
what to do with the control in hand, and the paragraph that explains why it works. The
second half carries `.roomy`, and a media query keyed to *room* (not to input type)
hides it in the cramped layout. That is one copy of one sentence, and the layout decides
how much of it fits — a shorter phone version would be a second sentence to keep true.
The standing legend that used to float over the ice, listing all five controls at once,
is gone: the title card already lists them and every phase repeats the one it needs, so
a third copy was only a third thing to go out of date — and it had no panel behind it,
which is why it could not be read. Where the thumb column is, the instrument band
cannot be: the meters sit above a column measured rather than guessed (14 px from the
edge, a 116 px action button, a 10 px gap, a ~34 px view pill, and a finger's width of
air), and the device pass compares the rectangle of every control against every other
one in both orientations — button against handle cells, explanation against miniature,
scoreboard against shot log.

What is proven and what is not. The pass that measured all of this is in the repository
now — `node tests/device.mjs`, 54 checks, green — and the flow was driven in headless
Edge at 390×844 and 844×390 through the DevTools protocol with real
`Input.dispatchTouchEvent` input. Measured: a 120 px drag moved the projected line's stop
marker 42.9 px sideways in the miniature and the same drag back restored it to 0.00 px; a
30 px drag was worth exactly a quarter of it; the mirrored drag was its negative; tapping
a handle cell lit that cell and bent the projected path by 14.8 px where a straight line
bends 0; holding the action button ran the marker to 20.5 m and letting go threw the
stone at the weight under the marker; holding the same button during the run brushed, and
the shot log afterwards reported the release. The layout half of the pass is what the
first phone look could not be settled by reasoning: the scoreboard band ends at y = 87, so
the explanation panel starts at 100 and covers 15.6% of the screen while never standing
on the play; the explanation and the shot log are bounded at 52vw and 34vw so about 36 px
of air separates them on a 390 px screen; and no control's rectangle overlaps another
control's, the miniature's, the scoreboard's or the shot log's in either orientation. It
has not been tried with a thumb on real glass, and that harness renders WebGL through
SwiftShader. See [Known limitations](#known-limitations).

### On a weak GPU: what the game stops drawing

This game was written against a desktop. On a phone or a tablet the same code asks for a
lot: at 1280×800 with `devicePixelRatio` 2 it fills 4.1 million fragments a frame, and it
hands the driver 56 separate things to draw. The arena is not the triangles — the whole
of `arena.glb` is 588 of them — it is 39 named boxes standing behind the play, and every
pixel of them is shaded more than once because the ice is already under them.

So the render cost is a ladder, and the rungs live in `perf.js` where they can be argued
with as numbers:

| rung | drawing buffer | arena dressing | sheet lamps | ice normal map |
|---|---|---|---|---|
| `full` | up to 2× | drawn | 2 | mapped |
| `lean` | 1.25× | **off** | 2 | mapped |
| `poor` | 1× | off | 1 | **off** |

Nothing else moves. The physics, the cameras, the rules, the light intensities and the
ice material's colour are the same at every rung, and the header of `perf.js` says what
each lever is worth and why the boards, kicks, dashers and the rubber deck are never in
it: ten meshes, and the cameras are written around them — the end summary stands at
Z = 21.2 and looks over the far dasher. Multisampling is deliberately *not* a rung: it is
a context flag fixed before the first frame exists, so `main.js` settles it once, from the
same pointer probe that chooses the controls — a touchscreen is never asked for it.

How a rung is chosen is the part worth reading. A device's name is not evidence, so the
opening guess is conservative and specific — a machine reporting 4 cores or 2 GB of
memory, or a touchscreen whose drawing buffer already exceeds 2.5 million pixels, starts at
`lean`; an *absent* value is not evidence the other way, since Safari reports no
`deviceMemory` at all — and then the frame intervals decide. 45 frames are sampled from
the timestamp `requestAnimationFrame` already hands the loop; their **median**, not their
mean, past 22 ms (a device holding vsync at 16.7 ms is never touched; one sitting at 33 ms
is), and the game steps down exactly one rung. Never two, never up, never past the last —
`decideTier` is written with no branch that goes up, because a phone that hit 60 fps on
the title screen does not stay there with 16 stones on the ice, and a player should not
watch the arena flicker back to find that out. The one 300 ms frame while a texture
uploads is why it is a median.

A tablet can be asked what it is doing. `window.__curlingPerf()` returns the rung, the
drawing-buffer ratio and its size in pixels, the sample count the driver gave, the measured
median frame, and the draw calls and triangles — and, kept separate from what the rung
*asks* for, how many of the 39 dressing parts are actually visible, how many sheet lamps
are on, and whether the ice still carries its normal map. On a phone or tablet that is
printed in a strip in the bottom-left corner, in 10 px type: it is the one corner the
touch layout leaves free, and it is the class of device that has a right to be told. The
device pass measures that strip against every control on the screen; on a desktop it is
`display: none`, which has a console.

`?tier=lean`, `?tier=poor`, `?tier=full` pin a rung so two can be compared by hand on the
same glass, and a pinned rung is not moved by the watchdog — that is what pinning it means.
No parameter, or `?tier=auto`, lets the frames decide.

The device pass measures what each rung costs on the shape of device this was asked for.
At 1280×800 dsf 2 the top rung covers **4.10M fragments** and hands over **56 draw calls**;
`lean` covers **1.60M** — 2.56× less to shade before anything is drawn — and hands over
**25**, with **0 of the 39** dressing parts visible while all 39 stay known to the game:
hidden, not deleted, so the assets and the coordinate contract are untouched. The
mechanism also fired on its own: the phone page in that pass walked itself from `full` to
`lean` on a measured median of 27.9 ms across 45 frames, and said so in the console with
the number. What none of that measures is a real phone GPU — the harness rasterises on a
CPU — so the frame rate on the device in your hand is still the one number only your
device can give.

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
favicon.ico     the icon: the house, drawn out of the sheet's own numbers
.nojekyll       empty marker: Pages publishes this folder as it is, with no Jekyll build
assets/         six GLB assets + generated textures (assets/tex)
blender/        the authoring and visual-gate scripts, their reports, and the
                reference photograph the stone handle was measured from
tools/          make_favicon.py, which draws favicon.ico from those sources, and
                check_windows_icon.ps1, which asks Windows whether it can read it
tests/          four Node suites, plus svg_peek.py to look at the widget
```

`physics.js`, `track.js`, `ai.js` and `release.js` deliberately import nothing outside
this folder — no THREE, no DOM.
That is what makes the whole game verifiable from Node, and
[tests/uitest.mjs](tests/uitest.mjs) fails the suite if a forbidden constant
creeps into the renderer.

## Tests

```sh
node tests/selftest.mjs    # 101 checks — physics, calibration, rules, scoring, the weight meter, the brushing model, the release bands measured on the ice, what a phone-sized drag is worth in metres on the sheet, and the render-quality ladder as numbers: that the rungs descend on every lever, that a 30 fps window steps down exactly one rung while a single hitch inside sixty real frames does not, that a window of forty frames is not a decision, and that no input at all can walk the ladder up
node tests/matchtest.mjs   # 30 checks — full matches, CPU strength ladder, timing, the two error models kept honest about each other
node tests/uitest.mjs      # 169 checks — DOM ids, key map, phases, cameras, the touch layer (no second state machine, no second handle widget, a label for every phase, the mark named in the copy is the mark printed on the button, an explanation that needs room is marked rather than rewritten shorter, the controls listed only where they are read), the render ladder (the ladder module owns no browser object, the drawing-buffer ratio has exactly one writer, the frame sampler runs ahead of the render call it measures, nothing on the cost path reads game state, and the dressing gate turns off precisely the 39 parts named in the shipped arena.glb while keeping the ten the cameras are written around — the procedural stand-in named the same way), the weight miniature, where a release may be rolled, the sweeper's stance and limbs (its joint solver is run, and every part the pose names is one the rig builds), whose handle angle, the tab icon, what the Windows icon decoder is given, and where it comes from, end resets, asset paths, that nothing asks the host root for a path, import boundary
node tests/glbtest.mjs     # 100 checks — the shipped GLBs against the game's coordinate contract, the handle's shape, and camera framing
```

One icon check can only run on Windows, because it asks Windows itself:

```sh
powershell -ExecutionPolicy Bypass -File tools/check_windows_icon.ps1
```

The phone pass is not one of those four. It needs a browser and a served copy of the
game, and a desktop browser lying about being a phone is not enough — the DevTools
emulation inside the script is what makes `(any-pointer: coarse)` true in the page, which
is the signal the game switches its layer on:

```sh
python -m http.server 8123 --bind 127.0.0.1   # from the repository root
node tests/device.mjs                         # 54 checks; EDGE=... for another Chromium build
```

Screenshots land in `tests/device-shots/`, gitignored on purpose: evidence, not source.
It drives real `Input.dispatchTouchEvent`, which is the only thing in this environment
that produces real PointerEvents in the page; synthetic key events through the protocol
never reach the game, which is why the keyboard path is tested by the suites above and
not by this one.

Its last half is the render ladder, and it is measured rather than asserted. The script
loads the same page again on a 1280×800 dsf 2 viewport with each rung pinned in the
address, and reads `window.__curlingPerf()` once the game has seen all 39 named dressing
parts — which is also the proof that the shipped `arena.glb` loaded rather than the
procedural stand-in, since that one names 29. It compares the fragments the drawing
buffer covers and the objects handed to the driver at each rung; checks that a pinned top
rung survived a renderer this slow, that the middle rung leaves none of the 39 visible
while still knowing all 39, that the bottom one *finds* the ice material and takes its
normal map off it rather than claiming to; that a touchscreen was never asked for
multisampling at all; and that the phone page it has been driving for two minutes — the
one case left unforced — walked itself down the ladder and logged the median it measured.
The strip that readout prints on a touch device is measured against every control on the
screen in both orientations, so the thing that reports the cost cannot itself be a thing
in the way.

It calls the shell's own icon extractor, reads the bitmaps the shell built, and compares
them against the bytes in `favicon.ico`; it exits non-zero if the shell cannot build the
icon, if a corner comes back solid black, or if the colours it drew differ from the file.

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
  roll described in [A delivery is a release](#a-delivery-is-a-release-the-shot-called-vs-the-stone-thrown).
- That roll is tested the same way: the four tiers and their exact bands, the
  frequencies over 40 000 draws of one fixed seed, no draw ever past its own tier on
  either axis and every band actually reachable, then the bands *measured* — each
  tier's share becoming exactly that share of the called run at 30 m, 20 m and 12 m in
  both directions, and the same on the ice, where the worst band leaves a called draw
  `4.50 m` short and a raise short of the far hog line (`hogViolation`), while the worst
  band long carries a draw through the house and past the back line (`outReason: 'back
  line'`). Across 2 000 real rolls of a called draw the mean miss is `0.78 m` and the
  median `0.47 m`, and `1.4%` of those deliveries finish out of play. The handle half is
  still asserted in the units the game calibrates curl in — `0.1` of a handle is
  `7.2 cm` at a draw, one level being `72.4 cm` — the shot-log wording is pinned, and
  the same seed replays the same release and the same rest position to the centimetre.
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

### The tab icon is the house, drawn from the sheet

`favicon.ico` is not a hand-drawn picture of a target. It is drawn from the numbers
the sheet is actually built with: [tools/make_favicon.py](tools/make_favicon.py) reads
the four ring radii out of `SHEET.rings` in `physics.js` and the four ring colours out
of the material factors in `blender/build_assets.py`, then draws the house — blue
twelve-foot, white eight-foot, red four-foot, white button, with the tee line and the
centre line crossing it — into one `.ico` carrying 16, 24, 32, 48, 64, 128 and 256 px,
49 KB in all. Each size is drawn from its own 8× supersample and averaged down, so no
size in the file is a shrunk copy of another one.

Two consequences of drawing the real thing small are left alone rather than corrected.
The lines are the sheet's own 0.05 m, which is 2.7% of the house radius: at 16 px that
is a fifth of a pixel, so the cross disappears except where the two lines meet, and what
survives is rings and a dot. The button is a twelfth of the house, so at 16 px it is one
dot. A version with the lines thickened to survive at 16 px would be a different sheet,
and the icon is meant to be this one.

The colour is the material, not the render. A glTF base-colour factor is linear, so the
factors are encoded to sRGB before they become pixels; the previews in
`blender/preview` sit lower than those bytes because they are shot under lights, which is
a different measurement belonging to a different file. The generator checks its own work:
it probes the mid-radius of every annulus along a diagonal, clear of the cross, and fails
unless those pixels carry the sheet colours exactly. That check earned its place on the
first run — LANCZOS ringing around the small, saturated button had shifted plain white
pixels by eleven, which would have gone straight into the file a browser shows.

The container carries two entry formats, and that is deliberate. The sizes Windows asks
for — 16, 24, 32, 48 and 64 px — are stored as classic uncompressed 32-bit DIBs whose
`biHeight` is twice the image height, the second half being the AND mask; 128 and 256 px
stay PNG, because an uncompressed 256 px entry would cost eight times what it is worth
and only browsers ask for those. The mask is derived from the alpha channel instead of
left empty, which is not pedantry: a set bit in that mask means "this pixel is
transparent", and the first version of these entries left the mask empty, so the bitmap
Windows built came back with **opaque black corners** — the black square that icon
folklore blames on "broken .ico files".

[tools/check_windows_icon.ps1](tools/check_windows_icon.ps1) asks Windows rather than
reasoning about it. It calls `shell32!ExtractIconEx`, reads the bitmaps the shell built
for the large and the small icon, and compares them against the DIB entries in the file;
it exits non-zero if a handle is missing, if a corner comes back solid black, or if the
colours differ from the file by more than a rounding step. For the current file it
reports both handles present, transparent corners, and a maximum channel difference of 0
across the 640 fully-opaque pixels of the 32 px icon. Two things worth knowing before
using it: `ExtractIconEx`'s second argument is an icon **index**, not a size selector —
one call at index 0 returns the large and the small handle together, and reading that
wrong once produced a confident "the shell produced no icon" that was the script's bug.
And what it did *not* find: the all-PNG container this file shipped with also passed on
this machine, both handles coming back transparent. PNG inside an `.ico` is not broken on
modern Windows. The DIB entries are there because Explorer's icon paths and every older
path predate PNG support, not because a measured failure demanded them.

If Explorer still shows something else after the file changes, it is showing its cached
icon for that path rather than the file: `ie4uinit.exe -show`, or an Explorer restart,
is what makes it look again. The browser's tab icon has the same habit — a
`favicon.ico` that once answered 404 stays missing until the page is reloaded.

Groups 4c and 4d of [tests/uitest.mjs](tests/uitest.mjs) hold the rest of it: the page
must declare the icon with a relative path, so the game still gets its icon when it is
served from a subpath; the shipped file must parse as an icon directory whose entries are
all complete payloads; the sizes Windows asks for must be 32-bit DIBs whose AND mask
agrees pixel-for-pixel with the alpha channel; the sizes only browsers want must stay
PNG; and the generator must keep reading the radii and the colours out of those two
sources rather than copying them, which is the only reason the icon cannot quietly drift
off the sheet. Regenerate it with `python tools/make_favicon.py`; it prints the radii,
palette, entry table and mask verdict it used.

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

### A delivery is a release: the shot called vs the stone thrown

The interface lets a player set three numbers exactly. If the stone obeyed all three
every time, the preview would be a promise instead of a call, aiming would have no
consequence beyond the number selected, and the only imprecision in the game would be
the CPU's. So a human delivery carries one roll, made once, at the moment of release —
in [release.js](release.js), a pure module, which is why the whole table is testable
from Node.

| release | weight | weight error, as a share of the delivery | handle error |
|---|---|---|---|
| good | 50 | ±2% | ±0.10 of a turn |
| ok | 25 | ±5% | ±0.20 |
| mediocre | 12 | ±9% | ±0.40 |
| bad | 12 | ±15% | ±0.40 |

The frequencies and the handle spans are the ones this table has always had; what
changed is what the tiers are wrong *about*. A real release goes wrong in the hands, and
what the hands control is how hard the stone is pushed and how the handle is loaded —
not the line, which the player sighted and can see. The earlier version of this table
put part of the error in the line, and it has none now: **a player is exactly on the
line they called.** Everything uncertain about a human delivery is distance and curl.

**The share is of the delivery, not of the meter value**, and that distinction is the
whole size of the model. A 30 m draw sits at power `0.700`, and travel is quadratic in
speed, so a percentage of power is roughly **2.2×** the same percentage of distance.
Read against the meter, ±2% would already be **±1.2 m** and ±15% would send the stone
off the sheet — "clean" and "bad" would be adjectives for the same catastrophe. Read
against the delivery that was called, the tiers mean what a player would call them:

| called delivery | clean | slightly off | loose | bad |
|---|---|---|---|---|
| a 30 m draw | ±0.60 m | ±1.50 m | ±2.70 m | ±4.50 m |
| a 20 m raise | ±0.40 m | ±1.00 m | ±1.80 m | ±3.00 m |
| a 12 m raise | ±0.20 m | ±0.60 m | ±1.10 m | ±1.80 m |

So a hard takeout and a soft guard are wrong by the same share of what they were asked
to be, which is how a weight error behaves on ice. The `run` the share is taken against
is the **unbrushed** distance of the weight being thrown, because that is what the
preview and the miniature drew; brushing is a separate effect the player asked for.

**The conversion is delegated, not invented.** `powerForDistance` is the rules module's
own inverse stopping law, so the share becomes the power that produces it and no new
constant enters the world. The resulting power is kept inside the calibrated range,
because `launchSpeed` clamps there and the deceleration and curl calibration are both
stated in it; inside the meter's own travel band (14–36 m) that clamp never binds — the
heaviest selection plus fifteen per cent is power `0.822` — so it is there for shots
built by hand or by a test rather than by the widget. The metres reported in the shot log
are computed from the power that was actually applied, so the log describes the delivery
that happened rather than the one that was intended.

**The handle half is smaller than it used to be, and it stays for a different reason.**
One handle level is worth 0.724 m of arc at draw weight — the calibrated 1.45 m of a ±2
turn, measured as `0.7242 m` per level — so ±0.2 of handle is `14.5 cm` of line and
±0.4 is `29 cm`. Against a weight term worth metres, that is now the minor half; it
stays in the table because curl is what makes a draw curve at all, and because a player
who loads the handle wrongly should be told so in the units the game already uses. The
handle error is still capped at the calibrated range rather than left to run past it,
because the curl law is stated *per turn*: a stone already asked for ±3 can only be
delivered with less handle than the player asked for, which is also the honest direction
for a maximum turn.

**What it does to a shot, measured.** 4 000 rolls of a called button draw, measured
against where the clean delivery would have stopped: mean miss `0.76 m`, median
`0.46 m`, p95 `2.68 m`, p99 `3.73 m`, and `49` of those `4000` (`1.2%`) finish **out of
play** — the `bad` tier long puts a draw at `Z = 18.55`, past the back line, and the
rules take it. At a called 20 m raise the same rolls mean `0.51 m` and lose nothing, but
the `bad` tier short stops at `Z = +1.97`, short of the far hog line a delivered stone
must fully pass, and that delivery is taken out of play too. A bad release is therefore
no longer a precision problem — it can cost you the stone — while a clean one still
misses by about half a metre at a draw, which is a precision problem, which is what a
clean-but-not-perfect release is. Both of those outcomes are asserted on the ice, in the
rules' own terms (`outReason: 'back line'`, `hogViolation`), not inferred from the
arithmetic.

**This is not the CPU's error model, and the expected comparison is the one that
matters.** A CPU throw is made imprecise by `DIFFICULTY` in ai.js — aim noise, weight
noise, a chance of the wrong handle — which models a plan chosen as well as a stone
thrown. [tests/matchtest.mjs](tests/matchtest.mjs) group 9 keeps the two honest about
each other on the only basis fair to both: expected error across a match. At a 30 m draw
a player is off by about **0.78 m** (`0.78 m` of weight and `0.07 m` of handle, in
quadrature, using the measured 0.724 m per level), where a NORMAL CPU is off by about
**2.10 m** on every single throw (`0.13 m` of aim, `2.09 m` of weight, `0.11 m` of
handle). That is what "NORMAL must lose to a determined human sometimes" rests on, and
the player still wins it comfortably. The two models are now asymmetric on purpose, and
group 9 records that too: a human release carries no aim term at all, while a CPU always
carries ±0.24° of it, because that noise models a plan chosen badly rather than hands
that slipped. The player's *worst* band (±4.50 m at a draw) does reach past the whole
CPU spread — only the two tiers whose bands do (24% of throws, and only the outer part
of those bands) — and the assertion states that boundary rather than a tidy "tiers below
clean", since every tier now carries some weight error.

**Determinism is not lost.** The world still has no random term, and the fixed-step
simulation still replays bit for bit — that is asserted, not assumed. The roll comes
from the match's seeded generator and draws in a fixed order (tier, then weight, then
handle), so a seed replays a match including its releases. What is random is the input;
the ice is not.

**What the player sees.** The preview, the miniature and the HUD keep showing the shot
that was *called*: `G.shot` is never written at the release, and the stone that leaves
the hack is the one carrying the difference — the meter reading is the intent, not the
launch. A release that was not clean says so next to the result (`— slightly off`); a
clean one says nothing, because an apology every third throw stops meaning anything. The
SHOT LOG gains a row naming both halves in signed units:
`loose release · handle −0.24 · weight +7% · 2.1 m long`, or `clean release · handle
+0.02 · dead weight` when the delivery made its distance.
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
- That bullet still holds for the desktop game, with one exception, because the touch
  layer needed a viewport rather than a source check: the phone flow is driven by
  [tests/device.mjs](tests/device.mjs) in headless Edge over the DevTools protocol at
  390×844 and 844×390 with real touch events — including the rectangle comparisons that
  a first look at the phone proved necessary, since reasoning about a layout had missed
  two overlaps in it — and the figures quoted in the [phone section](#on-a-phone-the-same-five-controls-in-the-hand)
  come out of that run, with screenshots. That is a browser, but a confined
  one rendering WebGL through SwiftShader: it proves the controls, the geometry of a
  drag, the labels, and that no two controls occupy the same ground. What only a real
  device would tell me is still unproven here —
  the feel of a fingertip on a drag (its resolution is measured in metres and asserted;
  its feel is a judgement), a notch or home indicator with real safe-area values, and a
  tablet's wider viewport, which sits between the two layouts that were run. One thing I
  can see in the screenshots and have not fixed: when a phase's text is longer than the
  panel's bound, the panel scrolls and a line can be cut at its lower edge — legible,
  but without a cue that there is more below. The
  keyboard path was not driven in that pass either — it is the path the Node suites have
  covered since the beginning, and the touch layer only writes into the channels it
  already had.
- The render ladder is measured, but the machine measuring it is not a phone. The figures
  in the [weak-GPU section](#on-a-weak-gpu-what-the-game-stops-drawing) — the fragments
  each rung's drawing buffer covers, the objects it hands the driver, 39 dressing parts
  hidden out of 39 still known — are read out of the page and hold for any renderer. The
  frame intervals that decide *when* to step down do not transfer: that harness
  rasterises on a CPU, so the budget (a median past 22 ms across 45 frames) is a stated
  number rather than a calibration against real mobile silicon, and the opening guess is
  one-way — a fast phone that the guess placed at `lean` will stay there until
  `?tier=full` says otherwise, because nothing in the browser walks the ladder back up.
  What the lower rungs give up is not subtle either: at `lean` the stands, crowd,
  banners, trusses and lamps are simply not drawn, and the arena reads as boards and ice
  in the dark. That is the trade the ladder exists to make, it is reversible by hand from
  the address, and it is not a rough edge to polish away — the alternative is shading the
  same 4.1 million fragments on a device that asked for less.
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
  carries the release bands described above — which is why group 9 asserts the
  comparison that actually matters instead of trusting it: a player's *expected* error
  across a match of throws (about `0.78 m` at a 30 m draw, weight and handle together)
  against a NORMAL CPU's on every throw (about `2.10 m`).
