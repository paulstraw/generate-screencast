#!/usr/bin/env node
/*
 * Teleprompter + per-beat mic recorder for a human-read voiceover (needs sox).
 * Run from the workdir; reads the one *.script.md there and writes vo/.
 *
 *   node record-vo.mjs [beat numbers…] [--script x.script.md] [--device "Scarlett Solo USB"] [--channel 0|1|mix]
 *
 * --device defaults to the system default input; --channel picks an input of a
 * multi-input interface (0 = first). Raw takes go to vo/raw/beatN.wav (the
 * previous take kept as beatN.prev.wav), silence-trimmed copies to vo/beatN.wav.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
const scriptPath = opt('--script', readdirSync(here).find((f) => f.endsWith('.script.md')));
if (!scriptPath) {
  console.error('no *.script.md in the current directory; pass --script');
  process.exit(1);
}
const only = args.map(Number).filter(Boolean);

const rawDir = join(here, 'vo', 'raw');
const voDir = join(here, 'vo');
mkdirSync(rawDir, { recursive: true });

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

const record = async (beat) => {
  const raw = join(rawDir, `beat${beat.n}.wav`);
  if (existsSync(raw)) renameSync(raw, join(rawDir, `beat${beat.n}.prev.wav`));
  // sox, not ffmpeg: ffmpeg's avfoundation audio input drops buffers (crackle/stutter).
  const remix = channel === 'mix' ? ['remix', '1,2'] : ['remix', String(Number(channel) + 1)];
  const ff = spawn('sox', ['-q', '-t', 'coreaudio', device, '-r', '48000', '-b', '24', raw, ...remix],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  // Count down while sox opens the device (~0.6s), so the first word is never lost.
  for (const c of ['3', '2', '1']) {
    screen(beat, `${Y}${B}  ${c}…${X}`);
    await sleep(700);
  }
  const started = Date.now();
  const tick = setInterval(() => {
    const t = ((Date.now() - started) / 1000).toFixed(1);
    screen(beat, `${R}${B}  ● REC ${t}s${X}   ${D}any key to stop${X}`);
  }, 200);
  const exited = new Promise((r) => ff.on('close', r));
  await Promise.race([key(), exited]);
  clearInterval(tick);
  ff.kill('SIGINT');
  await exited;
  if (!existsSync(raw)) return `${R}Recording failed: ${err.trim() || 'no file written'}${X}`;
  // Trim to 150ms either side of the speech so scene timing starts on the first word.
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15';
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw,
    '-af', `${trim},areverse,${trim},areverse`, '-y', join(voDir, `beat${beat.n}.wav`)]);
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
