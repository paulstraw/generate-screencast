import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../skills/generate-screencast/assets/project.mjs';
import { speechBounds, takePatch } from '../skills/generate-screencast/assets/record-vo.mjs';
import { gather, plan } from '../skills/generate-screencast/assets/status.mjs';
import { voKey } from '../skills/generate-screencast/assets/timeline.mjs';
import {
  MODEL,
  transcribe,
  whisperArgs,
  whisperLanguage,
} from '../skills/generate-screencast/assets/transcribe.mjs';
import { makeTone, needsFfmpeg, tempDir } from './helpers.mjs';

const ASSETS = fileURLToPath(new URL('../skills/generate-screencast/assets/', import.meta.url));

function project(t, { top = {}, beats } = {}) {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { human: true },
    ...top,
    beats: beats ?? [
      { id: 'intro', title: 'Intro', surface: 'terminal', text: 'Delete the lockfile. Then install.' },
      { id: 'two', title: 'Two', surface: 'terminal', text: 'Done.', needs: [{ kind: 'revo' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  return { dir, data, p: loadProject(dir) };
}

// silencedetect's log for silences [start, end] (end null: still silent at the end of the file).
const log = (silences) =>
  silences
    .map(([a, b]) => `[silencedetect] silence_start: ${a}\n` + (b === null ? '' : `[silencedetect] silence_end: ${b}\n`))
    .join('');

test('speechBounds: speech between leading and trailing silence, padded 150ms', () => {
  assert.deepEqual(speechBounds(log([[0, 1.2], [4.5, null]]), 5.1), [1.05, 4.65]);
  // Silence ends at the file's end without a silence_end line, or with one at the very end.
  assert.deepEqual(speechBounds(log([[0, 1.2], [4.5, 5.1]]), 5.1), [1.05, 4.65]);
  // A pause mid-sentence stays in; the pad never runs past the file.
  assert.deepEqual(speechBounds(log([[0, 0.1], [2, 2.6], [4.95, null]]), 5), [0, 5]);
  // No silence at all: the whole take.
  assert.deepEqual(speechBounds('', 3), [0, 3]);
  // All silence: nothing to keep.
  assert.equal(speechBounds(log([[0, null]]), 3), null);
});

test('speechBounds: a mic click (under 50ms of sound) inside the trailing silence is ignored', () => {
  // Speech ends at 4.0; a 10ms click at 5.0 splits the trailing silence in two.
  assert.deepEqual(speechBounds(log([[0, 1], [4, 5], [5.01, null]]), 7), [0.85, 4.15]);
});

test('takePatch: the trim becomes cam.trim; transcript and scene are dropped', (t) => {
  const { data, p } = project(t, { top: { camera: { delay: 0.15 } } });
  const beat = data.beats[0];
  const patch = takePatch(data, beat, {
    file: p.voFile('intro'),
    duration: 3.4999,
    bounds: [1.05, 4.55],
    mov: p.camFile('intro'),
    movDuration: 6.2,
  });
  assert.deepEqual(patch, {
    vo: { file: p.voFile('intro'), key: voKey(data, beat), duration: 3.5 },
    cam: { file: p.camFile('intro'), trim: [1.05, 4.55], duration: 6.2 },
    txt: null,
    scene: null,
  });
  // Recorded, it lands relative on disk and the old take's entries go.
  p.recordBuild('intro', { txt: { file: p.txtFile('intro'), voKey: 'old' }, scene: { file: p.sceneFile('intro') } });
  p.recordBuild('intro', patch);
  const disk = JSON.parse(fs.readFileSync(path.join(p.dir, 'build.json'), 'utf8')).beats.intro;
  assert.deepEqual(Object.keys(disk).sort(), ['cam', 'vo']);
  assert.equal(disk.cam.file, 'cam/raw/intro.mov');
  assert.equal(disk.vo.file, 'vo/intro.wav');
  // Without a camera the take has no footage.
  assert.equal(takePatch(data, beat, { file: 'x', duration: 1, bounds: [0, 1] }).cam, null);
});

test('a recorded take feeds the timeline: camWindow comes from cam.trim and camera.delay', (t) => {
  const { data, p } = project(t, {
    top: { camera: { delay: 0.15 } },
    beats: [{ id: 'hi', title: 'Hi', surface: 'camera', cam: 'full', text: 'Hi.' }],
  });
  p.recordBuild('hi', takePatch(data, data.beats[0], { file: p.voFile('hi'), duration: 2, bounds: [1, 3], mov: p.camFile('hi'), movDuration: 4 }));
  const [beat] = p.timeline().beats;
  // Picture [0, 3.5): the VO starts 0.5s in at take time 1.0, plus the 0.15s camera lag.
  assert.deepEqual(beat.camWindow, [0.65, 4.15]);
});

test('whisperLanguage maps a project lang to whisper codes', () => {
  assert.equal(whisperLanguage('eng'), 'en');
  assert.equal(whisperLanguage('en-US'), 'en');
  assert.equal(whisperLanguage('de'), 'de');
  assert.equal(whisperLanguage('fra'), 'fr');
  assert.equal(whisperLanguage(undefined), null);
  assert.equal(whisperLanguage('tlh'), null);
});

test('the mlx_whisper call: one take, word timestamps, the beat text as the prompt', () => {
  const args = whisperArgs({ text: 'Delete the lockfile.' }, { input: 'vo/a.wav', outDir: 'vo/txt', name: 'a', language: 'en' });
  assert.deepEqual(args, [
    '--from', 'mlx-whisper', 'mlx_whisper', '--model', MODEL, '--language', 'en', '--word-timestamps', 'True',
    '--output-format', 'json', '--output-dir', 'vo/txt', '--output-name', 'a', '--initial-prompt',
    'Delete the lockfile.', 'vo/a.wav',
  ]);
  assert.ok(!whisperArgs({ text: 'x' }, { input: 'i', outDir: 'o', name: 'n' }).includes('--language'));
});

// A stand-in for `uvx … mlx_whisper`: writes a transcript of `words` where mlx_whisper would.
function stub(words = ['Delete', 'the', 'lock', 'file.']) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const get = (flag) => args[args.indexOf(flag) + 1];
    const out = path.join(get('--output-dir'), `${get('--output-name')}.json`);
    const ws = words.map((word, i) => ({ word: ` ${word}`, start: i * 0.3, end: i * 0.3 + 0.25 }));
    fs.writeFileSync(out, JSON.stringify({ text: words.join(' '), segments: [{ words: ws }] }));
    return { status: 0, stderr: '' };
  };
  return { run, calls };
}

test('transcribe records txt against the take and makes word marks available', needsFfmpeg, (t) => {
  const { data, p } = project(t, { top: { lang: 'eng', spellings: { 'lock file': 'lockfile' } } });
  makeTone(p.voFile('intro'), 1.5);
  p.recordBuild('intro', { vo: { file: p.voFile('intro'), key: voKey(data, data.beats[0]), duration: 1.5 } });
  const { run, calls } = stub(['Delete', 'the', 'lock', 'file.', 'Then', 'install.']);
  const { txt, words } = transcribe(p, 'intro', { run });
  assert.equal(calls[0][0], 'uvx');
  assert.ok(calls[0].includes('en'));
  assert.equal(calls[0].at(-1), p.voFile('intro'));
  assert.equal(words.length, 6);
  assert.deepEqual(txt, { file: p.txtFile('intro'), voKey: p.build.beats.intro.vo.key });
  assert.ok(fs.existsSync(p.txtFile('intro')));
  assert.deepEqual(fs.readdirSync(path.dirname(p.txtFile('intro'))), ['intro.json'], 'no temp file left');
  // Word marks: "lockfile" (respelled) is the 3rd word, 0.6s in, after the 0.5s lead.
  assert.equal(p.beat('intro').at('lockfile'), 1100);
});

test('transcribe keeps the old transcript when whisper fails or hears nothing', needsFfmpeg, (t) => {
  const { data, p } = project(t);
  makeTone(p.voFile('intro'), 1);
  p.recordBuild('intro', { vo: { file: p.voFile('intro'), key: voKey(data, data.beats[0]), duration: 1 } });
  fs.mkdirSync(path.dirname(p.txtFile('intro')), { recursive: true });
  fs.writeFileSync(p.txtFile('intro'), 'old');
  assert.throws(
    () => transcribe(p, 'intro', { run: () => ({ status: 1, stderr: 'boom\n' }) }),
    /mlx_whisper failed for beat "intro": boom/,
  );
  assert.throws(() => transcribe(p, 'intro', { run: stub([]).run }), /found no words/);
  assert.equal(fs.readFileSync(p.txtFile('intro'), 'utf8'), 'old');
  assert.equal(p.build.beats.intro.txt, undefined);
  assert.throws(() => transcribe(p, 'two', { run: stub().run }), /"two" has no take yet/);
});

test('status: a new take re-asks for transcribe; transcribing clears it', needsFfmpeg, async (t) => {
  const { data, p } = project(t);
  const [intro] = data.beats;
  makeTone(p.voFile('intro'), 1);
  p.recordBuild('intro', takePatch(data, intro, { file: p.voFile('intro'), duration: 1, bounds: [0, 1] }));
  const todo = async () => plan(p.data, p.build, await gather(p)).todo;
  // ("two" has no take, so it needs everything.)
  assert.deepEqual((await todo()).transcribe, ['intro', 'two']);
  transcribe(p, 'intro', { run: stub(['Delete', 'the', 'lockfile.', 'Then', 'install.']).run });
  assert.deepEqual((await todo()).transcribe, ['two']);
  assert.deepEqual((await todo()).vo, ['two']);
  // The next take of the same text has the same key, but drops the transcript, so it's asked for again.
  p.recordBuild('intro', takePatch(data, intro, { file: p.voFile('intro'), duration: 1, bounds: [0, 1] }));
  assert.deepEqual((await todo()).transcribe, ['intro', 'two']);
});

test('the CLIs refuse TTS projects and record-vo refuses camera beats without --camera', (t) => {
  const tts = project(t, { top: { voice: { tts: 'en-US-AndrewNeural' } } });
  const node = (script, ...args) => spawnSync('node', [path.join(ASSETS, script), ...args], { encoding: 'utf8' });
  assert.match(node('transcribe.mjs', tts.dir).stderr, /TTS voice/);
  assert.match(node('record-vo.mjs', tts.dir).stderr, /TTS voice; make its VO with tts\.mjs/);
  const cam = project(t, {
    top: { camera: {} },
    beats: [{ id: 'hi', title: 'Hi', surface: 'camera', cam: 'full', text: 'Hi.' }],
  });
  const r = node('record-vo.mjs', cam.dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hi has cam pip\/full; pass --camera/);
  assert.match(node('record-vo.mjs').stderr, /usage: node record-vo\.mjs <dir>/);
});
