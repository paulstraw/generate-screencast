import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_HOME, loadProject, voKey } from '../skills/generate-screencast/assets/project.mjs';
import { qaFrames } from '../skills/generate-screencast/assets/qa-grid.mjs';
import { timeline } from '../skills/generate-screencast/assets/timeline.mjs';
import { hasFfmpeg, makeTone, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

const QA_GRID = fileURLToPath(new URL('../skills/generate-screencast/assets/qa-grid.mjs', import.meta.url));
const ASSEMBLE = fileURLToPath(new URL('../skills/generate-screencast/assets/assemble.mjs', import.meta.url));

let hasPlaywright = false;
try {
  createRequire(path.join(PLAYWRIGHT_HOME, 'noop.js')).resolve('playwright');
  hasPlaywright = true;
} catch {}

const BEATS = [
  { id: 'one', title: 'Opening', surface: 'web', text: 'Hit Save now.' },
  { id: 'two', title: 'The list', surface: 'web', text: 'Your drafts land here.', cut: -0.6 },
  { id: 'three', title: 'Done', surface: 'web', text: 'Next, the settings.', cut: 0.4 },
];
const VO = { one: [2, 'red'], two: [1.5, 'green'], three: [1.8, 'blue'] };
const project = (extra = {}) => ({ version: 1, slug: 'demo', title: 'Demo', size: [320, 180],
  voice: { tts: 'en-US-AndrewNeural' }, beats: BEATS, ...extra });
const build = { version: 1, beats: Object.fromEntries(BEATS.map((b) => [b.id, { vo: { duration: VO[b.id][0] } }])) };

test('frames: picture edges, the VO start, overlaps and given times, merged per frame', () => {
  const t = timeline(project(), build);
  // one: block [0, 3] (0.5 + 2 + 0.5); its picture ends 0.6s early, at the L cut into two.
  assert.deepEqual(qaFrames(t, 'one', [1]), [
    { x: 0, scene: 0, labels: ['picture in'] },
    { x: 0.5, scene: 0.5, labels: ['VO starts'] },
    { x: 1, scene: 1, labels: ['given'] },
    { x: 2.367, scene: 2.367, labels: ['picture out'] },
  ]);
  // two: block [3, 5.5], picture [2.4, 5.9]: arrives under one's narration (L) and stays under three's (J).
  const two = qaFrames(t, 'two', [], { filmedLead: 0.5 });
  assert.deepEqual(two.map((f) => [f.x, f.scene, f.labels]), [
    [2.4, -0.6, ['picture in']],
    [2.7, -0.3, ['L overlap: under "one" narration']],
    [3.5, 0.5, ['VO starts']],
    [5.7, 2.7, ['J overlap: under "three" narration']],
    [5.867, 2.867, ['picture out']],
  ]);
  // three's picture arrives late (the J cut into it): no overlap of its own; 9s is past its end.
  const three = qaFrames(t, 'three', [0.5, 0.5001, 9]);
  assert.deepEqual(three.map((f) => [f.x, f.labels]), [
    [5.9, ['picture in']],
    [6, ['VO starts', 'given']],
    [8.767, ['picture out']],
    [14.5, ['given, outside the picture']],
  ]);
  assert.throws(() => qaFrames(t, 'nope'), /"nope" isn't in the edit/);
});

test('a boundary that only rounds to the next frame is no overlap', () => {
  // one's block ends at 5.92s; two's picture starts on the frame at 5.933s, 13ms later.
  const b = { version: 1, beats: { one: { vo: { duration: 4.92 } }, two: { vo: { duration: 1.5 } } } };
  const t = timeline(project({ beats: BEATS.slice(0, 2).map(({ cut, ...x }) => x) }), b);
  assert.equal(t.beats[0].picture[1], 178 / 30);
  assert.ok(qaFrames(t, 'one').every((f) => !f.labels.some((l) => l.includes('overlap'))));
  assert.ok(qaFrames(t, 'two').every((f) => !f.labels.some((l) => l.includes('overlap'))));
});

test('frames follow the filmed lead when lead changed since filming', () => {
  const data = project({ beats: [{ ...BEATS[0], lead: 1 }] });
  const t = timeline(data, build);
  const f = qaFrames(t, 'one', [], { filmedLead: 0.5 });
  assert.deepEqual(f.map((x) => [x.x, x.scene]), [[0, -0.5], [1, 0.5], [3.967, 3.467]]);
});

// A recording of scene time −1.5…end: gray for the head handle, then `color`.
function makeScene(file, end, color) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1.5',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${end}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]',
    '-map', '[v]', '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', file]);
}

function fixture(t, extra) {
  const dir = tempDir(t);
  const data = project(extra);
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  for (const b of BEATS) {
    makeTone(p.voFile(b.id), VO[b.id][0]);
    const d = probeDuration(p.voFile(b.id));
    const ts = (x) => `00:00:${x.toFixed(3).padStart(6, '0').replace('.', ',')}`;
    fs.writeFileSync(p.subsFile(b.id), `1\n${ts(0)} --> ${ts(d)}\n${b.text}\n`);
    p.recordBuild(b.id, { vo: { file: p.voFile(b.id), key: voKey(data, b), duration: d, subs: p.subsFile(b.id) } });
  }
  for (const b of BEATS) {
    const end = p.beat(b.id).sceneMs / 1000 + 1.5;
    const file = p.sceneFile(b.id);
    makeScene(file, end, VO[b.id][1]);
    p.recordBuild(b.id, { scene: { file, raw: file, voKey: p.build.beats[b.id].vo.key, lead: 0.5,
      duration: probeDuration(file), end, footage: [-1.5, end], at: new Date().toISOString() } });
  }
  return dir;
}

// The average color of the center of tile k (640×360 tiles, three per row).
function tile(png, k) {
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf',
    `crop=40:40:${(k % 3) * 640 + 300}:${Math.floor(k / 3) * 360 + 160},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const [r, g, b] = rgb;
  if (r > 140 && g < 60 && b < 60) return 'red';
  if (r < 60 && g > 90 && b < 60) return 'green';
  if (r < 60 && g < 60 && b > 140) return 'blue';
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 90 && r < 170) return 'gray';
  return `rgb(${r},${g},${b})`;
}

const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('grids a screen beat from its recording, handles included', needsFfmpeg, (t) => {
  const dir = fixture(t);
  const r = run(QA_GRID, dir, 'two', '1');
  assert.equal(r.status, 0, r.stderr);
  const png = path.join(dir, 'qa', 'two.png');
  assert.equal(r.stdout.trim().split('\n').pop(), png);
  assert.match(r.stdout, /frame 1: scene −0\.60s \(timeline 2\.40s, file 0\.899s\): picture in/);
  assert.match(r.stdout, /frame 2: .*L overlap: under "one" narration/);
  assert.match(r.stdout, /J overlap: under "three" narration/);
  const size = String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', png]));
  assert.equal(size.trim(), '1920x720'); // six frames, three per row
  // Before scene time 0 is the gray head handle; from 0 on, the beat's color.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => tile(png, k)), ['gray', 'gray', 'green', 'green', 'green', 'green']);

  const o = run(QA_GRID, dir, 'one', '--out', path.join(dir, 'x.png'));
  assert.equal(o.status, 0, o.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'x.png')));
  assert.match(run(QA_GRID, dir, 'nope').stderr, /"nope" isn't in the edit/);
  assert.match(run(QA_GRID, dir).stderr, /usage/);
});

test('with burn-in, grids the render, and asks for one when it is missing', needsFfmpeg, async (t) => {
  const dir = fixture(t, { captions: { burn: true } });
  const r = run(QA_GRID, dir, 'two');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /captions are burned in, so "two" is gridded from the render, which is missing: run node assemble/);
  assert.equal(run(QA_GRID, dir, 'two', '--scene').status, 0);

  if (!hasFfmpeg || !hasPlaywright) return t.skip(`Playwright not installed in ${PLAYWRIGHT_HOME}`);
  const a = run(ASSEMBLE, dir, '--force');
  assert.equal(a.status, 0, a.stderr);
  const g = run(QA_GRID, dir, 'two');
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, new RegExp(`two from ${path.join(dir, 'demo.mp4')}`));
  assert.match(g.stdout, /frame 1: scene −0\.60s \(timeline 2\.40s, file 2\.400s\)/);
  // The render (H.264) is gridded at the same times: handle gray, then green.
  assert.deepEqual([0, 2, 4].map((k) => tile(path.join(dir, 'qa', 'two.png'), k)), ['gray', 'green', 'green']);
});
