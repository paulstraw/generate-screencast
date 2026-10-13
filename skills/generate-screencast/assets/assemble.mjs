#!/usr/bin/env node
/*
 * Trims, concatenates and voices the filmed scenes.
 *
 *   node assemble.mjs manifest.json
 *
 * manifest.json:
 *   {
 *     "out": "/Users/me/Downloads/tour-2026-10-13.mp4",
 *     "size": [1920, 1080],               // optional; [1080, 1920] for portrait
 *     "scenes": [{ "video": "scenes/s1.webm", "vo": "vo/beat1.mp3" }, …]
 *   }
 *
 * Scene length = 0.5s lead + VO + 0.5s tail (1.0s on the last). Each clip
 * keeps the LAST target-seconds of its recording, and VO offsets come from the
 * actual clip durations, so frame rounding never accumulates into drift.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('usage: node assemble.mjs manifest.json');
  process.exit(1);
}
const base = path.dirname(path.resolve(manifestPath));
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const [W, H] = m.size || [1920, 1080];
const abs = (p) => (path.isAbsolute(p) ? p : path.join(base, p));
const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const dur = (f) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));

const work = path.join(base, 'assembly');
fs.mkdirSync(work, { recursive: true });

const clips = m.scenes.map((s, i) => {
  const last = i === m.scenes.length - 1;
  const voDur = dur(abs(s.vo));
  const target = +(0.5 + voDur + (last ? 1.0 : 0.5)).toFixed(3);
  const src = abs(s.video);
  const srcDur = dur(src);
  if (srcDur < target) throw new Error(`${s.video}: ${srcDur.toFixed(2)}s recorded, scene needs ${target}s`);
  const clip = path.join(work, `clip${i + 1}.mp4`);
  ff('-i', src, '-ss', (srcDur - target).toFixed(3), '-t', String(target), '-r', '30',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,setsar=1`,
    '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', clip);
  return { clip, vo: abs(s.vo), target, actual: dur(clip) };
});

const list = path.join(work, 'concat.txt');
fs.writeFileSync(list, clips.map((c) => `file '${c.clip}'`).join('\n'));
const video = path.join(work, 'video.mp4');
ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video);

let cursor = 0;
const offsets = clips.map((c) => {
  const o = cursor + 0.5;
  cursor += c.actual;
  return Math.round(o * 1000);
});
const total = dur(video);
const inputs = ['-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
clips.forEach((c) => inputs.push('-i', c.vo));
const filter =
  clips.map((c, i) => `[${i + 1}:a]aresample=48000,adelay=${offsets[i]}|${offsets[i]}[a${i}]`).join(';') +
  `;[0:a]${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length + 1}:normalize=0:duration=first[aout]`;
const audio = path.join(work, 'audio.m4a');
ff(...inputs, '-filter_complex', filter, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', audio);

const out = abs(m.out);
fs.mkdirSync(path.dirname(out), { recursive: true });
ff('-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-shortest', '-movflags', '+faststart', out);

const volume = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {
  encoding: 'utf8',
})
  .stderr.split('\n')
  .filter((l) => /mean_volume|max_volume/.test(l))
  .map((l) => l.replace(/^\[.*?\] /, ''))
  .join('\n');

console.log(JSON.stringify({
  out,
  duration: +dur(out).toFixed(2),
  scenes: clips.map((c, i) => ({ clip: i + 1, target: c.target, actual: +c.actual.toFixed(3), voAt: offsets[i] / 1000 })),
}, null, 2));
console.log(volume.trim()); // healthy: mean −18…−26 dB (gaps pull it down), max < −1 dB
