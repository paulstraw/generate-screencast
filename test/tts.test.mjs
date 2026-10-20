import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../skills/generate-screencast/assets/project.mjs';
import { synthesize, ttsArgs } from '../skills/generate-screencast/assets/tts.mjs';
import { voKey } from '../skills/generate-screencast/assets/timeline.mjs';
import { makeTone, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

const TTS = fileURLToPath(new URL('../skills/generate-screencast/assets/tts.mjs', import.meta.url));

function project(t, { beats, voice = { tts: 'en-US-AndrewNeural' } } = {}) {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice,
    beats: beats ?? [
      { id: 'one', title: 'One', surface: 'web', text: 'Hit Save. It syncs.' },
      { id: 'two', title: 'Two', surface: 'web', text: 'Done.', needs: [{ kind: 'revo' }, { kind: 'qa' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  return dir;
}

const srt = (sentences, secs) =>
  sentences
    .map((s, i) => {
      const ts = (x) => `00:00:0${x.toFixed(3).replace('.', ',')}`;
      const step = secs / sentences.length;
      return `${i + 1}\n${ts(i * step)} --> ${ts((i + 1) * step)}\n${s}\n`;
    })
    .join('\n');

// A stand-in for `uvx edge-tts …`: writes a tone and an .srt with one cue per sentence of the input (or `cues`).
function stub({ secs = 1.2, cues, fail = 0 } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (calls.length <= fail) return { status: 1, stderr: 'No audio was received.\n' };
    const get = (flag) => args[args.indexOf(flag) + 1];
    makeTone(get('--write-media'), secs);
    fs.writeFileSync(get('--write-subtitles'), srt(cues ?? get('--text').split(/(?<=\.) /), secs));
    return { status: 0, stderr: '' };
  };
  return { run, calls };
}

test('the edge-tts call speaks `say` when set, else `text`', () => {
  assert.deepEqual(ttsArgs('v', { text: 'pnpm.', say: 'P N P M.' }, 'a.mp3', 'a.srt'), [
    'edge-tts',
    '--voice',
    'v',
    '--text',
    'P N P M.',
    '--write-media',
    'a.mp3',
    '--write-subtitles',
    'a.srt',
  ]);
  assert.equal(ttsArgs('v', { text: 'pnpm.' }, 'a.mp3', 'a.srt')[4], 'pnpm.');
});

test('records the vo entry with its key and duration, and clears revo only', needsFfmpeg, (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  const { run } = stub({ secs: 1.2 });
  const vo = synthesize(p, 'two', { run });

  assert.equal(vo.file, path.join(dir, 'vo/two.mp3'));
  assert.ok(Math.abs(vo.duration - probeDuration(vo.file)) < 0.001);
  assert.ok(Math.abs(vo.duration - 1.2) < 0.1);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  assert.deepEqual(disk.beats.two.vo, {
    file: 'vo/two.mp3',
    key: voKey(p.data, p.find('two')),
    duration: vo.duration,
    subs: 'vo/two.srt',
  });
  assert.deepEqual(loadProject(dir).find('two').needs, [{ kind: 'qa' }]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vo')).sort(), ['two.mp3', 'two.srt']);
});

test('a sentence-count mismatch fails the beat and keeps its previous VO', needsFfmpeg, (t) => {
  const dir = project(t);
  const p = loadProject(dir);
  synthesize(p, 'one', { run: stub({ secs: 1 }).run });
  const before = fs.readFileSync(path.join(dir, 'build.json'), 'utf8');
  const old = fs.readFileSync(p.voFile('one'));

  // "P.N.P.M." style input: edge-tts sees an extra sentence end.
  assert.throws(
    () => synthesize(p, 'one', { run: stub({ secs: 2, cues: ['Hit', 'Save.', 'It syncs.'] }).run }),
    /the script has 2 sentence\(s\) but .* has 3 cue\(s\)/,
  );
  assert.equal(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'), before);
  assert.deepEqual(fs.readFileSync(p.voFile('one')), old);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vo')).sort(), ['one.mp3', 'one.srt']);
});

test('retries a failing edge-tts call 3 times, then gives up', needsFfmpeg, (t) => {
  const p = loadProject(project(t));
  const ok = stub({ fail: 3 });
  synthesize(p, 'one', { run: ok.run });
  assert.equal(ok.calls.length, 4);

  const bad = stub({ fail: 99 });
  assert.throws(() => synthesize(p, 'two', { run: bad.run }), /edge-tts failed for beat "two": No audio was received/);
  assert.equal(bad.calls.length, 4);
  assert.equal(p.build.beats.two, undefined);
});

test('a timeout is reported as one', (t) => {
  const p = loadProject(project(t));
  const run = () => ({ error: Object.assign(new Error('spawnSync uvx ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.throws(() => synthesize(p, 'one', { run, retries: 0 }), /timed out after 30s/);
});

test('refuses a human-VO project', (t) => {
  const dir = project(t, {
    voice: { human: true },
    beats: [{ id: 'one', title: 'One', surface: 'web', text: 'Hi.' }],
  });
  assert.throws(() => synthesize(loadProject(dir), 'one', { run: stub().run }), /record-vo\.mjs/);
});

// The CLI with a fake `uvx` first on PATH: by default it makes only the VOs status.mjs lists.
test('CLI: makes the stale VOs, then nothing', needsFfmpeg, (t) => {
  const dir = project(t);
  const bin = tempDir(t);
  fs.writeFileSync(
    path.join(bin, 'uvx'),
    `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in --write-media) m="$2";; --write-subtitles) s="$2";; esac; shift
done
ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440 -t 1 -f mp3 "$m"
printf '1\\n00:00:00,000 --> 00:00:00,500\\nA.\\n\\n2\\n00:00:00,500 --> 00:00:01,000\\nB.\\n' > "$s"
echo call >> "${bin}/calls"
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const cli = (...args) => spawnSync(process.execPath, [TTS, dir, ...args], { encoding: 'utf8', env });

  // "two" has one sentence but the fake always writes two cues: it fails, "one" still succeeds.
  let r = cli();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^one: 1\.0\d\ds {2}vo\/one\.mp3$/m);
  assert.match(r.stderr, /two: beat "two": the script has 1 sentence/);
  assert.match(r.stderr, /1 beat\(s\) failed: two/);

  fs.writeFileSync(path.join(bin, 'calls'), '');
  r = cli('one');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(bin, 'calls'), 'utf8'), 'call\n');

  const data = JSON.parse(fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8'));
  data.beats[1].text = 'Done. Really.';
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data));
  r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^two: /m);
  assert.doesNotMatch(r.stdout, /^one: /m);
  assert.equal(cli().stdout.trim(), 'every VO is up to date');
});
