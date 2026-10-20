#!/usr/bin/env node
/*
 * Tiles frames of one beat, as the edit shows it, into a single QA image to look at before `status.mjs --qa`.
 *
 *   node qa-grid.mjs <dir> <id> [times…]            // writes qa/<id>.png and lists what each frame is
 *   node qa-grid.mjs <dir> <id> 1.2 3.4 --out x.png
 *   node qa-grid.mjs <dir> <id> --scene             // the raw recording even when the render would be used
 *
 * Times are scene time in seconds (the beat's clock: 0 when the screen is ready, the VO starting at its lead), the
 * same numbers film.mjs works in. Every grid also gets, automatically: the first and last frame of the beat's picture
 * window (where its cuts land), the VO's first word, and the middle of any L/J overlap where this beat's picture runs
 * under a neighbour's narration, since that's where the truth rule (the words mustn't point at the wrong screen) is
 * checked. Frames read left to right, top to bottom, three per row, in time order.
 *
 * The source follows what the picture needs. A plain screen beat is cut from its recording through build.json's
 * scene mapping (file time = scene time + duration − end), exactly as assemble.mjs cuts it, so it can be checked
 * before any render. With burned-in captions or a camera (pip or full), the frame only exists composited, so it's
 * taken from the assembled video instead: run `node assemble.mjs <dir> --force` first (QA hasn't passed yet, hence
 * --force); once every beat's QA is recorded that render is already current and needn't be redone.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProject } from './project.mjs';
import { gather, plan } from './status.mjs';
import { FPS } from './timeline.mjs';

const ms = (t) => Math.round(t * 1000) / 1000;
const secs = (t) => `${t < 0 ? '−' : ''}${Math.abs(t).toFixed(2)}s`;

/*
 * The frames to grid for beat `id` of timeline `t`: [{ x (timeline s), scene (s), labels: [...] }], in time order,
 * one per frame. `times` are scene times; `filmedLead` is build.json's scene.lead (the VO's scene time when filmed).
 * Pure, so the edge and overlap rules are testable without media.
 */
export function qaFrames(t, id, times = [], { filmedLead } = {}) {
  const i = t.beats.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`"${id}" isn't in the edit (unknown or skipped)`);
  const e = t.beats[i];
  const lead = filmedLead ?? e.voAt - e.block[0];
  const toScene = (x) => x - e.voAt + lead;
  const toX = (s) => s + e.voAt - lead;
  const frame = 1 / FPS;
  const [p0, p1] = e.picture;
  const [a0, a1] = e.block;

  const picks = [
    { x: p0, label: 'picture in' },
    { x: p1 - frame, label: 'picture out' },
    { x: e.voAt, label: 'VO starts' },
  ];
  // This picture over the previous beat's narration (an L cut), or over the next beat's (a J cut out of this beat).
  // Under half a frame is just boundary rounding (picture edges are whole frames, blocks aren't), not a cut.
  if (p0 < a0 - frame / 2)
    picks.push({ x: (p0 + Math.min(a0, p1)) / 2, label: `L overlap: under "${t.beats[i - 1].id}" narration` });
  if (p1 > a1 + frame / 2)
    picks.push({ x: (Math.max(a1, p0) + p1) / 2, label: `J overlap: under "${t.beats[i + 1].id}" narration` });
  for (const s of times) {
    const x = toX(s);
    picks.push({ x, label: x < p0 - 1e-6 || x > p1 - frame + 1e-6 ? 'given, outside the picture' : 'given' });
  }

  // Snap to whole frames of timeline time and merge picks that land on the same frame.
  const byFrame = new Map();
  for (const { x, label } of picks) {
    const k = Math.round(x * FPS);
    const f = byFrame.get(k) ?? { x: k / FPS, scene: ms(toScene(k / FPS)), labels: [] };
    if (!f.labels.includes(label)) f.labels.push(label);
    byFrame.set(k, f);
  }
  return [...byFrame.entries()].sort(([a], [b]) => a - b).map(([, f]) => ({ ...f, x: ms(f.x) }));
}

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);

// Grids beat `id` of the project in `dir`. Returns { out, source, frames: [{ x, scene, at, labels }] }.
export async function qaGrid(dir, id, times = [], { out, scene: forceScene = false } = {}) {
  const p = loadProject(dir);
  const s = plan(p.data, p.build, await gather(p));
  if (s.error) throw new Error(`can't grid: ${s.error}`);
  const t = s.timeline;
  const entry = t.beats.find((e) => e.id === id);
  if (!entry) throw new Error(`"${id}" isn't in the edit (unknown or skipped)`);
  const steps = p.build.beats[id] ?? {};

  const composite = !forceScene && (p.data.captions?.burn === true || entry.mode !== 'off');
  let source;
  let toFile;
  let limit;
  if (composite) {
    source = p.build.assembly?.out;
    const why = p.data.captions?.burn === true ? 'captions are burned in' : `the camera is ${entry.mode}`;
    if (!source || !fs.existsSync(source) || p.build.assembly.key !== t.key)
      throw new Error(
        `${why}, so "${id}" is gridded from the render, which is ${source && fs.existsSync(source) ? 'out of date' : 'missing'}: ` +
          `run node assemble.mjs ${dir} --force first (or pass --scene for the raw recording)`,
      );
    toFile = (x) => x;
    limit = entry.picture;
  } else {
    const sc = steps.scene;
    if (entry.mode === 'full' || !sc || !fs.existsSync(sc.file))
      throw new Error(`"${id}" has no screen recording to grid; film it first (node status.mjs ${dir})`);
    source = sc.file;
    toFile = (x) => x - entry.voAt + sc.lead + sc.duration - sc.end;
    limit = [0, sc.duration];
  }

  const frames = qaFrames(t, id, times, { filmedLead: steps.scene?.lead }).map((f) => {
    // ffmpeg's accurate seek yields the first frame at or after the target, as assemble.mjs's cuts do; a millisecond
    // early so the frame starting exactly there isn't skipped. Kept inside the source.
    const at = toFile(f.x) - 0.001;
    const clamped = Math.min(Math.max(at, limit[0]), limit[1] - 1 / FPS);
    const off = clamped - at > 0.002 || at - clamped > 0.5 / FPS;
    const labels = off ? [...f.labels, `clamped: not in the ${composite ? 'render' : 'recording'}`] : f.labels;
    return { ...f, at: ms(clamped), labels };
  });

  out = path.resolve(out ?? path.join(p.qaDir(), `${id}.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-grid-'));
  try {
    const pngs = frames.map((f, k) => {
      const png = path.join(tmp, `${k}.png`);
      ff('-ss', f.at.toFixed(3), '-i', source, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', png);
      return png;
    });
    if (pngs.length === 1) fs.copyFileSync(pngs[0], out);
    else {
      const [w, h] = String(
        execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of',
          'csv=s=x:p=0', pngs[0]]),
      )
        .trim()
        .split('x')
        .map(Number);
      const layout = pngs.map((_, k) => `${(k % 3) * w}_${Math.floor(k / 3) * h}`).join('|');
      ff(...pngs.flatMap((f) => ['-i', f]), '-filter_complex', `xstack=inputs=${pngs.length}:layout=${layout}:fill=black`,
        '-frames:v', '1', out);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { out, source, frames };
}

async function main(argv) {
  const args = [...argv];
  let out;
  const o = args.indexOf('--out');
  if (o >= 0) [, out] = args.splice(o, 2);
  const scene = args.includes('--scene');
  if (scene) args.splice(args.indexOf('--scene'), 1);
  const [dir, id, ...rest] = args;
  const times = rest.map(Number);
  if (!dir || !id || (o >= 0 && !out) || rest.some((r, k) => r.startsWith('--') || !Number.isFinite(times[k])))
    throw new Error('usage: node qa-grid.mjs <dir> <id> [scene times…] [--out file.png] [--scene]');
  const r = await qaGrid(dir, id, times, { out, scene });
  console.log(`${id} from ${r.source}`);
  r.frames.forEach((f, k) =>
    console.log(`frame ${k + 1}: scene ${secs(f.scene)} (timeline ${f.x.toFixed(2)}s, file ${f.at.toFixed(3)}s): ${f.labels.join('; ')}`),
  );
  console.log(r.out);
}

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
