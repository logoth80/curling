/* Device pass for the curling game's touch layer.
 *
 * There is no Playwright in this environment, so this drives a real browser
 * directly: headless Edge over the Chrome DevTools Protocol, with a phone
 * viewport, real touch input (Input.dispatchTouchEvent, which is what produces
 * real PointerEvents in the page), and screenshots.
 *
 * This is not one of the four Node suites: it needs a real browser and a served
 * copy of the game, and a desktop browser lying about being a phone will not do -
 * the emulation below is what makes (any-pointer: coarse) true in the page. Run:
 *   python -m http.server 8123 --bind 127.0.0.1     # from the repository root
 *   node tests/device.mjs                          # EDGE=... to pick another build
 * Screenshots go to tests/device-shots/ (gitignored: evidence, not source).
 *   node device.mjs            (assumes the game is served on 127.0.0.1:8123)
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_BASE = 'http://127.0.0.1:8123/index.html';
const PORT = 9333;
const SCRATCH = join(import.meta.dirname, 'device-shots');
const SHOTS = join(SCRATCH, 'shots');
mkdirSync(SHOTS, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'OK  ' : 'NO  '} ${name}${detail ? '  ::  ' + detail : ''}`);
};

/* ------------------------------------------------------------ CDP client */
let ws, nextId = 1;
const pending = new Map();
const consoleErrors = [];
// The game logs one thing on purpose: when measured frame intervals push the render
// tier down, it says so with the number it measured. That is a claim the page makes
// about itself, so the pass listens for it.
const consoleNotes = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket failed')));
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push('exception: ' + (d.exception?.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('console.error: ' + (msg.params.args || []).map(a => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['info', 'log', 'warning'].includes(msg.params.type)) {
      consoleNotes.push((msg.params.args || []).map(a => a.value ?? a.description).join(' '));
    }
  });
}
async function evalJs(expression, { awaitPromise = false } = {}) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const rectOf = sel => evalJs(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); var cs=getComputedStyle(e);
  return {x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height,
          display:cs.display, vis:!(e.classList.contains('hidden')||cs.display==='none'||cs.visibility==='hidden')};})()`);
async function tap(x, y) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function hold(x, y, ms) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(ms);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function drag(x1, y1, x2, y2, steps = 12) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }] });
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const pathPoints = () => evalJs(`(function(){var p=document.getElementById('trackPath');
  return (p.getAttribute('points')||'').trim().split(/\\s+/).filter(Boolean).map(s=>{var a=s.split(',');return [parseFloat(a[0]),parseFloat(a[1])];});})()`);
async function shot(name) {
  const img = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, name + '.png'), Buffer.from(img.data, 'base64'));
  console.log('     shot -> shots/' + name + '.png');
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evalJs(expr)) return true;
    await sleep(200);
  }
  console.log('     (timeout waiting for ' + label + ')');
  return false;
}

/* ---------------------------------------------------------------- run it */
const userDir = join(SCRATCH, 'edge-profile');
const proc = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  // The harness this runs in denies a child process handle access, which is what
  // Chromium's own process sandbox needs, so the browser sandbox is off here.
  // WebGL runs on SwiftShader: the 3D path is exercised, not proof of a phone GPU.
  '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=390,844', 'about:blank',
], { stdio: ['ignore', openSync(join(SCRATCH, 'edge-out.txt'), 'w'), openSync(join(SCRATCH, 'edge-err.txt'), 'w')], detached: true });
proc.unref();

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page');
  } catch (e) { /* not up yet */ }
}
if (!target) { console.log('NO   edge devtools endpoint never came up'); process.exit(2); }
await connect(target.webSocketDebuggerUrl);
console.log('browser: ' + (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).product);

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// A phone in every sense the page can see: viewport, mobile chrome, touch points.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
await send('Emulation.setEmulatedUserAgent', { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Edg/120.0.0.0' }).catch(() => {});

await send('Page.navigate', { url: URL_BASE });
const booted = await waitFor('window.__curlingBoot === true', 30000, 'the game to boot');
ok('the page boots in a phone viewport over HTTP', booted);
const startupError = await evalJs(`(document.getElementById('hint')||{}).textContent || ''`);
ok('no WebGL/asset startup error at 390x844', !/startup error/i.test(startupError), startupError.slice(0, 120));
const media = await evalJs(`({
  anyCoarse: matchMedia('(any-pointer: coarse)').matches,
  anyFine: matchMedia('(any-pointer: fine)').matches,
  touchBody: document.body.classList.contains('touch'),
  dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight,
  bodyTouchAction: getComputedStyle(document.body).touchAction,
})`);
ok('the page sees a touch-capable phone and switches the layer on',
  media.touchBody && media.vw === 390, JSON.stringify(media));

// --- the buttons are on screen and the first one says what the game will do ---
const btn = await rectOf('#btnAction');
ok('a 116px action button is on screen at the thumb corner',
  btn && btn.vis && btn.w >= 100 && btn.x > 390 - 150 && btn.y > 844 - 180,
  btn && `at ${Math.round(btn.x)},${Math.round(btn.y)} size ${Math.round(btn.w)}`);
ok('its label reads START on the title screen',
  (await evalJs(`(document.getElementById('actionLabel')||{}).textContent`)) === 'START');
const viewBtn = await rectOf('#btnView');
ok('a view button sits above it, saying which view is in force',
  viewBtn && viewBtn.vis && /auto/.test(await evalJs(`(document.getElementById('viewWord')||{}).textContent`)),
  viewBtn && `at ${Math.round(viewBtn.x)},${Math.round(viewBtn.y)}`);
await shot('01-title-phone');

// --- the title options are rows you tap, not rows you arrow through ---
const modeBefore = await evalJs(`(document.getElementById('optMode')||{}).textContent`);
const opt = await rectOf('.opt[data-opt="mode"]');
await tap(opt.x, opt.y);
await sleep(250);
const modeAfter = await evalJs(`(document.getElementById('optMode')||{}).textContent`);
ok('tapping the MODE row changes the option under the finger', modeBefore !== modeAfter, `${modeBefore} -> ${modeAfter}`);
await tap(opt.x, opt.y);
await sleep(250);
const modeRestored = await evalJs(`(document.getElementById('optMode')||{}).textContent`);
ok('a second tap moves it back, so a thumb cannot get stuck on a setting',
  modeRestored === modeBefore, `${modeAfter} -> ${modeRestored}`);

// --- start the match by tapping the card, as the copy says ---
await tap(195, 700);
await waitFor(`document.getElementById('title').classList.contains('hidden')`, 4000, 'the title card to go away');
await sleep(400);
ok('tapping the card starts the match (the title overlay is gone)',
  await evalJs(`document.getElementById('title').classList.contains('hidden')`));
ok('the button now says STEP UP, which is what pressing it does next',
  (await evalJs(`(document.getElementById('actionLabel')||{}).textContent`)) === 'STEP UP');
const promptSetup = await evalJs(`(document.getElementById('prompt')||{}).textContent || ''`);
ok('the explanation names the button, not a keycap, on a phone',
  /to step up to the hack/i.test(promptSetup) && !/Space/.test(promptSetup), promptSetup.slice(0, 90));

// --- step up to the hack ---
const btn2 = await rectOf('#btnAction');
await tap(btn2.x, btn2.y);
await waitFor(`!document.getElementById('powerBox').classList.contains('hidden')`, 4000, 'the aim phase to start');
ok('the action button starts the aiming phase',
  await evalJs(`!document.getElementById('powerBox').classList.contains('hidden')`));
ok('its label changes to HOLD, the gesture it wants',
  (await evalJs(`(document.getElementById('actionLabel')||{}).textContent`)) === 'HOLD');
const promptAim = await evalJs(`(document.getElementById('prompt')||{}).textContent || ''`);
ok('the aiming prompt describes a drag and a handle row, not arrow keys',
  /drag a finger/i.test(promptAim) && !/←/.test(promptAim), promptAim.replace(/\s+/g, ' ').slice(0, 120));
await shot('02-aim-phone');

// --- the ice drag: a real directional test of the sign, at phone size ---
// Three gestures, each one inside the viewport, each measured after it lands:
// right by 120 px, back to the start by the same drag, then the mirror image.
const neutral = await pathPoints();
ok('the aim preview is drawn in the miniature while aiming', Array.isArray(neutral) && neutral.length > 2,
  `${neutral && neutral.length ? neutral.length : 0} points`);

// --- layout: nothing a thumb needs may sit on top of anything else it needs ---
const layoutCode = `(function(){
  function R(t,tag){var e=typeof t==='string'?document.querySelector(t):t; if(!e) return null;
    var b=e.getBoundingClientRect(), cs=getComputedStyle(e);
    return {tag:tag||t,x:b.x,y:b.y,w:b.width,h:b.height,r:b.right,bottom:b.bottom,
            shown:b.width>0&&b.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'};}
  function hit(a,b){return a&&b&&a.shown&&b.shown&&a.x<b.r&&b.x<a.r&&a.y<b.bottom&&b.y<a.bottom;}
  var keys=['#btnAction','#btnView','#prompt','#meterRow','#board','#telemetry','#perf','#meters','#powerBox'],e={};
  keys.forEach(function(k){e[k]=R(k);});
  var cells=Array.prototype.map.call(document.querySelectorAll('.slev'),function(c){return R(c,'handle cell '+c.dataset.s);});
  var clashes=[],pairs=[['#btnAction','#btnView'],['#btnAction','#meterRow'],['#btnView','#meterRow'],
    ['#prompt','#meterRow'],['#prompt','#board'],['#prompt','#telemetry'],['#telemetry','#btnAction'],
    ['#telemetry','#meterRow'],
    // The render-tier strip is new, so it is measured against everything, not assumed
    // to be small enough to fit. It is the only element on the page that is allowed to
    // be an afterthought in a corner, and corners are where the controls live.
    ['#perf','#meterRow'],['#perf','#btnAction'],['#perf','#btnView'],['#perf','#prompt'],
    ['#perf','#telemetry'],['#perf','#board']];
  pairs.forEach(function(p){ if(hit(e[p[0]],e[p[1]])) clashes.push(p[0]+' over '+p[1]); });
  cells.forEach(function(c){ ['#btnAction','#btnView'].forEach(function(k){ if(hit(e[k],c)) clashes.push(k+' over '+c.tag); }); });
  var px=innerWidth/2, py=innerHeight*0.55, p=e['#prompt'];
  var roomy=document.querySelector('.roomy');
  var perf=e['#perf'], band=e['#meters'], power=e['#powerBox'], btn=e['#btnAction'], view=e['#btnView'];
  // The band and the thumb column, as the page lays them out: the offset the band is
  // kept at, the height of the weight panel the drop is half of, and whether the
  // column is under the band (a phone) or beside it (a wide touch screen).
  var bandOff=band&&band.shown?innerHeight-Math.round(band.bottom):null;
  var powerH=power&&power.shown?Math.round(power.h):null;
  var underBand=!!(band&&btn&&band.shown&&btn.shown&&band.x<btn.r&&btn.x<band.r);
  return {clashes:clashes,
    bandOffset:bandOff, powerH:powerH, underBand:underBand,
    promptArea:p&&p.shown?(p.w*p.h)/(innerWidth*innerHeight):0,
    bands:'board bottom '+(e['#board']&&e['#board'].shown?Math.round(e['#board'].bottom):'hidden')+
          ', panel '+(p&&p.shown?Math.round(p.y)+'..'+Math.round(p.bottom):'hidden')+
          ', perf '+(perf&&perf.shown?Math.round(perf.x)+','+Math.round(perf.y)+'..'+Math.round(perf.r)+','+Math.round(perf.bottom):'hidden')+
          ', band bottom offset '+(bandOff===null?'hidden':bandOff)+', weight panel '+(powerH===null?'hidden':powerH)+
          (underBand?', column under the band':', column beside the band'),
    perfShown:!!(perf&&perf.shown), perfText:perf?(document.getElementById('perf').textContent||''):'',
    perfInView:!!(perf&&perf.shown&&perf.x>=0&&perf.y>=0&&perf.r<=innerWidth&&perf.bottom<=innerHeight),
    roomyQuery:matchMedia('(max-width: 760px), (max-height: 620px)').matches,
    overPlay:!!(p&&p.shown&&px>p.x&&px<p.r&&py>p.y&&py<p.bottom),
    roomyHidden:!roomy||getComputedStyle(roomy).display==='none',
    vp:innerWidth+'x'+innerHeight};
})()`;
// The band is kept 190px off the bottom edge by the CSS; how much of that it gave
// up is what the page decided, and this is the difference.
const BAND_BASE = 190;
const bandDrop = f => (f.bandOffset === null ? null : BAND_BASE - f.bandOffset);
async function checkLayout(where) {
  const f = await evalJs(layoutCode);
  ok(`no control overlaps another control, the miniature, the scoreboard or the shot log (${where})`,
    f.clashes.length === 0, `${where}: ${f.clashes.join(' ; ') || 'nothing overlaps'} @ ${f.vp} [${f.bands}]`);
  ok(`the phase explanation keeps off the ice it is talking about (${where})`,
    !f.overPlay && f.promptArea > 0.01 && f.promptArea < 0.24,
    `${where}: the panel covers ${(f.promptArea * 100).toFixed(1)}% of the screen; over the play: ${f.overPlay} [${f.bands}]`);
  // Which way this viewport falls is the stylesheet's media query itself, read back:
  // the same sentence is tested from both sides, and a wide tablet is a viewport where
  // the room exists and the long half is supposed to stay.
  if (f.roomyQuery) {
    ok(`when there is no room, the half of the explanation that needs room is what goes (${where})`,
      f.roomyHidden, `${where}: a .roomy paragraph was still displayed at ${f.vp}`);
  } else {
    ok(`where the room does exist, the explanation keeps the half that needs it (${where})`,
      !f.roomyHidden, `${where}: the .roomy paragraph was hidden at ${f.vp} where there is room for it`);
  }
  ok(`the render-tier strip is on screen, inside the viewport, and says what the device is getting (${where})`,
    f.perfShown && f.perfInView && /\b(full|lean|poor)\b/.test(f.perfText) && /fps/.test(f.perfText),
    `${where}: "${f.perfText}" [${f.bands}]`);
  return f;
}
const aimPortrait = await checkLayout('portrait, aiming');
ok('on a phone portrait the band keeps the 190px the thumb column was measured at, because that column is under it',
  aimPortrait.underBand === true && bandDrop(aimPortrait) === 0,
  `bottom offset ${aimPortrait.bandOffset}, drop ${bandDrop(aimPortrait)}, weight panel ${aimPortrait.powerH}px [${aimPortrait.bands}]`);

// The same screen with a full shot log open. Forced here rather than waited for,
// because the invariant is that two top panels may never meet, and a line longer
// than any real log line makes both widths deterministic: the columns are bounded
// in CSS, so what is being tested is the bound, not the content.
await evalJs(`(function(){var t=document.getElementById('telemetry');
  t.innerHTML='<div class="hd">SHOT LOG</div>'+[1,2,3,4].map(function(){
    return '<div>position guard release clean release and a line long enough to be wrapped by the bounded column</div>';}).join('');
  t.classList.remove('hidden');})()`);
await checkLayout('portrait, aiming with a full shot log');
const endOf = pts => (pts && pts.length ? pts[pts.length - 1] : [NaN, NaN]);
// In the miniature the horizontal axis is travel along the sheet and the vertical
// axis is sideways, so a line change shows up in y, never in x. (track.js: trackD
// for distance, trackX for sideways; tests/uitest.mjs group 3b reads it the same way.)
const sideways = pts => endOf(pts)[1];
const headingOf = pts => (pts && pts.length > 1 ? pts[1][1] - pts[0][1] : NaN);
await evalJs(`window.__probe = [];
  for (const t of ['pointerdown','pointermove','pointerup','pointercancel']) {
    document.querySelector('canvas').addEventListener(t, e => window.__probe.push([t, e.pointerType, e.pointerId, Math.round(e.clientX)]), true);
  }`);
const p0 = endOf(neutral);
const h0 = headingOf(neutral);
// Two drags of known length: the ratio between them is a claim about the drag law
// itself, which is linear in pixels by construction (aimDragDeg). The absolute
// value in metres on the ice is asserted in tests/selftest.mjs group 9, in physics
// units; the browser cannot be more accurate than the widget it draws.
await drag(60, 430, 90, 430);               // +30 px: a thumbnail
await sleep(300);
const shiftSmall = sideways(await pathPoints()) - p0[1];
await drag(90, 430, 60, 430);              // back to the start, so the next drag starts clean
await sleep(300);
const backZero = sideways(await pathPoints()) - p0[1];
await drag(60, 430, 180, 430);             // +120 px: a thumb across the glass
await sleep(300);
const probe = await evalJs(`(function(){var c=document.querySelector('canvas'), p=window.__probe||[];
  var kinds = {}; p.forEach(e => kinds[e[0]] = (kinds[e[0]]||0)+1);
  return {counts: kinds, first: p[0], last: p[p.length-1], canvas: c.clientWidth+'x'+c.clientHeight,
          overCanvas: (document.elementFromPoint(120,430)||{}).tagName};})()`);
console.log('     drag probe: ' + JSON.stringify(probe));
const shifted = await pathPoints();
const shiftRight = sideways(shifted) - p0[1];
const headingRight = headingOf(shifted) - h0;
console.log(`     drag effect: stop marker sideways ${shiftRight.toFixed(1)} px, heading ${headingRight.toFixed(2)} px`);
await drag(180, 430, 60, 430);             // -120 px: back to the line the keys start at
await sleep(300);
const backPts = await pathPoints();
const backHead = headingOf(backPts) - h0, backEnd = sideways(backPts) - p0[1];
await drag(330, 430, 210, 430);            // -120 px again: the mirror of the first drag
await sleep(300);
const mirrored = await pathPoints();
const shiftLeft = sideways(mirrored) - p0[1];
const headingLeft = headingOf(mirrored) - h0;
ok('four times the drag is worth four times the line, on the phone itself',
  Math.abs(shiftSmall) > 6 && Math.abs(backZero) < 1.5
    && Math.abs(shiftRight / shiftSmall - 4) < 0.6,
  `30 px of drag: ${shiftSmall.toFixed(1)} px sideways, 120 px: ${shiftRight.toFixed(1)} px, ratio ${(shiftRight / shiftSmall).toFixed(2)}; the way back left it ${backZero.toFixed(2)} px off`);
ok('a drag right turns the projected line, and a drag left turns it the other way',
  Math.abs(headingRight) > 0.2 && Math.sign(headingRight) === -Math.sign(headingLeft)
    && Math.abs(headingRight + headingLeft) < Math.abs(headingRight) * 0.15,
  `heading: right ${headingRight.toFixed(2)}, left ${headingLeft.toFixed(2)}; end marker ${shiftRight.toFixed(1)}/${shiftLeft.toFixed(1)} px`);
ok('dragging the same distance back restores the line the keys start at',
  Math.abs(backHead) < Math.max(0.05, Math.abs(headingRight) * 0.08) && Math.abs(backEnd) < 1.5,
  `off by ${backHead.toFixed(3)} in heading and ${backEnd.toFixed(2)} px at the stop marker`);

// --- the handle row is the widget the HUD already paints, made tappable ---
const cell = await rectOf('.slev[data-s="2"]');
ok('the handle cells are thumb-sized targets', cell && cell.vis && cell.w >= 30, cell && `${Math.round(cell.w)}px cells`);
await tap(cell.x, cell.y);
await sleep(250);
const onLevel = await evalJs(`(document.querySelector('.slev.on')||{}).dataset ? document.querySelector('.slev.on').dataset.s : null`);
ok('tapping a handle level lights that level, exactly as the arrow keys would',
  onLevel === '2', `lit level: ${onLevel}`);
const spun = await pathPoints();
// A straight line cannot bend: deviation from the chord between the first and last
// point is what a handle does to a projected path, and it does not depend on scale.
const bend = pts => {
  if (!pts || pts.length < 3) return NaN;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  return Math.max(...pts.map(([x, y]) => Math.abs((x - ax) * dy - (y - ay) * dx) / len));
};
ok('and the projected path bends with the handle, which a straight line never does',
  bend(neutral) < 1.5 && bend(spun) > 1.5,
  `bend at handle 0: ${bend(neutral).toFixed(2)} px, at handle 2: ${bend(spun).toFixed(2)} px`);
await shot('03-aim-line-and-handle-phone');

// --- the weight button: hold, watch the marker, let go ---
const btn3 = await rectOf('#btnAction');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: btn3.x, y: btn3.y }] });
await sleep(700);
const midHold = {
  label: await evalJs(`(document.getElementById('actionLabel')||{}).textContent`),
  metres: await evalJs(`(document.getElementById('powerVal')||{}).textContent`),
};
await shot('04-weight-marker-held-phone');
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await waitFor(`!document.getElementById('sweepBox').classList.contains('hidden')`, 4000, 'the stone to be thrown');
ok('the marker ran while the button was held, and the label said LET GO',
  midHold.label === 'LET GO' && /m/.test(midHold.metres), `label ${midHold.label}, readout ${midHold.metres}`);
ok('letting go threw the stone at the weight under the marker',
  await evalJs(`!document.getElementById('sweepBox').classList.contains('hidden')`));
ok('the button becomes the brush during the run',
  (await evalJs(`(document.getElementById('actionLabel')||{}).textContent`)) === 'BRUSH');

// --- brush with the same button ---
const btn4 = await rectOf('#btnAction');
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: btn4.x, y: btn4.y }] });
await sleep(900);
const brushing = await evalJs(`(document.getElementById('sweepState')||{}).textContent`);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
ok('holding the button during the run brushes the ice', brushing === 'BRUSHING', `sweep state: ${brushing}`);
await shot('05-inflight-brushing-phone');

// --- the delivery: it must reach a result, report it, and ask for the next stone ---
const continued = await waitFor(`['STEP UP','NEXT END','PLAY AGAIN'].indexOf((document.getElementById('actionLabel')||{}).textContent) >= 0`,
  90000, 'the shot to finish and the game to ask for the next thing');
const afterLabel = await evalJs(`(document.getElementById('actionLabel')||{}).textContent`);
const logText = await evalJs(`(function(){var t=document.getElementById('telemetry');
  return t && !t.classList.contains('hidden') ? t.textContent.replace(/\\s+/g,' ').trim() : '';})()`);
ok('the stone runs to a result the game reports, then asks for the next stone',
  continued && logText.length > 0, `label: ${afterLabel} | shot log: ${logText.slice(0, 110)}`);
await shot('06-after-delivery-phone');
// The busiest portrait layout there is: a phase explanation, the shot log, the
// miniature and the handle row, all asking for the same 390x844 at once.
await checkLayout('portrait, with the shot log open');

// --- landscape: the same controls, split to the sides ---
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
const setupBtn = await rectOf('#btnAction');
if (afterLabel === 'STEP UP') await tap(setupBtn.x, setupBtn.y);   // step up to the hack, in landscape
await waitFor(`!document.getElementById('powerBox').classList.contains('hidden')`, 6000, 'the aim phase in landscape');
const land = {
  btn: await rectOf('#btnAction'),
  power: await rectOf('#powerBox'),
  meters: await rectOf('#meters'),
};
ok('in landscape the weight button stays fully on screen, clear of the miniature',
  land.btn && land.btn.vis && land.btn.x + land.btn.w / 2 <= 844 && land.btn.y > 120 && land.btn.y < 390 - 60,
  land.btn && `button centre ${Math.round(land.btn.x)},${Math.round(land.btn.y)}; miniature right edge ${land.power ? Math.round(land.power.x + land.power.w / 2) : 'n/a'}`);
ok('the sheet miniature is not pushed off the screen in landscape',
  land.power && land.power.w > 200 && (land.power.x + land.power.w / 2) <= 844,
  land.power && `miniature ${Math.round(land.power.w)}px wide, centre x ${Math.round(land.power.x)}`);
const landLay = await checkLayout('landscape, aiming');
ok('a phone turned sideways keeps the band where the landscape rule puts it, with no drop past the bottom edge',
  landLay.bandOffset !== null && landLay.bandOffset <= 12,
  `bottom offset ${landLay.bandOffset}, weight panel ${landLay.powerH}px [${landLay.bands}]`);
await shot('07-landscape-phone');

/* ------------------------------------------------- a tablet in landscape: the room
 * A 1024x768 touch screen is wide enough that a centred 452px band cannot reach the
 * thumb column at the right edge, so the column is beside the band instead of under
 * it, and the band drops by half the weight panel's own height. That is the whole
 * point of measuring it in the page: the panel is min(452px,86vw) wide and its
 * miniature keeps the sheet's aspect, so at 1024px it is a different height than it
 * was at 390px, and a constant in the CSS would be half of the wrong panel.
 */
await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
await sleep(1400);
if (!await evalJs(`!document.getElementById('powerBox').classList.contains('hidden')`)) {
  const again = await rectOf('#btnAction');
  if (again) await tap(again.x, again.y);
  await waitFor(`!document.getElementById('powerBox').classList.contains('hidden')`, 8000, 'the aim phase at 1024x768');
}
const tabLay = await checkLayout('tablet landscape, aiming');
const halfPanel = tabLay.powerH ? Math.round(tabLay.powerH / 2) : 0;
ok('on a wide touch screen the thumb column stands beside the band instead of under it',
  tabLay.underBand === false, `[${tabLay.bands}]`);
ok('and there the weight and spin band moves down by half of the weight panel height, as asked',
  halfPanel > 0 && Math.abs(bandDrop(tabLay) - halfPanel) <= 2 && tabLay.bandOffset >= 10,
  `moved ${bandDrop(tabLay)}px; half of the ${tabLay.powerH}px weight panel is ${halfPanel}px; ` +
  `band now sits ${tabLay.bandOffset}px off the bottom edge [${tabLay.bands}]`);
ok('the drop is the page measuring, not a number in the stylesheet: the same page at 390px moved nowhere',
  bandDrop(tabLay) > 0 && bandDrop(aimPortrait) === 0 && (tabLay.powerH || 0) > (aimPortrait.powerH || 0),
  `390x844: drop ${bandDrop(aimPortrait)} at panel ${aimPortrait.powerH}px; 1024x768: drop ${bandDrop(tabLay)} at panel ${tabLay.powerH}px`);
await shot('09-tablet-landscape-aiming');

/* ------------------------------------------------------------------ render cost
 * What the game asks a device to draw and shade, read out of the page itself with
 * window.__curlingPerf() - the same call a tablet's own console can make.
 *
 * The frame times here say nothing about a phone GPU: this runs on SwiftShader, a CPU
 * rasteriser, and it is slower than any real tablet. Two things are exact anyway, and
 * they are the two the levers move - the number of fragments the drawing buffer covers
 * and the number of objects handed to the driver per frame - so the ladder can be
 * measured here even though the frame rate cannot.
 *
 * What the frame rate *does* prove is the mechanism: this very page has been running
 * for two minutes on a renderer that cannot keep up, and the only thing that should
 * have happened is the ladder walking itself down, by itself.
 */
async function tryWait(expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(expr)) return true; } catch (e) { /* the context is being replaced */ }
    await sleep(200);
  }
  console.log('     (timeout waiting for ' + label + ')');
  return false;
}
// Ready means the game has seen all 39 named dressing parts, which is also proof it
// loaded the shipped arena.glb rather than the stand-in (that one names 29).
const READY = `(window.__curlingPerf||function(){return{dressingParts:0};})().dressingParts === 39`;
async function loadTier(query, label) {
  await send('Page.navigate', { url: URL_BASE + query });
  if (!await tryWait('window.__curlingBoot === true', 30000, label + ' boot')) return null;
  if (!await tryWait(READY, 25000, label + ' arena')) return null;
  await sleep(1200);
  return evalJs('window.__curlingPerf()');
}
const fragsOf = p => { const m = /^(\d+)x(\d+)$/.exec((p && p.buffer) || ''); return m ? +m[1] * +m[2] : 0; };
const tierLine = p => p && `${p.id}${p.forced ? ' (pinned)' : ''} ${p.pixelRatio}x dpr${p.devicePixelRatio} ` +
  `buffer ${p.buffer} = ${(fragsOf(p) / 1e6).toFixed(2)}M fragments | ${p.drawCalls} calls, ` +
  `${p.triangles} tris | dress ${p.dressingVisible}/${p.dressingParts} lamps ${p.lampsVisible} ` +
  `iceNormal ${p.iceNormalApplied} | msaa asked ${p.msaaRequested}, got ${p.samples} | ` +
  `${p.fps} fps @ ${p.msMedian} ms`;

const watched = await evalJs('window.__curlingPerf()');
ok('a device that cannot keep up walks the ladder down by itself: no phase change, no settings screen, no key',
  watched && watched.id !== 'full' && watched.dressing === false && watched.dressingVisible === 0,
  tierLine(watched));
ok('and it says so out loud, in the console, with the number it measured',
  consoleNotes.some(l => /render tier \w+ -> \w+/.test(l) && /median frame [\d.]+ ms over \d+ frames/.test(l)),
  consoleNotes.filter(l => /render tier/.test(l)).slice(0, 2).join('  ||  '));
ok('the game is holding the real arena, not the stand-in: 39 named dressing parts, of which a hidden one shows none',
  watched && watched.dressingParts === 39,
  watched && `${watched.dressingParts} parts known, ${watched.dressingVisible} visible at tier ${watched.id}`);

// The shape the report was actually about: a 1280x800 tablet at devicePixelRatio 2.
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: true });
const full = await loadTier('?tier=full', 'tablet, tier full');
const lean = await loadTier('?tier=lean', 'tablet, tier lean');
const poor = await loadTier('?tier=poor', 'tablet, tier poor');
const auto = await loadTier('', 'tablet, no tier in the address');

ok('a pinned tier survives a renderer this slow: the watchdog does not move a level someone asked for',
  full && full.id === 'full' && full.forced === true && full.dressingVisible === 39 &&
    full.lampsVisible === 2 && full.iceNormalApplied === true,
  tierLine(full));
ok('the middle rung switches off the 39 dressing parts it names, and only those: boards, kicks, dashers and the deck stay',
    full && lean && lean.id === 'lean' && lean.dressingVisible === 0 && lean.dressingParts === 39 &&
    lean.lampsVisible === 2 && lean.iceNormalApplied === true &&
    full.drawCalls - lean.drawCalls >= 30,
  `full: ${tierLine(full)}\n     lean: ${tierLine(lean)}`);
ok('the bottom rung takes the ice normal map off the sheet it covers and one of the two sheet lamps out of every shader',
  poor && poor.id === 'poor' && poor.pixelRatio === 1 && poor.iceNormalApplied === false &&
    poor.lampsVisible === 1 && poor.dressingVisible === 0 && poor.drawCalls <= lean.drawCalls,
  tierLine(poor));
const ratio = full && lean ? fragsOf(full) / fragsOf(lean) : 0;
ok('what that is worth in fragments on the way this device is built: two and a half times less to shade before anything is drawn',
  ratio >= 2.5 && full.pixelRatio === 2 && lean.pixelRatio === 1.25,
  `${fragsOf(full) / 1e6}M -> ${fragsOf(lean) / 1e6}M fragments, ratio ${ratio.toFixed(2)}x`);
ok('a touchscreen that already has a large drawing buffer starts below the top rung, before it has drawn a frame',
  auto && !auto.forced && ['lean', 'poor'].includes(auto.id) && auto.pixelRatio <= 1.25,
  tierLine(auto));
ok('a touchscreen is not asked for multisampling at all: the sample count is decided before the ladder exists',
  watched && auto && watched.msaaRequested === false && auto.msaaRequested === false,
  `asked ${auto && auto.msaaRequested}, driver reported ${auto && auto.samples} samples`);
await shot('08-tablet-tier-lean');

ok('no console errors while all of this ran', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter(r => !r.pass);
console.log(`\nDEVICE ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed: ' + failed.map(f => f.name).join(' ; '));
try { process.kill(-proc.pid); } catch (e) { /* group kill is best effort */ }
try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
process.exit(failed.length ? 1 : 0);
