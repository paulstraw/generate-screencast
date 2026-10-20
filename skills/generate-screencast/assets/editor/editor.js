/*
 * The clip editor's page: the project's beats with what each needs rebuilt, and a live preview of the edit.
 *
 * Everything shown is computed here from GET /api/project's { data, build, facts } by the same plan() and timeline()
 * the pipeline runs (served from /lib/), so the preview is never a second implementation of the edit. update()
 * recomputes and redraws after any change to state.data.
 *
 * The preview plays from the source media, not a render: one <video> per picture span, shown while the playhead is
 * inside it and seeked through the scene-time mapping (file time = sceneWindow[0] + (x − picture[0]) + duration − end);
 * the VO through Web Audio, each beat's buffer scheduled at its voAt; the camera as a full-frame or circle-masked
 * <video> cut by camWindow; captions as DOM text from the timeline's overlays. The stage is laid out in output pixels
 * and scaled to fit, so caption and bubble geometry match assemble.mjs. The clock is the AudioContext's, and videos
 * are nudged back whenever they drift from it. It's an approximation (no loudnorm, no exact compositing): Render is
 * the real thing.
 *
 * window.editor exposes the state and transport for scripted checks (test/editor-page.test.mjs).
 */
import { plan } from '/lib/status.mjs';
import { FPS } from '/lib/timeline.mjs';

const $ = (sel) => document.querySelector(sel);
const BACKDROP = '#0b0d12'; // assemble.mjs's letterbox colour
const STEP_LABEL = { vo: 'VO', transcribe: 'transcribe', film: 'film', qa: 'QA' };

// A DOM element: el('div', { class: 'x', onclick }, 'text', child…). Text is always text, never HTML.
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) node.style.setProperty(p, x);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return node;
}

const media = (rel) => `/media/${rel.split('/').map(encodeURIComponent).join('/')}`;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const secs = (t) => `${t.toFixed(2)}s`;
const signed = (t) => `${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2)}s`;

export const state = {
  data: null, // screencast.json, as edited
  hash: null, // its hash when read (sent back on save)
  build: null, // build.json (paths project-relative)
  facts: null, // what plan() can't read itself
  plan: null,
  timeline: null,
  x: 0, // playhead, timeline seconds (while paused)
  playing: false,
};

// --- Data ----------------------------------------------------------------------------------------------------------

export async function load() {
  const r = await fetch('/api/project', { cache: 'no-store' });
  const s = await r.json();
  if (!r.ok) throw new Error(s.error);
  Object.assign(state, { data: s.data, hash: s.hash, build: s.build, facts: s.facts });
  update();
}

// Recompute the plan and timeline from state.data and redraw everything.
export function update() {
  state.plan = plan(state.data, state.build, state.facts);
  state.timeline = state.plan.timeline;
  renderHeader();
  renderRows();
  renderRuler();
  preview.build();
  if (state.x > total()) seek(total());
}

const total = () => state.timeline?.total ?? 0;
const steps = (id) => state.build?.beats?.[id] ?? {};
const exists = (rel) => typeof rel === 'string' && state.facts.exists.includes(rel);
const entryOf = (id) => state.timeline?.beats.find((e) => e.id === id);

// Where beat `e`'s screen recording is at timeline time x, in file seconds (unclamped).
function sceneFileTime(e, x) {
  const sc = steps(e.id).scene;
  return e.sceneWindow[0] + (x - e.picture[0]) + sc.duration - sc.end;
}
const camFileTime = (e, x) => e.camWindow[0] + (x - e.picture[0]);

// The J/L overlaps: where one beat's narration plays over another beat's picture (D7's truth rule applies there).
function overlaps(t) {
  const out = [];
  t.beats.forEach((e, i) => {
    if (!i) return;
    const prev = t.beats[i - 1];
    const prevEnd = prev.voAt + (steps(prev.id).vo?.duration ?? 0);
    const P = e.picture[0];
    if (P < prevEnd - 1e-6) out.push({ kind: 'L', range: [P, prevEnd], voice: prev.id, picture: e.id });
    if (P > e.voAt + 1e-6) out.push({ kind: 'J', range: [e.voAt, P], voice: e.id, picture: prev.id });
  });
  return out;
}

// --- Header and beat rows --------------------------------------------------------------------------------------------

function renderHeader() {
  const d = state.data;
  const [W, H] = d.size ?? [1920, 1080];
  document.title = `${d.title} · screencast editor`;
  $('#title').textContent = d.title;
  const voice = d.voice.human ? 'your voice' : d.voice.tts;
  const live = d.beats.filter((b) => !b.skip).length;
  $('#summary').textContent =
    `${d.slug} · ${W}×${H} · ${voice} · ${live} beat${live === 1 ? '' : 's'}` +
    (d.beats.length > live ? ` (+${d.beats.length - live} skipped)` : '') +
    (state.timeline ? ` · ${fmt(total())}` : '') +
    ` · captions ${d.captions?.burn ? 'burned in' : 'as a track'}`;

  const a = state.plan.assemble;
  $('#render-status').replaceChildren(
    a.length
      ? el('span', { class: 'badge stale', title: a.join('\n') }, 'render needed')
      : el('span', { class: 'badge ok' }, 'render up to date'),
    a.length ? el('div', { class: 'why' }, a.join('; ')) : null,
  );
  const err = $('#error');
  err.hidden = !state.plan.error;
  err.textContent = state.plan.error ? `The edit is impossible: ${state.plan.error}` : '';
}

// Thumbnails are <video> elements parked on one frame; kept across redraws so edits don't reload them.
const thumbs = new Map();
function thumb(b) {
  const e = entryOf(b.id);
  const s = steps(b.id);
  let src = null;
  let t = 0;
  if (e?.sceneWindow && exists(s.scene?.file)) {
    src = s.scene.file;
    t = sceneFileTime(e, (e.picture[0] + e.picture[1]) / 2);
  } else if (e?.camWindow && exists(s.cam?.file)) {
    src = s.cam.file;
    t = camFileTime(e, (e.picture[0] + e.picture[1]) / 2);
  } else if (!e && exists(s.scene?.file)) src = s.scene.file; // skipped: its first frame
  if (!src) return el('div', { class: 'thumb empty' }, b.cam === 'full' ? 'no take' : 'not filmed');
  const url = `${media(src)}#t=${Math.max(0, t).toFixed(3)}`;
  let v = thumbs.get(b.id);
  if (!v || v.dataset.src !== url) {
    v = el('video', { class: 'thumb', muted: true, preload: 'metadata', playsinline: true });
    v.muted = true;
    v.dataset.src = url;
    v.src = url;
    thumbs.set(b.id, v);
  }
  return v;
}

function badges(b, pb) {
  const out = [];
  if (b.skip) out.push(el('span', { class: 'badge skip' }, 'skipped'));
  for (const st of pb?.steps ?? []) {
    const follows = st.reasons.every((r) => r.startsWith('follows '));
    out.push(
      el('span', { class: `badge step ${follows ? 'follows' : 'stale'}`, title: st.reasons.join('\n') }, STEP_LABEL[st.step]),
    );
  }
  for (const f of b.needs ?? [])
    out.push(el('span', { class: 'badge flag', title: f.note ?? '' }, `⚑ ${f.kind}${f.note ? `: ${f.note}` : ''}`));
  if (!b.skip && !pb?.steps.length) out.push(el('span', { class: 'badge ok' }, 'ready'));
  return out;
}

function renderRows() {
  const list = $('#beats');
  list.replaceChildren(
    ...state.data.beats.map((b, i) => {
      const pb = state.plan.beats.find((x) => x.id === b.id);
      const e = entryOf(b.id);
      const vo = steps(b.id).vo?.duration;
      const meta = [
        b.surface,
        e ? `picture ${secs(e.picture[1] - e.picture[0])}` : null,
        typeof vo === 'number' ? `VO ${secs(vo)}` : 'no VO',
        b.cut ? `${b.cut > 0 ? 'J' : 'L'} cut ${signed(b.cut)}` : null,
        b.cam && b.cam !== 'off' ? `camera ${b.cam}` : null,
      ].filter(Boolean);
      const reasons = (pb?.steps ?? []).filter((st) => !st.reasons.every((r) => r.startsWith('follows ')));
      return el(
        'li',
        {
          class: `beat${b.skip ? ' skipped' : ''}`,
          'data-id': b.id,
          onclick: () => e && seek(e.picture[0]),
        },
        el('div', { class: 'n' }, String(i + 1)),
        thumb(b),
        el(
          'div',
          { class: 'info' },
          el('div', { class: 'title' }, b.title, ' ', el('code', {}, b.id)),
          el('div', { class: 'meta' }, meta.join(' · ')),
          el('div', { class: 'text' }, b.text),
          reasons.length
            ? el('ul', { class: 'why' }, ...reasons.map((st) => el('li', {}, `${STEP_LABEL[st.step]}: ${st.reasons.join('; ')}`)))
            : null,
        ),
        el('div', { class: 'badges' }, ...badges(b, pb)),
      );
    }),
  );
}

// --- Ruler ---------------------------------------------------------------------------------------------------------

const pct = (x) => `${(100 * x) / (total() || 1)}%`;
const span = (cls, [a, z], { style, ...attrs } = {}, ...kids) =>
  el('div', { class: cls, ...attrs, style: { left: pct(a), width: pct(z - a), ...style } }, ...kids);

function renderRuler() {
  const t = state.timeline;
  const pic = $('#lane-picture');
  const voice = $('#lane-voice');
  const ticks = $('#lane-ticks');
  if (!t) return [pic, voice, ticks].forEach((l) => l.replaceChildren());
  const hue = (i) => String((i * 67 + 200) % 360);
  pic.replaceChildren(
    ...t.beats.map((e, i) =>
      span(
        'pic',
        e.picture,
        { 'data-id': e.id, title: `${e.id}: picture ${fmt(e.picture[0])}–${fmt(e.picture[1])}`, style: { '--hue': hue(i) } },
        e.id,
      ),
    ),
    ...overlaps(t).map((o) =>
      span(`overlap ${o.kind}`, o.range, {
        title: `${o.kind} cut: "${o.voice}" narrates over "${o.picture}"'s picture. Keep these words off the screen.`,
      }),
    ),
    ...t.beats.slice(1).map((e) => el('div', { class: 'cut', 'data-id': e.id, style: { left: pct(e.picture[0]) } })),
  );
  voice.replaceChildren(
    ...t.beats.map((e, i) => {
      const D = steps(e.id).vo?.duration ?? 0;
      const B = e.block[1] - e.block[0] || 1;
      const vo = D
        ? el('div', { class: 'vo', style: { left: `${(100 * (e.voAt - e.block[0])) / B}%`, width: `${(100 * D) / B}%` } })
        : null;
      return span('block', e.block, { 'data-id': e.id, title: `${e.id}: VO at ${fmt(e.voAt)}`, style: { '--hue': hue(i) } }, vo);
    }),
  );
  const step = total() > 60 ? 10 : total() > 20 ? 5 : 1;
  const marks = [];
  for (let s = 0; s <= total() + 1e-6; s += step) marks.push(el('div', { class: 'tick', style: { left: pct(s) } }, fmt(s).replace(/\.00$/, '')));
  ticks.replaceChildren(...marks);
}

// Scrubbing: press and drag anywhere on the lanes.
function setupRuler() {
  const lanes = $('#lanes');
  let resume = false;
  const at = (ev) => {
    const r = lanes.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / r.width, 0, 1) * total();
  };
  lanes.addEventListener('pointerdown', (ev) => {
    if (!state.timeline) return;
    resume = state.playing;
    pause();
    lanes.setPointerCapture(ev.pointerId);
    seek(at(ev));
  });
  lanes.addEventListener('pointermove', (ev) => lanes.hasPointerCapture(ev.pointerId) && seek(at(ev)));
  lanes.addEventListener('pointerup', () => resume && play());
}

// --- Preview -------------------------------------------------------------------------------------------------------

const audio = { ctx: null, buffers: new Map(), sources: [], t0: 0, x0: 0 };

const preview = {
  clips: [], // per timeline beat: { e, node, videos: [{ video, map(x) → [fileTime, clamped] }] }
  pool: new Map(), // `${role}:${src}` → <video>, kept across rebuilds

  video(role, src) {
    const k = `${role}:${src}`;
    let v = this.pool.get(k);
    if (!v) {
      v = el('video', { class: role, muted: true, preload: 'auto', playsinline: true, src: media(src) });
      v.muted = true;
      this.pool.set(k, v);
    }
    return v;
  },

  build() {
    const stage = $('#stage');
    const [W, H] = state.data.size ?? [1920, 1080];
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;
    stage.style.background = BACKDROP;
    fit();
    const used = new Set();
    const t = state.timeline;
    this.clips = (t?.beats ?? []).map((e) => {
      const s = steps(e.id);
      const node = el('div', { class: 'clip', 'data-id': e.id, hidden: true });
      const videos = [];
      const clampTo = (v, f, lo, hi) => {
        const end = Number.isFinite(v.duration) ? Math.min(hi, v.duration) : hi;
        const g = clamp(f, lo, Math.max(lo, end - 1 / FPS / 2));
        return [g, g !== f];
      };
      if (e.mode !== 'full') {
        if (exists(s.scene?.file)) {
          const v = this.video('screen', s.scene.file);
          used.add(v);
          node.append(v);
          videos.push({ video: v, map: (x) => clampTo(v, sceneFileTime(e, x), 0, s.scene.duration) });
        } else node.append(el('div', { class: 'placeholder' }, `${e.id}: not filmed yet`));
      }
      if (e.mode !== 'off') {
        if (e.camWindow && exists(s.cam?.file)) {
          const v = this.video(`cam ${e.mode}`, s.cam.file);
          used.add(v);
          if (e.mode === 'pip') {
            // assemble.mjs's geometry: size is the diameter as a fraction of the short side, margin in output pixels.
            const d = e.bubble.size * Math.min(W, H);
            const left = e.bubble.position.endsWith('right') ? W - d - e.bubble.margin : e.bubble.margin;
            const top = e.bubble.position.startsWith('top') ? e.bubble.margin : H - d - e.bubble.margin;
            Object.assign(v.style, { width: `${d}px`, height: `${d}px`, left: `${left}px`, top: `${top}px` });
          }
          node.append(v);
          videos.push({ video: v, map: (x) => clampTo(v, camFileTime(e, x), 0, s.cam.duration ?? Infinity) });
        } else node.append(el('div', { class: 'placeholder cam' }, `${e.id}: no camera take`));
      }
      return { e, node, videos };
    });
    for (const [k, v] of this.pool)
      if (!used.has(v)) {
        v.removeAttribute('src');
        v.load();
        this.pool.delete(k);
      }
    stage.replaceChildren(...this.clips.map((c) => c.node), el('div', { id: 'captions' }));
    this.shown = -1;
    this.sync(now());
  },

  // Show and drive whatever is on screen at timeline time x.
  sync(x) {
    const clips = this.clips;
    let i = clips.findIndex((c) => x >= c.e.picture[0] - 1e-9 && x < c.e.picture[1]);
    if (i < 0 && clips.length) i = clips.length - 1;
    if (i !== this.shown) {
      clips.forEach((c, k) => (c.node.hidden = k !== i));
      for (const row of document.querySelectorAll('#beats .beat'))
        row.classList.toggle('active', row.dataset.id === clips[i]?.e.id);
      this.shown = i;
    }
    clips.forEach((c, k) => {
      for (const m of c.videos) {
        const v = m.video;
        if (k === i) {
          const [f, clamped] = m.map(x);
          if (state.playing && !clamped) {
            if (v.paused) {
              v.currentTime = f;
              v.play().catch(() => {});
            } else if (Math.abs(v.currentTime - f) > 0.15 && !v.seeking) v.currentTime = f;
          } else {
            if (!v.paused) v.pause();
            if (!v.seeking && Math.abs(v.currentTime - f) > 0.5 / FPS) v.currentTime = f;
          }
        } else {
          if (!v.paused) v.pause();
          // Cue up the next clip just before its boundary, so the switch doesn't wait on a seek.
          if (k === i + 1 && c.e.picture[0] - x < 1) {
            const [f] = m.map(c.e.picture[0]);
            if (!v.seeking && Math.abs(v.currentTime - f) > 0.5 / FPS) v.currentTime = f;
          }
        }
      }
    });
    this.captions(x, clips[i]?.e);
  },

  captions(x, e) {
    const box = $('#captions');
    const cues = (e?.overlays ?? []).filter((c) => x >= c.start && x < c.end);
    const key = cues.map((c) => `${c.position}|${c.text}`).join('\n');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(
      ...cues.map((c) => el('div', { class: `cue ${c.position}` }, el('div', { class: 'pill' }, c.text))),
    );
  },

  // True once every video on screen shows the frame for the playhead (for scripted checks and screenshots).
  ready() {
    const c = this.clips[this.shown];
    return !c || c.videos.every((m) => !m.video.seeking && m.video.readyState >= 2 && Math.abs(m.video.currentTime - m.map(now())[0]) < 0.05);
  },
};

// Scale the output-pixel stage to the frame's width.
function fit() {
  const [W, H] = state.data?.size ?? [1920, 1080];
  const frame = $('#frame');
  const scale = Math.min(frame.clientWidth / W, (window.innerHeight * 0.55) / H);
  frame.style.height = `${H * scale}px`;
  const stage = $('#stage');
  stage.style.transform = `scale(${scale})`;
  stage.style.left = `${(frame.clientWidth - W * scale) / 2}px`;
  // Caption sizing follows caption-frames.mjs: 3.7% of the short side, inset 6% (landscape) or 16%/9% (portrait).
  const unit = Math.min(W, H);
  const portrait = H > W;
  stage.style.setProperty('--font', `${Math.round(unit * 0.037)}px`);
  stage.style.setProperty('--bottom', `${Math.round(portrait ? H * 0.16 : H * 0.06)}px`);
  stage.style.setProperty('--top', `${Math.round(portrait ? H * 0.09 : H * 0.04)}px`);
  stage.style.setProperty('--side', `${Math.round(W * 0.04)}px`);
}

async function voBuffer(rel) {
  if (!audio.buffers.has(rel))
    audio.buffers.set(
      rel,
      fetch(media(rel))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${rel}: ${r.status}`))))
        .then((b) => audio.ctx.decodeAudioData(b))
        .catch((err) => {
          console.warn(err);
          return null;
        }),
    );
  return audio.buffers.get(rel);
}

export function now() {
  return state.playing ? Math.min(total(), audio.x0 + Math.max(0, audio.ctx.currentTime - audio.t0)) : state.x;
}

export async function play() {
  if (state.playing || !state.timeline) return;
  audio.ctx ??= new AudioContext();
  await audio.ctx.resume();
  if (state.x >= total() - 1 / FPS) state.x = 0;
  const entries = state.timeline.beats;
  const bufs = await Promise.all(
    entries.map((e) => (exists(steps(e.id).vo?.file) ? voBuffer(steps(e.id).vo.file) : null)),
  );
  if (state.playing) return;
  audio.x0 = state.x;
  audio.t0 = audio.ctx.currentTime + 0.05;
  entries.forEach((e, i) => {
    const buf = bufs[i];
    const off = audio.x0 - e.voAt;
    if (!buf || off >= buf.duration) return;
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.ctx.destination);
    src.start(audio.t0 + Math.max(0, -off), Math.max(0, off));
    audio.sources.push(src);
  });
  state.playing = true;
  $('#play').textContent = 'Pause';
}

export function pause() {
  if (!state.playing) return;
  state.x = now();
  state.playing = false;
  for (const s of audio.sources) s.stop();
  audio.sources = [];
  $('#play').textContent = 'Play';
}

export function seek(x) {
  const resume = state.playing;
  pause();
  state.x = clamp(x, 0, total());
  preview.sync(state.x);
  if (resume) play();
}

function frame() {
  let x = now();
  if (state.playing && x >= total()) {
    pause();
    x = state.x = total();
  }
  if (state.timeline) {
    preview.sync(x);
    $('#playhead').style.left = pct(x);
    $('#time').textContent = `${fmt(x)} / ${fmt(total())}`;
  }
  requestAnimationFrame(frame);
}

function setupKeys() {
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea, select, [contenteditable]')) return;
    if (ev.key === ' ') {
      ev.preventDefault();
      state.playing ? pause() : play();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const d = (ev.shiftKey ? 1 : 1 / FPS) * (ev.key === 'ArrowLeft' ? -1 : 1);
      seek(Math.round((now() + d) * FPS) / FPS);
    }
  });
}

// --- Start ---------------------------------------------------------------------------------------------------------

window.editor = {
  state,
  load,
  update,
  play,
  pause,
  seek,
  now,
  overlaps: () => (state.timeline ? overlaps(state.timeline) : []),
  // Resolves once the preview shows the frame for the playhead.
  settled: () =>
    new Promise((resolve) => {
      const check = () => (preview.ready() ? resolve() : requestAnimationFrame(check));
      check();
    }),
};

$('#play').addEventListener('click', () => (state.playing ? pause() : play()));
window.addEventListener('resize', () => state.data && fit());
setupRuler();
setupKeys();
load()
  .then(() => requestAnimationFrame(frame))
  .catch((err) => {
    $('#title').textContent = 'Could not load the project';
    const box = $('#error');
    box.hidden = false;
    box.textContent = err.message;
  });
