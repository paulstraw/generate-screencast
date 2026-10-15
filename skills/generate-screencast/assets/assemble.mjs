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
 *     "captions": "burn",                 // optional; also burn captions into the picture
 *     "voice": "en-US-AndrewNeural",      // optional; its locale tags the subtitle track
 *     "lang": "eng",                      // optional; the tag itself (ISO 639)
 *     "spellings": { "P&PM": "pnpm" },    // optional; fixes whisper's spelling of terms
 *     "scenes": [{
 *       "video": "scenes/s1.webm", "vo": "vo/beat1.mp3",
 *       "text": "The approved script for this beat, real spelling.",  // TTS VO
 *       "subs": "vo/beat1.srt",           // optional; default vo/beatN.srt when "text" is
 *                                         // given, else vo/txt/beatN.json (whisper)
 *       "captionPosition": "top"          // optional; burn-in at the top of this scene
 *     }, …]
 *   }
 *
 * Scene length = 0.5s lead + VO + 0.5s tail (1.0s on the last). Each clip
 * keeps the LAST target-seconds of its recording, and VO offsets come from the
 * actual clip durations, so frame rounding never accumulates into drift.
 * Normalizing each clip before the mix keeps dynamic processing off the
 * finished track, where it pumps at beat starts.
 *
 * Captions are always made: <out>.srt beside the mp4, and the same cues as a
 * toggleable mov_text track inside it. Each beat's cues shift by that beat's
 * VO offset, so they can't drift from the audio. Burn-in lays Chromium-rendered
 * PNGs over the picture inside the per-clip encode: no libass, no extra pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderCaptionFrames } from './caption-frames.mjs';
import { iso3, language, toSrt, ttsCues, whisperCues } from './captions.mjs';

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

/* Where speech resumes after each silence, in seconds into the clip. */
const onsets = (f) =>
  [...spawnSync('ffmpeg', ['-hide_banner', '-i', f, '-af', 'silencedetect=noise=-40dB:d=0.08', '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr.matchAll(/silence_end: ([\d.]+)/g)].map((x) => +x[1]);

/* Each scene's cues in clip time (the VO starts at 0.5s), built before any
 * encode so a script/cue mismatch fails fast. */
const whisperLang = [];
const plans = m.scenes.map((s, i) => {
  const last = i === m.scenes.length - 1;
  const voDur = dur(abs(s.vo));
  const target = +(0.5 + voDur + (last ? 1.0 : 0.5)).toFixed(3);
  const label = `beat ${i + 1} (${s.vo})`;
  const stem = path.join(path.dirname(s.vo), path.basename(s.vo, path.extname(s.vo)));
  const subs = abs(s.subs || (s.text ? `${stem}.srt` : path.join(path.dirname(s.vo), 'txt', `${path.basename(stem)}.json`)));
  if (!fs.existsSync(subs)) throw new Error(`${label}: no caption timing at ${subs}`);
  let cues;
  if (subs.endsWith('.srt')) {
    if (!s.text) throw new Error(`${label}: ${s.subs} is edge-tts timing; add the approved script as "text"`);
    cues = ttsCues(subs, s.text, label);
  } else {
    cues = whisperCues(subs, label, m.spellings);
    whisperLang.push(language(subs));
  }
  // edge-tts and whisper both report speech ~0.1–0.15s before it's audible
  // (whisper puts a take's first word at 0, inside the trim pad): start each
  // cue at a measured voice onset when one follows within 0.35s.
  const heard = onsets(abs(s.vo));
  cues = cues.map((c) => {
    const o = heard.find((t) => t >= c.start - 0.02 && t <= c.start + 0.35 && t < c.end - 0.2);
    return o === undefined ? c : { ...c, start: o };
  });
  // Linger: hold each cue 0.3s past its speech and at least 1.2s, into the gap
  // before the next cue or the scene's tail, so short sentences stay readable.
  cues = cues.map((c, k) => ({
    start: 0.5 + c.start,
    end: Math.min(0.5 + (cues[k + 1]?.start ?? target), Math.max(c.end + 0.3, c.start + 1.2) + 0.5, target),
    text: c.text,
    position: s.captionPosition,
  }));
  return { s, target, cues };
});

const burn = m.captions === 'burn';
if (m.captions && !burn) throw new Error(`"captions": "${m.captions}" — the only option is "burn"`);
let frames = [];
if (burn) {
  const dir = path.join(work, 'captions');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  frames = await renderCaptionFrames(plans.flatMap((p) => p.cues), { size: [W, H], dir, from: base });
}

let nextFrame = 0;
const clips = plans.map(({ s, target, cues }, i) => {
  const src = abs(s.video);
  const srcDur = dur(src);
  if (srcDur < target) throw new Error(`${s.video}: ${srcDur.toFixed(2)}s recorded, scene needs ${target}s`);
  const clip = path.join(work, `clip${i + 1}.mp4`);
  const ss = srcDur - target;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,setsar=1`;
  const picture = burn ? burnIn(src, fit, frames.slice(nextFrame, (nextFrame += cues.length)), cues, ss) : ['-i', src, '-vf', fit];
  ff(...picture, '-ss', ss.toFixed(3), '-t', String(target), '-r', '30',
    '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-an', clip);
  return { clip, vo: m.normalize ? normalize(abs(s.vo), i) : abs(s.vo), target, actual: dur(clip), cues };
});

/* One overlay per cue, each a single still held by overlay's default
 * eof_action=repeat. Output-side -ss trims after filtering, so the filter's
 * `t` is recording time: shift the cue windows by the trim point. */
function burnIn(src, fit, frames, cues, ss) {
  const graph = [`[0:v]${fit}[v0]`];
  frames.forEach((f, k) => {
    const [a, b] = [cues[k].start + ss, cues[k].end + ss].map((t) => t.toFixed(3));
    graph.push(`[v${k}][${k + 1}:v]overlay=${f.x}:${f.y}:enable='gte(t,${a})*lt(t,${b})'[v${k + 1}]`);
  });
  return ['-i', src, ...frames.flatMap((f) => ['-i', f.png]), '-filter_complex', graph.join(';'), '-map', `[v${frames.length}]`];
}

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

const cues = clips.flatMap((c, i) => {
  const shift = offsets[i] / 1000 - 0.5;
  return c.cues.map((q) => ({ ...q, start: q.start + shift, end: q.end + shift }));
});
const out = abs(m.out);
const srt = out.replace(/\.[^./]+$/, '') + '.srt';
const lang = m.lang ? iso3(m.lang) : iso3(whisperLang[0] || m.voice);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(srt, toSrt(cues));
ff('-i', video, '-i', audio, '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c', 'copy', '-c:s', 'mov_text',
  '-metadata:s:s:0', `language=${lang}`, '-shortest', '-movflags', '+faststart', out);

// Readable: on screen at least ~1s, at no more than ~20 characters a second.
const tooFast = cues
  .map((q) => ({ at: +q.start.toFixed(2), secs: +(q.end - q.start).toFixed(2), cps: +(q.text.replace('\n', '').length / (q.end - q.start)).toFixed(1), text: q.text.replace('\n', ' / ') }))
  .filter((q) => q.secs < 1 || q.cps > 20);

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
  captions: { srt, lang, cues: cues.length, burned: burn, tooFast },
}, null, 2));
console.log(volume.trim()); // healthy: mean −18…−26 dB (gaps pull it down), max < −1 dB
