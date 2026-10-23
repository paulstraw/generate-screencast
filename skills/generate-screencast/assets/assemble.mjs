#!/usr/bin/env node
/*
 * Renders a project's edit: cuts the filmed scenes to the timeline, voices them, and writes the deliverables.
 *
 *   node assemble.mjs <dir>            // refuses while status.mjs lists any step before assemble
 *   node assemble.mjs <dir> --force    // renders anyway, printing what's stale (a recording that doesn't cover its
 *                                      // window clones its edge frames; a missing one is a dark placeholder)
 *
 * Everything comes from timeline.mjs, the same module the editor previews with, so the render and the preview can't
 * disagree. Audio is fixed: each beat's VO plays at its `voAt`. Pictures move with cuts: one clip per picture span,
 * cut from the beat's recording by explicit in/out points. Scene time maps to file time through build.json's
 * scene entry (file time = scene time + duration − end: recordings are aligned to their end, because stopping is
 * precise and starting isn't), and each clip is exactly its span's whole frames, so nothing drifts.
 *
 * Camera beats (human VO recorded with a camera): `full` replaces the screen with the take, cropped to fill; `pip`
 * lays it over the screen as a circular bubble (size is its diameter as a fraction of the frame's short side, margin
 * in output pixels). The take is cut by the timeline's camWindow (which already includes camera.delay, the capture
 * card's lag), cloning its first or last frame where the window runs off the take.
 *
 * Normalizing each VO before the mix (voice.normalize, human VO) keeps dynamic processing off the finished track, where
 * it pumps at beat starts.
 *
 * Captions are always made: <out>.srt beside the mp4, and the same cues as a toggleable mov_text track inside it.
 * With captions.burn they're also burned in: Chromium renders each cue piece as a PNG (caption-frames.mjs) and the
 * per-clip encode overlays it, so no libass and no extra pass. A cue that runs across a cut is drawn in both clips,
 * positioned by the beat whose picture it's over.
 *
 * It also writes <out>.script.md (the script, exported: a section per beat with its text) and records the render in
 * build.json's `assembly` ({ key: the timeline's key, out, at }), so status.mjs knows when the video is current. It
 * prints a JSON report (per beat: picture span, scene window, VO offset; caption counts and any cue too fast to read)
 * and the loudness.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderCaptionFrames } from './caption-frames.mjs';
import { iso3, language, toSrt } from './captions.mjs';
import { loadProject } from './project.mjs';
import { gather, plan } from './status.mjs';
import { FPS } from './timeline.mjs';

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
const dur = (f) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], {
      encoding: 'utf8',
    }),
  );
const s3 = (t) => t.toFixed(3);
const r3 = (t) => Math.round(t * 1000) / 1000;
const even = (x) => 2 * Math.round(x / 2);
const BACKDROP = '0x0b0d12';

const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
function normalize(src, out) {
  const pass1 = spawnSync('ffmpeg', ['-hide_banner', '-i', src, '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr;
  const j = JSON.parse(pass1.slice(pass1.lastIndexOf('{'), pass1.lastIndexOf('}') + 1));
  ff('-i', src, '-af', `${LOUDNORM}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}` +
    `:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`, '-ar', '48000', out);
  return out;
}

// The project's script as Markdown: a section per beat in the video, its text quoted.
export const scriptMarkdown = (data) =>
  [
    `# ${data.title}`,
    ...data.beats
      .filter((b) => !b.skip)
      .map((b, i) => `## ${i + 1} · ${b.title}\n\n${b.text.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}`),
  ].join('\n\n') + '\n';

// Renders the project in `dir`. Returns the report the CLI prints; throws (without rendering) on a stale project
// unless `force`.
export async function assemble(dir, { force = false, log = console.error } = {}) {
  const p = loadProject(dir);
  const s = plan(p.data, p.build, await gather(p));
  if (s.error) throw new Error(`can't render: ${s.error}`);
  const pending = s.beats.filter((b) => b.steps.length);
  if (pending.length) {
    const list = pending.flatMap((b) => b.steps.map((st) => `  ${b.id}: ${st.step} (${st.reasons.join('; ')})`));
    if (!force)
      throw new Error(
        `not ready to assemble; run node status.mjs ${dir} and do what it says (or --force):\n${list.join('\n')}`,
      );
    log(`--force: rendering with stale beats:\n${list.join('\n')}`);
  }

  const { data, build } = p;
  const t = s.timeline;
  const [W, H] = data.size ?? [1920, 1080];
  const burn = data.captions?.burn === true;
  const work = p.assemblyDir();
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  let frames = [];
  if (burn) {
    const capDir = path.join(work, 'captions');
    fs.mkdirSync(capDir);
    frames = await renderCaptionFrames(
      t.beats.flatMap((e) => e.overlays),
      { size: [W, H], dir: capDir },
    );
  }

  const masks = new Map();
  const mask = (d) => {
    // Antialiased circle, white inside: the bubble's alpha channel.
    if (!masks.has(d)) {
      const out = path.join(work, `mask-${d}.png`);
      const r = d / 2;
      ff('-f', 'lavfi', '-i', `color=c=black:s=${d}x${d},format=gray`, '-frames:v', '1',
        '-vf', `geq=lum='255*clip(${r}-hypot(X+0.5-${r},Y+0.5-${r})+0.5,0,1)'`, out);
      masks.set(d, out);
    }
    return masks.get(d);
  };

  const fill = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BACKDROP},setsar=1`;
  const encode = ['-r', String(FPS), '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-an'];

  let nextFrame = 0;
  const clips = t.beats.map((e, i) => {
    const steps = build.beats[e.id] ?? {};
    const n = e.frames[1] - e.frames[0];
    const len = n / FPS;
    const clip = path.join(work, `${String(i + 1).padStart(2, '0')}-${e.id}.mp4`);
    const inputs = [];
    let count = 0;
    const input = (...args) => (inputs.push(...args), count++);
    // Exactly `n` frames from a source seeked to `from` (s), cloning edge frames where it runs out at either end.
    const cut = (idx, from) =>
      `[${idx}:v]setpts=PTS-STARTPTS,fps=${FPS},` +
      `tpad=start_mode=clone:start_duration=${s3(Math.max(0, -from))}:stop_mode=clone:stop_duration=${s3(len)},` +
      `trim=end_frame=${n},setpts=PTS-STARTPTS`;

    const graph = [];
    let screen = null;
    if (e.mode !== 'full') {
      const scene = steps.scene;
      if (scene && fs.existsSync(scene.file)) {
        const from = e.sceneWindow[0] + scene.duration - scene.end;
        screen = cut(input('-ss', s3(Math.max(0, from)), '-t', s3(len + 1), '-i', scene.file), from);
      } else {
        log(`${e.id}: no recording; using a placeholder`);
        screen = `[${input('-f', 'lavfi', '-i', `color=c=${BACKDROP}:s=${W}x${H}:r=${FPS}`)}:v]trim=end_frame=${n}`;
      }
    }
    let cam = null;
    if (e.mode !== 'off') {
      if (!e.camWindow || !fs.existsSync(steps.cam?.file ?? '')) throw new Error(`${e.id}: no camera take to render`);
      cam = cut(input('-ss', s3(Math.max(0, e.camWindow[0])), '-t', s3(len + 1), '-i', steps.cam.file), e.camWindow[0]);
    }

    if (e.mode === 'off') graph.push(`${screen},${fill}[v]`);
    else if (e.mode === 'full')
      graph.push(`${cam},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v]`);
    else {
      const b = e.bubble;
      const d = even(b.size * Math.min(W, H));
      const x = b.position.endsWith('right') ? W - d - b.margin : b.margin;
      const y = b.position.startsWith('top') ? b.margin : H - d - b.margin;
      const m = input('-loop', '1', '-i', mask(d));
      graph.push(
        `${screen},${fill}[bg]`,
        `${cam},crop='min(iw,ih)':'min(iw,ih)',scale=${d}:${d}:flags=lanczos,format=yuva420p[c]`,
        `[${m}:v]format=gray[m]`,
        '[c][m]alphamerge[cb]',
        `[bg][cb]overlay=${x}:${y}:shortest=1[v]`,
      );
    }

    // Burn-in: one overlay per cue piece over this picture, each a still held by overlay's default
    // eof_action=repeat, enabled for its span in clip time (timeline time − picture start).
    let out = 'v';
    if (burn)
      e.overlays.forEach((c, k) => {
        const f = frames[nextFrame++];
        const idx = input('-i', f.png);
        const [a, z] = [c.start, c.end].map((x) => s3(x - e.picture[0]));
        graph.push(`[${out}][${idx}:v]overlay=${f.x}:${f.y}:enable='gte(t,${a})*lt(t,${z})'[cap${k}]`);
        out = `cap${k}`;
      });

    ff(...inputs, '-filter_complex', graph.join(';'), '-map', `[${out}]`, '-frames:v', String(n), ...encode, clip);
    return clip;
  });

  const list = path.join(work, 'concat.txt');
  fs.writeFileSync(list, clips.map((c) => `file '${c.replaceAll("'", "'\\''")}'`).join('\n'));
  const video = path.join(work, 'video.mp4');
  ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', video);

  // Each VO at its fixed offset, to the sample, over silence the length of the edit.
  const voiced = t.beats.filter((e) => fs.existsSync(build.beats[e.id]?.vo?.file ?? ''));
  const inputs = ['-f', 'lavfi', '-t', s3(t.total), '-i', 'anullsrc=r=48000:cl=stereo'];
  for (const e of voiced) {
    const src = build.beats[e.id].vo.file;
    inputs.push('-i', data.voice.normalize ? normalize(src, path.join(work, `vo-${e.id}.wav`)) : src);
  }
  const filter =
    voiced.map((e, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(e.voAt * 48000)}S:all=1[a${i}]`).join(';') +
    `${voiced.length ? ';' : ''}[0:a]${voiced.map((_, i) => `[a${i}]`).join('')}` +
    `amix=inputs=${voiced.length + 1}:normalize=0:duration=first[aout]`;
  const audio = path.join(work, 'audio.m4a');
  ff(...inputs, '-filter_complex', filter, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', audio);

  const out = p.out();
  const srt = p.srtOut();
  const firstTxt = t.beats.map((e) => build.beats[e.id]?.txt?.file).find((f) => f && fs.existsSync(f));
  const lang = iso3(data.lang ?? (data.voice.human ? firstTxt && language(firstTxt) : data.voice.tts));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(srt, toSrt(t.cues));
  ff('-i', video, '-i', audio, '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', `language=${lang}`, '-movflags', '+faststart', out);
  const script = p.scriptOut();
  fs.writeFileSync(script, scriptMarkdown(data));
  p.recordAssembly({ key: t.key, out, at: new Date().toISOString() });

  // Readable: on screen at least ~1s, at no more than ~20 characters a second.
  const tooFast = t.cues
    .map((q) => ({
      at: r3(q.start),
      secs: r3(q.end - q.start),
      cps: +(q.text.replace('\n', '').length / (q.end - q.start)).toFixed(1),
      text: q.text.replace('\n', ' / '),
    }))
    .filter((q) => q.secs < 1 || q.cps > 20);

  const volume = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {
    encoding: 'utf8',
  })
    .stderr.split('\n')
    .filter((l) => /mean_volume|max_volume/.test(l))
    .map((l) => l.replace(/^\[.*?\] /, ''))
    .join('\n')
    .trim();

  return {
    out,
    duration: r3(dur(out)),
    total: t.total,
    beats: t.beats.map((e) => ({
      id: e.id,
      picture: e.picture,
      sceneWindow: e.sceneWindow,
      ...(e.camWindow ? { camWindow: e.camWindow } : {}),
      voAt: e.voAt,
    })),
    captions: { srt, lang, cues: t.cues.length, burned: burn, tooFast },
    script,
    stale: pending.map((b) => b.id),
    volume,
  };
}

async function main(argv) {
  const args = argv.filter((a) => a !== '--force');
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error('usage: node assemble.mjs <dir> [--force]');
  const { volume, ...report } = await assemble(args[0], { force: argv.includes('--force') });
  console.log(JSON.stringify(report, null, 2));
  console.log(volume); // healthy: mean −18…−26 dB (gaps pull it down), max < −1 dB
}

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
