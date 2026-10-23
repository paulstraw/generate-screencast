import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTone, makeVideo, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

test('tempDir is created and removed after the test', async (t) => {
  let dir;
  await t.test('inner', (t2) => {
    dir = tempDir(t2);
    assert.ok(fs.statSync(dir).isDirectory());
  });
  assert.equal(fs.existsSync(dir), false);
});

test('makeVideo generates a 30 fps clip of the requested length', needsFfmpeg, (t) => {
  const dir = tempDir(t);
  for (const name of ['scene.webm', 'cam.mp4']) {
    const file = makeVideo(path.join(dir, name), 2);
    assert.ok(Math.abs(probeDuration(file) - 2) < 0.05, name);
  }
  const solid = makeVideo(path.join(dir, 'solid.mp4'), 1, { color: 'navy' });
  assert.ok(Math.abs(probeDuration(solid) - 1) < 0.05);
});

test('makeTone generates mp3 and wav of the requested length', needsFfmpeg, (t) => {
  const dir = tempDir(t);
  for (const name of ['vo.mp3', 'vo.wav']) {
    const file = makeTone(path.join(dir, name), 1.5);
    // mp3 encoders pad by a frame or so.
    assert.ok(Math.abs(probeDuration(file) - 1.5) < 0.06, name);
  }
});
