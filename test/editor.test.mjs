import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { confine, parseRange, startEditor } from '../skills/generate-screencast/assets/editor.mjs';
import { loadProject, voKey } from '../skills/generate-screencast/assets/project.mjs';
import { gather, plan, qaKey } from '../skills/generate-screencast/assets/status.mjs';
import { makeTone, makeVideo, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

const BEATS = [
  { id: 'one', title: 'Opening', surface: 'web', text: 'Hit Save now.' },
  { id: 'two', title: 'The list', surface: 'web', text: 'Next, your drafts.', cut: 0.3 },
];

// A TTS project with tone VOs, one-cue .srt files and testsrc scenes with full handles, filmed and QA'd; no burn-in,
// so rendering needs only ffmpeg.
async function fixture(t) {
  const dir = tempDir(t);
  const data = { version: 1, slug: 'demo', title: 'Demo', size: [320, 180], voice: { tts: 'en-US-AndrewNeural' },
    captions: { burn: false }, beats: BEATS };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  for (const b of BEATS) {
    makeTone(p.voFile(b.id), 1.2);
    const d = probeDuration(p.voFile(b.id));
    fs.writeFileSync(p.subsFile(b.id), `1\n00:00:00,000 --> 00:00:01,200\n${b.text}\n`);
    p.recordBuild(b.id, { vo: { file: p.voFile(b.id), key: voKey(data, b), duration: d, subs: p.subsFile(b.id) } });
  }
  for (const b of BEATS) {
    const end = p.beat(b.id).sceneMs / 1000 + 1.5;
    const file = makeVideo(p.sceneFile(b.id), end + 1.5);
    p.recordBuild(b.id, { scene: { file, raw: file, voKey: p.build.beats[b.id].vo.key, lead: 0.5,
      duration: probeDuration(file), end, footage: [-1.5, end], at: new Date().toISOString() } });
  }
  const s = plan(p.data, p.build, await gather(p));
  for (const e of s.timeline.beats)
    p.recordBuild(e.id, { qa: { key: qaKey(p.data, p.build, e), at: new Date().toISOString() } });
  return dir;
}

async function editor(t, dir) {
  const ed = await startEditor(dir, { port: 0 });
  t.after(() => ed.close());
  const req = (pathname, { method = 'GET', body, headers = {} } = {}) =>
    fetch(new URL(pathname, ed.url), {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...ed, req };
}

// Reads server-sent events from a streaming response until `until(events)` is true.
async function events(res, until) {
  const out = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) out.push({ event, data: JSON.parse(data) });
    }
    if (until(out)) break;
  }
  return out;
}

// A raw request, for paths fetch() would normalize (`/media/../x`) and Host headers it won't set: { status, body }.
const raw = (port, pathname, headers = {}) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9]);
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=50-500', 100), [50, 99]);
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=9-3', 100), 'unsatisfiable');
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('bytes=0-1,4-5', 100), null);
});

test('confine keeps paths inside the project, through symlinks too', (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.mkdirSync(path.join(dir, 'scenes'));
  fs.writeFileSync(path.join(dir, 'scenes', 'a.webm'), '');
  fs.writeFileSync(path.join(outside, 'secret'), 'x');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'link'));
  assert.equal(confine(dir, 'scenes/a.webm'), path.join(dir, 'scenes', 'a.webm'));
  assert.equal(confine(dir, 'scenes%2Fa.webm'), path.join(dir, 'scenes', 'a.webm'));
  assert.equal(confine(dir, 'missing.mp4'), path.join(dir, 'missing.mp4'));
  const deep = '../'.repeat(20) + outside.slice(1) + '/secret';
  const bad = ['../secret', '..%2Fsecret', 'scenes/../../secret', '%2E%2E/secret', 'link', deep, '%E0%A4%A', 'a%00b'];
  for (const rel of bad) assert.equal(confine(dir, rel), null, rel);
});

test('editor server: project, media, conflicts, events, render', needsFfmpeg, async (t) => {
  const dir = await fixture(t);
  const ed = await editor(t, dir);

  // The page and the shared modules; nothing else from assets/.
  let r = await ed.req('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  r = await ed.req('/lib/timeline.mjs');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  assert.match(await r.text(), /export function timeline/);
  assert.equal((await ed.req('/lib/project.mjs')).status, 404);
  assert.equal((await raw(ed.port, '/../editor.mjs')).status, 404);

  // GET /api/project: relative paths, and a plan the page can reproduce from data + build + facts.
  r = await ed.req('/api/project');
  assert.equal(r.status, 200);
  const state = await r.json();
  assert.equal(state.data.slug, 'demo');
  assert.equal(state.build.beats.one.scene.file, 'scenes/one.webm');
  assert.ok(state.facts.exists.includes('vo/two.mp3'));
  assert.equal(state.facts.out, 'demo.mp4');
  assert.deepEqual(state.plan.todo, { vo: [], transcribe: [], film: [], qa: [], assemble: true });
  assert.deepEqual(state.plan.assemble, ['never assembled']);
  const again = plan(state.data, state.build, state.facts);
  assert.equal(again.timeline.key, state.timeline.key);
  assert.deepEqual(again.todo, state.plan.todo);

  // /media: whole files, ranges, and nothing outside the folder.
  const size = fs.statSync(path.join(dir, 'scenes', 'one.webm')).size;
  r = await ed.req('/media/scenes/one.webm');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/webm');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal((await r.arrayBuffer()).byteLength, size);
  r = await ed.req('/media/scenes/one.webm', { headers: { range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${size}`);
  assert.deepEqual(
    Buffer.from(await r.arrayBuffer()),
    fs.readFileSync(path.join(dir, 'scenes', 'one.webm')).subarray(10, 20),
  );
  r = await ed.req('/media/scenes/one.webm', { headers: { range: `bytes=${size}-` } });
  assert.equal(r.status, 416);
  assert.equal((await ed.req('/media/nope.mp4')).status, 404);
  fs.writeFileSync(path.join(path.dirname(dir), 'editor-escape-test'), 'secret');
  t.after(() => fs.rmSync(path.join(path.dirname(dir), 'editor-escape-test'), { force: true }));
  const escapes = ['../', '..%2F', 'scenes/..%2F..%2F', '%2E%2E/'].map((up) => `/media/${up}editor-escape-test`);
  for (const bad of escapes)
  {
    const res = await raw(ed.port, bad);
    assert.ok([403, 404].includes(res.status) && !res.body.includes('secret'), `${bad}: ${res.status}`);
  }

  // Host checks (DNS rebinding) and JSON-only writes (no simple cross-site POSTs).
  assert.equal((await raw(ed.port, '/api/project', { host: 'evil.example' })).status, 403);
  r = await ed.req('/api/render', { method: 'POST', headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415);

  // SSE: a change on disk is announced.
  const ctl = new AbortController();
  const stream = await fetch(new URL('/api/events', ed.url), { signal: ctl.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const isSave = (e) => e.event === 'change' && e.data.file === 'screencast.json';
  const seen = events(stream, (ev) => ev.some(isSave));

  // PUT: validated, saved, and refused once the file changes underneath.
  const edited = structuredClone(state.data);
  edited.beats[1].cut = 0.2;
  r = await ed.req('/api/project', { method: 'PUT', body: { data: edited, hash: state.hash } });
  assert.equal(r.status, 200);
  const { hash } = await r.json();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8')).beats[1].cut, 0.2);
  assert.ok((await seen).some(isSave)); // (watch events from the fixture's build.json writes may arrive too)
  ctl.abort();

  const bad = structuredClone(edited);
  bad.beats[0].cam = 'sideways';
  r = await ed.req('/api/project', { method: 'PUT', body: { data: bad, hash } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /beats\[0\]\.cam/);

  r = await ed.req('/api/project', { method: 'PUT', body: { data: edited, hash: state.hash } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /changed on disk — reload/);

  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify({ ...edited, title: 'Theirs' }, null, 2));
  r = await ed.req('/api/project', { method: 'PUT', body: { data: edited, hash } });
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8')).title, 'Theirs');

  // POST /api/render streams assemble.mjs: refused while the moved cut needs QA on both beats, then forced.
  const render = async (body) => {
    const res = await ed.req('/api/render', { method: 'POST', body });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const log = await events(res, (ev) => ev.some((e) => e.event === 'done'));
    return { log, code: log.find((e) => e.event === 'done').data.code };
  };
  let out = await render({});
  assert.equal(out.code, 1);
  assert.ok(out.log.some((e) => e.event === 'err' && /not ready to assemble/.test(e.data)));
  out = await render({ force: true });
  assert.equal(out.code, 0, out.log.map((e) => e.data).join('\n'));
  assert.ok(out.log.some((e) => e.event === 'out' && /"out":/.test(e.data)));
  const after = await (await ed.req('/api/project')).json();
  assert.deepEqual(after.plan.todo.qa, ['one', 'two']);
  assert.deepEqual(after.plan.assemble, ['2 beats changed (one, two)']);
  assert.equal(after.build.assembly.out, 'demo.mp4');
  assert.equal(after.build.assembly.key, after.timeline.key);
  assert.equal(after.data.title, 'Theirs');
  r = await ed.req('/media/demo.mp4', { headers: { range: 'bytes=0-' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  await r.arrayBuffer();
});

test('editor server refuses to start on an invalid project', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'screencast.json'), '{"version": 1}');
  await assert.rejects(startEditor(dir, { port: 0 }), /invalid/);
});
