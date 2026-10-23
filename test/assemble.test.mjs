import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scriptMarkdown } from '../skills/generate-screencast/assets/assemble.mjs';
import { CACHE_DIR, loadProject, voKey } from '../skills/generate-screencast/assets/project.mjs';
import { gather, plan, qaKey } from '../skills/generate-screencast/assets/status.mjs';
import { hasFfmpeg, makeTone, probeDuration, tempDir } from './helpers.mjs';

const ASSEMBLE = fileURLToPath(new URL('../skills/generate-screencast/assets/assemble.mjs', import.meta.url));

let hasPlaywright = false;
try {
  createRequire(path.join(CACHE_DIR, 'noop.js')).resolve('playwright');
  hasPlaywright = true;
} catch {}
const needs = {
  skip: !hasFfmpeg ? 'ffmpeg/ffprobe not installed' : !hasPlaywright ? `Playwright not installed in ${CACHE_DIR}` : false,
};

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
const srt = (cues) =>
  cues
    .map(([a, b, text], i) => {
      const ts = (x) => `00:00:${x.toFixed(3).padStart(6, '0').replace('.', ',')}`;
      return `${i + 1}\n${ts(a)} --> ${ts(b)}\n${text}\n`;
    })
    .join('\n');

// A recording of beat scene time −1.5…end: gray for the head handle, then `color`. Scene time 0 is the color change.
function makeScene(file, end, color) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ffmpeg('-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${end}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', file);
}

// The average color of the top-left corner (clear of burned-in captions) of frame `k`.
function corner(file, k) {
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k}),crop=40:40:0:0,scale=1:1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const [r, g, b] = rgb;
  if (r < 60 && g < 60 && b > 140) return 'blue';
  if (r > 140 && g < 60 && b < 60) return 'red';
  if (r < 60 && g > 90 && b < 60) return 'green';
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 90 && r < 170) return 'gray';
  return `rgb(${r},${g},${b})`;
}

const BEATS = [
  { id: 'one', title: 'Opening', surface: 'web', text: 'Hit Save now. It syncs everywhere.' },
  { id: 'two', title: 'The list', surface: 'web', text: 'Your drafts land here.', cut: -0.6, captionPosition: 'top' },
  { id: 'three', title: 'Done', surface: 'web', text: 'Next, the settings.', cut: 0.4 },
];
const VO = { one: [2, 'red', 1.2], two: [1.5, 'green'], three: [1.8, 'blue'] };

// TTS project with tone VOs, synthetic .srt cues, color scenes with 1.5s handles, everything filmed and QA'd.
async function fixture(t) {
  const dir = tempDir(t);
  const data = { version: 1, slug: 'demo', title: 'Demo', size: [320, 180], voice: { tts: 'en-US-AndrewNeural' },
    captions: { burn: true }, beats: BEATS };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  BEATS.forEach((b, i) => {
    const [secs, , split] = VO[b.id];
    makeTone(p.voFile(b.id), secs, { freq: 300 + 200 * i });
    const d = probeDuration(p.voFile(b.id));
    const parts = b.text.split(/(?<=\.) /);
    fs.writeFileSync(p.subsFile(b.id), srt(parts.length > 1 ? [[0, split, parts[0]], [split, d, parts[1]]] : [[0, d, b.text]]));
    p.recordBuild(b.id, { vo: { file: p.voFile(b.id), key: voKey(data, b), duration: d, subs: p.subsFile(b.id) } });
  });
  for (const b of BEATS) {
    const sceneMs = p.beat(b.id).sceneMs;
    const end = sceneMs / 1000 + 1.5;
    const file = p.sceneFile(b.id);
    makeScene(file, end, VO[b.id][1]);
    p.recordBuild(b.id, { scene: { file, raw: file, voKey: p.build.beats[b.id].vo.key, lead: 0.5,
      duration: probeDuration(file), end, footage: [-1.5, end], at: new Date().toISOString() } });
  }
  const s = plan(p.data, p.build, await gather(p));
  for (const e of s.timeline.beats)
    p.recordBuild(e.id, { qa: { key: qaKey(p.data, p.build, e), at: new Date().toISOString() } });
  return { dir, p };
}

const run = (...args) => spawnSync(process.execPath, [ASSEMBLE, ...args], { encoding: 'utf8' });

test('assemble renders the timeline: duration, cut placement, VO offsets, captions, provenance', needs, async (t) => {
  const { dir, p } = await fixture(t);
  const before = plan(p.data, p.build, await gather(p));
  assert.deepEqual(before.beats.map((b) => b.steps), [[], [], []]);
  assert.deepEqual(before.assemble, ['never assembled']);
  const tl = before.timeline;

  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('}') + 1));
  const out = path.join(dir, 'demo.mp4');
  assert.equal(report.out, out);

  // Length: the timeline's total, within a frame.
  assert.ok(Math.abs(probeDuration(out) - tl.total) <= 1 / 30, `${probeDuration(out)} vs ${tl.total}`);
  assert.deepEqual(report.beats.map((b) => b.voAt), tl.beats.map((e) => e.voAt));

  // Pictures: the L cut brings "two" in 0.6s early, inside its head handle (gray); the J cut keeps "two" on screen
  // 0.4s into "three"'s block. Frames either side of each boundary belong to the right beat.
  const [, two, three] = tl.beats;
  assert.equal(two.picture[0], 2.4);
  assert.equal(corner(out, 15), 'red');
  assert.equal(corner(out, two.frames[0] - 1), 'red');
  assert.equal(corner(out, two.frames[0]), 'gray'); // scene time −0.6: the handle
  assert.equal(corner(out, Math.round(3.2 * 30)), 'green'); // scene time 0.2
  assert.equal(corner(out, three.frames[0] - 1), 'green');
  assert.equal(corner(out, three.frames[0]), 'blue');
  assert.ok(three.frames[0] / 30 - three.block[0] > 0.39, 'J cut: picture follows the narration');

  // Audio: each tone starts at its voAt (the silences before it end there).
  const ends = [...spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'],
    { encoding: 'utf8' }).stderr.matchAll(/silence_end: ([\d.]+)/g)]
    .map((x) => +x[1])
    .filter((x) => x < tl.total - 0.05); // the trailing silence "ends" at the end of the file
  assert.equal(ends.length, 3, `silence ends: ${ends}`);
  ends.forEach((x, i) => assert.ok(Math.abs(x - tl.beats[i].voAt) < 0.05, `VO ${i}: ${x} vs ${tl.beats[i].voAt}`));

  // Captions: the .srt beside it and a mov_text track inside it.
  const cues = fs.readFileSync(path.join(dir, 'demo.srt'), 'utf8');
  assert.match(cues, /Hit Save now\.[\s\S]*It syncs everywhere\.[\s\S]*Your drafts land here\.[\s\S]*Next, the settings\./);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:stream_tags=language',
    '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.match(streams, /mov_text,eng/);
  assert.equal(report.captions.burned, true);
  assert.ok(fs.readdirSync(path.join(dir, 'assembly', 'captions')).length >= 4);

  // Script export and provenance: status is now clean.
  assert.equal(
    fs.readFileSync(path.join(dir, 'demo.script.md'), 'utf8'),
    '# Demo\n\n## 1 · Opening\n\n> Hit Save now. It syncs everywhere.\n\n## 2 · The list\n\n> Your drafts land here.\n\n' +
      '## 3 · Done\n\n> Next, the settings.\n',
  );
  const q = loadProject(dir);
  assert.equal(q.build.assembly.key, tl.key);
  assert.equal(q.build.assembly.out, out);
  const after = plan(q.data, q.build, await gather(q));
  assert.deepEqual(after.assemble, []);
  assert.equal(after.todo.assemble, false);
});

test('assemble refuses a stale project, and --force renders it anyway', needs, async (t) => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'screencast.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.beats[1].needs = [{ kind: 'reshoot', note: 'cursor missed Save' }];
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not ready to assemble/);
  assert.match(r.stderr, /two: film \(flagged reshoot: cursor missed Save\)/);
  assert.match(r.stderr, /two: qa \(follows film\)/);
  assert.ok(!fs.existsSync(path.join(dir, 'demo.mp4')));

  const f = run(dir, '--force');
  assert.equal(f.status, 0, f.stderr);
  assert.match(f.stderr, /--force: rendering with stale beats/);
  assert.ok(fs.existsSync(path.join(dir, 'demo.mp4')));
});

test('the script export quotes every line and leaves out skipped beats', () => {
  const md = scriptMarkdown({
    title: 'T',
    beats: [
      { id: 'a', title: 'A', text: 'One.\nTwo.' },
      { id: 'b', title: 'B', text: 'Gone.', skip: true },
      { id: 'c', title: 'C', text: 'Three.' },
    ],
  });
  assert.equal(md, '# T\n\n## 1 · A\n\n> One.\n> Two.\n\n## 2 · C\n\n> Three.\n');
});
