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
 *     "normalize": true,                  // optional; two-pass loudnorm per VO clip (human VO)
 *     "bubble": { "position": "bottom-left", "size": 0.22, "margin": 48 },  // optional; camera bubble defaults
 *     "scenes": [{ "video": "scenes/s1.webm", "vo": "vo/beat1.mp3" }, …]
 *   }
 *
 * Camera (human VO recorded with --camera), per scene:
 *   "cam": "cam/raw/beat1.mov", "camTrim": [2.13, 9.87]   // vo/trims.json entry for the beat
 *   "camMode": "pip" | "full" | "off"                     // default pip when cam is set
 *   "bubble": { … }                                       // overrides the manifest's
 * pip overlays a circular bubble: size is its diameter as a fraction of the
 * frame's short side, margin is in output pixels, position is
 * top|bottom-left|right. full replaces the screen with the camera, cropped to
 * fill (a full scene needs no "video"). The raw take's frame at camTrim[0] (the
 * VO's first sample) lands at clip start + 0.5s, so the lead and tail are real
 * footage too.
 *
 * Scene length = 0.5s lead + VO + 0.5s tail (1.0s on the last). Each clip
 * keeps the LAST target-seconds of its recording, and VO offsets come from the
 * actual clip durations, so frame rounding never accumulates into drift.
 * Normalizing each clip before the mix keeps dynamic processing off the
 * finished track, where it pumps at beat starts.
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

const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
function normalize(src, i) {
  const pass1 = spawnSync('ffmpeg', ['-hide_banner', '-i', src, '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr;
  const j = JSON.parse(pass1.slice(pass1.lastIndexOf('{'), pass1.lastIndexOf('}') + 1));
  const out = path.join(work, `vo${i + 1}.wav`);
  ff('-i', src, '-af', `${LOUDNORM}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}` +
    `:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`, '-ar', '48000', out);
  return out;
}

const BUBBLE = { position: 'bottom-left', size: 0.22, margin: 48, ...m.bubble };
const even = (x) => 2 * Math.round(x / 2);
const masks = new Map();
function mask(d) {
  // Antialiased circle, white inside: the bubble's alpha channel.
  if (!masks.has(d)) {
    const out = path.join(work, `mask-${d}.png`);
    const r = d / 2;
    ff('-f', 'lavfi', '-i', `color=c=black:s=${d}x${d},format=gray`, '-frames:v', '1',
      '-vf', `geq=lum='255*clip(${r}-hypot(X+0.5-${r},Y+0.5-${r})+0.5,0,1)'`, out);
    masks.set(d, out);
  }
  return masks.get(d);
}

const fill = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,setsar=1`;
const encode = ['-r', '30', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-an'];

const clips = m.scenes.map((s, i) => {
  const last = i === m.scenes.length - 1;
  const voDur = dur(abs(s.vo));
  const target = +(0.5 + voDur + (last ? 1.0 : 0.5)).toFixed(3);
  const mode = s.cam ? s.camMode || 'pip' : 'off';
  if (!['pip', 'full', 'off'].includes(mode)) throw new Error(`scene ${i + 1}: camMode must be pip, full or off`);
  const clip = path.join(work, `clip${i + 1}.mp4`);
  const inputs = [];
  if (mode !== 'full') {
    const src = abs(s.video);
    const srcDur = dur(src);
    if (srcDur < target) throw new Error(`${s.video}: ${srcDur.toFixed(2)}s recorded, scene needs ${target}s`);
    inputs.push('-ss', (srcDur - target).toFixed(3), '-t', String(target), '-i', src);
  }
  if (mode === 'off') {
    ff(...inputs, '-vf', fill, ...encode, clip);
    return { clip, vo: m.normalize ? normalize(abs(s.vo), i) : abs(s.vo), target, actual: dur(clip) };
  }

  if (!Array.isArray(s.camTrim)) throw new Error(`scene ${i + 1}: cam needs camTrim (its vo/trims.json entry)`);
  // Camera frames from 0.5s before the VO's first sample; clone the first or
  // last frame where the raw take doesn't reach that far.
  const camStart = s.camTrim[0] - 0.5;
  const camIdx = inputs.length ? 1 : 0;
  inputs.push('-ss', Math.max(0, camStart).toFixed(3), '-t', (target + 1).toFixed(3), '-i', abs(s.cam));
  const cam = `[${camIdx}:v]setpts=PTS-STARTPTS,fps=30,` +
    `tpad=start_mode=clone:start_duration=${Math.max(0, -camStart).toFixed(3)}:stop_mode=clone:stop_duration=${target},` +
    `trim=duration=${target},setpts=PTS-STARTPTS`;

  let graph;
  if (mode === 'full') {
    graph = `${cam},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v]`;
  } else {
    const b = { ...BUBBLE, ...s.bubble };
    const d = even(b.size * Math.min(W, H));
    const x = b.position.endsWith('right') ? W - d - b.margin : b.margin;
    const y = b.position.startsWith('top') ? b.margin : H - d - b.margin;
    inputs.push('-loop', '1', '-i', mask(d));
    graph = `[0:v]${fill}[bg];` +
      `${cam},crop='min(iw,ih)':'min(iw,ih)',scale=${d}:${d}:flags=lanczos,format=yuva420p[c];` +
      `[2:v]format=gray[m];[c][m]alphamerge[cb];[bg][cb]overlay=${x}:${y}:shortest=1[v]`;
  }
  ff(...inputs, '-filter_complex', graph, '-map', '[v]', '-t', String(target), ...encode, clip);
  return { clip, vo: m.normalize ? normalize(abs(s.vo), i) : abs(s.vo), target, actual: dur(clip) };
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
