// A dependency-free dev server for this game. ES modules and the GLB fetches need
// an http:// origin, which the file:// protocol will not give them, so something has
// to serve this folder — and rather than make you remember a port number and type a
// URL, this one prints it and opens the page.
//
//   node serve.mjs                  port 8123, then open the default browser
//   node serve.mjs 8000            another port
//   node serve.mjs --no-open       serve without opening anything (scripts, CI)
//   BROWSER=path/to/browser        open this browser instead of the default one
//
// Nothing here is part of the game: no build step, no dependencies, no package
// manifest. Node 18+ is enough. If 8123 is already taken it takes any free port
// instead and says which, so two checkouts can be open at once.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const HOST = '127.0.0.1';
const USAGE = 'usage: node serve.mjs [port] [--no-open]\n';

// The types the game actually asks for. .js matters more than it looks: a module
// served as anything but a JavaScript type is refused by the browser, and the page
// then sits there with an empty canvas and one console error.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); process.exit(0); }
const openWanted = !argv.includes('--no-open');
let port = Number(argv.find(a => /^\d+$/.test(a)) || process.env.PORT || 8123);

function plain(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const kB = n => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;

const server = createServer(async (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname).replace(/^[/\\]+/, '');
  } catch { return plain(res, 400, 'bad request\n'); }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const file = join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return plain(res, 404, 'outside the folder\n');

  let body;
  try {
    body = await readFile(file);
  } catch {
    return plain(res, 404, `404 — no such file: /${rel}\nthe game itself is at /\n`);
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    // A dev server that caches is a dev server whose edits you never see.
    'Cache-Control': 'no-store',
  });
  res.end(body);
  if (!rel.startsWith('assets/tex/')) console.log(`  ${req.method} /${rel}  ${body.length} B`);
});

function openBrowser(url) {
  // BROWSER is the usual convention for naming your own browser; it also makes this
  // path testable, which is how the fallback message below got checked rather than
  // assumed.
  const [cmd, args] = process.env.BROWSER ? [process.env.BROWSER, [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`  could not open a browser — load ${url} yourself`));
    child.unref();
  } catch { console.log(`  could not open a browser — load ${url} yourself`); }
}

let listening = false;
server.on('error', err => {
  if (listening) { console.error(`  server error: ${err.message}`); return; }
  if (err.code === 'EADDRINUSE' && port !== 0) {
    console.log(`  port ${port} is already serving; taking a free one instead`);
    port = 0;
    return server.listen(0, HOST);
  }
  console.error(`  could not listen on ${HOST}:${port}: ${err.message}`);
  process.exitCode = 1;
});

server.listen(port, HOST, () => {
  listening = true;
  const url = `http://${HOST}:${server.address().port}/`;
  console.log(`\n  curling — 4 end\n  ${url}\n  from ${ROOT}\n  Ctrl+C stops it\n`);
  if (openWanted) openBrowser(url);
});

process.on('SIGINT', () => { console.log('\n  stopped'); process.exit(0); });
