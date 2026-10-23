import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ConflictError,
  loadProject,
  sha256,
  voKey,
  writeAtomic,
} from '../skills/generate-screencast/assets/project.mjs';
import { tempDir } from './helpers.mjs';

const fixture = () => ({
  version: 1,
  slug: 'drafts',
  title: 'Drafts',
  voice: { tts: 'en-US-AndrewNeural' },
  beats: [
    { id: 'intro', title: 'Intro', surface: 'web', text: 'Here are drafts.' },
    { id: 'gone', title: 'Gone', surface: 'web', text: 'Skipped.', skip: true },
    {
      id: 'save',
      title: 'Save',
      surface: 'terminal',
      text: 'Hit Save.',
      needs: [{ kind: 'reshoot', note: 'missed' }, { kind: 'qa' }],
    },
  ],
});

const write = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function project(t, obj = fixture()) {
  const dir = tempDir(t);
  write(dir, 'screencast.json', obj);
  return dir;
}

test('loads a project without build.json as an empty build', (t) => {
  const p = loadProject(project(t));
  assert.deepEqual(p.build, { version: 1, beats: {} });
  assert.deepEqual(
    p.beats.map((b) => b.id),
    ['intro', 'save'],
  );
  assert.equal(p.find('gone').skip, true);
  assert.throws(() => p.find('nope'), /no beat "nope"/);
});

test('refuses an invalid screencast.json, naming the path', (t) => {
  const obj = fixture();
  obj.beats[0].cam = 'bubble';
  assert.throws(() => loadProject(project(t, obj)), /beats\[0\]\.cam: must be pip \| full \| off/);
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'screencast.json'), '{ nope');
  assert.throws(() => loadProject(dir), /screencast\.json: /);
  assert.throws(() => loadProject(tempDir(t)), /not found/);
});

test('refuses a malformed build.json', (t) => {
  const dir = project(t);
  write(dir, 'build.json', { version: 2, beats: {} });
  assert.throws(() => loadProject(dir), /build\.json: expected/);
});

test('save round-trips and refuses to save something invalid', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  p.data.beats[0].text = 'Here are your drafts.';
  p.save();
  assert.equal(readJson(dir, 'screencast.json').beats[0].text, 'Here are your drafts.');
  assert.deepEqual(loadProject(dir).data, p.data);
  // A second save from the same handle is fine: the hash moved with the first.
  p.data.title = 'Drafts!';
  p.save();
  assert.equal(readJson(dir, 'screencast.json').title, 'Drafts!');

  p.data.beats[0].surface = 'desktop';
  assert.throws(() => p.save(), /invalid[\s\S]*beats\[0\]\.surface/);
  assert.equal(readJson(dir, 'screencast.json').beats[0].surface, 'web');
});

test('save refuses when the file changed on disk since it was read', (t) => {
  const dir = project(t);
  const a = loadProject(dir);
  const b = loadProject(dir);
  a.data.title = 'From the editor';
  a.save();
  b.data.title = 'From the agent';
  assert.throws(
    () => b.save(),
    (err) => err instanceof ConflictError && err.code === 'ECONFLICT',
  );
  assert.equal(readJson(dir, 'screencast.json').title, 'From the editor');
  b.reload();
  assert.equal(b.data.title, 'From the editor');
  b.data.title = 'From the agent';
  b.save();
  assert.equal(readJson(dir, 'screencast.json').title, 'From the agent');

  fs.rmSync(path.join(dir, 'screencast.json'));
  assert.throws(() => b.save(), ConflictError);
});

test('voKey: TTS hashes voice + say ?? text; human hashes text', () => {
  const tts = fixture();
  const beat = { ...tts.beats[0] };
  const base = voKey(tts, beat);
  assert.equal(base, sha256(JSON.stringify(['tts', 'en-US-AndrewNeural', 'Here are drafts.'])));
  assert.notEqual(voKey(tts, { ...beat, text: 'Changed.' }), base);
  assert.notEqual(voKey({ ...tts, voice: { tts: 'en-GB-RyanNeural' } }, beat), base);
  // With `say`, text is captions only.
  const said = { ...beat, say: 'Here are drafts.' };
  assert.equal(voKey(tts, said), base);
  assert.equal(voKey(tts, { ...said, text: 'Here are Drafts™.' }), base);

  const human = { ...tts, voice: { human: true } };
  assert.equal(voKey(human, beat), sha256(JSON.stringify(['human', 'Here are drafts.'])));
  assert.notEqual(voKey(human, beat), base);
});

test('path helpers are absolute in memory', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  assert.equal(p.voFile('save'), path.join(dir, 'vo/save.mp3'));
  assert.equal(p.subsFile('save'), path.join(dir, 'vo/save.srt'));
  assert.equal(p.rawVoFile('save'), path.join(dir, 'vo/raw/save.wav'));
  assert.equal(p.txtFile('save'), path.join(dir, 'vo/txt/save.json'));
  assert.equal(p.camFile('save'), path.join(dir, 'cam/raw/save.mov'));
  assert.equal(p.sceneFile('save'), path.join(dir, 'scenes/save.webm'));
  assert.equal(p.sceneFile('save', '.mov'), path.join(dir, 'scenes/save.mov'));
  assert.equal(p.out(), path.join(dir, 'drafts.mp4'));
  assert.equal(p.srtOut(), path.join(dir, 'drafts.srt'));
  assert.equal(p.scriptOut(), path.join(dir, 'drafts.script.md'));

  p.data.voice = { human: true };
  assert.equal(p.voFile('save'), path.join(dir, 'vo/save.wav'));
  p.data.out = 'out/final.mp4';
  assert.equal(p.srtOut(), path.join(dir, 'out/final.srt'));
  p.data.out = '/tmp/elsewhere/final.mp4';
  assert.equal(p.out(), '/tmp/elsewhere/final.mp4');
  assert.equal(p.scriptOut(), '/tmp/elsewhere/final.script.md');
});

test('recordBuild stores relative paths, returns absolute ones, and survives a reload', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  const key = voKey(p.data, p.find('save'));
  p.recordBuild('save', { vo: { file: p.voFile('save'), key, duration: 3.412, subs: p.subsFile('save') } });
  p.recordBuild('save', {
    scene: { file: p.sceneFile('save'), raw: 'scenes/save.webm', voKey: key, lead: 0.5, footage: [-1.5, 5.9] },
  });

  const disk = readJson(dir, 'build.json');
  assert.deepEqual(disk.beats.save.vo, { file: 'vo/save.mp3', key, duration: 3.412, subs: 'vo/save.srt' });
  assert.equal(disk.beats.save.scene.file, 'scenes/save.webm');
  assert.equal(p.build.beats.save.vo.file, path.join(dir, 'vo/save.mp3'));
  assert.equal(p.build.beats.save.scene.raw, path.join(dir, 'scenes/save.webm'));
  assert.deepEqual(loadProject(dir).build, p.build);

  // An entry replaces the step whole; null removes it.
  p.recordBuild('save', { vo: { file: 'vo/save.mp3', key: 'k2', duration: 2 }, scene: null });
  assert.deepEqual(readJson(dir, 'build.json').beats.save, { vo: { file: 'vo/save.mp3', key: 'k2', duration: 2 } });

  p.recordAssembly({ key: 'a', out: p.out(), at: '2026-10-19T00:00:00Z' });
  assert.equal(readJson(dir, 'build.json').assembly.out, path.join(dir, 'drafts.mp4'));
});

test('recordBuild merges with what another script wrote since this one loaded', (t) => {
  const dir = project(t);
  const a = loadProject(dir);
  const b = loadProject(dir);
  a.recordBuild('intro', { vo: { file: 'vo/intro.mp3', key: 'k', duration: 1 } });
  b.recordBuild('save', { vo: { file: 'vo/save.mp3', key: 'k', duration: 2 } });
  assert.deepEqual(Object.keys(readJson(dir, 'build.json').beats).sort(), ['intro', 'save']);
  assert.deepEqual(Object.keys(b.build.beats).sort(), ['intro', 'save']);
});

test('a crashed build.json write leaves the old file whole and no temp file behind', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  p.recordBuild('intro', { vo: { file: 'vo/intro.mp3', key: 'k', duration: 1 } });
  const before = fs.readFileSync(path.join(dir, 'build.json'), 'utf8');

  // Dies half way through writing the temp file…
  const real = fs.writeFileSync;
  const write = t.mock.method(fs, 'writeFileSync', (file, text) => {
    real(file, text.slice(0, 10));
    throw new Error('disk full');
  });
  assert.throws(() => p.recordBuild('save', { vo: { file: 'vo/save.mp3', key: 'k', duration: 2 } }), /disk full/);
  write.mock.restore();
  // …or just before the rename.
  const rename = t.mock.method(fs, 'renameSync', () => {
    throw new Error('killed');
  });
  assert.throws(() => p.recordBuild('save', { vo: { file: 'vo/save.mp3', key: 'k', duration: 2 } }), /killed/);
  rename.mock.restore();

  assert.equal(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['build.json', 'screencast.json']);
  assert.deepEqual(Object.keys(loadProject(dir).build.beats), ['intro']);
});

test('a crashed save leaves screencast.json whole', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  const before = fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('killed');
  });
  p.data.title = 'New';
  assert.throws(() => p.save(), /killed/);
  assert.equal(fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['screencast.json']);
});

test('writeAtomic replaces a file', (t) => {
  const file = path.join(tempDir(t), 'x.json');
  writeAtomic(file, 'one');
  writeAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
});

test('clearFlags removes only the given kinds, on disk and in memory', (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  p.clearFlags('save', ['reshoot']);
  assert.deepEqual(readJson(dir, 'screencast.json').beats[2].needs, [{ kind: 'qa' }]);
  assert.deepEqual(p.find('save').needs, [{ kind: 'qa' }]);
  p.clearFlags('save', ['qa']);
  assert.equal('needs' in readJson(dir, 'screencast.json').beats[2], false);
  assert.equal('needs' in p.find('save'), false);
  // Nothing to clear: no write, and saving afterwards still works.
  const mtime = fs.statSync(path.join(dir, 'screencast.json')).mtimeMs;
  p.clearFlags('intro', ['qa']);
  assert.equal(fs.statSync(path.join(dir, 'screencast.json')).mtimeMs, mtime);
  p.data.title = 'After';
  p.save();
});

test('clearFlags keeps an edit made since load, and a later save still reports that conflict', (t) => {
  const dir = project(t);
  const pipeline = loadProject(dir);
  const editor = loadProject(dir);
  editor.data.beats[0].text = 'Edited in the editor.';
  editor.save();

  pipeline.clearFlags('save', ['reshoot']);
  const disk = readJson(dir, 'screencast.json');
  assert.equal(disk.beats[0].text, 'Edited in the editor.');
  assert.deepEqual(disk.beats[2].needs, [{ kind: 'qa' }]);
  assert.deepEqual(pipeline.find('save').needs, [{ kind: 'qa' }]);
  pipeline.data.title = 'Stale';
  assert.throws(() => pipeline.save(), ConflictError);
});
