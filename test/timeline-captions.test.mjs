import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadProject, loadTimeline } from '../skills/generate-screencast/assets/project.mjs';
import { placeCues, timeline } from '../skills/generate-screencast/assets/timeline.mjs';
import { needsFfmpeg, tempDir } from './helpers.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);

// Three TTS beats of 2s VO each, filmed as they stand; `extra` merges into each beat.
function fixture(extra = [], top = {}) {
  const project = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { tts: 'en-US-AndrewNeural' },
    ...top,
    beats: [0, 1, 2].map((i) => ({ id: `b${i}`, title: `B${i}`, surface: 'web', text: 'Hi.', ...extra[i] })),
  };
  const beats = {};
  project.beats.forEach((b, i) => {
    const end = 0.5 + 2 + (i === 2 ? 1 : 0.5) + 1.5;
    beats[b.id] = {
      vo: { file: `vo/${b.id}.mp3`, key: `k${i}`, duration: 2 },
      scene: { file: `scenes/${b.id}.webm`, voKey: `k${i}`, lead: 0.5, duration: end + 1.5, end, footage: [-1.5, end] },
    };
  });
  return { project, build: { version: 1, beats } };
}

// One cue per beat, spoken across its whole VO.
const oneCue = (ids, text = (id) => `Cue ${id}.`) =>
  Object.fromEntries(ids.map((id) => [id, { cues: [{ start: 0, end: 2, text: text(id) }], onsets: [] }]));

test('placeCues snaps a cue to a voice onset just after it, and not to one too far away', () => {
  const cues = [
    { start: 0.1, end: 1.0, text: 'One.' },
    { start: 1.5, end: 2.5, text: 'Two.' },
  ];
  const placed = placeCues(cues, [0.3, 2.0], { voAt: 10, end: 20 });
  close(placed[0].start, 10.3, 'snapped to the onset 0.2s later');
  close(placed[1].start, 11.5, 'onset 0.5s later is too far');
});

test('placeCues lingers 0.3s past speech, at least 1.2s, but never into the next cue or past the block', () => {
  const placed = placeCues(
    [
      { start: 0, end: 0.2, text: 'Short.' },
      { start: 2, end: 3, text: 'Then.' },
      { start: 3.1, end: 4, text: 'Last.' },
    ],
    [],
    { voAt: 1, end: 5.1 },
  );
  assert.deepEqual(
    placed.map((c) => [c.start, c.end]),
    [
      [1, 2.2], // held to 1.2s
      [3, 4.1], // next cue starts at 4.1, before 3 + 0.3
      [4.1, 5.1], // clamped to the block end, not 5.3
    ],
  );
});

test('cues land at the VO offset in timeline time, and t.cues is the .srt in order', () => {
  const { project, build } = fixture();
  const t = timeline(project, build, oneCue(['b0', 'b1', 'b2']));
  assert.deepEqual(
    t.cues.map((c) => [c.start, c.end, c.text]),
    [
      [0.5, 2.5 + 0.3, 'Cue b0.'],
      [3.5, 5.5 + 0.3, 'Cue b1.'],
      [6.5, 8.5 + 0.3, 'Cue b2.'],
    ],
  );
  assert.deepEqual(t.beats[1].cues, [t.cues[1]]);
  // No cuts: each cue is drawn over its own beat's picture only.
  assert.deepEqual(
    t.beats.map((b) => b.overlays.map((o) => o.text)),
    [['Cue b0.'], ['Cue b1.'], ['Cue b2.']],
  );
});

test('a J cut draws the next beat’s first cue over the previous picture, in that picture’s caption position', () => {
  // Beat 1's block starts at 3.0, its VO at 3.5; a +1.0 cut holds beat 0's picture until 4.0.
  const { project, build } = fixture([{ captionPosition: 'top' }, { cut: 1.0 }]);
  const t = timeline(project, build, oneCue(['b0', 'b1', 'b2']));
  assert.deepEqual(t.beats[0].picture, [0, 4]);
  const cue = t.beats[1].cues[0];
  assert.deepEqual([cue.start, cue.end], [3.5, 5.8], 'the cue itself is unchanged by the cut: audio is fixed');
  assert.deepEqual(t.beats[0].overlays, [
    { start: 0.5, end: 2.8, text: 'Cue b0.', position: 'top' },
    { start: 3.5, end: 4, text: 'Cue b1.', position: 'top' },
  ]);
  assert.deepEqual(t.beats[1].overlays, [{ start: 4, end: 5.8, text: 'Cue b1.', position: 'bottom' }]);
  assert.deepEqual(
    t.cues.map((c) => c.text),
    ['Cue b0.', 'Cue b1.', 'Cue b2.'],
    'the .srt has each cue once',
  );
});

test('an L cut draws the previous beat’s lingering cue over the next picture', () => {
  // Beat 0's cue runs 0.5–2.8; a −0.5 cut brings beat 1's picture in at 2.5.
  const { project, build } = fixture([{}, { cut: -0.5, captionPosition: 'top' }]);
  const t = timeline(project, build, oneCue(['b0', 'b1', 'b2']));
  assert.deepEqual(t.beats[0].overlays, [{ start: 0.5, end: 2.5, text: 'Cue b0.', position: 'bottom' }]);
  assert.deepEqual(t.beats[1].overlays[0], { start: 2.5, end: 2.8, text: 'Cue b0.', position: 'top' });
});

test('cue inputs: missing ones are stale only when captions are passed, and errors are reported', () => {
  const { project, build } = fixture();
  assert.deepEqual(timeline(project, build).beats[0].stale, [], 'pure edit callers pass no captions');
  const t = timeline(project, build, { b0: { error: 'the script has 2 sentence(s) but … has 1 cue(s)' } });
  assert.deepEqual(t.beats[0].stale, [
    { step: 'vo', reason: 'captions for "b0": the script has 2 sentence(s) but … has 1 cue(s)' },
  ]);
  assert.deepEqual(t.beats[1].stale, [{ step: 'vo', reason: 'no caption timing for "b1" yet' }]);
  assert.deepEqual(t.beats[0].cues, []);
});

test('captions change the key; so does a caption position', () => {
  const { project, build } = fixture();
  const a = timeline(project, build, oneCue(['b0', 'b1', 'b2'])).key;
  assert.notEqual(
    timeline(
      project,
      build,
      oneCue(['b0', 'b1', 'b2'], (id) => `Other ${id}.`),
    ).key,
    a,
  );
  project.beats[1].captionPosition = 'top';
  assert.notEqual(timeline(project, build, oneCue(['b0', 'b1', 'b2'])).key, a);
});

// A human-VO project with camera: beat 0 pip, beat 1 full (camera surface), beat 2 off.
function cameraFixture(delay = 0.15) {
  const { project, build } = fixture(
    [
      { cam: 'pip', bubble: { position: 'top-right' } },
      { cam: 'full', surface: 'camera', cut: -0.3 },
    ],
    { voice: { human: true }, camera: { delay, bubble: { size: 0.3 } } },
  );
  build.beats.b0.cam = { file: 'cam/raw/b0.mov', trim: [2, 4], duration: 5 };
  build.beats.b1.cam = { file: 'cam/raw/b1.mov', trim: [0.2, 2.2] };
  delete build.beats.b1.scene;
  return { project, build };
}

test('camWindow maps the picture span into the take, delayed, with clone padding where it runs off', () => {
  const { project, build } = cameraFixture();
  const t = timeline(project, build);
  const [pip, full, off] = t.beats;

  assert.equal(pip.mode, 'pip');
  assert.deepEqual(pip.bubble, { position: 'top-right', size: 0.3, margin: 48 });
  // Picture 0–2.7 (beat 1 cuts in 0.3s early); VO at 0.5 ⇒ take time 2 − 0.5 + 0.15 = 1.65 … 2 + 2.2 + 0.15 = 4.35.
  assert.deepEqual(pip.picture, [0, 2.7]);
  assert.deepEqual(pip.camWindow, [1.65, 4.35]);
  assert.deepEqual(pip.camPad, [0, 0]);

  assert.equal(full.mode, 'full');
  assert.equal(full.sceneWindow, null);
  // Picture 2.7–6, VO at 3.5 ⇒ 0.2 − 0.8 + 0.15 = −0.45 (clone 0.45s of the first frame) … 0.2 + 2.5 + 0.15 = 2.85.
  assert.deepEqual(full.camWindow, [-0.45, 2.85]);
  assert.deepEqual(full.camPad, [0.45, 0], 'take length unknown: no tail pad computed');

  assert.equal(off.camWindow, null);
  assert.equal(off.camPad, null);
  assert.ok(t.beats.every((b) => b.stale.length === 0));
});

test('the tail pad covers a window past the end of a take of known length; delay and trims change the key', () => {
  const { project, build } = cameraFixture();
  build.beats.b0.cam.duration = 4;
  const t = timeline(project, build);
  close(t.beats[0].camPad[1], 0.35);
  const k = t.key;
  assert.notEqual(timeline(cameraFixture(0).project, cameraFixture(0).build).key, k);
  build.beats.b0.cam.trim = [2.1, 4.1];
  assert.notEqual(timeline(project, build).key, k);
});

test('a camera beat without a take is stale for vo', () => {
  const { project, build } = cameraFixture();
  delete build.beats.b0.cam;
  const t = timeline(project, build);
  assert.equal(t.beats[0].camWindow, null);
  assert.deepEqual(t.beats[0].stale, [{ step: 'vo', reason: 'no camera take for "b0" yet' }]);
});

// On disk: a VO with 0.3s of silence before the voice, and its timing as edge-tts or whisper wrote it.
function voWithSilence(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-af',
    'adelay=300|300,apad=pad_dur=0.2',
    file,
  ]);
}

test('loadTimeline reads TTS cues from the srt, snapped to the measured onset', needsFfmpeg, (t) => {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { tts: 'en-US-AndrewNeural' },
    beats: [
      { id: 'one', title: 'One', surface: 'web', text: 'Hit Save. It syncs.' },
      { id: 'two', title: 'Two', surface: 'web', text: 'Done.', cut: 0.6 },
    ],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data));
  const p = loadProject(dir);
  for (const id of ['one', 'two']) {
    voWithSilence(p.voFile(id));
    p.recordBuild(id, { vo: { file: p.voFile(id), key: 'k', duration: 2.5, subs: p.subsFile(id) } });
  }
  fs.writeFileSync(
    p.subsFile('one'),
    '1\n00:00:00,200 --> 00:00:01,000\nhit save.\n\n2\n00:00:01,300 --> 00:00:02,000\nit syncs.\n',
  );
  fs.writeFileSync(
    p.subsFile('two'),
    '1\n00:00:00,100 --> 00:00:01,000\nP N P M.\n\n2\n00:00:01,200 --> 00:00:02,000\nmore.\n',
  );

  const tl = loadTimeline(dir);
  const [one, two] = tl.beats;
  assert.deepEqual(
    one.cues.map((c) => c.text),
    ['Hit Save.', 'It syncs.'],
    'text from the script, not edge-tts',
  );
  assert.ok(Math.abs(one.cues[0].start - (0.5 + 0.3)) < 0.03, `snapped to the onset: ${one.cues[0].start}`);
  close(one.cues[1].start, 0.5 + 1.3, 'no onset near the second sentence');
  assert.deepEqual(one.stale, []);
  assert.deepEqual(two.cues, []);
  assert.match(two.stale[0].reason, /^captions for "two": the script has 1 sentence\(s\)/);
  // The J cut: "two" starts at 3.5 but beat one's picture runs to 3.5 + 0.6, so nothing of two's is drawn there.
  assert.deepEqual(one.picture, [0, 4.1]);
});

test('loadTimeline reads whisper cues with spellings for human VO', needsFfmpeg, (t) => {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { human: true },
    spellings: { 'lock file': 'lockfile' },
    beats: [{ id: 'one', title: 'One', surface: 'terminal', text: 'Delete the lockfile.' }],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data));
  const p = loadProject(dir);
  voWithSilence(p.voFile('one'));
  fs.mkdirSync(path.dirname(p.txtFile('one')), { recursive: true });
  const words = [
    ['Delete', 0.0, 0.4],
    ['the', 0.4, 0.6],
    ['lock', 0.6, 0.9],
    ['file.', 0.9, 1.4],
  ].map(([word, start, end]) => ({ word: ` ${word}`, start, end }));
  fs.writeFileSync(p.txtFile('one'), JSON.stringify({ language: 'en', segments: [{ words }] }));

  p.recordBuild('one', { vo: { file: p.voFile('one'), key: 'k', duration: 2.5 } });
  assert.deepEqual(p.timeline().beats[0].stale.at(-1), {
    step: 'transcribe',
    reason: 'no caption timing for "one" yet',
  });

  p.recordBuild('one', { txt: { file: p.txtFile('one'), voKey: 'k' } });
  const [beat] = p.timeline().beats;
  assert.equal(beat.cues.length, 1);
  assert.equal(beat.cues[0].text, 'Delete the lockfile.');
  assert.ok(Math.abs(beat.cues[0].start - 0.8) < 0.03, `whisper's 0 snapped to the onset: ${beat.cues[0].start}`);
  close(beat.cues[0].end, 0.5 + 1.4 + 0.3);
});
