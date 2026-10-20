import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clicksToVideo, nativeScene, nativeTiming } from '../skills/generate-screencast/assets/native-helpers.mjs';
import { loadProject, useVariant, voKey } from '../skills/generate-screencast/assets/project.mjs';
import { gather, plan } from '../skills/generate-screencast/assets/status.mjs';
import { makeVideo, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

const ASSETS = fileURLToPath(new URL('../skills/generate-screencast/assets/', import.meta.url));

test('nativeTiming: the file ends at the stop; footage reaches back its length, no further than the handle', () => {
  // Clock started at 10s wall; stopped 4.5s later: scene time 4.5 is the file's last frame.
  assert.deepEqual(nativeTiming({ t0: 10_000, stoppedAt: 14_500, duration: 7.2, handle: 1500 }), {
    end: 4.5,
    footage: [-1.5, 4.5],
  });
  // A capture that came up late (only 5s of file): footage starts 0.5s into the scene.
  assert.deepEqual(nativeTiming({ t0: 10_000, stoppedAt: 15_500, duration: 5, handle: 1500 }), {
    end: 5.5,
    footage: [0.5, 5.5],
  });
});

test('clicksToVideo times clicks from the end of the file, as the scene mapping does', () => {
  const [c] = clicksToVideo([{ at: 12_000, x: 100, y: 50 }], {
    stoppedAt: 14_500,
    videoDuration: 7.2,
    region: { x: 0, y: 0, w: 960, h: 540 },
    scale: 2,
    srcW: 1920,
    srcH: 1080,
  });
  assert.deepEqual(c, { t: 4.7, x: 200, y: 100 });
});

// A TTS project with one terminal beat whose fake VO runs `secs`.
function project(t, secs = 0.5) {
  const dir = tempDir(t);
  const data = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    size: [640, 360],
    voice: { tts: 'en-US-AndrewNeural' },
    beats: [{ id: 'app', title: 'App', surface: 'macos', text: 'Click it.', needs: [{ kind: 'reshoot' }] }],
  };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  fs.mkdirSync(path.join(dir, 'vo'), { recursive: true });
  fs.writeFileSync(p.voFile('app'), '');
  fs.writeFileSync(p.subsFile('app'), `1\n00:00:00,000 --> 00:00:00,500\nClick it.\n`);
  p.recordBuild('app', {
    vo: { file: p.voFile('app'), key: voKey(data, data.beats[0]), duration: secs, subs: p.subsFile('app') },
  });
  return { dir, p };
}

// A recorder like startScreenCapture: the file spans start() to stop(), and it writes nothing until then.
function fakeCapture(file, { lateMs = 0 } = {}) {
  const startedAt = Date.now() + lateMs;
  return {
    kind: 'screen',
    region: { x: 0, y: 0, w: 320, h: 180 },
    scale: 2,
    started: Promise.resolve(),
    stops: 0,
    async stop(out) {
      this.stops++;
      const stoppedAt = Date.now();
      makeVideo(out, (stoppedAt - startedAt) / 1000);
      return stoppedAt;
    },
  };
}

test('nativeScene films through p.film: handles, end at the stop, a capture log, then only qa and assemble', needsFfmpeg, async (t) => {
  const { dir, p } = project(t);
  const b = p.beat('app');
  assert.equal(b.sceneMs, 2000); // 0.5 lead + 0.5 VO + 1.0 last tail
  let cap;
  await p.film(
    {
      app: nativeScene(p, async (b) => {
        cap = fakeCapture(b.file);
        const clock = await b.ready(cap, { clicks: [{ at: Date.now() + 2000, x: 10, y: 20 }] });
        await clock.until(b.at('it'));
      }),
    },
    { only: [], log: () => {} },
  );
  assert.equal(cap.stops, 1);
  const scene = p.build.beats.app.scene;
  assert.equal(scene.file, p.sceneFile('app', 'mp4'));
  assert.ok(Math.abs(scene.end - 3.5) < 0.15, `end ${scene.end} ≈ sceneMs + handle`);
  assert.equal(scene.footage[0], -1.5);
  assert.equal(scene.footage[1], scene.end);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'scenes/app.capture.json'), 'utf8'));
  assert.equal(log.kind, 'screen');
  assert.equal(log.clicks.length, 1);
  assert.ok(Math.abs(log.duration - scene.duration) < 0.01);
  assert.equal(p.data.beats[0].needs, undefined, 'reshoot cleared');
  const s = plan(p.data, p.build, await gather(p));
  assert.deepEqual(s.beats[0].steps.map((x) => x.step), ['qa']);
  assert.equal(s.todo.assemble, true);
});

test('nativeScene: a late capture shortens the footage; a failing scene still stops its capture', needsFfmpeg, async (t) => {
  const { p } = project(t);
  const scene = nativeScene(p, async (b) => {
    await b.ready(fakeCapture(b.file, { lateMs: 1000 }));
  });
  const { end, footage } = await scene(p.beat('app'));
  // ready() holds handle + 250ms before scene time 0, so the file would have started at −1.75; it started 1s later.
  assert.ok(Math.abs(footage[0] - -0.75) < 0.15, `footage starts ${footage[0]}, a second after −1.75`);
  assert.equal(footage[1], end);

  let cap;
  const broken = nativeScene(p, async (b) => {
    cap = fakeCapture(b.file);
    await b.ready(cap);
    throw new Error('the button moved');
  });
  await assert.rejects(broken(p.beat('app')), /the button moved/);
  assert.equal(cap.stops, 1);
  await assert.rejects(nativeScene(p, async () => {})(p.beat('app')), /never called b\.ready\(capture\)/);
});

test('device-frame.mjs and ripples.mjs keep a scene\'s length, so project.mjs use accepts them', needsFfmpeg, (t) => {
  const { dir, p } = project(t);
  const raw = makeVideo(p.sceneFile('app', 'mp4'), 4.2, { size: [180, 390] });
  p.recordBuild('app', { scene: { file: raw, raw, voKey: 'k', lead: 0.5, duration: 4.2, end: 3.5, footage: [-0.7, 3.5] } });
  const node = (script, ...args) => execFileSync('node', [path.join(ASSETS, script), ...args], { encoding: 'utf8' });

  const framed = path.join(dir, 'scenes/app.framed.mp4');
  node('device-frame.mjs', raw, framed, '--height', '820', '--top', '30');
  assert.ok(Math.abs(probeDuration(framed) - 4.2) < 0.05, `framed runs ${probeDuration(framed)}s`);
  const clicks = path.join(dir, 'scenes/app.ripples.json');
  fs.writeFileSync(clicks, JSON.stringify([{ t: 1, x: 960, y: 540 }, { t: 4.1, x: 900, y: 500 }]));
  const rippled = path.join(dir, 'scenes/app.r.mp4');
  node('ripples.mjs', framed, clicks, rippled);
  assert.ok(Math.abs(probeDuration(rippled) - 4.2) < 0.05, `rippled runs ${probeDuration(rippled)}s`);

  const out = spawnSync('node', [path.join(ASSETS, 'project.mjs'), 'use', dir, 'app', rippled], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /app: scene is now scenes\/app\.r\.mp4 \(raw scenes\/app\.mp4\)/);
  p.reload();
  assert.equal(p.build.beats.app.scene.file, rippled);
  assert.equal(p.build.beats.app.scene.raw, raw);
  // A variant that isn't the same length is refused.
  const short = makeVideo(path.join(dir, 'scenes/short.mp4'), 3);
  assert.throws(() => useVariant(p, 'app', short), /must match/);
});
