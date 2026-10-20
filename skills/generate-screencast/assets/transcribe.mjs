#!/usr/bin/env node
/*
 * Transcribes each beat's human voiceover take with mlx-whisper (Apple Silicon) and records it in build.json.
 *
 *   node transcribe.mjs <dir>              // every beat status.mjs says needs a transcript
 *   node transcribe.mjs <dir> save intro   // just these beats
 *
 * Per beat, one take per invocation (given several inputs, mlx_whisper writes every result to the first
 * --output-name):
 *
 *   uvx --from mlx-whisper mlx_whisper --model mlx-community/whisper-large-v3-turbo --language en
 *     --word-timestamps True --output-format json --output-dir vo/txt --output-name <id>
 *     --initial-prompt "<the beat's text>" vo/<id>.wav
 *
 * The prompt steers spelling and punctuation, not words: a riff is still transcribed as it was said, which is what
 * captions and the truth rule need. Word times are relative to the trimmed take, so they are p.beat(id).at() marks
 * and caption cue times directly. The `txt` entry records which take (`vo.key`) it transcribed.
 *
 * The language is the project's `lang` as whisper's two-letter code (eng → en); without `lang`, whisper detects it.
 * The result is written under a temp name and renamed into place once it has words, so a failure keeps the old one.
 *
 *   import { transcribe, whisperArgs } from './transcribe.mjs';
 *   transcribe(p, 'save', { run })   // run(cmd, args) → spawnSync-like result; tests stub it
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODEL = 'mlx-community/whisper-large-v3-turbo';

// ISO 639-2 codes (what `lang` and mov_text use) to whisper's ISO 639-1, for the languages people narrate in most.
const TWO = {
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', dut: 'nl',
  jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', rus: 'ru', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi',
  tur: 'tr', ukr: 'uk', ces: 'cs', cze: 'cs', hin: 'hi', ara: 'ar', heb: 'he',
};

// Whisper's language code for a project `lang` (en, eng, en-US…), or null to let whisper detect it.
export function whisperLanguage(lang) {
  if (!lang) return null;
  const base = lang.split(/[-_]/)[0].toLowerCase();
  return base.length === 2 ? base : (TWO[base] ?? null);
}

// The mlx_whisper command line for a beat's take, writing <outDir>/<name>.json.
export const whisperArgs = (beat, { input, outDir, name, language }) => [
  '--from',
  'mlx-whisper',
  'mlx_whisper',
  '--model',
  MODEL,
  ...(language ? ['--language', language] : []),
  '--word-timestamps',
  'True',
  '--output-format',
  'json',
  '--output-dir',
  outDir,
  '--output-name',
  name,
  '--initial-prompt',
  beat.text,
  input,
];

const whisper = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Transcribes one beat's take and records it. Returns the `txt` entry and the words it found; throws on failure.
export function transcribe(p, id, { run = whisper } = {}) {
  const beat = p.find(id);
  if (!p.data.voice.human) throw new Error('this project has a TTS voice; its timing comes from edge-tts');
  const vo = p.build.beats[id]?.vo;
  if (!vo?.file || !fs.existsSync(vo.file)) throw new Error(`beat "${id}" has no take yet; record it with record-vo.mjs`);
  const file = p.txtFile(id);
  const outDir = path.dirname(file);
  const name = `${id}.tmp`;
  const tmp = path.join(outDir, `${name}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(tmp, { force: true });
  try {
    const language = whisperLanguage(p.data.lang);
    const r = run('uvx', whisperArgs(beat, { input: vo.file, outDir, name, language }));
    const error = r.error
      ? r.error.message
      : r.status !== 0
        ? (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`
        : !fs.existsSync(tmp)
          ? 'mlx_whisper wrote no transcript'
          : null;
    if (error) throw new Error(`mlx_whisper failed for beat "${id}": ${error}`);
    const words = JSON.parse(fs.readFileSync(tmp, 'utf8'))
      .segments?.flatMap((s) => s.words ?? [])
      .map((w) => w.word.trim())
      .filter(Boolean);
    if (!words?.length) throw new Error(`mlx_whisper found no words in beat "${id}"'s take (${p.rel(vo.file)})`);
    fs.renameSync(tmp, file);
    const txt = { file, voKey: vo.key };
    p.recordBuild(id, { txt });
    return { txt, words };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function main(argv) {
  const [dir, ...ids] = argv;
  if (!dir || dir.startsWith('-') || ids.some((a) => a.startsWith('-')))
    throw new Error('usage: node transcribe.mjs <dir> [ids…]');
  const { loadProject } = await import('./project.mjs');
  const p = loadProject(dir);
  if (!p.data.voice.human) throw new Error('this project has a TTS voice; its timing comes from edge-tts');

  let todo = ids;
  if (!todo.length) {
    const { plan, gather } = await import('./status.mjs');
    todo = plan(p.data, p.build, await gather(p)).todo.transcribe;
    if (!todo.length) return console.log('every transcript is up to date');
  }
  todo.forEach((id) => p.find(id));

  const failed = [];
  for (const id of todo) {
    try {
      const { words } = transcribe(p, id);
      console.log(`${id}: ${words.join(' ')}`);
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

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
