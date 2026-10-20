/*
 * Shared test helpers: temp dirs and generated fixture media.
 *
 *   import { tempDir, hasFfmpeg, needsFfmpeg, makeVideo, makeTone, probeDuration } from './helpers.mjs';
 *
 *   test('renders', needsFfmpeg, async (t) => {
 *     const dir = tempDir(t);
 *     const video = makeVideo(path.join(dir, 'scene.webm'), 3);
 *   });
 *
 * Fixture media is generated with ffmpeg's lavfi sources rather than committed as binaries, so the repo stays small and
 * every test states the exact durations it depends on. Tests that need ffmpeg pass `needsFfmpeg` as their options, which
 * skips them with a clear message when it isn't installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const has = (cmd) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;

export const hasFfmpeg = has('ffmpeg') && has('ffprobe');

// node:test options: `test('name', needsFfmpeg, fn)`.
export const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe not installed' };

// A fresh temp dir, removed when the test (or suite) `t` finishes. Without `t`, the caller cleans up.
export function tempDir(t, prefix = 'screencast-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// A 30 fps test video of `seconds`: `testsrc2` (moving pattern, useful for spotting trims) or a solid `color`.
// The container follows the extension (.webm → VP8, .mp4/.mov → H.264).
export function makeVideo(file, seconds, { size = [320, 180], color, fps = 30 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const [w, h] = size;
  const src = color ? `color=c=${color}:s=${w}x${h}:r=${fps}` : `testsrc2=s=${w}x${h}:r=${fps}`;
  const codec = /\.webm$/i.test(file)
    ? ['-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  ffmpeg(['-f', 'lavfi', '-i', src, '-t', String(seconds), ...codec, file]);
  return file;
}

// A sine tone of `seconds`. The extension picks the format (.mp3, .wav, …).
export function makeTone(file, seconds, { freq = 440, rate = 48000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=${rate}`, '-t', String(seconds), file]);
  return file;
}

export function probeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(String(out).trim());
}
