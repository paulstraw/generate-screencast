#!/usr/bin/env node
/*
 * Composites a portrait phone recording into a 1920x1080 stage — the same
 * dark radial backdrop as terminal.html — with rounded screen corners and a
 * soft shadow, so mobile scenes cut cleanly with browser and terminal scenes.
 *
 *   node device-frame.mjs in.mp4 out.mp4 [--height 960] [--radius 54] [--top <px>]
 *
 * The phone is centered unless --top sets its distance from the top edge. With
 * burned-in captions, use --height 820 --top 30: it leaves a caption band
 * below the phone, clear of its frame and home bar.
 *
 * For an all-mobile video in portrait, skip this and scale to 1080x1920.
 * Backdrop, shadow and corner mask are rendered once as stills; geq per video
 * frame would be far too slow.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [input, output] = positional;
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
if (!output) {
  console.error('usage: node device-frame.mjs in.mp4 out.mp4 [--height 960] [--radius 54] [--top <px>]');
  process.exit(1);
}
const H = opt('height', 960);
const R = opt('radius', 54);
const TOP = opt('top', (1080 - H) / 2);
const PAD = 40;

const [srcW, srcH] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height', '-of', 'csv=p=0', input], { encoding: 'utf8' }).trim().split(',').map(Number);
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
  { encoding: 'utf8' }).trim();
const W = Math.round((srcW * H) / srcH / 2) * 2;

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const still = (size, fmt, geq, out) =>
  ff('-f', 'lavfi', '-i', `color=c=black:s=${size}`, '-vf', `format=${fmt},geq=${geq}`, '-frames:v', '1', out);

/* Distance outside a w×h rounded rect of radius r, offset by o. */
const outside = (w, h, r, o) =>
  `hypot(max(${o + r}-X,max(X-(${o + w - 1 - r}),0)),max(${o + r}-Y,max(Y-(${o + h - 1 - r}),0)))`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devframe-'));
try {
  const bg = path.join(dir, 'bg.png');
  const shadow = path.join(dir, 'shadow.png');
  const mask = path.join(dir, 'mask.png');
  const d = 'hypot(X-960,Y-454)/1100';
  still('1920x1080', 'rgb24', `r='clip(23-12*${d},11,23)':g='clip(26-13*${d},13,26)':b='clip(35-17*${d},18,35)'`, bg);
  still(`${W + 2 * PAD}x${H + 2 * PAD}`, 'rgba',
    `r=0:g=0:b=0:a='140*clip(1-(${outside(W, H, R, PAD)}-${R})/${PAD},0,1)'`, shadow);
  still(`${W}x${H}`, 'gray', `lum='255*clip(${R}+0.5-${outside(W, H, R, 0)},0,1)'`, mask);

  const filter = [
    `[0:v]fps=30,scale=${W}:${H}:flags=lanczos,format=rgba[v0]`,
    `[v0][3:v]alphamerge[dev]`,
    `[1:v][2:v]overlay=(W-w)/2:${TOP - PAD + 14}[b2]`,
    `[b2][dev]overlay=(W-w)/2:${TOP}:shortest=1,format=yuv420p[v]`,
  ].join(';');
  const loop = (f) => ['-loop', '1', '-framerate', '30', '-t', dur, '-i', f];
  ff('-i', input, ...loop(bg), ...loop(shadow), ...loop(mask),
    '-filter_complex', filter, '-map', '[v]', '-map', '0:a?', '-r', '30',
    '-c:v', 'libx264', '-crf', '19', '-c:a', 'copy', output);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`framed → ${output}`);
