import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../skills/generate-screencast/assets/project.mjs';
import { CLEARS, plan, qaKey } from '../skills/generate-screencast/assets/status.mjs';
import { voKey } from '../skills/generate-screencast/assets/timeline.mjs';
import { makeTone, needsFfmpeg, tempDir } from './helpers.mjs';

const STATUS = fileURLToPath(new URL('../skills/generate-screencast/assets/status.mjs', import.meta.url));

// A fully built TTS project: three web beats with 2s VO, filmed, QA'd and assembled. `beats` merges into each beat.
function fixture({ beats: extra = [], top = {} } = {}) {
  const project = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { tts: 'en-US-AndrewNeural' },
    ...top,
    beats: [0, 1, 2].map((i) => ({ id: `b${i}`, title: `B${i}`, surface: 'web', text: `Beat ${i}.`, ...extra[i] })),
  };
  const build = { version: 1, beats: {} };
  const exists = ['demo.mp4'];
  project.beats.forEach((b, i) => {
    const key = voKey(project, b);
    const end = 0.5 + 2 + (i === 2 ? 1 : 0.5) + 1.5;
    build.beats[b.id] = {
      vo: { file: `vo/${b.id}.mp3`, key, duration: 2, subs: `vo/${b.id}.srt` },
      scene: {
        file: `scenes/${b.id}.webm`,
        raw: `scenes/${b.id}.webm`,
        voKey: key,
        lead: 0.5,
        duration: end + 1.5,
        end,
        footage: [-1.5, end],
        at: '2026-10-19T00:00:00Z',
      },
    };
    exists.push(`vo/${b.id}.mp3`, `vo/${b.id}.srt`, `scenes/${b.id}.webm`);
  });
  return finish(project, build, exists);
}

// Captions as captions.mjs would make them: one cue per beat with its text (TTS cues carry the real spelling).
const captionsOf = (project) =>
  Object.fromEntries(project.beats.map((b) => [b.id, { cues: [{ start: 0, end: 2, text: b.text }], onsets: [] }]));

// Records QA and assembly as current, as if the pipeline had just run.
function finish(project, build, exists) {
  const facts = { exists, out: 'demo.mp4', captions: captionsOf(project) };
  const s = plan(project, build, facts);
  for (const e of s.timeline.beats) build.beats[e.id].qa = { key: qaKey(project, build, e), at: 'now' };
  build.assembly = { key: s.timeline.key, out: 'demo.mp4', at: 'now' };
  return { project, build, facts };
}

const rerun = (f) => plan(f.project, f.build, { ...f.facts, captions: captionsOf(f.project) });
const stepsOf = (s) => Object.fromEntries(s.beats.map((b) => [b.id, b.steps.map((st) => st.step)]));
const reasons = (s, id, step) => s.beats.find((b) => b.id === id).steps.find((st) => st.step === step)?.reasons ?? [];

test('a fully built project needs nothing', () => {
  const s = rerun(fixture());
  assert.deepEqual(stepsOf(s), { b0: [], b1: [], b2: [] });
  assert.deepEqual(s.assemble, []);
  assert.deepEqual(s.todo, { vo: [], transcribe: [], film: [], qa: [], assemble: false });
});

test('a new project needs everything, in dependency order', () => {
  const { project } = fixture();
  const s = plan(project, undefined, { captions: {} });
  assert.deepEqual(stepsOf(s), { b0: ['vo', 'film', 'qa'], b1: ['vo', 'film', 'qa'], b2: ['vo', 'film', 'qa'] });
  assert.deepEqual(reasons(s, 'b0', 'vo'), ['no VO yet']);
  assert.deepEqual(reasons(s, 'b0', 'film'), ['not filmed yet']);
  assert.ok(s.assemble.includes('never assembled'));
  assert.deepEqual(s.todo.vo, ['b0', 'b1', 'b2']);
  assert.equal(s.todo.assemble, true);
});

test('vo: missing entry, missing file, changed key, revo flag', () => {
  let f = fixture();
  delete f.build.beats.b0.vo;
  assert.deepEqual(reasons(rerun(f), 'b0', 'vo'), ['no VO yet']);

  f = fixture();
  f.facts.exists = f.facts.exists.filter((x) => x !== 'vo/b1.mp3');
  assert.match(reasons(rerun(f), 'b1', 'vo')[0], /VO file missing \(vo\/b1\.mp3\)/);

  f = fixture();
  f.project.voice.tts = 'en-GB-RyanNeural';
  assert.deepEqual(rerun(f).todo.vo, ['b0', 'b1', 'b2']);

  f = fixture();
  f.project.beats[2].needs = [{ kind: 'revo', note: 'too fast' }];
  const s = rerun(f);
  assert.deepEqual(stepsOf(s).b2, ['vo', 'film', 'qa']);
  assert.deepEqual(reasons(s, 'b2', 'vo'), ['flagged revo: too fast']);
  assert.deepEqual(reasons(s, 'b2', 'film'), ['follows vo']);
});

test('transcribe: human VO without a transcript, or one of another take', () => {
  const f = fixture({ top: { voice: { human: true } } });
  for (const b of f.project.beats) {
    const s = f.build.beats[b.id];
    s.vo = { ...s.vo, file: `vo/${b.id}.wav`, key: voKey(f.project, b) };
    s.scene.voKey = s.vo.key;
    s.txt = { file: `vo/txt/${b.id}.json`, voKey: s.vo.key };
    f.facts.exists.push(s.vo.file, s.txt.file);
  }
  Object.assign(f, finish(f.project, f.build, f.facts.exists));
  assert.deepEqual(stepsOf(rerun(f)), { b0: [], b1: [], b2: [] });

  delete f.build.beats.b0.txt;
  f.build.beats.b1.txt.voKey = 'an older take';
  f.facts.exists = f.facts.exists.filter((x) => x !== 'vo/txt/b2.json');
  const s = rerun(f);
  assert.deepEqual(stepsOf(s), {
    b0: ['transcribe', 'film', 'qa'],
    b1: ['transcribe', 'film', 'qa'],
    b2: ['transcribe', 'film', 'qa'],
  });
  assert.deepEqual(reasons(s, 'b0', 'transcribe'), ['no transcript yet']);
  assert.deepEqual(reasons(s, 'b1', 'transcribe'), ['the recording changed since the transcript']);
  assert.match(reasons(s, 'b2', 'transcribe')[0], /transcript missing/);
  assert.deepEqual(reasons(s, 'b0', 'film'), ['follows transcribe']);

  // Editing a human beat's text means re-recording it.
  f.project.beats[0].text = 'Something else.';
  assert.deepEqual(reasons(rerun(f), 'b0', 'vo'), ['text changed since the recording']);
});

test('film: missing entry, missing file, another VO, past the handles, reshoot flag', () => {
  let f = fixture();
  delete f.build.beats.b0.scene;
  f.facts.exists = f.facts.exists.filter((x) => x !== 'scenes/b1.webm');
  f.build.beats.b2.scene.voKey = 'an older VO';
  let s = rerun(f);
  assert.deepEqual(stepsOf(s), { b0: ['film', 'qa'], b1: ['film', 'qa'], b2: ['film', 'qa'] });
  assert.deepEqual(reasons(s, 'b0', 'film'), ['not filmed yet']);
  assert.match(reasons(s, 'b1', 'film')[0], /recording missing/);
  assert.deepEqual(reasons(s, 'b2', 'film'), ['the VO changed since filming']);
  assert.deepEqual(reasons(s, 'b1', 'qa'), ['follows film']);

  f = fixture();
  f.project.beats[1].cut = -2.1;
  s = rerun(f);
  assert.deepEqual(stepsOf(s), { b0: ['qa'], b1: ['film', 'qa'], b2: [] }); // b0's picture now ends earlier
  assert.match(reasons(s, 'b1', 'film')[0], /cut −2\.10s reaches .* before the footage of "b1"/);

  f = fixture();
  f.project.beats[1].needs = [{ kind: 'reshoot', note: 'cursor missed Save' }];
  s = rerun(f);
  assert.deepEqual(stepsOf(s).b1, ['film', 'qa']);
  assert.deepEqual(reasons(s, 'b1', 'film'), ['flagged reshoot: cursor missed Save']);
});

test('a cut within the handles is edit-only: QA for the beats it touches, then assemble', () => {
  const f = fixture();
  f.project.beats[1].cut = -1.2;
  const s = rerun(f);
  // The boundary moved both b0's end and b1's start, so both pictures need a fresh look; nothing needs filming.
  assert.deepEqual(stepsOf(s), { b0: ['qa'], b1: ['qa'], b2: [] });
  assert.deepEqual(reasons(s, 'b1', 'qa'), ['the picture changed since QA']);
  assert.deepEqual(s.todo.film, []);
  assert.ok(s.assemble.some((r) => /2 beats changed \(b0, b1\)/.test(r)));
  assert.ok(s.assemble.includes('the edit changed since the last render'));
});

test('qa: never checked, a qa flag, and a key change from a reshoot', () => {
  let f = fixture();
  delete f.build.beats.b0.qa;
  f.project.beats[1].needs = [{ kind: 'qa', note: 'caption overlaps the toolbar' }];
  f.build.beats.b2.scene.at = '2026-10-20T00:00:00Z';
  const s = rerun(f);
  assert.deepEqual(stepsOf(s), { b0: ['qa'], b1: ['qa'], b2: ['qa'] });
  assert.deepEqual(reasons(s, 'b0', 'qa'), ['not checked yet']);
  assert.deepEqual(reasons(s, 'b1', 'qa'), ['flagged qa: caption overlaps the toolbar']);
  assert.deepEqual(reasons(s, 'b2', 'qa'), ['the picture changed since QA']);

  // Burn-in changes what every frame shows.
  f = fixture();
  f.project.captions = { burn: true };
  assert.deepEqual(rerun(f).todo.qa, ['b0', 'b1', 'b2']);
});

test('assemble: stale key, missing deliverable, moved output, any beat changed', () => {
  let f = fixture();
  f.facts.exists = f.facts.exists.filter((x) => x !== 'demo.mp4');
  assert.deepEqual(rerun(f).assemble, ['the deliverable is missing']);

  f = fixture();
  f.facts.out = 'elsewhere.mp4';
  assert.deepEqual(rerun(f).assemble, ['the output moved to elsewhere.mp4']);

  f = fixture();
  f.build.assembly.key = 'old';
  assert.deepEqual(rerun(f).assemble, ['the edit changed since the last render']);
  assert.deepEqual(stepsOf(rerun(f)), { b0: [], b1: [], b2: [] });

  f = fixture();
  f.project.beats[0].needs = [{ kind: 'qa' }];
  assert.deepEqual(rerun(f).assemble, ['1 beat changed (b0)']);
});

test('editing text with `say` set only changes captions: qa and assemble, not vo', () => {
  const f = fixture({ beats: [{ say: 'Beat zero.' }] });
  f.project.beats[0].text = 'Beat 0, reworded.';
  let s = rerun(f);
  assert.deepEqual(stepsOf(s), { b0: ['qa'], b1: [], b2: [] });
  assert.ok(s.assemble.includes('the edit changed since the last render'));

  // Without `say`, the same edit changes what TTS speaks.
  f.project.beats[1].text = 'Beat 1, reworded.';
  s = rerun(f);
  assert.deepEqual(stepsOf(s).b1, ['vo', 'film', 'qa']);
  assert.deepEqual(reasons(s, 'b1', 'vo'), ['text or voice changed since the VO']);

  // Changing `say` does change the VO.
  f.project.beats[0].say = 'Beat zero again.';
  assert.deepEqual(reasons(rerun(f), 'b0', 'vo'), ['say or voice changed since the VO']);
});

test('skipped beats need nothing, even when flagged; skipping one moves the edit', () => {
  const f = fixture();
  f.project.beats[1].skip = true;
  f.project.beats[1].needs = [{ kind: 'reshoot' }];
  const s = rerun(f);
  assert.deepEqual(s.beats[1], { id: 'b1', title: 'B1', skip: true, steps: [] });
  assert.deepEqual(s.todo.film, []);
  // b2 now starts where b1 did: its picture is unchanged relative to its VO, so its QA still holds.
  assert.deepEqual(stepsOf(s).b2, []);
  assert.ok(s.assemble.includes('the edit changed since the last render'));
});

test('camera-full beats are never filmed; a missing take is a vo reason', () => {
  const f = fixture({
    top: { voice: { human: true }, camera: { delay: 0.1 } },
    beats: [{}, { surface: 'camera', cam: 'full' }],
  });
  const s = plan(f.project, { version: 1, beats: {} }, {});
  assert.deepEqual(stepsOf(s).b1, ['vo', 'transcribe', 'qa']);
  assert.deepEqual(stepsOf(s).b0, ['vo', 'transcribe', 'film', 'qa']);
});

test('an impossible edit is reported, not thrown', () => {
  const f = fixture();
  f.project.beats[1].cut = 3; // b1's picture would start where b2's does
  const s = rerun(f);
  assert.match(s.error, /cuts leave no picture for "b1"/);
  assert.equal(s.timeline, null);
  assert.equal(s.todo.assemble, true);
  assert.deepEqual(reasons(s, 'b0', 'qa'), ['the edit is invalid']);
});

test('the step that satisfies a flag clears it', () => {
  assert.deepEqual(CLEARS, { vo: ['revo'], film: ['reshoot'], qa: ['qa'] });
});

// The CLI, on a real folder: files on disk, cues from real .srt files.
function onDisk(t) {
  const dir = tempDir(t);
  const f = fixture();
  fs.mkdirSync(path.join(dir, 'vo'));
  fs.mkdirSync(path.join(dir, 'scenes'));
  const srt = (text) => `1\n00:00:00,000 --> 00:00:02,000\n${text}\n`;
  for (const b of f.project.beats) {
    fs.writeFileSync(path.join(dir, `vo/${b.id}.srt`), srt(b.text));
    fs.writeFileSync(path.join(dir, `scenes/${b.id}.webm`), '');
  }
  for (const b of f.project.beats) makeTone(path.join(dir, `vo/${b.id}.mp3`), 2);
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(f.project, null, 2));
  delete f.build.assembly;
  for (const s of Object.values(f.build.beats)) delete s.qa;
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(f.build, null, 2));
  return dir;
}

test('CLI: table, --json, and --qa recording a pass and clearing qa flags', needsFfmpeg, (t) => {
  const dir = onDisk(t);
  const run = (...args) => execFileSync('node', [STATUS, dir, ...args], { encoding: 'utf8' });

  const table = run();
  assert.match(table, /^b0\s+qa\s+not checked yet$/m);
  assert.match(table, /^assemble\s+needed\s+3 beats changed/m);
  assert.match(table, /^next:\n {2}qa-grid .*\(b0 b1 b2\)\n {2}node assemble\.mjs /m);

  const json = JSON.parse(run('--json'));
  assert.deepEqual(json.todo, { vo: [], transcribe: [], film: [], qa: ['b0', 'b1', 'b2'], assemble: true });
  assert.equal(json.timeline, undefined);

  // Flag b1 for QA and a reshoot; --qa refuses while it needs filming, then clears only the qa flag once it doesn't.
  const p = loadProject(dir);
  p.data.beats[1].needs = [{ kind: 'qa', note: 'look again' }, { kind: 'reshoot' }];
  p.save();
  const refused = spawnSync('node', [STATUS, dir, '--qa', 'b1'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"b1" needs film before QA/);

  p.reload();
  p.data.beats[1].needs = [{ kind: 'qa', note: 'look again' }];
  p.save();
  assert.match(run('--qa', 'b1', '--note', 'checked the toolbar'), /recorded QA for "b1"/);
  p.reload();
  assert.equal(p.find('b1').needs, undefined);
  assert.equal(p.build.beats.b1.qa.note, 'checked the toolbar');
  assert.match(p.build.beats.b1.qa.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(run('--json')).todo.qa, ['b0', 'b2']);

  // Moving the cut into b1 within its handle puts b0 and b1 back on the QA list.
  run('--qa', 'b0');
  run('--qa', 'b2');
  p.reload();
  p.data.beats[1].cut = -0.6;
  p.save();
  const todo = JSON.parse(run('--json')).todo;
  assert.deepEqual(todo, { vo: [], transcribe: [], film: [], qa: ['b0', 'b1'], assemble: true });

  const bad = spawnSync('node', [STATUS, dir, '--qa', 'nope'], { encoding: 'utf8' });
  assert.match(bad.stderr, /no beat "nope"/);
});
