#!/usr/bin/env node
/*
 * Teleprompter + per-beat mic recorder for a human-read voiceover (needs sox,
 * or camrec with --camera). Run from the workdir; reads the one *.script.md
 * there and writes vo/ (and cam/).
 *
 *   node record-vo.mjs [beat numbers…] [--script x.script.md] [--device "Scarlett Solo USB"] [--channel 0|1|mix]
 *                      [--camera "Cam Link 4K"]
 *
 * --device defaults to the system default input; --channel picks an input of a
 * multi-input interface (0 = first). Raw takes go to vo/raw/beatN.wav (the
 * previous take kept as beatN.prev.wav), silence-trimmed copies to vo/beatN.wav.
 * vo/trims.json maps each beat to the [start, end] seconds of the raw take that
 * vo/beatN.wav covers.
 *
 * --camera records each take with camrec (camera + mic in one .mov, built from
 * camrec.swift beside this script on first use) instead of sox: the raw take is
 * cam/raw/beatN.mov, and vo/raw/beatN.wav is its audio, so trims.json offsets
 * index the camera footage too.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = process.cwd();
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const device = opt('--device', 'default');
const channel = opt('--channel', '0');
const camera = opt('--camera', null);
const scriptPath = opt('--script', readdirSync(here).find((f) => f.endsWith('.script.md')));
if (!scriptPath) {
  console.error('no *.script.md in the current directory; pass --script');
  process.exit(1);
}
const only = args.map(Number).filter(Boolean);

const rawDir = join(here, 'vo', 'raw');
const voDir = join(here, 'vo');
const camDir = join(here, 'cam', 'raw');
const trimsPath = join(voDir, 'trims.json');
mkdirSync(rawDir, { recursive: true });

const camrec = join(here, 'camrec');
if (camera) {
  mkdirSync(camDir, { recursive: true });
  if (!existsSync(camrec)) {
    const src = join(dirname(fileURLToPath(import.meta.url)), 'camrec.swift');
    console.log('building camrec…');
    const b = spawnSync('swiftc', ['-O', src, '-o', camrec], { stdio: 'inherit' });
    if (b.status !== 0) process.exit(1);
  }
}

const beats = [];
for (const block of readFileSync(scriptPath, 'utf8').split(/^## /m).slice(1)) {
  const [heading, ...rest] = block.split('\n');
  const n = Number(heading.match(/^(\d+)/)?.[1]);
  const text = rest
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
    .trim();
  if (n && text) beats.push({ n, title: heading.replace(/^\d+\s*·\s*/, ''), text });
}
const queue = only.length ? beats.filter((b) => only.includes(b.n)) : beats;

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
const cols = Math.min(process.stdout.columns || 80, 72);
const wrap = (s) => {
  const out = [];
  let line = '';
  for (const w of s.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > cols - 4) { out.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.map((l) => `  ${l}`).join('\n\n');
};

const probe = (file) => {
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim();
  const vol = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const mean = Number(vol.match(/mean_volume: (-?[\d.]+)/)?.[1]);
  const max = Number(vol.match(/max_volume: (-?[\d.]+)/)?.[1]);
  return { dur: Number(dur), mean, max };
};

const describe = (file) => {
  if (!existsSync(file)) return `${D}no take yet${X}`;
  const { dur, mean, max } = probe(file);
  const warn = [];
  if (max > -1) warn.push(`${R}clipping (max ${max} dB)${X}`);
  if (mean < -32) warn.push(`${Y}quiet (mean ${mean} dB)${X}`);
  return `${G}${dur.toFixed(1)}s${X}  ${D}mean ${mean} dB · max ${max} dB${X}  ${warn.join('  ')}`;
};

const screen = (beat, status) => {
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`${D}Beat ${beat.n} of ${beats.length} · ${beat.title}${X}\n`);
  console.log(`${B}${wrap(beat.text)}${X}\n`);
  console.log(`${D}${'─'.repeat(cols)}${X}`);
  console.log(status);
};

if (!process.stdin.isTTY) {
  console.error('record-vo needs an interactive terminal (it reads single keystrokes)');
  process.exit(1);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
const key = () => new Promise((res) => process.stdin.once('data', (k) => {
  if (k === '\x03') { process.stdout.write('\n'); process.exit(130); }
  res(k);
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Speech bounds in a raw take, padded 150ms either side, so scene timing starts
// on the first word. silencedetect (unlike silenceremove) reports where it would
// cut, so the same offsets can trim the camera footage.
const speechBounds = (file) => {
  const total = probe(file).dur;
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.15', '-f', 'null', '-'],
    { encoding: 'utf8' }).stderr;
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((x) => Math.max(0, Number(x[1])));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((x) => Number(x[1]));
  let from = 0, to = total;
  if (starts.length && starts[0] < 0.01) from = ends[0] ?? total;     // leading silence
  const last = starts.at(-1);
  if (last !== undefined && last > from && (ends.length < starts.length || ends.at(-1) > total - 0.01)) to = last;
  if (to <= from) return null;
  const r = (x) => +x.toFixed(3);
  return [r(Math.max(0, from - 0.15)), r(Math.min(total, to + 0.15))];
};

const saveTrim = (n, bounds) => {
  const trims = existsSync(trimsPath) ? JSON.parse(readFileSync(trimsPath, 'utf8')) : {};
  trims[n] = bounds;
  writeFileSync(trimsPath, JSON.stringify(trims, null, 2) + '\n');
};

const keepPrev = (dir, n, ext) => {
  const f = join(dir, `beat${n}.${ext}`);
  if (existsSync(f)) renameSync(f, join(dir, `beat${n}.prev.${ext}`));
  return f;
};

// sox, not ffmpeg: ffmpeg's avfoundation audio input drops buffers (crackle/stutter).
// Resolves once the device is open; stop() resolves when the WAV is finalized.
const startSox = async (raw) => {
  const remix = channel === 'mix' ? ['remix', '1,2'] : ['remix', String(Number(channel) + 1)];
  const p = spawn('sox', ['-q', '-t', 'coreaudio', device, '-r', '48000', '-b', '24', raw, ...remix],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('close', r));
  return { exited, err: () => err, stop: () => { p.kill('SIGINT'); return exited; } };
};

// camrec prints "rec" once frames are being written; "stop" on stdin finalizes the .mov.
const startCam = async (mov) => {
  const p = spawn(camrec, ['record', camera, device, mov], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdin.on('error', () => {}); // camrec already gone: its stderr says why
  const exited = new Promise((r) => p.on('close', r));
  const started = new Promise((r) => createInterface({ input: p.stdout }).on('line', (l) => l === 'rec' && r(true)));
  const ok = await Promise.race([started, exited.then(() => false)]);
  return { ok, exited, err: () => err, stop: () => { p.stdin.end('stop\n'); return exited; } };
};

// The camera's audio, cut down to the chosen input of a multi-input interface
// and shifted so its t=0 is the movie's t=0: AVFoundation starts the audio
// track a few hundred ms after the video, and trims.json must index both.
const extractAudio = (mov, wav) => {
  const q = (entries, stream = []) => spawnSync('ffprobe', ['-v', 'error', ...stream, '-show_entries', entries,
    '-of', 'csv=p=0', mov]).stdout.toString().trim().split(',');
  const [rate, chans, aStart] = q('stream=sample_rate,channels,start_time', ['-select_streams', 'a:0']).map(Number);
  const lead = aStart - (Number(q('format=start_time')[0]) || 0);
  const pick = chans === 1 ? 'c0' : channel === 'mix' ? '0.5*c0+0.5*c1' : `c${Math.min(Number(channel), chans - 1)}`;
  const shift = lead > 0 ? `,adelay=delays=${Math.round(lead * rate)}S:all=1` : '';
  return spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mov, '-map', '0:a:0',
    '-af', `pan=mono|c0=${pick}${shift}`, '-c:a', 'pcm_s24le', '-y', wav]).status === 0;
};

const record = async (beat) => {
  const raw = keepPrev(rawDir, beat.n, 'wav');
  const mov = camera ? keepPrev(camDir, beat.n, 'mov') : null;
  if (camera) screen(beat, `${D}  opening camera…${X}`);
  const rec = camera ? await startCam(mov) : await startSox(raw);
  if (camera && !rec.ok) {
    await rec.exited;
    return `${R}Camera failed: ${rec.err().trim() || 'camrec exited'}${X}`;
  }
  // Count down while capture warms up (sox ~0.6s to open; a camera's exposure
  // and white balance settle for a moment after it opens), so the first word is never lost.
  for (const c of ['3', '2', '1']) {
    screen(beat, `${Y}${B}  ${c}…${X}`);
    await sleep(700);
  }
  const started = Date.now();
  const tick = setInterval(() => {
    const t = ((Date.now() - started) / 1000).toFixed(1);
    screen(beat, `${R}${B}  ● REC ${t}s${X}   ${D}any key to stop${X}`);
  }, 200);
  await Promise.race([key(), rec.exited]);
  clearInterval(tick);
  await rec.stop();
  if (camera) {
    if (!existsSync(mov)) return `${R}Recording failed: ${rec.err().trim() || 'no file written'}${X}`;
    if (!extractAudio(mov, raw)) return `${R}No audio in ${mov}${X}`;
  }
  if (!existsSync(raw)) return `${R}Recording failed: ${rec.err().trim() || 'no file written'}${X}`;
  const bounds = speechBounds(raw);
  if (!bounds) return `${R}No speech detected in the take${X}`;
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-ss', String(bounds[0]),
    '-t', (bounds[1] - bounds[0]).toFixed(3), '-c:a', 'pcm_s24le', '-y', join(voDir, `beat${beat.n}.wav`)]);
  saveTrim(beat.n, bounds);
  return null;
};

let player = null;
const stopPlay = () => { player?.kill(); player = null; };

for (let i = 0; i < queue.length;) {
  const beat = queue[i];
  const take = join(voDir, `beat${beat.n}.wav`);
  let note = '';
  for (;;) {
    screen(beat, `  Take: ${describe(take)}\n${note}\n` +
      `  ${B}r${X} record  ${B}p${X} play  ${B}n${X} next  ${B}b${X} back  ${B}q${X} quit`);
    const k = (await key()).toLowerCase();
    stopPlay();
    note = '';
    if (k === 'r' || k === '\r') note = (await record(beat)) ?? '';
    else if (k === 'p' && existsSync(take)) player = spawn('afplay', [take], { stdio: 'ignore' });
    else if (k === 'n') { i += 1; break; }
    else if (k === 'b') { i = Math.max(0, i - 1); break; }
    else if (k === 'q') { i = queue.length; break; }
  }
}
stopPlay();
process.stdout.write('\x1b[2J\x1b[H');
for (const b of beats) console.log(`Beat ${b.n}: ${describe(join(voDir, `beat${b.n}.wav`))}`);
process.exit(0);
