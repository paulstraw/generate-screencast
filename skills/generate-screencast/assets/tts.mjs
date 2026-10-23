#!/usr/bin/env node
/*
 * Synthesises each beat's voiceover with edge-tts and records it in build.json.
 *
 *   node tts.mjs <dir>              // every beat status.mjs says needs a VO
 *   node tts.mjs <dir> save intro   // just these beats, stale or not
 *
 * Per beat: `uvx edge-tts --voice <voice> --text "<say ?? text>" --write-media vo/<id>.mp3 --write-subtitles
 * vo/<id>.srt`, then the .srt's sentence count is checked against the beat's `text` (captions take only the .srt's
 * timing and the text's words, so the two must split the same way), the clip is ffprobed, and the `vo` entry is
 * recorded with the key it was made from, so status.mjs can tell when `text`, `say` or the voice moves on. A `revo`
 * flag on the beat is cleared.
 *
 * edge-tts is a free online service that occasionally hangs, so each call has a 30s timeout and is retried 3 times.
 * The clip is written to temp files and renamed into place only once it passes, so a failed beat keeps its old VO.
 * One failing beat doesn't stop the others; the exit code is 1 if any failed.
 *
 *   import { synthesize } from './tts.mjs';
 *   synthesize(p, 'save', { run })   // run(cmd, args) → spawnSync-like result; tests stub it
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ttsCues } from './captions.mjs';
import { voKey } from './timeline.mjs';

export const TIMEOUT = 30_000;
export const RETRIES = 3;

const edgeTts = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT });

const probe = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));

// The edge-tts command line for a beat, writing to `media` and `subs`.
export const ttsArgs = (voice, beat, media, subs) => [
  'edge-tts',
  '--voice',
  voice,
  '--text',
  beat.say ?? beat.text,
  '--write-media',
  media,
  '--write-subtitles',
  subs,
];

// Makes one beat's VO and records it. Returns the `vo` entry; throws (leaving any previous VO in place) on failure.
export function synthesize(p, id, { run = edgeTts, retries = RETRIES, log = () => {} } = {}) {
  const beat = p.find(id);
  const voice = p.data.voice.tts;
  if (!voice) throw new Error('this project has a human voiceover; record it with record-vo.mjs');
  const media = p.voFile(id);
  const subs = p.subsFile(id);
  fs.mkdirSync(path.dirname(media), { recursive: true });
  const tmp = (file) => file.replace(/(\.[^./]+)$/, `.tmp$1`);
  const [tmpMedia, tmpSubs] = [tmp(media), tmp(subs)];
  const clean = () => [tmpMedia, tmpSubs].forEach((f) => fs.rmSync(f, { force: true }));

  try {
    let error;
    for (let attempt = 0; attempt <= retries; attempt++) {
      clean();
      const r = run('uvx', ttsArgs(voice, beat, tmpMedia, tmpSubs));
      error = r.error
        ? r.error.code === 'ETIMEDOUT'
          ? `timed out after ${TIMEOUT / 1000}s`
          : r.error.message
        : r.status !== 0
          ? (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`
          : !fs.existsSync(tmpMedia) || !fs.statSync(tmpMedia).size || !fs.existsSync(tmpSubs)
            ? 'edge-tts wrote no audio or subtitles'
            : null;
      if (!error) break;
      if (attempt < retries) log(`  ${id}: ${error}; retrying (${attempt + 1}/${retries})`);
    }
    if (error) throw new Error(`edge-tts failed for beat "${id}": ${error}`);

    // Throws with both sentence lists when the .srt and the text split differently.
    ttsCues(tmpSubs, beat.text, `beat "${id}"`);
    const duration = Math.round(probe(tmpMedia) * 1000) / 1000;
    fs.renameSync(tmpMedia, media);
    fs.renameSync(tmpSubs, subs);
    const vo = { file: media, key: voKey(p.data, beat), duration, subs };
    p.recordBuild(id, { vo });
    p.clearFlags(id, ['revo']);
    return vo;
  } finally {
    clean();
  }
}

async function main(argv) {
  const [dir, ...ids] = argv;
  if (!dir || dir.startsWith('-') || ids.some((a) => a.startsWith('-'))) throw new Error('usage: node tts.mjs <dir> [ids…]');
  const { loadProject } = await import('./project.mjs');
  const p = loadProject(dir);
  if (!p.data.voice.tts) throw new Error('this project has a human voiceover; record it with record-vo.mjs');

  let todo = ids;
  if (!todo.length) {
    const { plan, gather } = await import('./status.mjs');
    todo = plan(p.data, p.build, await gather(p)).todo.vo;
    if (!todo.length) return console.log('every VO is up to date');
  }
  todo.forEach((id) => p.find(id));

  const failed = [];
  for (const id of todo) {
    try {
      const vo = synthesize(p, id, { log: console.log });
      console.log(`${id}: ${vo.duration.toFixed(3)}s  ${p.rel(vo.file)}`);
    } catch (err) {
      failed.push(id);
      console.error(`${id}: ${err.message}`);
    }
  }
  if (failed.length) {
    console.error(`\n${failed.length} beat(s) failed: ${failed.join(' ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
