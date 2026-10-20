/*
 * The clip editor's page: the project's beats with what each needs rebuilt, a live preview of the edit, and the
 * controls to change it.
 *
 * Everything shown is computed here from GET /api/project's { data, build, facts } by the same plan() and timeline()
 * the pipeline runs (served from /lib/), so the preview is never a second implementation of the edit. Every edit goes
 * through change(), which mutates state.data, marks it unsaved and calls update() to recompute and redraw, so
 * staleness (a VO to redo after a text edit, a re-shoot once a cut leaves the handles) shows as you type or drag.
 *
 * The preview plays from the source media, not a render: one <video> per picture span, shown while the playhead is
 * inside it and seeked through the scene-time mapping (file time = sceneWindow[0] + (x − picture[0]) + duration − end);
 * the VO through Web Audio, each beat's buffer scheduled at its voAt; the camera as a full-frame or circle-masked
 * <video> cut by camWindow; captions as DOM text from the timeline's overlays. The stage is laid out in output pixels
 * and scaled to fit, so caption and bubble geometry match assemble.mjs. The clock is the AudioContext's, and videos
 * are nudged back whenever they drift from it. It's an approximation (no loudnorm, no exact compositing): Render is
 * the real thing.
 *
 * Editing: drag a cut (on the picture lane) or a lead/tail edge (on the voice lane); drags stop at the recorded
 * handles, and holding Alt drags past them, which shows the beat needs a re-shoot. Each beat row has reorder and skip
 * buttons and, under Edit, its text/say, timing, camera, caption position and flags. Save (⌘S) PUTs screencast.json
 * with the hash it was read with; if the file changed on disk meanwhile the server refuses (409) and the page says
 * "changed on disk — reload". The page follows /api/events: build.json changes and clean screencast.json changes
 * reload silently, a screencast.json change under unsaved edits raises the same conflict notice. Render saves, runs
 * assemble.mjs (forced when beats are stale, as a draft), streams its output and plays the result. The page never
 * writes build.json, and never runs TTS, recording or filming (D16).
 *
 * window.editor exposes the state, transport and actions for scripted checks (test/editor-page.test.mjs).
 */
import { plan } from '/lib/status.mjs';
import { FPS, LAST_TAIL, LEAD, TAIL, timeline } from '/lib/timeline.mjs';

const $ = (sel) => document.querySelector(sel);
const BACKDROP = '#0b0d12'; // assemble.mjs's letterbox colour
const STEP_LABEL = { vo: 'VO', transcribe: 'transcribe', film: 'film', qa: 'QA' };
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const FLAGS = ['reshoot', 'revo', 'qa'];

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
  dirty: false, // unsaved edits
  saving: false,
  conflict: false, // screencast.json changed on disk under unsaved edits
  notice: null, // { kind: 'conflict' | 'error' | 'info', text }
  rendering: false,
};

// --- Data ----------------------------------------------------------------------------------------------------------

async function fetchProject() {
  const r = await fetch('/api/project', { cache: 'no-store' });
  const s = await r.json();
  if (!r.ok) throw new Error(s.error);
  return s;
}

// (Re)load everything from disk, discarding unsaved edits.
export async function load() {
  const s = await fetchProject();
  Object.assign(state, { data: s.data, hash: s.hash, build: s.build, facts: s.facts });
  Object.assign(state, { dirty: false, conflict: false, notice: null });
  update();
}

// After a file changed on disk: take the new build state, and the new screencast.json unless that would lose edits.
let refreshing = false;
let refreshAgain = false;
export async function refresh() {
  if (refreshing || state.saving) return void (refreshAgain = true);
  refreshing = true;
  try {
    const s = await fetchProject();
    Object.assign(state, { build: s.build, facts: s.facts });
    if (s.hash !== state.hash) {
      if (!state.dirty) Object.assign(state, { data: s.data, hash: s.hash, conflict: false, notice: null });
      else {
        state.conflict = true;
        state.notice = {
          kind: 'conflict',
          text: 'screencast.json changed on disk — reload (your unsaved edits would overwrite it)',
        };
      }
    }
    update();
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

// Recompute the plan and timeline from state.data and redraw everything.
export function update() {
  state.plan = plan(state.data, state.build, state.facts);
  state.timeline = state.plan.timeline;
  renderHeader();
  renderSettings();
  renderRows();
  renderRuler();
  preview.build();
  if (state.x > total()) seek(total());
}

// Every edit: mutate screencast.json in memory, then recompute. fn gets the data, or the beat when given an id.
export function change(id, fn) {
  if (typeof id === 'function') [id, fn] = [null, id];
  fn(id === null ? state.data : beatOf(id));
  state.dirty = true;
  if (state.notice?.kind !== 'conflict') state.notice = null;
  update();
}

const total = () => state.timeline?.total ?? 0;
const steps = (id) => state.build?.beats?.[id] ?? {};
const exists = (rel) => typeof rel === 'string' && state.facts.exists.includes(rel);
const entryOf = (id) => state.timeline?.beats.find((e) => e.id === id);
const beatOf = (id) => state.data.beats.find((b) => b.id === id);
const hasCamera = () => Boolean(state.data.voice?.human && state.data.camera);

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

// --- Timing edits: cut, lead, tail ----------------------------------------------------------------------------------

const isLast = (b) => state.data.beats.filter((x) => !x.skip).at(-1) === b;
const timingDefault = (b, field) => (field === 'cut' ? 0 : field === 'lead' ? LEAD : isLast(b) ? LAST_TAIL : TAIL);
const timingOf = (b, field) => b[field] ?? timingDefault(b, field);

// Set a timing field, leaving it out of the file when it's the default.
function setTiming(b, field, v) {
  if (v === null || !Number.isFinite(v)) return void delete b[field];
  v = Math.round(v * 1000) / 1000;
  if (Math.abs(v - timingDefault(b, field)) < 1e-6) delete b[field];
  else b[field] = v;
}

// The beats whose picture runs off its recorded footage (they'd need a re-shoot), or null for an impossible edit.
function offFootage() {
  try {
    const t = timeline(state.data, state.build);
    return new Set(t.beats.filter((e) => e.stale.some((s) => s.step === 'film')).map((e) => e.id));
  } catch {
    return null;
  }
}

// How far a drag may take beat `id`'s `field`, in whole frames: `hard` is what the timeline allows at all, `soft`
// what stays inside the handles (no beat newly off its footage). Found by trying each frame through timeline() itself,
// so the limits always agree with what the render and status.mjs will say.
function limits(id, field) {
  const b = beatOf(id);
  const had = Object.hasOwn(b, field);
  const old = b[field];
  const at = (k) => {
    b[field] = k / FPS;
    return offFootage();
  };
  const k0 = Math.round(timingOf(b, field) * FPS);
  const kn = Math.round(timingDefault(b, field) * FPS);
  const [lo, hi] = field === 'cut' ? [-10 * FPS, 10 * FPS] : [0, 10 * FPS];
  const scan = (ok, from, dir, bound) => {
    let k = from;
    while (dir * (bound - k) > 0 && ok(k + dir)) k += dir;
    return k;
  };
  const possible = (k) => at(k) !== null;
  const base = at(kn);
  const inside = (k) => {
    const s = at(k);
    return s !== null && [...s].every((x) => base?.has(x));
  };
  const from = possible(k0) ? k0 : kn;
  const hard = [scan(possible, from, -1, lo), scan(possible, from, 1, hi)];
  const soft = base ? [scan(inside, kn, -1, lo), scan(inside, kn, 1, hi)] : hard;
  if (had) b[field] = old;
  else delete b[field];
  // Never snap the current value: a beat already past its handles can still be dragged back.
  return {
    hard: hard.map((k) => k / FPS),
    soft: [Math.max(hard[0], Math.min(soft[0], k0)) / FPS, Math.min(hard[1], Math.max(soft[1], k0)) / FPS],
  };
}

// Reorder: a beat moves past its neighbour. Only the first beat in the file may not carry a cut.
function move(id, d) {
  change((data) => {
    const i = data.beats.findIndex((b) => b.id === id);
    const j = i + d;
    if (j < 0 || j >= data.beats.length) return;
    [data.beats[i], data.beats[j]] = [data.beats[j], data.beats[i]];
    delete data.beats[0].cut;
  });
}

// --- Header, settings and actions ------------------------------------------------------------------------------------

function renderHeader() {
  const d = state.data;
  const [W, H] = d.size ?? [1920, 1080];
  document.title = `${state.dirty ? '• ' : ''}${d.title} · screencast editor`;
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
  renderActions();
}

// The beats that would make Render a forced draft: anything status wants rebuilt or re-checked first.
const staleBeats = () => state.plan.beats.filter((b) => b.steps.length).map((b) => b.id);

function renderActions() {
  const save = $('#save');
  save.disabled = !state.dirty || state.saving;
  save.textContent = state.saving ? 'Saving…' : 'Save';
  $('#save-status').textContent = state.conflict ? '' : state.dirty ? 'Unsaved changes' : '';
  const render = $('#render');
  const stale = staleBeats();
  render.disabled = state.rendering || Boolean(state.plan.error) || state.conflict;
  render.textContent = state.rendering ? 'Rendering…' : stale.length ? 'Render draft' : 'Render';
  render.title = stale.length
    ? `Not everything is current (${stale.join(', ')}): renders anyway, cloning edge frames where footage is ` +
      'missing. Ask the agent to rebuild and QA for the final video.'
    : 'Save and render the video';
  const box = $('#notice');
  const n = state.notice;
  box.hidden = !n;
  box.className = n ? n.kind : '';
  box.replaceChildren(
    ...(n
      ? [
          el('span', {}, n.text),
          n.kind === 'conflict'
            ? el('button', { type: 'button', onclick: () => load() }, 'Reload (discard my edits)')
            : null,
        ]
      : []),
  );
}

// Inputs keep what the user is typing: a redraw only rewrites a control that doesn't have focus.
function setValue(input, v) {
  if (document.activeElement === input) return;
  if (input.type === 'checkbox') input.checked = Boolean(v);
  else input.value = v ?? '';
}

function renderSettings() {
  const d = state.data;
  $('#set-voice-tts').hidden = Boolean(d.voice.human);
  $('#set-voice-human').hidden = !d.voice.human;
  setValue($('#set-voice'), d.voice.tts);
  setValue($('#set-normalize'), d.voice.normalize);
  const [W, H] = d.size ?? [1920, 1080];
  setValue($('#set-w'), W);
  setValue($('#set-h'), H);
  setValue($('#set-burn'), d.captions?.burn);
}

function setupSettings() {
  $('#set-voice').addEventListener('input', (ev) => {
    const v = ev.target.value.trim();
    if (v) change((d) => (d.voice.tts = v));
  });
  $('#set-normalize').addEventListener('change', (ev) =>
    change((d) => (ev.target.checked ? (d.voice.normalize = true) : delete d.voice.normalize)),
  );
  const size = () => {
    const [w, h] = [Number($('#set-w').value), Number($('#set-h').value)];
    if (![w, h].every((n) => Number.isInteger(n) && n >= 16 && n <= 7680)) return;
    const [W, H] = state.data.size ?? [1920, 1080];
    if (w !== W || h !== H) change((d) => (d.size = [w, h]));
  };
  $('#set-w').addEventListener('input', size);
  $('#set-h').addEventListener('input', size);
  $('#set-burn').addEventListener('change', (ev) => change((d) => (d.captions = { ...d.captions, burn: ev.target.checked })));
  $('#save').addEventListener('click', () => save());
  $('#render').addEventListener('click', () => render());
}

// --- Beat rows -----------------------------------------------------------------------------------------------------

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

// A film step on a beat that has footage means the edit ran past its handles: say so plainly.
const stepLabel = (id, step) => (step === 'film' && steps(id).scene ? 'reshoot' : STEP_LABEL[step]);

function badges(b, pb) {
  const out = [];
  if (b.skip) out.push(el('span', { class: 'badge skip' }, 'skipped'));
  for (const st of pb?.steps ?? []) {
    const follows = st.reasons.every((r) => r.startsWith('follows '));
    out.push(
      el(
        'span',
        { class: `badge step ${follows ? 'follows' : 'stale'}`, title: st.reasons.join('\n') },
        stepLabel(b.id, st.step),
      ),
    );
  }
  for (const f of b.needs ?? [])
    out.push(el('span', { class: 'badge flag', title: f.note ?? '' }, `⚑ ${f.kind}${f.note ? `: ${f.note}` : ''}`));
  if (!b.skip && !pb?.steps.length) out.push(el('span', { class: 'badge ok' }, 'ready'));
  return out;
}

const select = (options, onchange, attrs = {}) =>
  el(
    'select',
    { ...attrs, onchange: (ev) => onchange(ev.target.value) },
    ...options.map((o) => (Array.isArray(o) ? el('option', { value: o[0] }, o[1]) : el('option', { value: o }, o))),
  );
const field = (label, ...controls) => el('label', { class: 'field' }, el('span', {}, label), ...controls);

// A beat's row, built once per id; fillRow() refreshes it. Controls look the beat up by id on every edit.
const rows = new Map();
function makeRow(id) {
  const c = {};
  const timing = (name) =>
    el('input', {
      type: 'number',
      step: '0.01',
      class: 'num',
      name,
      oninput: (ev) =>
        change(id, (b) => setTiming(b, name, ev.target.value === '' ? null : Number(ev.target.value))),
    });
  c.up = el('button', { type: 'button', class: 'icon', name: 'up', title: 'Move earlier', onclick: () => move(id, -1) }, '↑');
  c.down = el('button', { type: 'button', class: 'icon', name: 'down', title: 'Move later', onclick: () => move(id, 1) }, '↓');
  c.skip = el('input', {
    type: 'checkbox',
    name: 'skip',
    onchange: (ev) => change(id, (b) => (ev.target.checked ? (b.skip = true) : delete b.skip)),
  });
  c.text = el('textarea', { rows: 2, name: 'text', oninput: (ev) => change(id, (b) => (b.text = ev.target.value)) });
  c.say = el('textarea', {
    rows: 2,
    name: 'say',
    placeholder: 'same as the text',
    oninput: (ev) => change(id, (b) => (ev.target.value ? (b.say = ev.target.value) : delete b.say)),
  });
  c.lead = timing('lead');
  c.tail = timing('tail');
  c.cut = timing('cut');
  c.captionPosition = select(['bottom', 'top'], (v) => change(id, (b) => (v === 'bottom' ? delete b.captionPosition : (b.captionPosition = v))), { name: 'captionPosition' });
  c.cam = select(['off', 'pip', 'full'], (v) => change(id, (b) => (v === 'off' ? delete b.cam : (b.cam = v))), { name: 'cam' });
  const bubble = (k, v) =>
    change(id, (b) => {
      const next = { ...b.bubble, [k]: v };
      if (v === undefined) delete next[k];
      if (Object.keys(next).length) b.bubble = next;
      else delete b.bubble;
    });
  c.bubblePosition = select([['', 'project default'], ...POSITIONS], (v) => bubble('position', v || undefined), { name: 'bubblePosition' });
  c.bubbleSize = el('input', {
    type: 'number',
    step: '0.01',
    min: '0.05',
    max: '1',
    class: 'num',
    name: 'bubbleSize',
    oninput: (ev) => {
      const v = Number(ev.target.value);
      if (ev.target.value === '') bubble('size', undefined);
      else if (v >= 0.05 && v <= 1) bubble('size', v);
    },
  });
  c.flags = el('ul', { class: 'flags' });
  c.flagKind = select(FLAGS, () => {}, { name: 'flagKind' });
  c.flagNote = el('input', { type: 'text', name: 'flagNote', placeholder: 'note (what to fix)' });
  const addFlag = () => {
    const note = c.flagNote.value.trim();
    change(id, (b) => (b.needs = [...(b.needs ?? []), { kind: c.flagKind.value, ...(note ? { note } : {}) }]));
    c.flagNote.value = '';
  };
  c.flagNote.addEventListener('keydown', (ev) => ev.key === 'Enter' && addFlag());
  c.flagAdd = el('button', { type: 'button', name: 'flagAdd', onclick: addFlag }, 'Add flag');

  c.sayField = field('Say (TTS)', c.say);
  c.camField = field('Camera', c.cam);
  c.bubbleField = el('div', { class: 'group' }, field('Bubble', c.bubblePosition), field('size', c.bubbleSize));
  const r = {
    c,
    n: el('div', { class: 'n' }),
    thumb: el('div', { class: 'thumb-box' }),
    title: el('div', { class: 'title' }),
    meta: el('div', { class: 'meta' }),
    text: el('div', { class: 'text' }),
    why: el('ul', { class: 'why' }),
    badges: el('div', { class: 'badges' }),
  };
  r.edit = el(
    'details',
    { class: 'edit' },
    el('summary', {}, 'Edit'),
    el(
      'div',
      { class: 'form' },
      field('Text', c.text),
      c.sayField,
      el('div', { class: 'group' }, field('Lead', c.lead), field('Tail', c.tail), field('Cut', c.cut), field('Captions', c.captionPosition)),
      el('div', { class: 'group' }, c.camField, c.bubbleField),
      el('div', { class: 'flag-box' }, el('span', {}, 'Flags'), c.flags, el('div', { class: 'group' }, c.flagKind, c.flagNote, c.flagAdd)),
    ),
  );
  r.li = el(
    'li',
    {
      class: 'beat',
      'data-id': id,
      onclick: (ev) => {
        if (ev.target.closest('.edit, .tools')) return;
        const e = entryOf(id);
        if (e) seek(e.picture[0]);
      },
    },
    r.n,
    r.thumb,
    el('div', { class: 'info' }, r.title, r.meta, r.text, r.why, r.edit),
    el('div', { class: 'side' }, r.badges, el('div', { class: 'tools' }, c.up, c.down, el('label', { class: 'skip' }, c.skip, 'skip'))),
  );
  rows.set(id, r);
  return r;
}

function fillRow(r, b, i) {
  const { c } = r;
  const pb = state.plan.beats.find((x) => x.id === b.id);
  const e = entryOf(b.id);
  const vo = steps(b.id).vo?.duration;
  r.li.classList.toggle('skipped', Boolean(b.skip));
  r.n.textContent = String(i + 1);
  r.thumb.replaceChildren(thumb(b));
  r.title.replaceChildren(b.title, ' ', el('code', {}, b.id));
  r.meta.textContent = [
    b.surface,
    e ? `picture ${secs(e.picture[1] - e.picture[0])}` : null,
    typeof vo === 'number' ? `VO ${secs(vo)}` : 'no VO',
    b.cut ? `${b.cut > 0 ? 'J' : 'L'} cut ${signed(b.cut)}` : null,
    b.cam && b.cam !== 'off' ? `camera ${b.cam}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  r.text.textContent = b.text;
  const reasons = (pb?.steps ?? []).filter((st) => !st.reasons.every((x) => x.startsWith('follows ')));
  r.why.hidden = !reasons.length;
  r.why.replaceChildren(...reasons.map((st) => el('li', {}, `${stepLabel(b.id, st.step)}: ${st.reasons.join('; ')}`)));
  r.badges.replaceChildren(...badges(b, pb));

  c.up.disabled = i === 0;
  c.down.disabled = i === state.data.beats.length - 1;
  setValue(c.skip, b.skip);
  setValue(c.text, b.text);
  c.sayField.hidden = Boolean(state.data.voice.human);
  setValue(c.say, b.say);
  for (const name of ['lead', 'tail', 'cut']) {
    setValue(c[name], b[name]);
    c[name].placeholder = String(timingDefault(b, name));
  }
  // The first beat on screen has no boundary into it, so no cut.
  c.cut.disabled = i === 0 || state.timeline?.beats[0]?.id === b.id;
  setValue(c.captionPosition, b.captionPosition ?? 'bottom');
  c.camField.hidden = !hasCamera();
  c.cam.disabled = b.surface === 'camera';
  setValue(c.cam, b.cam ?? 'off');
  c.bubbleField.hidden = !hasCamera() || b.cam !== 'pip';
  setValue(c.bubblePosition, b.bubble?.position ?? '');
  setValue(c.bubbleSize, b.bubble?.size);
  c.bubbleSize.placeholder = String(state.data.camera?.bubble?.size ?? 0.22);
  c.flags.replaceChildren(
    ...(b.needs ?? []).map((f, k) =>
      el(
        'li',
        {},
        el('span', { class: 'kind' }, f.kind),
        f.note ? ` ${f.note}` : '',
        el(
          'button',
          {
            type: 'button',
            class: 'icon',
            title: 'Remove this flag',
            onclick: () =>
              change(b.id, (x) => {
                x.needs.splice(k, 1);
                if (!x.needs.length) delete x.needs;
              }),
          },
          '✕',
        ),
      ),
    ),
  );
}

function renderRows() {
  const list = $('#beats');
  const ids = new Set(state.data.beats.map((b) => b.id));
  for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
  const lis = state.data.beats.map((b, i) => {
    const r = rows.get(b.id) ?? makeRow(b.id);
    fillRow(r, b, i);
    return r.li;
  });
  // Only re-append when the order changed: moving a focused textarea would blur it.
  if (lis.length !== list.children.length || lis.some((li, i) => list.children[i] !== li)) list.replaceChildren(...lis);
}

// --- Ruler ---------------------------------------------------------------------------------------------------------

let drag = null; // { id, field, v0, x0, width, total, lim }

// While dragging, the ruler keeps the scale it had when the drag started, so a lead/tail drag (which changes the
// total) doesn't slide the handle away from the pointer.
const scale = () => drag?.total ?? total();
const pct = (x) => `${(100 * x) / (scale() || 1)}%`;
const span = (cls, [a, z], { style, ...attrs } = {}, ...kids) =>
  el('div', { class: cls, ...attrs, style: { left: pct(a), width: pct(z - a), ...style } }, ...kids);
const handle = (field, id, x, title) =>
  el('div', { class: `handle ${field}`, 'data-handle': field, 'data-id': id, title, style: { left: pct(x) } });

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
        `pic${e.stale.some((s) => s.step === 'film') ? ' over' : ''}`,
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
    ...t.beats
      .slice(1)
      .map((e) => handle('cut', e.id, e.picture[0], `Drag to move the cut into "${e.id}" (Alt: past the handles)`)),
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
    ...t.beats.flatMap((e) => [
      handle('lead', e.id, e.voAt, `Drag to change "${e.id}"'s lead (the pause before its VO)`),
      handle('tail', e.id, e.block[1], `Drag to change "${e.id}"'s tail (the pause after its VO)`),
    ]),
  );
  const step = total() > 60 ? 10 : total() > 20 ? 5 : 1;
  const marks = [];
  for (let s = 0; s <= total() + 1e-6; s += step) marks.push(el('div', { class: 'tick', style: { left: pct(s) } }, fmt(s).replace(/\.00$/, '')));
  ticks.replaceChildren(...marks);
}

// Where a dragged handle sits now, so the preview can show that frame.
function handleAt(id, field) {
  const e = entryOf(id);
  if (!e) return null;
  return field === 'cut' ? e.picture[0] : field === 'lead' ? e.voAt : e.block[1] - 1 / FPS;
}

// Press and drag on the lanes: on a handle it edits, anywhere else it scrubs.
function setupRuler() {
  const lanes = $('#lanes');
  let resume = false;
  const at = (ev) => {
    const r = lanes.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / r.width, 0, 1) * total();
  };
  lanes.addEventListener('pointerdown', (ev) => {
    if (!state.timeline) return;
    lanes.setPointerCapture(ev.pointerId);
    const h = ev.target.closest('[data-handle]');
    if (h) {
      pause();
      const { id, handle: f } = h.dataset;
      drag = {
        id,
        field: f,
        v0: timingOf(beatOf(id), f),
        x0: ev.clientX,
        width: lanes.getBoundingClientRect().width,
        total: total(),
        lim: limits(id, f),
      };
      return;
    }
    resume = state.playing;
    pause();
    seek(at(ev));
  });
  lanes.addEventListener('pointermove', (ev) => {
    if (!lanes.hasPointerCapture(ev.pointerId)) return;
    if (!drag) return seek(at(ev));
    const { id, field: f, v0, x0, width, total: T, lim } = drag;
    const [lo, hi] = ev.altKey ? lim.hard : lim.soft;
    const v = clamp(Math.round((v0 + ((ev.clientX - x0) / width) * T) * FPS) / FPS, lo, hi);
    if (Math.abs(v - timingOf(beatOf(id), f)) < 1e-6) return;
    change(id, (b) => setTiming(b, f, v));
    const x = handleAt(id, f);
    if (x !== null) seek(x);
  });
  const end = () => {
    if (drag) {
      drag = null;
      renderRuler();
    } else if (resume) play();
    resume = false;
  };
  lanes.addEventListener('pointerup', end);
  lanes.addEventListener('pointercancel', end);
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

// --- Save and render -----------------------------------------------------------------------------------------------

// PUT screencast.json with the hash it was read with. Resolves true when saved.
export async function save() {
  if (!state.dirty || state.saving) return !state.dirty;
  state.saving = true;
  renderActions();
  try {
    const r = await fetch('/api/project', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: state.data, hash: state.hash }),
    });
    const s = await r.json();
    if (r.ok) {
      Object.assign(state, { hash: s.hash, dirty: false, notice: null });
      return true;
    }
    if (r.status === 409) {
      state.conflict = true;
      state.notice = { kind: 'conflict', text: `Not saved: ${s.error}` };
    } else state.notice = { kind: 'error', text: `Not saved: ${s.error}` };
    return false;
  } catch (err) {
    state.notice = { kind: 'error', text: `Not saved: ${err.message}` };
    return false;
  } finally {
    state.saving = false;
    renderHeader();
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

// Server-sent events from a fetch() response (EventSource can't POST).
async function* events(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    for (let k; (k = buf.indexOf('\n\n')) >= 0; ) {
      const block = buf.slice(0, k);
      buf = buf.slice(k + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

// Save, run assemble.mjs (forced while anything is stale), stream its output, then play the result.
// Resolves to the exit code (null if it never ran).
export async function render() {
  if (state.rendering) return null;
  if (!(await save())) return null;
  const force = staleBeats().length > 0;
  const box = $('#render-out');
  const log = $('#render-log');
  const result = $('#result');
  box.hidden = false;
  result.hidden = true;
  log.textContent = force ? '(draft: some beats are stale, rendering with --force)\n' : '';
  state.rendering = true;
  renderActions();
  let code = null;
  try {
    const r = await fetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    for await (const { event, data } of events(r)) {
      if (event === 'done') code = data.code;
      else {
        log.append(el('span', { class: event }, `${data}\n`));
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    log.append(el('span', { class: 'err' }, `${err.message}\n`));
  } finally {
    state.rendering = false;
  }
  log.append(el('span', { class: code === 0 ? 'ok' : 'err' }, code === 0 ? 'Rendered.\n' : `Render failed (exit ${code}).\n`));
  await refresh();
  const out = state.facts.out;
  if (code === 0 && out && !out.startsWith('..') && !out.startsWith('/')) {
    pause();
    result.hidden = false;
    result.src = `${media(out)}?v=${Date.now()}`;
    result.play().catch(() => {});
  } else if (code === 0) log.append(el('span', {}, `The video is at ${out}.\n`));
  return code;
}

function setupKeys() {
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') {
      ev.preventDefault();
      save();
      return;
    }
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

// Follow the files: the agent or a pipeline script may write either JSON while the page is open.
function setupEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => refresh().catch((err) => console.warn(err)));
}

// --- Start ---------------------------------------------------------------------------------------------------------

window.editor = {
  state,
  load,
  refresh,
  update,
  change,
  save,
  render,
  play,
  pause,
  seek,
  now,
  limits,
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
window.addEventListener('beforeunload', (ev) => state.dirty && ev.preventDefault());
setupRuler();
setupKeys();
setupSettings();
load()
  .then(() => {
    setupEvents();
    requestAnimationFrame(frame);
  })
  .catch((err) => {
    $('#title').textContent = 'Could not load the project';
    const box = $('#error');
    box.hidden = false;
    box.textContent = err.message;
  });
