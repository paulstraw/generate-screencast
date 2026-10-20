import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { FPS, HANDLE, sha256, timeline } from '../skills/generate-screencast/assets/timeline.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);

// A project of beats with these VO durations, and a build where each was filmed as it now stands.
function fixture(durations, extra = []) {
  const project = {
    version: 1,
    slug: 'demo',
    title: 'Demo',
    voice: { tts: 'en-US-AndrewNeural' },
    beats: durations.map((_, i) => ({ id: `b${i}`, title: `B${i}`, surface: 'web', text: 'Hi.', ...extra[i] })),
  };
  return { project, build: film(project, durations) };
}

function film(project, durations) {
  const live = project.beats.filter((b) => !b.skip);
  const beats = {};
  project.beats.forEach((b, i) => {
    const last = live.at(-1) === b;
    const lead = b.lead ?? 0.5;
    const end = lead + durations[i] + (b.tail ?? (last ? 1 : 0.5)) + HANDLE;
    beats[b.id] = {
      vo: { file: `vo/${b.id}.mp3`, key: `k${i}`, duration: durations[i] },
      scene: { file: `scenes/${b.id}.webm`, raw: `scenes/${b.id}.webm`, voKey: `k${i}`, lead, duration: end + 1.7,
        end, footage: [-HANDLE, end] },
    };
  });
  return { version: 1, beats };
}

test('no cuts reproduces today’s lengths: 0.5 + VO + 0.5, 1.0 after the last', () => {
  const { project, build } = fixture([3, 2.5, 4]);
  const t = timeline(project, build);
  assert.deepEqual(
    t.beats.map((b) => b.block),
    [
      [0, 4],
      [4, 7.5],
      [7.5, 13],
    ],
  );
  assert.deepEqual(
    t.beats.map((b) => b.voAt),
    [0.5, 4.5, 8],
  );
  assert.deepEqual(
    t.beats.map((b) => b.picture),
    [
      [0, 4],
      [4, 7.5],
      [7.5, 13],
    ],
  );
  assert.equal(t.total, 13);
  assert.deepEqual(t.beats[0].sceneWindow, [0, 4]);
  assert.deepEqual(t.beats[2].sceneWindow, [0, 5.5]);
  assert.ok(t.beats.every((b) => b.stale.length === 0));
  assert.deepEqual(t.beats[0].frames, [0, 120]);
  assert.equal(t.beats[0].mode, 'off');
  assert.equal(t.beats[0].captionPosition, 'bottom');
  assert.equal(t.beats[0].bubble, null);
});

test('L and J cuts move only pictures', () => {
  const plain = fixture([3, 2.5, 4]);
  const { project, build } = fixture([3, 2.5, 4], [{}, { cut: -0.6 }, { cut: 0.8 }]);
  const a = timeline(plain.project, plain.build);
  const t = timeline(project, build);
  assert.deepEqual(
    t.beats.map((b) => [b.block, b.voAt]),
    a.beats.map((b) => [b.block, b.voAt]),
  );
  assert.equal(t.total, a.total);
  close(t.beats[0].picture[1], 3.4, 'L cut into b1');
  close(t.beats[1].picture[0], 3.4);
  close(t.beats[1].picture[1], 8.3, 'J cut into b2');
  close(t.beats[2].picture[0], 8.3);
  // b0's picture ends 0.6s early, b1's starts 0.6s early and runs 0.8s into its tail handle, b2's starts 0.8s late.
  close(t.beats[0].sceneWindow[1], 3.4);
  close(t.beats[1].sceneWindow[0], -0.6);
  close(t.beats[1].sceneWindow[1], 4.3);
  close(t.beats[2].sceneWindow[0], 0.8);
  assert.ok(t.beats.every((b) => b.stale.length === 0));
  assert.notEqual(t.key, a.key);
});

test('boundaries are whole frames and never drift over 50 beats with awkward durations', () => {
  const durations = Array.from({ length: 50 }, (_, i) => 1 + ((i * 0.737) % 2.9) + 0.0123 * i);
  const extra = durations.map((_, i) => (i && i % 3 === 0 ? { cut: -0.333 } : i % 5 === 0 ? { cut: 0.271 } : {}));
  const { project, build } = fixture(durations, extra);
  const t = timeline(project, build);
  let A = 0;
  t.beats.forEach((b, i) => {
    const D = durations[i];
    const B = 0.5 + D + (i === 49 ? 1 : 0.5);
    close(b.block[0], A, `block ${i}`);
    close(b.voAt, A + 0.5, `voAt ${i}`);
    const P = i === 0 ? 0 : A + (project.beats[i].cut ?? 0);
    assert.ok(Math.abs(b.picture[0] - P) <= 0.5 / FPS + 1e-9, `boundary ${i} within half a frame`);
    assert.ok(Number.isInteger(b.frames[0]) && Math.abs(b.picture[0] * FPS - b.frames[0]) < 1e-9);
    if (i) assert.equal(b.frames[0], t.beats[i - 1].frames[1], 'pictures abut');
    A += B;
  });
  assert.ok(Math.abs(t.total - A) <= 0.5 / FPS + 1e-9);
  assert.equal(t.beats.at(-1).frames[1], Math.round(t.total * FPS));
  assert.ok(t.beats.every((b) => b.stale.length === 0));
});

test('lead, tail and cuts within the handles stay fresh; beyond them go stale with a reason', () => {
  // Filmed as plain beats, then edited: b0's tail +1.4s, b1 cut −1.5 with lead +0.7, b2 cut +1.4.
  const { project, build } = fixture([3, 2.5, 4]);
  Object.assign(project.beats[0], { tail: 1.9 });
  Object.assign(project.beats[1], { cut: -1.5, lead: 1.2 });
  Object.assign(project.beats[2], { cut: 1.4 });
  const t = timeline(project, build);
  assert.equal(t.beats[0].stale.length, 0, 'a longer tail inside the handle is edit-only');
  assert.equal(t.beats[1].stale.length, 1);
  assert.equal(t.beats[1].stale[0].step, 'film');
  assert.match(t.beats[1].stale[0].reason, /cut −1\.50s and lead 0\.5s → 1\.2s reaches 0\.70s before the footage of "b1"/);
  assert.equal(t.beats[2].stale.length, 0);

  const edges = fixture([3, 2.5, 4], [{}, { cut: -1.5 }, { cut: 1.5 }]);
  assert.ok(timeline(edges.project, edges.build).beats.every((b) => b.stale.length === 0), 'exactly the handle');

  const past = fixture([3, 2.5, 4], [{}, { cut: -2.1 }, { cut: 2 }]);
  const p = timeline(past.project, past.build);
  assert.equal(p.beats[0].stale.length, 0, 'an L cut shortens the previous picture: no new footage needed');
  assert.match(p.beats[1].stale[0].reason, /^cut −2\.10s reaches 0\.60s before the footage of "b1"/);
  assert.match(p.beats[1].stale[1].reason, /^cut into "b2" \+2\.00s runs 0\.50s past the footage of "b1"/);
  assert.equal(p.beats[2].stale.length, 0);

  const tail = fixture([3, 2.5]);
  tail.project.beats[1].tail = 3;
  assert.match(timeline(tail.project, tail.build).beats[1].stale[0].reason, /^tail 3s runs 0\.50s past the footage/);
});

test('skip removes a beat; the next beat’s cut then applies to its new predecessor', () => {
  const { project, build } = fixture([3, 2.5, 4], [{}, { skip: true }, { cut: -0.5 }]);
  const t = timeline(project, build);
  assert.deepEqual(
    t.beats.map((b) => b.id),
    ['b0', 'b2'],
  );
  assert.deepEqual(t.beats[0].block, [0, 4]);
  assert.deepEqual(t.beats[1].block, [4, 9.5]);
  close(t.beats[0].picture[1], 3.5);
  close(t.beats[1].picture[0], 3.5);
  assert.equal(t.total, 9.5);

  // Skipping the first beat: the new first beat's cut is ignored.
  const first = fixture([3, 2.5], [{ skip: true }, { cut: -0.5 }]);
  const f = timeline(first.project, first.build);
  assert.deepEqual(f.beats[0].picture, [0, 4]);
});

test('unrecorded beats, camera beats, bubbles and the key', () => {
  const { project } = fixture([3, 2.5]);
  const bare = timeline(project, { version: 1, beats: {} });
  assert.deepEqual(bare.beats[0].stale, [{ step: 'vo', reason: 'no VO duration for "b0" yet' }]);
  assert.deepEqual(bare.beats[0].sceneWindow, [0, 1]);
  assert.equal(bare.total, 2.5);

  const cam = fixture([3, 2.5], [{ cam: 'full', surface: 'camera' }, { cam: 'pip', bubble: { position: 'top-right' } }]);
  cam.project.voice = { human: true };
  cam.project.camera = { delay: 0.15, bubble: { size: 0.3 } };
  const c = timeline(cam.project, cam.build);
  assert.equal(c.beats[0].sceneWindow, null);
  assert.deepEqual(c.beats[1].bubble, { position: 'top-right', size: 0.3, margin: 48 });

  const a = fixture([3, 2.5]);
  const key = timeline(a.project, a.build).key;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(timeline(structuredClone(a.project), structuredClone(a.build)).key, key, 'stable');
  a.project.beats[1].captionPosition = 'top';
  assert.notEqual(timeline(a.project, a.build).key, key, 'caption position changes the key');
  a.project.beats[1].captionPosition = undefined;
  a.build.beats.b1.vo.duration = 2.6;
  assert.notEqual(timeline(a.project, a.build).key, key, 'a new VO length changes the key');
});

test('cuts that leave a beat no picture are refused', () => {
  const { project, build } = fixture([1, 1, 1], [{}, { cut: 1.5 }, { cut: -1.5 }]);
  assert.throws(() => timeline(project, build), /cuts leave no picture for "b1"/);
});

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'é ✓ 🎬', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)])
    assert.equal(sha256(s), crypto.createHash('sha256').update(s).digest('hex'));
});
