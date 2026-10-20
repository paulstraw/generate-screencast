/*
 * The edit, computed: turns screencast.json (intent) and build.json (what was recorded) into where every beat's
 * audio and picture sit in the finished video. assemble.mjs renders it and the editor previews it, so the preview is
 * never a second implementation.
 *
 *   import { timeline } from './timeline.mjs';
 *   const t = timeline(project, build, captions);   // parsed screencast.json and build.json; captions below
 *   t.total                                // seconds, a whole number of frames
 *   t.key                                  // hash of everything assembly consumes; changes ⇒ re-render
 *   t.beats[0]                             // { id, block, voAt, picture, frames, sceneWindow, camWindow, mode, …,
 *                                          //   cues, overlays, stale }
 *   t.cues                                 // every cue in timeline time, in order: the .srt
 *
 * Audio is fixed: each non-skipped beat is a block of lead + VO + tail, back to back, and its VO plays at block
 * start + lead. Pictures move with cuts: the boundary into a beat is its block start + `cut`, so a negative cut is an
 * L cut (the picture arrives under the previous narration) and a positive one a J cut (the narration starts under the
 * previous picture). Boundaries are rounded to whole frames in timeline time, so rounding never accumulates.
 *
 * Every screen recording keeps HANDLE seconds of footage either side of its clock (scene time 0 to lead + VO + tail),
 * so cuts and lead/tail changes are edit-only while the picture window stays inside build.json's `scene.footage`;
 * past it the beat lists a `film` reason in `stale`.
 *
 * Camera beats (pip or full) map their picture span into the raw camera take: `camWindow` is take time, starting
 * camera.delay later to put lips back on the words, and `camPad` the seconds of first/last frame to clone where the
 * window runs off the take.
 *
 * Captions: `captions` maps beat id to { cues, onsets }: the beat's cues relative to its VO, from captions.mjs
 * (ttsCues or whisperCues), and the measured voice onsets in the VO file (ffmpeg silencedetect); or to { error } when
 * the cues couldn't be made. placeCues() snaps and lingers them onto the timeline. A beat's `cues` are its own
 * narration (the .srt); its `overlays` are every cue piece drawn over its picture, clipped to the picture span and in
 * its caption position, so a cue spanning a cut is burned into both clips. Without `captions` at all (pure edit
 * tests) cues are empty and nothing is reported; with it, a beat missing from the map is stale. project.mjs's
 * loadTimeline(dir) gathers the inputs.
 *
 * Pure and browser-safe (the editor imports it): no Node built-ins, callers pass in everything it reads.
 */

export const FPS = 30;
export const HANDLE = 1.5;
export const LEAD = 0.5;
export const TAIL = 0.5;
export const LAST_TAIL = 1.0;
export const BUBBLE = { position: 'bottom-left', size: 0.22, margin: 48 };

// Picture edges may miss the footage by half a frame: that's frame rounding, and cloning one edge frame is invisible.
const SLOP = 0.5 / FPS + 1e-6;

const us = (t) => Math.round(t * 1e6) / 1e6;
const signed = (t) => `${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2)}s`;
const secs = (t) => `${t < 0 ? '−' : ''}${Math.abs(t).toFixed(2)}s`;
const base = (file) => (typeof file === 'string' ? file.split(/[\\/]/).pop() : null);

/*
 * A beat's cues, relative to its VO, onto the timeline (VO playing at `voAt`, its block ending at `end`).
 * edge-tts and whisper both report speech ~0.1–0.15s before it's audible (whisper puts a take's first word at 0,
 * inside the trim pad), so each cue starts at a measured voice onset when one follows within 0.35s. Then each cue
 * lingers 0.3s past its speech and at least 1.2s, into the gap before the next cue or the block's end, so short
 * sentences stay readable.
 */
export function placeCues(cues, onsets = [], { voAt = 0, end = Infinity } = {}) {
  const snapped = cues.map((c) => {
    const o = onsets.find((t) => t >= c.start - 0.02 && t <= c.start + 0.35 && t < c.end - 0.2);
    return o === undefined ? c : { ...c, start: o };
  });
  return snapped.map((c, k) => ({
    start: us(voAt + c.start),
    end: us(Math.min(voAt + (snapped[k + 1]?.start ?? Infinity), voAt + Math.max(c.end + 0.3, c.start + 1.2), end)),
    text: c.text,
  }));
}

export function timeline(project, build = { version: 1, beats: {} }, captions) {
  const beats = project.beats.filter((b) => !b.skip);
  const steps = (id) => build?.beats?.[id] ?? {};

  // Blocks: audio positions, fixed regardless of cuts.
  let at = 0;
  const blocks = beats.map((b, i) => {
    const duration = steps(b.id).vo?.duration;
    const lead = b.lead ?? LEAD;
    const tail = b.tail ?? (i === beats.length - 1 ? LAST_TAIL : TAIL);
    const D = typeof duration === 'number' ? duration : 0;
    const block = { start: at, lead, tail, D, hasVo: typeof duration === 'number' };
    at += lead + D + tail;
    return block;
  });
  const frames = Math.round(at * FPS);
  const total = frames / FPS;

  // Picture boundaries in whole frames: P_0 = 0, P_i = A_i + cut_i, P_n = total.
  const cut = (i) => (i === 0 ? 0 : (beats[i].cut ?? 0));
  const edges = beats.map((_, i) => (i === 0 ? 0 : Math.round((blocks[i].start + cut(i)) * FPS)));
  edges.push(frames);
  for (let i = 0; i < beats.length; i++)
    if (edges[i + 1] <= edges[i])
      throw new Error(
        `cuts leave no picture for "${beats[i].id}" (it would run ${secs(edges[i] / FPS)} to ` +
          `${secs(edges[i + 1] / FPS)}); shorten the cuts around it`,
      );

  const out = beats.map((b, i) => {
    const { start, lead, tail, D, hasVo } = blocks[i];
    const voAt = start + lead;
    const picture = [edges[i] / FPS, edges[i + 1] / FPS];
    const mode = b.cam ?? 'off';
    const scene = steps(b.id).scene;
    const stale = [];
    if (!hasVo) stale.push({ step: 'vo', reason: `no VO duration for "${b.id}" yet` });

    // Scene time of timeline time x: the VO started at scene time scene.lead (the lead when filmed).
    let sceneWindow = null;
    let camWindow = null;
    let camPad = null;
    if (mode !== 'full') {
      const filmedLead = scene?.lead ?? lead;
      sceneWindow = picture.map((x) => us(x - voAt + filmedLead));
      if (scene && hasVo && Array.isArray(scene.footage)) {
        const [lo, hi] = scene.footage;
        const [a, z] = sceneWindow;
        if (a < lo - SLOP) {
          const why = [];
          if (cut(i) < 0) why.push(`cut ${signed(cut(i))}`);
          if (lead > filmedLead) why.push(`lead ${filmedLead}s → ${lead}s`);
          stale.push({
            step: 'film',
            reason:
              `${why.join(' and ') || 'the edit'} reaches ${secs(lo - a)} before the footage of "${b.id}" ` +
              `(picture starts at scene ${secs(a)}, footage at ${secs(lo)}; handle ${HANDLE}s)`,
          });
        }
        if (z > hi + SLOP) {
          const why = [];
          if (i + 1 < beats.length && cut(i + 1) > 0) why.push(`cut into "${beats[i + 1].id}" ${signed(cut(i + 1))}`);
          if (scene.end !== undefined && filmedLead + D + tail + HANDLE > scene.end + SLOP) why.push(`tail ${tail}s`);
          stale.push({
            step: 'film',
            reason:
              `${why.join(' and ') || 'the edit'} runs ${secs(z - hi)} past the footage of "${b.id}" ` +
              `(picture ends at scene ${secs(z)}, footage at ${secs(hi)}; handle ${HANDLE}s)`,
          });
        }
      }
    }

    // Camera-take time of timeline time x: the take's trim[0] is the VO's first sample, plus the capture lag.
    if (mode !== 'off') {
      const cam = steps(b.id).cam;
      if (!Array.isArray(cam?.trim)) stale.push({ step: 'vo', reason: `no camera take for "${b.id}" yet` });
      else {
        const delay = project.camera?.delay ?? 0;
        camWindow = picture.map((x) => us(cam.trim[0] + (x - voAt) + delay));
        // The take's length is only known once record-vo records it; until then the far end can't be checked.
        const length = typeof cam.duration === 'number' ? cam.duration : Infinity;
        camPad = [us(Math.max(0, -camWindow[0])), us(Math.max(0, camWindow[1] - length))];
      }
    }

    let cues = [];
    if (captions) {
      const c = captions[b.id];
      const step = project.voice?.human ? 'transcribe' : 'vo';
      if (c?.error) stale.push({ step, reason: `captions for "${b.id}": ${c.error}` });
      else if (!c) {
        if (hasVo) stale.push({ step, reason: `no caption timing for "${b.id}" yet` });
      } else cues = placeCues(c.cues, c.onsets, { voAt, end: start + lead + D + tail });
    }

    return {
      id: b.id,
      block: [us(start), us(start + lead + D + tail)],
      voAt: us(voAt),
      picture,
      frames: [edges[i], edges[i + 1]],
      sceneWindow,
      camWindow,
      camPad,
      mode,
      bubble: mode === 'pip' ? { ...BUBBLE, ...project.camera?.bubble, ...b.bubble } : null,
      captionPosition: b.captionPosition ?? 'bottom',
      cues,
      stale,
    };
  });

  // Burn-in: every cue piece over each picture, so a cue crossing a cut is drawn in both clips for its part.
  const all = out.flatMap((t) => t.cues);
  for (const t of out) {
    const [p0, p1] = t.picture;
    t.overlays = all
      .filter((c) => c.start < p1 - 1e-6 && c.end > p0 + 1e-6)
      .map((c) => ({
        start: us(Math.max(c.start, p0)),
        end: us(Math.min(c.end, p1)),
        text: c.text,
        position: t.captionPosition,
      }));
  }

  // Everything assembly consumes: the edit above plus which recordings it cuts from and how they're voiced.
  const key = sha256(
    JSON.stringify({
      size: project.size ?? [1920, 1080],
      voice: project.voice,
      lang: project.lang ?? null,
      captions: project.captions ?? null,
      spellings: project.spellings ?? null,
      camera: project.camera ?? null,
      beats: out.map(({ stale, ...t }, i) => {
        const b = beats[i];
        const s = steps(b.id);
        return {
          ...t,
          title: b.title,
          text: b.text,
          vo: s.vo ? { file: base(s.vo.file), key: s.vo.key, duration: s.vo.duration } : null,
          txt: s.txt ? { voKey: s.txt.voKey } : null,
          cam: s.cam ? { file: base(s.cam.file), trim: s.cam.trim } : null,
          scene: s.scene ? { file: base(s.scene.file), duration: s.scene.duration, end: s.scene.end } : null,
        };
      }),
    }),
  );

  return { total, key, cues: all, beats: out };
}

// SHA-256 of a string, hex. Hand-rolled because this module also runs in the browser, where crypto.subtle is async.
const K = Uint32Array.from(
  '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'
    .split(' ')
    .map((h) => parseInt(h, 16)),
);

export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const len = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(len);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(len - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(len - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.of(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  );
  const w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => (h[i] += x));
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}
