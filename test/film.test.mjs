import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PLAYWRIGHT_HOME,
  importPlaywright,
  loadProject,
  useVariant,
  voKey,
} from '../skills/generate-screencast/assets/project.mjs';
import { gather, plan } from '../skills/generate-screencast/assets/status.mjs';
import { makeTone, makeVideo, needsFfmpeg, tempDir } from './helpers.mjs';

const PROJECT = fileURLToPath(new URL('../skills/generate-screencast/assets/project.mjs', import.meta.url));

const srt = (cues) =>
  cues
    .map(([a, b, text], i) => {
      const ts = (x) => `00:00:${x.toFixed(3).padStart(6, '0').replace('.', ',')}`;
      return `${i + 1}\n${ts(a)} --> ${ts(b)}\n${text}\n`;
    })
    .join('\n');

// A TTS project with fake VOs: build.json says each beat's VO runs `secs`, and its .srt has the given cues.
function project(t, { beats, size = [640, 360], vo = {} } = {}) {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    size,
    voice: { tts: 'en-US-AndrewNeural' },
    beats: beats ?? [
      {
        id: 'one',
        title: 'One',
        surface: 'web',
        text: 'Hit Save now. It syncs everywhere.',
        needs: [{ kind: 'reshoot' }],
      },
      { id: 'two', title: 'Two', surface: 'web', text: 'Done.', lead: 0.8, cut: -0.6, needs: [{ kind: 'qa' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  for (const b of data.beats) {
    const { secs = 2, cues = [[0, secs, b.text]], audio = false } = vo[b.id] ?? {};
    fs.mkdirSync(path.join(dir, 'vo'), { recursive: true });
    if (audio) makeTone(p.voFile(b.id), secs);
    else fs.writeFileSync(p.voFile(b.id), '');
    fs.writeFileSync(p.subsFile(b.id), srt(cues));
    p.recordBuild(b.id, { vo: { file: p.voFile(b.id), key: voKey(data, b), duration: secs, subs: p.subsFile(b.id) } });
  }
  return { dir, p };
}

const ONE = {
  secs: 2,
  cues: [
    [0, 1.2, 'Hit Save now.'],
    [1.2, 2, 'It syncs everywhere.'],
  ],
};

test('p.beat: scene length, VO start and handle in ms; cuts change nothing', (t) => {
  const { p } = project(t, { vo: { one: ONE, two: { secs: 1.25 } } });
  const one = p.beat('one');
  assert.deepEqual([one.id, one.sceneMs, one.voAt, one.handle], ['one', 3000, 500, 1500]);
  // The last beat's tail is 1.0s; its own lead is 0.8s and its cut doesn't touch the scene.
  const two = p.beat('two');
  assert.deepEqual([two.sceneMs, two.voAt], [3050, 800]);
});

test('p.beat(id).at: words timed by word count inside each .srt sentence; sentences by number', (t) => {
  const { p } = project(t, { vo: { one: ONE } });
  const b = p.beat('one');
  assert.equal(b.at('Hit'), 500);
  assert.equal(b.at('Save'), 900); // 1.2s sentence of 3 words: the 2nd starts 0.4s in
  assert.equal(b.at('save'), 900);
  assert.equal(b.at('syncs'), 500 + 1200 + 267); // 0.8s sentence of 3 words
  assert.equal(b.at('syncs everywhere'), 1967);
  assert.equal(b.at(1), 500);
  assert.equal(b.at(2), 1700);
  assert.throws(
    () => b.at('Publish'),
    /beat "one" never says "Publish"; it says: Hit Save now\. It syncs everywhere\./,
  );
  assert.throws(() => b.at(3), /has no sentence 3 \(it has 2\)/);
});

test('p.beat refuses skipped beats and beats without a VO', (t) => {
  const { dir, p } = project(t);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'screencast.json'), 'utf8'));
  data.beats[1].skip = true;
  data.beats.push({ id: 'three', title: 'Three', surface: 'web', text: 'New.' });
  p.data = data;
  assert.throws(() => p.beat('two'), /"two" is skipped/);
  assert.throws(() => p.beat('three'), /"three" has no VO yet/);
  data.beats.pop();
  // With "two" skipped, "one" is the last beat and gets the long tail.
  assert.equal(p.beat('one').sceneMs, 3500);
});

test('p.beat(id).at on a human VO reads whisper words, respelled', (t) => {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { human: true },
    spellings: { 'lock file': 'lockfile' },
    beats: [{ id: 'one', title: 'One', surface: 'terminal', text: 'Delete the lockfile. Then install.' }],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data));
  const p = loadProject(dir);
  const words = [
    [' Delete', 0.0],
    [' the', 0.3],
    [' lock', 0.42],
    [' file.', 0.6],
    [' Then', 1.4],
    [' install.', 1.6],
  ].map(([word, start]) => ({ word, start, end: start + 0.2 }));
  fs.mkdirSync(path.join(dir, 'vo/txt'), { recursive: true });
  fs.writeFileSync(p.txtFile('one'), JSON.stringify({ segments: [{ words }] }));
  p.recordBuild('one', {
    vo: { file: p.voFile('one'), key: voKey(data, data.beats[0]), duration: 2 },
    txt: { file: p.txtFile('one'), voKey: voKey(data, data.beats[0]) },
  });
  const b = p.beat('one');
  assert.equal(b.at('lockfile'), 920);
  assert.equal(b.at('install'), 2100);
  assert.equal(b.at(2), 1900);
});

test('p.film records each scene, clears reshoot, and honours the id filter', needsFfmpeg, async (t) => {
  const { dir, p } = project(t, { vo: { one: ONE } });
  const ran = [];
  const scene = (secs, end) => async (b) => {
    ran.push(b.id);
    return { file: makeVideo(p.sceneFile(b.id, 'mp4'), secs), end };
  };
  const log = () => {};

  assert.deepEqual(await p.film({ one: scene(6.5, 4.5), two: scene(6, 4) }, { only: ['two'], log }), ['two']);
  assert.deepEqual(ran, ['two']);
  assert.equal(p.build.beats.one?.scene, undefined);

  await p.film({ one: scene(6.5, 4.5), two: scene(3, 4) }, { only: [], log });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  const { at, ...one } = disk.beats.one.scene;
  assert.deepEqual(one, {
    file: 'scenes/one.mp4',
    raw: 'scenes/one.mp4',
    voKey: disk.beats.one.vo.key,
    lead: 0.5,
    duration: 6.5,
    end: 4.5,
    footage: [-1.5, 4.5],
  });
  assert.ok(Date.now() - Date.parse(at) < 60_000);
  // A short file only covers what it holds: 3s ending at scene 4s starts at scene 1s.
  assert.deepEqual(disk.beats.two.scene.footage, [1, 4]);
  assert.equal(disk.beats.two.scene.lead, 0.8);
  assert.equal(loadProject(dir).find('one').needs, undefined);
  assert.deepEqual(loadProject(dir).find('two').needs, [{ kind: 'qa' }]);
});

test(
  'p.film: unknown ids are refused up front; a failing scene fails the run after the rest',
  needsFfmpeg,
  async (t) => {
    const { p } = project(t, { vo: { one: ONE } });
    const log = () => {};
    await assert.rejects(p.film({ one: async () => ({}) }, { only: ['two'], log }), /film\.mjs has no scene for "two"/);
    await assert.rejects(p.film({ nope: async () => ({}) }, { only: [], log }), /no beat "nope"/);

    const errors = [];
    t.mock.method(console, 'error', (m) => errors.push(m));
    const ok = async (b) => ({ file: makeVideo(p.sceneFile(b.id), 5), end: 3.5 });
    await assert.rejects(
      p.film({ one: async () => ({ file: 'scenes/missing.webm', end: 1 }), two: ok }, { only: [], log }),
      /1 scene\(s\) failed: one/,
    );
    assert.match(errors[0], /^one: .*scenes\/missing\.webm, which doesn't exist/);
    assert.ok(p.build.beats.two.scene);
    await assert.rejects(
      p.film({ one: async (b) => ({ file: makeVideo(p.sceneFile(b.id), 2), end: -1 }) }, { only: [], log }),
      /failed: one/,
    );
    assert.match(errors[1], /end -1; it must be the scene time \(s\) of the recording's last frame/);
  },
);

test('use: points a scene at a same-length variant, keeping raw', needsFfmpeg, async (t) => {
  const { dir, p } = project(t, { vo: { one: ONE } });
  await p.film(
    { one: async (b) => ({ file: makeVideo(p.sceneFile(b.id), 5), end: 3.5 }) },
    { only: ['one'], log: () => {} },
  );
  const framed = makeVideo(path.join(dir, 'scenes/one-framed.mp4'), 5.05, { color: 'black' });
  const short = makeVideo(path.join(dir, 'scenes/one-short.mp4'), 4.5);

  assert.throws(() => useVariant(p, 'one', short), /runs 4\.500s but the raw recording .* runs 5\.000s/);
  assert.throws(() => useVariant(p, 'two', framed), /"two" hasn't been filmed yet/);

  const r = spawnSync(process.execPath, [PROJECT, 'use', dir, 'one', framed], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /one: scene is now scenes\/one-framed\.mp4 \(raw scenes\/one\.webm\)/);
  const scene = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8')).beats.one.scene;
  assert.equal(scene.file, 'scenes/one-framed.mp4');
  assert.equal(scene.raw, 'scenes/one.webm');
  assert.equal(scene.end, 3.5);
});

test('importPlaywright names the shared install when it is missing', async (t) => {
  await assert.rejects(importPlaywright(tempDir(t)), (err) => {
    assert.match(
      err.message,
      /Playwright isn't installed in .*\n {2}mkdir -p ~\/\.cache\/generate-screencast && .*npx playwright install chromium/,
    );
    return true;
  });
});

// --- A real headless scene -------------------------------------------------------------------------------------------

const playwright = await importPlaywright().catch((err) => err);
const needsPlaywright = needsFfmpeg.skip
  ? needsFfmpeg
  : { skip: playwright instanceof Error ? `Playwright not installed in ${PLAYWRIGHT_HOME}` : false, timeout: 60_000 };

// The mean colour of the frame at file time `t`.
function colorAt(file, t) {
  const rgb = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(t),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  return [...rgb];
}

test('browserScene films a real page with handles, aligned to scene time', needsPlaywright, async (t) => {
  const { dir, p } = project(t, {
    beats: [
      {
        id: 'one',
        title: 'One',
        surface: 'web',
        text: 'Hit Save now. It syncs everywhere.',
        needs: [{ kind: 'reshoot' }],
      },
    ],
    vo: { one: { ...ONE, audio: true } },
  });
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());

  let mark;
  await p.film(
    {
      one: p.browserScene(browser, async (page, b) => {
        await page.setContent('<body style="margin:0;height:100vh;background:#fff"></body>');
        const clock = await b.ready();
        // The screen turns black at the word "syncs": 2.2s into the scene.
        mark = b.at('syncs');
        await clock.until(mark);
        await page.evaluate(() => (document.body.style.background = '#000'));
      }),
    },
    { only: [], log: () => {} },
  );

  const scene = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8')).beats.one.scene;
  assert.equal(scene.file, 'scenes/one.webm');
  assert.equal(scene.lead, 0.5);
  assert.equal(scene.voKey, p.build.beats.one.vo.key);
  // sceneMs is 0.5 + 2 + 1.0: the footage runs from the head handle to past the tail handle.
  assert.equal(scene.footage[0], -1.5);
  assert.ok(scene.footage[1] >= 3.5 + 1.5 && scene.footage[1] < 3.5 + 1.5 + 0.2, `footage ends ${scene.footage[1]}`);
  assert.ok(scene.end > scene.footage[1] && scene.end <= scene.duration);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'scenes')), ['one.webm']);

  // Scene time maps to file time through `end`: white just before the mark, black just after, ready screen at −1.4s.
  const file = p.path(scene.file);
  const fileTime = (s) => s + scene.duration - scene.end;
  assert.ok(colorAt(file, fileTime(-1.4)).every((c) => c > 230));
  assert.ok(colorAt(file, fileTime(mark / 1000 - 0.1)).every((c) => c > 230));
  assert.ok(colorAt(file, fileTime(mark / 1000 + 0.1)).every((c) => c < 25));
  assert.ok(colorAt(file, fileTime(scene.footage[1] - 0.05)).every((c) => c < 25));

  // Filmed, so only QA and assembly remain; the reshoot flag is gone.
  const fresh = loadProject(dir);
  assert.equal(fresh.find('one').needs, undefined);
  const s = plan(fresh.data, fresh.build, await gather(fresh));
  assert.deepEqual(
    s.beats[0].steps.map((x) => x.step),
    ['qa'],
  );
  assert.deepEqual(s.todo, { vo: [], transcribe: [], film: [], qa: ['one'], assemble: true });
});
