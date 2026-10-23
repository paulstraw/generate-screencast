#!/usr/bin/env node
/*
 * Teleprompter + per-beat mic recorder for a human-read voiceover (needs sox, or camrec with --camera). Reads the beats
 * from the project's screencast.json and records each take in build.json.
 *
 *   node record-vo.mjs <dir> [ids…] [--device "Scarlett Solo USB"] [--channel 0|1|mix]
 *                      [--camera "Cam Link 4K"] [--cam-delay 0.15]
 *
 * With no ids it queues every beat status.mjs says needs a VO. --device defaults to the system default input;
 * --channel picks an input of a multi-input interface (0 = first). Raw takes go to vo/raw/<id>.wav (the previous take
 * kept as <id>.prev.wav), the silence-trimmed copy to vo/<id>.wav, and build.json's `vo` entry records it with its
 * duration and key. A `revo` flag on the beat is cleared.
 *
 * --camera records each take with camrec (camera + mic in one .mov; built from camrec.swift beside this script into
 * ~/.cache/generate-screencast on first use) instead of sox: the raw take is cam/raw/<id>.mov and vo/raw/<id>.wav is
 * its audio, so the trim's [start, end] seconds index the camera footage too. They're recorded as `cam.trim`, with the
 * take's length as `cam.duration`. --cam-delay (seconds the picture lags the sound, from a clap test; default the
 * project's camera.delay) only lines up the p preview; assembly reads camera.delay.
 *
 * A new take changes the words' timing but not the VO key (a human VO's key is its text), so recording one also drops
 * the beat's transcript and scene from build.json: status.mjs then asks for transcribe and film again.
 *
 *   import { speechBounds, takePatch } from './record-vo.mjs';   // the pure parts, for tests
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { voKey } from './timeline.mjs';

const PAD = 0.15;
const r3 = (x) => +x.toFixed(3);

/* Speech bounds in a take, padded 150ms either side, from ffmpeg silencedetect's log and the take's length, so scene
 * timing starts on the first word. silencedetect (unlike silenceremove) reports where it would cut, so the same
 * offsets can trim the camera footage. null when there's no speech. */
export function speechBounds(log, total) {
  const rawStarts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((x) => Math.max(0, Number(x[1])));
  const rawEnds = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((x) => Number(x[1]));
  // Merge silences split by under 50ms of sound: mic clicks (~1ms) aren't speech, and would otherwise pull the trim a
  // second early.
  const starts = [];
  const ends = [];
  rawStarts.forEach((st, i) => {
    if (starts.length && ends.length === starts.length && st - ends.at(-1) < 0.05) ends.pop();
    else starts.push(st);
    if (rawEnds[i] !== undefined) ends.push(rawEnds[i]);
  });
  let from = 0;
  let to = total;
  if (starts.length && starts[0] < 0.01) from = ends[0] ?? total; // leading silence
  const last = starts.at(-1);
  if (last !== undefined && last > from && (ends.length < starts.length || ends.at(-1) > total - 0.01)) to = last;
  if (to <= from) return null;
  return [r3(Math.max(0, from - PAD)), r3(Math.min(total, to + PAD))];
}

/* The build.json patch for a new take of `beat`: its trimmed VO (`file`, `duration` s), the camera take it was cut
 * from, if any (`mov`, `movDuration`), trimmed to `bounds` like the VO. The transcript and scene were of the old take,
 * and a take without camera leaves no camera footage. */
export function takePatch(data, beat, { file, duration, bounds, mov, movDuration }) {
  return {
    vo: { file, key: voKey(data, beat), duration: r3(duration) },
    cam: mov ? { file: mov, trim: bounds, ...(movDuration ? { duration: r3(movDuration) } : {}) } : null,
    txt: null,
    scene: null,
  };
}

// --- Recording (interactive; nothing below runs on import) ----------------------------------------------------------

const probe = (file) => {
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const vol = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr;
  const mean = Number(vol.match(/mean_volume: (-?[\d.]+)/)?.[1]);
  const max = Number(vol.match(/max_volume: (-?[\d.]+)/)?.[1]);
  return { dur: Number(String(dur.stdout).trim()), mean, max };
};

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const args = [...argv];
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    if (i === -1) return fallback;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const device = opt('--device', 'default');
  const channel = opt('--channel', '0');
  const camera = opt('--camera', null);
  const camDelayArg = opt('--cam-delay', null);
  const [dir, ...ids] = args;
  if (!dir || dir.startsWith('-') || ids.some((a) => a.startsWith('-')))
    throw new Error('usage: node record-vo.mjs <dir> [ids…] [--device …] [--channel 0|1|mix] [--camera …] [--cam-delay s]');

  const { loadProject, ensureBuilt } = await import('./project.mjs');
  const p = loadProject(dir);
  if (!p.data.voice.human) throw new Error('this project has a TTS voice; make its VO with tts.mjs');
  const camDelay = Number(camDelayArg ?? p.data.camera?.delay ?? 0);

  let todo = ids;
  if (!todo.length) {
    const { plan, gather } = await import('./status.mjs');
    todo = plan(p.data, p.build, await gather(p)).todo.vo;
    if (!todo.length) return console.log('every beat has a take; name ids to re-record');
  }
  todo.forEach((id) => p.find(id));
  const queue = p.data.beats.filter((b) => todo.includes(b.id));
  const needCam = queue.filter((b) => (b.cam ?? 'off') !== 'off').map((b) => b.id);
  if (needCam.length && !camera)
    throw new Error(`${needCam.join(', ')} ${needCam.length > 1 ? 'have' : 'has'} cam pip/full; pass --camera "<name>"`);

  fs.mkdirSync(path.dirname(p.rawVoFile('x')), { recursive: true });
  let camrec;
  if (camera) {
    fs.mkdirSync(path.dirname(p.camFile('x')), { recursive: true });
    camrec = ensureBuilt('camrec');
  }

  const cols = Math.min(process.stdout.columns || 80, 72);
  const wrap = (s) => {
    const out = [];
    let line = '';
    for (const w of s.split(/\s+/)) {
      if ((line + ' ' + w).trim().length > cols - 4) {
        out.push(line);
        line = w;
      } else line = (line + ' ' + w).trim();
    }
    if (line) out.push(line);
    return out.map((l) => `  ${l}`).join('\n\n');
  };
  const describe = (file) => {
    if (!fs.existsSync(file)) return `${D}no take yet${X}`;
    const { dur, mean, max } = probe(file);
    const warn = [];
    if (max > -1) warn.push(`${R}clipping (max ${max} dB)${X}`);
    if (mean < -32) warn.push(`${Y}quiet (mean ${mean} dB)${X}`);
    return `${G}${dur.toFixed(1)}s${X}  ${D}mean ${mean} dB · max ${max} dB${X}  ${warn.join('  ')}`;
  };
  const screen = (beat, status) => {
    const n = p.data.beats.indexOf(beat) + 1;
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`${D}Beat ${n} of ${p.data.beats.length} · ${beat.title} (${beat.id})${X}\n`);
    console.log(`${B}${wrap(beat.text)}${X}\n`);
    console.log(`${D}${'─'.repeat(cols)}${X}`);
    console.log(status);
  };

  if (!process.stdin.isTTY) throw new Error('record-vo needs an interactive terminal (it reads single keystrokes)');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const key = () =>
    new Promise((res) =>
      process.stdin.once('data', (k) => {
        if (k === '\x03') {
          process.stdout.write('\n');
          process.exit(130);
        }
        res(k);
      }),
    );

  const keepPrev = (file) => {
    if (fs.existsSync(file)) fs.renameSync(file, file.replace(/(\.[^./]+)$/, '.prev$1'));
    return file;
  };

  // sox, not ffmpeg: ffmpeg's avfoundation audio input drops buffers (crackle/stutter).
  // Resolves once the device is open; stop() resolves when the WAV is finalized.
  const startSox = async (raw) => {
    const remix = channel === 'mix' ? ['remix', '1,2'] : ['remix', String(Number(channel) + 1)];
    const proc = spawn('sox', ['-q', '-t', 'coreaudio', device, '-r', '48000', '-b', '24', raw, ...remix], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    const exited = new Promise((r) => proc.on('close', r));
    return { exited, err: () => err, stop: () => (proc.kill('SIGINT'), exited) };
  };

  // camrec prints "rec" once frames are being written; "stop" on stdin finalizes the .mov.
  const startCam = async (mov) => {
    const proc = spawn(camrec, ['record', camera, device, mov], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.stdin.on('error', () => {}); // camrec already gone: its stderr says why
    const exited = new Promise((r) => proc.on('close', r));
    const started = new Promise((r) => createInterface({ input: proc.stdout }).on('line', (l) => l === 'rec' && r(true)));
    const ok = await Promise.race([started, exited.then(() => false)]);
    return { ok, exited, err: () => err, stop: () => (proc.stdin.end('stop\n'), exited) };
  };

  // The camera's audio, cut down to the chosen input of a multi-input interface and shifted so its t=0 is the movie's
  // t=0 (fixAudio already aligns it; this guards a movie whose audio track starts late), since the trim indexes both.
  const audioInfo = (mov) => {
    const q = (entries, stream = []) =>
      String(
        spawnSync('ffprobe', ['-v', 'error', ...stream, '-show_entries', entries, '-of', 'csv=p=0', mov]).stdout,
      )
        .trim()
        .split(',');
    const [rate, chans, aStart] = q('stream=sample_rate,channels,start_time', ['-select_streams', 'a:0']).map(Number);
    return { rate, chans, lead: aStart - (Number(q('format=start_time')[0]) || 0) };
  };
  const pickChannel = (chans) =>
    chans === 1 ? 'c0' : channel === 'mix' ? '0.5*c0+0.5*c1' : `c${Math.min(Number(channel), chans - 1)}`;
  // camrec leaves the take's audio decoded beside it (out.wav), because ffmpeg misreads AVFoundation's 24-bit PCM as
  // static; swap it into the movie (video copied as is) so every later step reads one ordinary file.
  const fixAudio = (mov, side) => {
    const tmp = mov.replace(/\.mov$/, '.tmp.mov');
    const ok =
      spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mov, '-i', side, '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy', '-c:a', 'pcm_s24le', '-y', tmp]).status === 0;
    if (ok) {
      fs.renameSync(tmp, mov);
      fs.rmSync(side);
    }
    return ok;
  };
  const extractAudio = (mov, wav) => {
    const { rate, chans, lead } = audioInfo(mov);
    const shift = lead > 0 ? `,adelay=delays=${Math.round(lead * rate)}S:all=1` : '';
    return (
      spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mov, '-map', '0:a:0',
        '-af', `pan=mono|c0=${pickChannel(chans)}${shift}`, '-c:a', 'pcm_s24le', '-y', wav]).status === 0
    );
  };

  const record = async (beat) => {
    const raw = keepPrev(p.rawVoFile(beat.id));
    const mov = camera ? keepPrev(p.camFile(beat.id)) : null;
    if (camera) screen(beat, `${D}  opening camera…${X}`);
    const rec = camera ? await startCam(mov) : await startSox(raw);
    if (camera && !rec.ok) {
      await rec.exited;
      return `${R}Camera failed: ${rec.err().trim() || 'camrec exited'}${X}`;
    }
    // Count down while capture warms up (sox ~0.6s to open; a camera's exposure and white balance settle for a moment
    // after it opens), so the first word is never lost.
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
      const side = mov.replace(/\.mov$/, '.wav');
      if (!fs.existsSync(mov) || !fs.existsSync(side))
        return `${R}Recording failed: ${rec.err().trim() || 'no file written'}${X}`;
      if (!fixAudio(mov, side) || !extractAudio(mov, raw)) return `${R}Can't read the audio in ${mov}${X}`;
    }
    if (!fs.existsSync(raw)) return `${R}Recording failed: ${rec.err().trim() || 'no file written'}${X}`;
    const log = spawnSync('ffmpeg', ['-hide_banner', '-i', raw, '-af', 'silencedetect=noise=-45dB:d=0.15', '-f', 'null',
      '-'], { encoding: 'utf8' }).stderr;
    const bounds = speechBounds(log, probe(raw).dur);
    if (!bounds) return `${R}No speech detected in the take${X}`;
    const file = p.voFile(beat.id);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-ss', String(bounds[0]),
      '-t', (bounds[1] - bounds[0]).toFixed(3), '-c:a', 'pcm_s24le', '-y', file]);
    p.recordBuild(
      beat.id,
      takePatch(p.data, beat, { file, duration: probe(file).dur, bounds, mov, movDuration: mov && probe(mov).dur }),
    );
    p.clearFlags(beat.id, ['revo']);
    return null;
  };

  // With the camera on, play the trimmed take's picture and sound together (ffplay window); otherwise just the audio.
  // Any key in the teleprompter stops it.
  const hasFfplay = spawnSync('which', ['ffplay']).status === 0;
  const play = (beat, take) => {
    const cam = p.build.beats[beat.id]?.cam;
    if (!camera || !hasFfplay || !cam || !fs.existsSync(cam.file)) return spawn('afplay', [take], { stdio: 'ignore' });
    const [a, b] = cam.trim;
    return spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-autoexit', '-window_title', beat.title,
      '-ss', String(a), '-t', (b - a).toFixed(3), '-vf', 'scale=-2:540',
      '-af', `pan=mono|c0=${pickChannel(audioInfo(cam.file).chans)},adelay=${Math.round(camDelay * 1000)}`, cam.file],
      { stdio: 'ignore' });
  };

  let player = null;
  const stopPlay = () => {
    player?.kill();
    player = null;
  };

  for (let i = 0; i < queue.length; ) {
    const beat = queue[i];
    const take = p.voFile(beat.id);
    let note = '';
    for (;;) {
      screen(beat, `  Take: ${describe(take)}\n${note}\n` +
        `  ${B}r${X} record  ${B}p${X} play  ${B}n${X} next  ${B}b${X} back  ${B}q${X} quit`);
      const k = (await key()).toLowerCase();
      stopPlay();
      note = '';
      if (k === 'r' || k === '\r') note = (await record(beat)) ?? '';
      else if (k === 'p' && fs.existsSync(take)) player = play(beat, take);
      else if (k === 'n') {
        i += 1;
        break;
      } else if (k === 'b') {
        i = Math.max(0, i - 1);
        break;
      } else if (k === 'q') {
        i = queue.length;
        break;
      }
    }
  }
  stopPlay();
  process.stdout.write('\x1b[2J\x1b[H');
  for (const b of p.data.beats) console.log(`${b.id}: ${describe(p.voFile(b.id))}`);
  process.exit(0);
}

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
