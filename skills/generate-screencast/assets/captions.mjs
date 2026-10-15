/*
 * Turns each beat's voiceover timing into readable caption cues, relative to
 * the VO clip: [{ start, end, text }] in seconds, text holding at most two
 * lines of at most 42 characters, joined by "\n".
 *
 *   ttsCues(srtPath, scriptText, label)   edge-tts --write-subtitles output.
 *     Timing only: each sentence's text comes from the approved script, so
 *     phonetic TTS input ("P N P M") never reaches the screen. Throws when the
 *     sentence counts differ. Words inside a sentence are timed by word count.
 *   whisperCues(jsonPath, label, spellings)   mlx-whisper --word-timestamps.
 *     What was actually said, on exact word times, split at sentence ends and
 *     pauses. `spellings` maps whisper's rendering of a term to the real one
 *     ({ "P&PM": "pnpm", "lock file": "lockfile" }).
 *
 * Used by assemble.mjs, which shifts each beat's cues onto the final timeline.
 */
import fs from 'node:fs';

const LINE = 42;

const secs = (ts) => {
  const [h, m, s] = ts.trim().replace(',', '.').split(':');
  return +h * 3600 + +m * 60 + +s;
};

export function parseSrt(text) {
  return text
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      const [a, b] = lines[i].split('-->');
      return { start: secs(a), end: secs(b), text: lines.slice(i + 1).join(' ').trim() };
    });
}

/* Sentence ends: terminal punctuation (plus closing quotes/brackets) before an
 * uppercase letter, digit or opening quote — so "e.g. for" stays one sentence,
 * as it does for edge-tts, and so do titles like "Dr. Who". */
const TITLE = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs)\.$/;
export const sentences = (text) =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[\p{Lu}\d])/u)
    .filter(Boolean)
    .reduce((acc, s) => {
      if (acc.length && TITLE.test(acc[acc.length - 1])) acc[acc.length - 1] += ` ${s}`;
      else acc.push(s);
      return acc;
    }, []);

export function ttsCues(srtPath, scriptText, label) {
  const subs = parseSrt(fs.readFileSync(srtPath, 'utf8'));
  const said = sentences(scriptText);
  if (said.length !== subs.length) {
    throw new Error(
      `${label}: the script has ${said.length} sentence(s) but ${srtPath} has ${subs.length} cue(s). ` +
        `Reword the script or the TTS input so each sentence ends the same way in both.\n` +
        `  script: ${said.map((s) => JSON.stringify(s)).join(' | ')}\n` +
        `  edge-tts: ${subs.map((s) => JSON.stringify(s.text)).join(' | ')}`,
    );
  }
  return said.flatMap((sentence, i) => {
    const { start, end } = subs[i];
    const ws = sentence.split(' ');
    const at = (k) => start + ((end - start) * k) / ws.length;
    return split(ws.map((w, k) => ({ w, s: at(k), e: at(k + 1) })), end);
  });
}

export function whisperCues(jsonPath, label, spellings = {}) {
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  let words = (j.segments || [])
    .flatMap((seg) => seg.words || [])
    .map((x) => ({ w: x.word.trim(), s: x.start, e: x.end }))
    .filter((x) => x.w);
  if (!words.length) throw new Error(`${label}: ${jsonPath} has no word timestamps (run whisper with --word-timestamps True)`);
  words = respell(words, spellings);
  const out = [];
  let run = [];
  // A sentence ends at terminal punctuation, or at a pause: whisper sometimes
  // leaves a take unpunctuated.
  words.forEach((x, k) => {
    run.push(x);
    if (/[.!?…]["'”’)\]]*$/.test(x.w) || k === words.length - 1 || words[k + 1].s - x.e >= 0.5) {
      out.push(...split(run, x.e));
      run = [];
    }
  });
  return out;
}

export const language = (j) => JSON.parse(fs.readFileSync(j, 'utf8')).language;

/* Replaces whisper's spelling of terms, matching whole words case-insensitively
 * and ignoring punctuation; a multi-word key merges its words into one. */
function respell(words, spellings) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const keys = Object.entries(spellings).map(([k, v]) => [k.split(/\s+/).map(norm), v]);
  const out = [];
  for (let i = 0; i < words.length; ) {
    const hit = keys.find(([ks]) => ks.every((k, j) => words[i + j] && norm(words[i + j].w) === k));
    if (!hit) {
      out.push(words[i++]);
      continue;
    }
    const last = words[i + hit[0].length - 1];
    const trail = last.w.match(/[^\p{L}\p{N}]*$/u)[0];
    out.push({ w: hit[1] + trail, s: words[i].s, e: last.e });
    i += hit[0].length;
  }
  return out;
}

/* How well a line or cue breaks after this word: negative after punctuation,
 * positive after a word that leads into the next ("the", "and"). */
const WEAK = /^(a|an|the|and|or|but|nor|of|to|in|on|at|by|for|from|with|into|as|is|are|was|that|this|its|your|our|their|my)$/i;
const breakCost = (w) => (/[,;:—–]$/.test(w) ? -1 : WEAK.test(w) ? 1 : 0);

/* Lays out words as one line, or two balanced lines; null when they don't fit. */
function layout(ws) {
  const one = ws.join(' ');
  if (one.length <= LINE || ws.length === 1) return one;
  let best = null;
  for (let k = 1; k < ws.length; k++) {
    const a = ws.slice(0, k).join(' ');
    const b = ws.slice(k).join(' ');
    if (a.length > LINE || b.length > LINE) continue;
    const score = Math.max(a.length, b.length) + 8 * breakCost(ws[k - 1]);
    if (!best || score < best.score) best = { score, text: `${a}\n${b}` };
  }
  return best?.text ?? null;
}

/* Splits one sentence into the fewest cues that fit, as evenly as possible.
 * Cues within a sentence run back to back; the last ends at `end`. */
function split(words, end) {
  const n = words.length;
  const best = Array(n + 1).fill(null);
  best[0] = { count: 0, cost: 0 };
  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      if (!best[i]) continue;
      const text = layout(words.slice(i, j).map((x) => x.w));
      if (text === null) continue;
      const cost = best[i].cost + text.length ** 2 + (j < n ? 600 * breakCost(words[j - 1].w) : 0);
      const cand = { count: best[i].count + 1, cost, from: i, text };
      if (!best[j] || cand.count < best[j].count || (cand.count === best[j].count && cand.cost < best[j].cost)) {
        best[j] = cand;
      }
    }
  }
  const cues = [];
  for (let j = n; j > 0; j = best[j].from) cues.unshift({ start: words[best[j].from].s, text: best[j].text });
  cues.forEach((c, k) => (c.end = k + 1 < cues.length ? cues[k + 1].start : end));
  return cues;
}

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (v, w = 2) => String(v).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export const toSrt = (cues) =>
  cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');

/* ISO 639-1 → 639-2, for the mp4 subtitle track's language tag. */
const ISO3 = {
  ar: 'ara', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', fi: 'fin', fr: 'fra', he: 'heb',
  hi: 'hin', hu: 'hun', id: 'ind', it: 'ita', ja: 'jpn', ko: 'kor', nb: 'nob', nl: 'nld', no: 'nor', pl: 'pol',
  pt: 'por', ro: 'ron', ru: 'rus', sv: 'swe', th: 'tha', tr: 'tur', uk: 'ukr', vi: 'vie', zh: 'zho',
};
export function iso3(code) {
  const c = (code || '').toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{3}$/.test(c) ? c : ISO3[c] || 'eng';
}
