#!/usr/bin/env node
/*
 * The clip editor's server: a zero-dependency local web app for adjusting a project's edit without the agent.
 *
 *   node editor.mjs <dir> [--port 4321] [--no-open]
 *
 * It serves one static page (editor/: index.html, editor.js, editor.css; plain ES modules, no build step) and the
 * browser-safe pipeline modules it imports (/lib/timeline.mjs, /lib/status.mjs), so the preview runs the same timeline
 * code the render does. The API:
 *
 *   GET  /api/project   { data, hash, build, facts, plan, timeline }: screencast.json and its hash (send it back on
 *                       save), build.json as on disk, and status.mjs's plan. Paths in build and facts are
 *                       project-relative, so the page can recompute plan(data, build, facts) live as the user edits
 *                       and turn any path into /media/<path>.
 *   PUT  /api/project   { data, hash } → { hash }. Validated (400 with the errors) and refused with 409 if
 *                       screencast.json changed on disk since `hash` (D15: the agent or a script wrote it meanwhile).
 *   POST /api/render    { force? } → runs assemble.mjs, streaming its output as server-sent events (`out`/`err`
 *                       lines, then `done` with the exit code). One render at a time (409 otherwise).
 *   GET  /api/events    server-sent events: `change` { file } whenever screencast.json or build.json changes on disk.
 *   GET  /media/<path>  any file inside the project folder (scenes, VO, camera takes, the render), with Range support
 *                       so <video> can seek. Paths escaping the folder, through `..` or a symlink, are refused.
 *
 * It listens on 127.0.0.1 only and checks the Host header (no DNS rebinding); PUT and POST must be
 * application/json, which a cross-site page can't send without a CORS preflight this server never answers. The editor
 * never writes build.json (D5): only pipeline scripts do. Opens the page in the default browser unless --no-open; if
 * the port is taken (and wasn't given explicitly) it tries the next few.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConflictError, formatErrors, loadProject, readProject, saveProject, validate } from './project.mjs';
import { gather, plan } from './status.mjs';

const ASSETS = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(ASSETS, 'editor');
const LIB = ['timeline.mjs', 'status.mjs']; // browser-safe modules the page imports
const WATCHED = ['screencast.json', 'build.json'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

// A Range header against a file of `size` bytes: [start, end] inclusive, null for no/unsupported range (send it all),
// or 'unsatisfiable'. Multi-range requests get the whole file, which the spec allows.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    [start, end] = [Math.max(0, size - n), size - 1];
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return [start, end];
}

// The absolute path for a project-relative URL path, or null if it would leave the project (`..`, absolute, or a
// symlink pointing outside).
export function confine(dir, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(dir, decoded.replace(/^\/+/, ''));
  const inside = (root, f) => f === root || f.startsWith(root + path.sep);
  if (!inside(dir, file)) return null;
  try {
    return inside(fs.realpathSync(dir), fs.realpathSync(file)) ? file : null;
  } catch {
    return file; // missing: the caller's 404
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function sendFile(req, res, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
  const headers = { 'content-type': typeOf(file), 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  const range = parseRange(req.headers.range, st.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${st.size}` });
    return res.end();
  }
  const [start, end] = range ?? [0, st.size - 1];
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': st.size ? end - start + 1 : 0,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${st.size}` } : {}),
  });
  if (req.method === 'HEAD' || !st.size) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function readBody(req, limit = 5e6) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw Object.assign(new Error(`bad JSON: ${err.message}`), { status: 400 });
  }
}

// Everything the page needs. build.json's paths are project-relative (as on disk), so the page can recompute the plan.
export async function projectState(dir) {
  const p = loadProject(dir);
  const facts = await gather(p);
  const s = plan(p.data, p.build, facts);
  const relPaths = (entry) => {
    const out = { ...entry };
    for (const k of ['file', 'raw', 'subs']) if (typeof out[k] === 'string') out[k] = p.rel(out[k]);
    return out;
  };
  const build = {
    ...p.build,
    beats: Object.fromEntries(
      Object.entries(p.build.beats).map(([id, steps]) => [
        id,
        Object.fromEntries(Object.entries(steps).map(([step, entry]) => [step, relPaths(entry)])),
      ]),
    ),
    ...(p.build.assembly ? { assembly: { ...p.build.assembly, out: p.rel(p.build.assembly.out) } } : {}),
  };
  const { timeline, ...rest } = s;
  return {
    data: p.data,
    hash: p.hash,
    build,
    facts: { exists: facts.exists.map(p.rel), out: p.rel(facts.out), captions: facts.captions },
    plan: rest,
    timeline,
  };
}

const sse = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// Starts the server. Resolves to { url, port, server, close() }.
export async function startEditor(dir, { port = 4321, tries = 10, host = '127.0.0.1' } = {}) {
  dir = loadProject(dir).dir; // resolves ~ and validates up front
  const clients = new Set();
  let rendering = null;

  // File watching: the directory, not the files, since atomic writes replace them. Debounced per file.
  const timers = new Map();
  const watcher = fs.watch(dir, (_, name) => {
    if (!WATCHED.includes(name)) return;
    clearTimeout(timers.get(name));
    timers.set(
      name,
      setTimeout(() => {
        for (const send of clients) send('change', { file: name });
      }, 80),
    );
  });
  const keepAlive = setInterval(() => {
    for (const send of clients) send('ping', {});
  }, 15000);

  let actualPort = port;
  const hostOk = (h) => h === `127.0.0.1:${actualPort}` || h === `localhost:${actualPort}`;

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    const method = req.method;

    if ((method === 'PUT' || method === 'POST') && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
      return sendJson(res, 415, { error: 'expected application/json' });

    if (pathname === '/api/project') {
      if (method === 'GET') {
        try {
          return sendJson(res, 200, await projectState(dir));
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      }
      if (method === 'PUT') {
        const { data, hash } = await readBody(req);
        const errors = validate(data);
        if (errors.length) return sendJson(res, 400, { error: formatErrors(errors), errors });
        try {
          return sendJson(res, 200, { hash: saveProject(dir, data, hash ?? null) });
        } catch (err) {
          if (err instanceof ConflictError)
            return sendJson(res, 409, {
              error: 'screencast.json changed on disk — reload',
              hash: readProject(dir).hash,
            });
          throw err;
        }
      }
      return sendJson(res, 405, { error: 'GET or PUT' });
    }

    if (pathname === '/api/render') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'POST' });
      const { force } = await readBody(req);
      if (rendering) return sendJson(res, 409, { error: 'a render is already running' });
      const send = sse(res);
      const args = [path.join(ASSETS, 'assemble.mjs'), dir, ...(force ? ['--force'] : [])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      rendering = child;
      for (const [stream, event] of [
        [child.stdout, 'out'],
        [child.stderr, 'err'],
      ]) {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          const lines = (buf + chunk).split('\n');
          buf = lines.pop();
          for (const line of lines) send(event, line);
        });
        stream.on('end', () => buf && send(event, buf));
      }
      child.on('close', (code) => {
        rendering = null;
        send('done', { code });
        res.end();
      });
      return;
    }

    if (pathname === '/api/events') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'GET' });
      const send = sse(res);
      clients.add(send);
      req.on('close', () => clients.delete(send));
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'GET' });

    if (pathname.startsWith('/media/')) {
      const file = confine(dir, pathname.slice('/media/'.length));
      return file ? sendFile(req, res, file) : sendJson(res, 403, { error: 'outside the project folder' });
    }
    if (pathname.startsWith('/lib/')) {
      const name = pathname.slice('/lib/'.length);
      if (!LIB.includes(name)) return sendJson(res, 404, { error: 'not found' });
      return sendFile(req, res, path.join(ASSETS, name));
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = confine(PAGE, name);
    return file ? sendFile(req, res, file) : sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req.headers.host)) return sendJson(res, 403, { error: 'bad Host' });
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      sendJson(res, err.status ?? 500, { error: err.message });
    });
  });

  for (let i = 0; ; i++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port + (port ? i : 0), host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i + 1 >= tries || !port) throw err;
    }
  }
  actualPort = server.address().port;

  const close = () =>
    new Promise((resolve) => {
      watcher.close();
      clearInterval(keepAlive);
      for (const t of timers.values()) clearTimeout(t);
      rendering?.kill();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url: `http://127.0.0.1:${actualPort}/`, port: actualPort, server, close, dir };
}

function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  spawn(cmd, [...args, url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main(argv) {
  const args = [...argv];
  const open = !args.includes('--no-open');
  if (!open) args.splice(args.indexOf('--no-open'), 1);
  let port = 4321;
  let tries = 10;
  const i = args.indexOf('--port');
  if (i >= 0) {
    port = Number(args.splice(i, 2)[1]);
    tries = 1;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a port number');
  }
  if (args.length !== 1 || args[0].startsWith('-'))
    throw new Error('usage: node editor.mjs <dir> [--port 4321] [--no-open]');
  const ed = await startEditor(args[0], { port, tries });
  console.log(`editor for ${ed.dir} at ${ed.url}  (Ctrl-C to stop)`);
  if (open) openBrowser(ed.url);
  const stop = () => ed.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
