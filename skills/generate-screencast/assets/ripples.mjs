#!/usr/bin/env node
/*
 * Burns click ripples into a native recording — the same blue ring the
 * browser helpers draw in-page.
 *
 *   node ripples.mjs in.mp4 clicks.json out.mp4
 *
 * clicks.json: [{ t, x, y }] in video seconds / video pixels (native-helpers'
 * clicksToVideo produces exactly this). The ring is drawn by ffmpeg alone:
 * a short transparent clip generated with geq, overlaid once per click.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [input, clicksFile, output] = process.argv.slice(2);
if (!output) {
  console.error('usage: node ripples.mjs in.mp4 clicks.json out.mp4');
  process.exit(1);
}
const clicks = JSON.parse(fs.readFileSync(clicksFile, 'utf8')).filter((c) => c.t >= 0);
if (!clicks.length) {
  fs.copyFileSync(input, output);
  process.exit(0);
}

const S = 80;
const D = 0.48;
const ring = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-')), 'ring.mov');
// k = eased progress; radius 6→23px, stroke 2.5px scaled, alpha .85 fading out.
const k = `(1-pow(1-T/${D},2))`;
const r = `(18*(0.35+0.95*${k}))`;
const w = `(1.25*(0.35+0.95*${k}))`;
const alpha = `255*0.85*(1-T/${D})*clip(1-abs(hypot(X-${S / 2},Y-${S / 2})-${r})/${w},0,1)`;
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', `color=c=black@0:s=${S}x${S}:r=30:d=${D}`,
  '-vf', `format=rgba,geq=r=56:g=132:b=255:a='${alpha}'`,
  '-c:v', 'qtrle', ring,
]);

const inputs = ['-i', input];
const chain = [];
let prev = '0:v';
clicks.forEach((c, i) => {
  inputs.push('-i', ring);
  chain.push(`[${i + 1}:v]setpts=PTS+${c.t}/TB[r${i}]`);
  const out = i === clicks.length - 1 ? 'vout' : `v${i}`;
  chain.push(`[${prev}][r${i}]overlay=${c.x - S / 2}:${c.y - S / 2}:eof_action=pass[${out}]`);
  prev = out;
});
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y', ...inputs,
  '-filter_complex', chain.join(';'), '-map', '[vout]', '-map', '0:a?',
  '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', output,
]);
console.log(`${clicks.length} ripple(s) → ${output}`);
