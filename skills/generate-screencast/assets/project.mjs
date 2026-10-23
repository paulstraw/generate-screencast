/*
 * The project data layer: one folder per screencast, whose screencast.json is the single source of truth for every
 * beat (script, voice, surface, camera, captions, edit decisions). Machine state lives beside it in build.json.
 *
 *   import { loadProject } from './project.mjs';
 *   const p = loadProject('~/Downloads/drafts-that-sync');   // throws on an invalid screencast.json
 *   p.data                  // screencast.json, parsed; edit it, then p.save()
 *   p.build                 // build.json ({ version, beats: {}, assembly? }); file paths absolute in memory
 *   p.beats                 // the non-skipped beats, in order
 *   p.find('save')          // a beat by id, skipped or not
 *   p.voFile('save')        // absolute paths for every file a beat owns (relative on disk, in build.json)
 *   p.recordBuild('save', { vo: { file: p.voFile('save'), key: voKey(p.data, beat), duration: 3.41 } });
 *   p.clearFlags('save', ['revo']);
 *   p.timeline()            // timeline.mjs's edit, with each beat's caption cues and voice onsets read from disk
 *   loadTimeline(dir)       // the same, for a folder
 *
 *   import { validate } from './project.mjs';
 *   const errors = validate(JSON.parse(fs.readFileSync('screencast.json', 'utf8')));
 *   // [{ path: 'beats[2].cam', message: 'must be pip | full | off' }, …]
 *
 * It is also the film helper. A project's film.mjs is choreography only:
 *
 *   import { loadProject, importPlaywright } from '<skill>/assets/project.mjs';
 *   import { setCur, glide, clickHere, bboxCenter } from '<skill>/assets/film-helpers.mjs';
 *   const p = loadProject(import.meta.dirname);
 *   const { chromium } = await importPlaywright();
 *   const browser = await chromium.launch();
 *   await p.film({
 *     save: p.browserScene(browser, async (page, b) => {
 *       await page.goto(URL, { waitUntil: 'networkidle' });
 *       await setCur(page, 960, 540);
 *       const clock = await b.ready();         // screen settled: holds the head handle, then scene time 0
 *       await clock.until(b.at('Save'));       // scene ms of the first "Save" in the VO; b.at(2): sentence 2
 *       await glide(page, x, y, 700);
 *     }),                                      // then holds to b.sceneMs + the tail handle and stops
 *   });
 *   await browser.close();
 *
 * `node film.mjs save` films only the named beats. Each filmed beat records its build.json `scene` entry and clears
 * its `reshoot` flags. p.beat(id) is { id, sceneMs, voAt, handle, at(word | n) }, all in scene-time milliseconds:
 * scene time 0 is when the clock starts, the VO starts at voAt (the lead), and sceneMs is lead + VO + tail. Every
 * recording keeps `handle` ms of footage before 0 and after sceneMs, so cuts and trims can move without re-shooting.
 * A scene is any async (b) => ({ file, end, footage? }): `end` is the scene time (seconds) of the file's last frame,
 * so scene time t is file time t + (duration − end), and `footage` the usable scene-time range (default [−handle or
 * the file's start, end]). native-helpers.mjs wraps its recorders the same way.
 *
 *   node project.mjs use <dir> <id> <file>   // points a beat's scene at a post-processed variant (device frame,
 *                                            // ripples) of the same length; `raw` keeps the original
 *   node project.mjs build mousectl|camrec   // compiles a native helper into the shared cache if it's missing or
 *                                            // stale, and prints its path (ensureBuilt)
 *
 * Playwright and Chromium live once per machine in ~/.cache/generate-screencast (PLAYWRIGHT_INSTALL), never in the
 * project or the user's repo; importPlaywright() loads them from there.
 *
 * screencast.schema.json describes the same shape for editor autocomplete. Validation is hand-rolled rather than a
 * schema library because the skill has no npm dependencies; `validateShape` mirrors the schema rule for rule (a test
 * walks the schema and checks they agree), and `validate` adds the cross-field rules a schema can't express.
 *
 * screencast.json has several writers (the editor, the agent, scripts clearing flags), so every save checks the file
 * still has the content hash it was read with and throws a ConflictError otherwise, rather than overwriting someone
 * else's edit. build.json has one writer class (the pipeline scripts); each write re-reads it, merges, and replaces it
 * atomically (temp file + rename), so a crash never leaves half a file and deleting it just means everything is stale.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSrt, respell, sentences, ttsCues, whisperCues } from './captions.mjs';
import { Clock, CURSOR_INIT, sleep } from './film-helpers.mjs';
import { HANDLE, timeline, voKey } from './timeline.mjs';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const LANG = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]+)*$/;
const SURFACES = ['web', 'storybook', 'terminal', 'macos', 'ios', 'android', 'hybrid', 'camera'];
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const FLAGS = ['reshoot', 'revo', 'qa'];

// A tiny checker over (value, path) pairs, collecting { path, message } in order.
function checker() {
  const errors = [];
  const fail = (path, message) => (errors.push({ path, message }), false);
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const is = {
    object: (v) => kind(v) === 'object',
    array: Array.isArray,
    string: (v) => typeof v === 'string',
    boolean: (v) => typeof v === 'boolean',
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
  };
  const c = {
    errors,
    type: (v, path, type) => is[type](v) || fail(path, `must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`),
    oneOf: (v, path, values) => values.includes(v) || fail(path, `must be ${values.join(' | ')}`),
    range: (v, path, min, max) =>
      (min === undefined || v >= min || fail(path, `must be ≥ ${min}`)) &&
      (max === undefined || v <= max || fail(path, `must be ≤ ${max}`)),
    match: (v, path, re) => re.test(v) || fail(path, `must match ${re.source}`),
    // An object with exactly these known keys; `required` must be present. Returns false if not an object.
    object(v, path, keys, required = []) {
      if (!c.type(v, path, 'object')) return false;
      for (const k of required) if (!(k in v)) fail(join(path, k), 'is required');
      for (const k of Object.keys(v)) if (keys && !keys.includes(k)) fail(join(path, k), 'is not allowed');
      return true;
    },
    // Runs `fn(value, path)` for each key present in `v` that has a rule.
    each(v, path, rules) {
      for (const [k, fn] of Object.entries(rules)) if (k in v) fn(v[k], join(path, k));
    },
    str: (re) => (v, path) => c.type(v, path, 'string') && (!re || c.match(v, path, re)),
    num:
      (min, max, type = 'number') =>
      (v, path) =>
        c.type(v, path, type) && c.range(v, path, min, max),
    bool: (v, path) => c.type(v, path, 'boolean'),
    enum: (values) => (v, path) => c.oneOf(v, path, values),
  };
  return c;
}

const join = (path, key) => (path ? `${path}.${key}` : key);

// Structural validation: exactly what screencast.schema.json says, no more.
export function validateShape(obj) {
  const c = checker();
  const bubble = (v, path) =>
    c.object(v, path, ['position', 'size', 'margin']) &&
    c.each(v, path, { position: c.enum(POSITIONS), size: c.num(0.05, 1), margin: c.num(0, undefined, 'integer') });
  const flag = (v, path) =>
    c.object(v, path, ['kind', 'note'], ['kind']) && c.each(v, path, { kind: c.enum(FLAGS), note: c.str() });
  const beat = (v, path) =>
    c.object(v, path, BEAT_KEYS, ['id', 'title', 'surface', 'text']) &&
    c.each(v, path, {
      id: c.str(ID),
      title: c.str(),
      surface: c.enum(SURFACES),
      text: c.str(),
      say: c.str(),
      cam: c.enum(['pip', 'full', 'off']),
      bubble,
      lead: c.num(0),
      tail: c.num(0),
      cut: c.num(),
      captionPosition: c.enum(['bottom', 'top']),
      skip: c.bool,
      needs: (v, path) => c.type(v, path, 'array') && v.forEach((f, i) => flag(f, `${path}[${i}]`)),
    });

  if (!c.object(obj, '', TOP_KEYS, ['version', 'slug', 'title', 'voice', 'beats'])) return c.errors;
  c.each(obj, '', {
    $schema: c.str(),
    version: c.enum([1]),
    slug: c.str(ID),
    title: c.str(),
    out: c.str(),
    size: (v, path) => {
      if (!c.type(v, path, 'array')) return;
      v.forEach((n, i) => c.num(16, 7680, 'integer')(n, `${path}[${i}]`));
      if (v.length !== 2) c.errors.push({ path, message: 'must be [width, height]' });
    },
    voice: (v, path) =>
      c.object(v, path, ['tts', 'human', 'normalize']) &&
      c.each(v, path, { tts: c.str(), human: c.bool, normalize: c.bool }),
    lang: c.str(LANG),
    captions: (v, path) => c.object(v, path, ['burn']) && c.each(v, path, { burn: c.bool }),
    spellings: (v, path) => c.object(v, path, null) && Object.entries(v).forEach(([k, s]) => c.str()(s, join(path, k))),
    camera: (v, path) => c.object(v, path, ['delay', 'bubble']) && c.each(v, path, { delay: c.num(0, 2), bubble }),
    beats: (v, path) => {
      if (!c.type(v, path, 'array')) return;
      if (v.length < 1) c.errors.push({ path, message: 'must have at least one beat' });
      v.forEach((b, i) => beat(b, `${path}[${i}]`));
    },
  });
  return c.errors;
}

const TOP_KEYS = [
  '$schema',
  'version',
  'slug',
  'title',
  'out',
  'size',
  'voice',
  'lang',
  'captions',
  'spellings',
  'camera',
  'beats',
];
const BEAT_KEYS = [
  'id',
  'title',
  'surface',
  'text',
  'say',
  'cam',
  'bubble',
  'lead',
  'tail',
  'cut',
  'captionPosition',
  'skip',
  'needs',
];

// The rules that span fields. Assumes nothing about shape beyond what it checks, so it can run on a broken file.
function validateRules(obj) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return errors;
  const voice = obj.voice && typeof obj.voice === 'object' ? obj.voice : null;
  const tts = typeof voice?.tts === 'string';
  const human = voice?.human === true;
  if (voice && tts === human) fail('voice', 'must set exactly one of tts or human: true');
  if (voice && tts && 'normalize' in voice) fail('voice.normalize', 'is only for human VO');
  if (obj.camera !== undefined && !human) fail('camera', 'is only for human VO');
  const camera = human && obj.camera !== undefined;

  const seen = new Map();
  (Array.isArray(obj.beats) ? obj.beats : []).forEach((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return;
    const path = `beats[${i}]`;
    if (typeof b.id === 'string') {
      if (seen.has(b.id)) fail(`${path}.id`, `duplicates beats[${seen.get(b.id)}].id "${b.id}"`);
      else seen.set(b.id, i);
    }
    if ((b.cam === 'pip' || b.cam === 'full') && !camera) fail(`${path}.cam`, 'needs human VO with camera');
    if (b.bubble !== undefined && !camera) fail(`${path}.bubble`, 'needs human VO with camera');
    if (b.surface === 'camera' && b.cam !== 'full') fail(`${path}.cam`, 'must be full on a camera surface');
    if (i === 0 && typeof b.cut === 'number' && b.cut !== 0) fail(`${path}.cut`, 'is not allowed on the first beat');
    if (b.say !== undefined && !tts) fail(`${path}.say`, 'is only for TTS voice');
  });
  return errors;
}

// Every problem with a parsed screencast.json, as [{ path, message }]; empty when valid.
export function validate(obj) {
  return [...validateShape(obj), ...validateRules(obj)];
}

export const formatErrors = (errors) => errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('\n');

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// voKey lives in timeline.mjs so the editor can compute staleness in the browser; it's the same SHA-256.
export { voKey };

export class ConflictError extends Error {
  code = 'ECONFLICT';
}

// Writes `text` to `file` via a temp file and a rename, so readers see the old file or the new one, never part of one.
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const readMaybe = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

const parse = (text, file) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
};

// Reads and validates screencast.json: { data, hash }. `hash` is what a later save checks against.
export function readProject(dir) {
  const file = path.join(dir, 'screencast.json');
  const text = readMaybe(file);
  if (text === null) throw new Error(`${file}: not found`);
  const data = parse(text, file);
  const errors = validate(data);
  if (errors.length) throw new Error(`${file} is invalid:\n${formatErrors(errors)}`);
  return { data, hash: sha256(text) };
}

// Saves `data` as screencast.json if the file still hashes to `base` (null: it must not exist). Returns the new hash.
export function saveProject(dir, data, base) {
  const errors = validate(data);
  if (errors.length) throw new Error(`refusing to save an invalid screencast.json:\n${formatErrors(errors)}`);
  const file = path.join(dir, 'screencast.json');
  const current = readMaybe(file);
  if ((current === null ? null : sha256(current)) !== base)
    throw new ConflictError(`${file} changed on disk since it was read; reload and redo the edit`);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeAtomic(file, text);
  return sha256(text);
}

// The fields in build.json entries that hold file paths: project-relative on disk, absolute in memory.
const PATH_FIELDS = ['file', 'raw', 'subs'];

const mapPaths = (entry, fn) => {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  for (const k of PATH_FIELDS) if (typeof out[k] === 'string') out[k] = fn(out[k]);
  return out;
};

const mapBuild = (build, fn) => ({
  ...build,
  beats: Object.fromEntries(
    Object.entries(build.beats).map(([id, steps]) => [
      id,
      Object.fromEntries(Object.entries(steps).map(([step, entry]) => [step, mapPaths(entry, fn)])),
    ]),
  ),
});

// build.json as on disk (relative paths); an empty build when it's missing.
function readBuildRaw(dir) {
  const file = path.join(dir, 'build.json');
  const text = readMaybe(file);
  if (text === null) return { version: 1, beats: {} };
  const build = parse(text, file);
  if (build?.version !== 1 || !build.beats || typeof build.beats !== 'object' || Array.isArray(build.beats))
    throw new Error(`${file}: expected { "version": 1, "beats": { … } }`);
  return build;
}

export function loadProject(dir) {
  dir = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME));
  let { data, hash } = readProject(dir);
  const abs = (rel) => path.resolve(dir, rel);
  const rel = (file) => (path.isAbsolute(file) ? path.relative(dir, file).split(path.sep).join('/') : file);
  let build = mapBuild(readBuildRaw(dir), abs);

  const writeBuild = (update) => {
    const next = update(readBuildRaw(dir));
    writeAtomic(path.join(dir, 'build.json'), `${JSON.stringify(next, null, 2)}\n`);
    build = mapBuild(next, abs);
  };

  // Deliverables: "out" (absolute or project-relative) or <slug>.mp4, with the .srt and .script.md beside it.
  const out = () => abs(data.out ?? `${data.slug}.mp4`);
  const beside = (ext) => out().replace(/(\.[^./]+)?$/, ext);

  const p = {
    dir,
    get data() {
      return data;
    },
    set data(next) {
      data = next;
    },
    get hash() {
      return hash;
    },
    get build() {
      return build;
    },
    get beats() {
      return data.beats.filter((b) => !b.skip);
    },
    find(id) {
      const beat = data.beats.find((b) => b.id === id);
      if (!beat) throw new Error(`no beat "${id}" in ${dir}/screencast.json`);
      return beat;
    },

    path: abs,
    rel,
    voFile: (id) => abs(`vo/${id}.${data.voice.human ? 'wav' : 'mp3'}`),
    subsFile: (id) => abs(`vo/${id}.srt`),
    rawVoFile: (id) => abs(`vo/raw/${id}.wav`),
    txtFile: (id) => abs(`vo/txt/${id}.json`),
    camFile: (id) => abs(`cam/raw/${id}.mov`),
    sceneFile: (id, ext = 'webm') => abs(`scenes/${id}.${ext.replace(/^\./, '')}`),
    qaDir: () => abs('qa'),
    assemblyDir: () => abs('assembly'),
    out,
    srtOut: () => beside('.srt'),
    scriptOut: () => beside('.script.md'),

    // Saves p.data, refusing (ConflictError) if screencast.json changed on disk since it was loaded or last saved.
    save() {
      hash = saveProject(dir, data, hash);
    },
    reload() {
      ({ data, hash } = readProject(dir));
      build = mapBuild(readBuildRaw(dir), abs);
    },

    // Replaces whole step entries for a beat: recordBuild('save', { vo: {…}, txt: null }); null removes a step.
    // Paths may be absolute; they're stored project-relative.
    recordBuild(id, patch) {
      writeBuild((b) => {
        const steps = { ...b.beats[id] };
        for (const [step, entry] of Object.entries(patch)) {
          if (entry === null || entry === undefined) delete steps[step];
          else steps[step] = mapPaths(entry, rel);
        }
        return { ...b, beats: { ...b.beats, [id]: steps } };
      });
    },
    recordAssembly(entry) {
      writeBuild((b) => ({ ...b, assembly: entry }));
    },

    timeline() {
      return timeline(data, build, captionInputs(data, build));
    },

    // A beat as film.mjs sees it, in scene-time ms. Needs the beat's VO; cuts don't matter (they move only pictures).
    beat(id) {
      const raw = p.find(id);
      if (raw.skip) throw new Error(`"${id}" is skipped; there's nothing to film`);
      const vo = build.beats[id]?.vo;
      if (typeof vo?.duration !== 'number') throw new Error(`"${id}" has no VO yet; make it before filming`);
      const uncut = { ...data, beats: data.beats.map(({ cut, ...b }) => b) };
      const { block, voAt } = timeline(uncut, build).beats.find((e) => e.id === id);
      const lead = Math.round((voAt - block[0]) * 1000);
      let words;
      return {
        id,
        sceneMs: Math.round((block[1] - block[0]) * 1000),
        voAt: lead,
        handle: HANDLE * 1000,
        at(what) {
          words ??= voWords(data, build, raw);
          return lead + Math.round(wordAt(words, what, id) * 1000);
        },
      };
    },

    // Films the given scenes ({ id: async (b) => ({ file, end }) }), or only the ids on the command line, in project
    // order, recording each. A failing scene doesn't stop the rest; film() throws at the end naming them.
    async film(scenes, { only = process.argv.slice(2).filter((a) => !a.startsWith('-')), log = console.log } = {}) {
      for (const id of [...Object.keys(scenes), ...only]) p.find(id);
      const missing = only.filter((id) => !(id in scenes));
      if (missing.length) throw new Error(`film.mjs has no scene for ${missing.map((id) => `"${id}"`).join(', ')}`);
      const ids = data.beats
        .filter((b) => b.id in scenes && (only.length ? only.includes(b.id) : !b.skip))
        .map((b) => b.id);
      const failed = [];
      for (const id of ids) {
        try {
          const b = p.beat(id);
          log(`${id}: filming ${(b.sceneMs / 1000).toFixed(2)}s (+${HANDLE}s handles)`);
          const { file, end, footage } = await scenes[id](b);
          const scene = recordScene(p, id, file, end, b, footage);
          log(`${id}: ${p.rel(scene.file)}  footage ${scene.footage[0]}s…${scene.footage[1]}s`);
        } catch (err) {
          failed.push(id);
          console.error(`${id}: ${err.stack ?? err.message}`);
        }
      }
      if (failed.length) throw new Error(`${failed.length} scene(s) failed: ${failed.join(' ')}`);
      return ids;
    },

    // A Playwright scene: one recording context per beat, at the project's size. `fn(page, b)` sets the screen up,
    // calls `await b.ready()` once it's settled (which holds the head handle, then starts and returns the Clock), and
    // choreographs on that clock. After it returns the screen is held to sceneMs + handle, then recording stops.
    //
    // Playwright's video isn't tied to wall time at its ends: Chromium only sends frames when something repaints, the
    // file starts at the first one (often stale), and stopping appends ≥1s of the last frame. So the page repaints
    // one invisible pixel every frame (FRAME_TICKER) to keep frames flowing, and at the stop the screen flashes
    // magenta: finding the flash's first frame in the file pins scene time to file time. The flash is after the
    // footage.
    browserScene(browser, fn, contextOptions = {}) {
      return async (b) => {
        const [width, height] = data.size ?? [1920, 1080];
        const file = p.sceneFile(b.id, 'webm');
        const tmp = path.join(path.dirname(file), `.recording-${b.id}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        const ctx = await browser.newContext({
          ...contextOptions,
          viewport: { width, height },
          recordVideo: { dir: tmp, size: { width, height } },
        });
        let clock = null;
        let flashed;
        try {
          const page = await ctx.newPage();
          await page.addInitScript(CURSOR_INIT);
          await page.addInitScript(FRAME_TICKER);
          b.ready = async () => {
            if (clock) throw new Error('b.ready() called twice');
            await sleep(b.handle + 250); // the file's first frame can land a frame or two late
            clock = b.clock = new Clock();
            return clock;
          };
          await fn(page, b);
          if (!clock) throw new Error(`scene "${b.id}" never called b.ready()`);
          await clock.until(b.sceneMs + b.handle);
          flashed = await page.evaluate(SYNC_FLASH);
          await sleep(300);
          const video = page.video();
          await ctx.close();
          fs.renameSync(await video.path(), file);
        } finally {
          await ctx.close().catch(() => {});
          fs.rmSync(tmp, { recursive: true, force: true });
        }
        // File time `sync` is scene time `stop`, so the file ends at scene time stop + duration − sync.
        const stop = (flashed - clock.t0) / 1000;
        const duration = probe(file);
        const end = stop + duration - syncTime(file);
        return { file, end, footage: [Math.max(-b.handle / 1000, end - duration), stop] };
      };
    },

    // Removes a beat's `needs` flags of these kinds, as a fresh read-modify-write of screencast.json, so it neither
    // clobbers nor is blocked by an edit made since this project was loaded. The in-memory copy drops the same flags;
    // if the file had changed under it, its hash stays stale so a later save() still reports that conflict.
    clearFlags(id, kinds) {
      const drop = (beat) => {
        const kept = (beat.needs ?? []).filter((f) => !kinds.includes(f.kind));
        if (kept.length === (beat.needs ?? []).length) return false;
        if (kept.length) beat.needs = kept;
        else delete beat.needs;
        return true;
      };
      const fresh = readProject(dir);
      const beat = fresh.data.beats.find((b) => b.id === id);
      if (beat && drop(beat)) {
        const next = saveProject(dir, fresh.data, fresh.hash);
        if (fresh.hash === hash) hash = next;
      }
      const mine = data.beats.find((b) => b.id === id);
      if (mine) drop(mine);
    },
  };
  return p;
}

export const loadTimeline = (dir) => loadProject(dir).timeline();

// --- Film -----------------------------------------------------------------------------------------------------------

const probe = (file) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
      encoding: 'utf8',
    }),
  );
const ms3 = (t) => Math.round(t * 1000) / 1000;
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/* A beat's spoken words, [{ w, s, sentence }] with `s` seconds into its VO. TTS: the script's words, timed by word
 * count inside each sentence of the edge-tts .srt (as captions are). Human: whisper's words, respelled. */
export function voWords(data, build, beat) {
  const s = build.beats[beat.id] ?? {};
  const label = `beat "${beat.id}"`;
  if (data.voice.human) {
    if (!s.txt?.file) throw new Error(`${label} isn't transcribed yet; word marks come from the transcript`);
    const j = JSON.parse(fs.readFileSync(s.txt.file, 'utf8'));
    const raw = (j.segments ?? [])
      .flatMap((seg) => seg.words ?? [])
      .map((x) => ({ w: x.word.trim(), s: x.start, e: x.end }));
    let sentence = 1;
    return respell(
      raw.filter((x) => x.w),
      data.spellings ?? {},
    ).map((x, k, all) => {
      const out = { w: x.w, s: x.s, sentence };
      if (/[.!?…]["'”’)\]]*$/.test(x.w) && k + 1 < all.length) sentence++;
      return out;
    });
  }
  const subs = s.vo.subs ?? s.vo.file.replace(/\.[^./]+$/, '.srt');
  ttsCues(subs, beat.text, label); // throws on a sentence-count mismatch
  const cues = parseSrt(fs.readFileSync(subs, 'utf8'));
  return sentences(beat.text).flatMap((text, i) => {
    const ws = text.split(' ');
    const { start, end } = cues[i];
    return ws.map((w, k) => ({ w, s: start + ((end - start) * k) / ws.length, sentence: i + 1 }));
  });
}

// Seconds into the VO of sentence `what` (1-based) or of the first occurrence of a word or phrase.
export function wordAt(words, what, id = '?') {
  if (typeof what === 'number') {
    const w = words.find((x) => x.sentence === what);
    if (!w) throw new Error(`beat "${id}" has no sentence ${what} (it has ${words.at(-1)?.sentence ?? 0})`);
    return w.s;
  }
  const want = String(what).split(/\s+/).map(norm).filter(Boolean);
  const said = words.map((x) => norm(x.w));
  const k = said.findIndex((_, i) => want.length && want.every((n, j) => said[i + j] === n));
  if (k < 0) throw new Error(`beat "${id}" never says "${what}"; it says: ${words.map((x) => x.w).join(' ')}`);
  return words[k].s;
}

/* Keeps Chromium sending video frames: one corner pixel alternates between two all-but-transparent shades every
 * animation frame. Runs in the top document of a recorded page. */
const FRAME_TICKER = `
if (window === window.top) {
  const install = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(d);
    let on = false;
    const tick = () => ((on = !on), (d.style.background = on ? 'rgba(0,0,0,.01)' : 'rgba(0,0,0,.02)'), requestAnimationFrame(tick));
    tick();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
}
`;

/* Covers the screen magenta and resolves to the wall time (ms) of the first frame showing it. Runs in the page;
 * syncTime() finds that frame in the recording. */
const SYNC_FLASH = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f0f;pointer-events:none';
      document.documentElement.appendChild(d);
      resolve(performance.timeOrigin + performance.now());
    }),
  );

// File time (s) of the first frame of the final run of SYNC_FLASH frames in a recording.
export function syncTime(file) {
  const pts = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .map(Number);
  const args = [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    'scale=4:4,format=rgb24',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-',
  ];
  const rgb = execFileSync('ffmpeg', args, { maxBuffer: 1 << 28 });
  const magenta = (k) => {
    let [r, g, b] = [0, 0, 0];
    for (let i = k * 48; i < k * 48 + 48; i += 3) [r, g, b] = [r + rgb[i], g + rgb[i + 1], b + rgb[i + 2]];
    return r / 16 > 200 && g / 16 < 60 && b / 16 > 200;
  };
  let k = Math.min(pts.length, rgb.length / 48) - 1;
  if (k < 0 || !magenta(k)) throw new Error(`${file}: no sync flash at the end, so scene time can't be pinned`);
  while (k > 0 && magenta(k - 1)) k--;
  return pts[k];
}

// Records a filmed scene for beat `b` (from p.beat): what it was timed to, and the scene time its footage covers
// (default: from −handle, or the file's start if later, to `end`).
export function recordScene(p, id, file, end, b = p.beat(id), footage) {
  file = path.resolve(p.dir, file);
  if (!fs.existsSync(file)) throw new Error(`scene "${id}" returned ${file}, which doesn't exist`);
  const duration = ms3(probe(file));
  if (!(typeof end === 'number' && end > 0))
    throw new Error(`scene "${id}" returned end ${end}; it must be the scene time (s) of the recording's last frame`);
  end = ms3(end);
  const scene = {
    file,
    raw: file,
    voKey: p.build.beats[id].vo.key,
    lead: b.voAt / 1000,
    duration,
    end,
    footage: footage ? footage.map(ms3) : [ms3(Math.max(-HANDLE, end - duration)), end],
    at: new Date().toISOString(),
  };
  if (end < b.sceneMs / 1000)
    console.warn(`${id}: recording stopped at ${end}s, before the scene ends (${b.sceneMs / 1000}s)`);
  p.recordBuild(id, { scene });
  p.clearFlags(id, ['reshoot']);
  return p.build.beats[id].scene;
}

// Points beat `id`'s scene at a post-processed variant of its raw recording, which must be the same length.
export function useVariant(p, id, file) {
  const scene = p.build.beats[id]?.scene;
  if (!scene) throw new Error(`"${id}" hasn't been filmed yet`);
  const raw = scene.raw ?? scene.file;
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error(`${file}: not found`);
  const [a, b] = [probe(raw), probe(file)];
  if (Math.abs(a - b) > 0.1)
    throw new Error(
      `${file} runs ${b.toFixed(3)}s but the raw recording ${raw} runs ${a.toFixed(3)}s; they must match`,
    );
  p.recordBuild(id, { scene: { ...scene, file, raw } });
  return p.build.beats[id].scene;
}

export const PLAYWRIGHT_HOME = path.join(os.homedir(), '.cache', 'generate-screencast');
// The Playwright the skill is tested with. Bump it deliberately; other versions still load, with a warning.
export const PLAYWRIGHT_VERSION = '1.64.1';
export const PLAYWRIGHT_INSTALL =
  'mkdir -p ~/.cache/generate-screencast && cd ~/.cache/generate-screencast && npm init -y >/dev/null && ' +
  `npm i playwright@${PLAYWRIGHT_VERSION} && npx playwright install chromium`;

// Playwright from the shared per-machine install. Throws with the install command when it's missing.
export async function importPlaywright(home = PLAYWRIGHT_HOME) {
  const require = createRequire(path.join(home, 'noop.js'));
  let resolved;
  try {
    resolved = require.resolve('playwright');
  } catch {
    throw new Error(
      `Playwright isn't installed in ${home}. Install it once for every project:\n  ${PLAYWRIGHT_INSTALL}`,
    );
  }
  const { version } = require('playwright/package.json');
  if (version !== PLAYWRIGHT_VERSION)
    console.warn(
      `Playwright ${version} is installed in ${home}; the skill is tested with ${PLAYWRIGHT_VERSION}. To match:\n  ${PLAYWRIGHT_INSTALL}`,
    );
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}

// A helper binary compiled from <src>/<name>.swift into the shared cache, rebuilt whenever the source is newer.
// Returns its path. Needs swiftc (Xcode or the Command Line Tools).
export function ensureBuilt(name, { dir = PLAYWRIGHT_HOME, src = import.meta.dirname, log = console.log } = {}) {
  const bin = path.join(dir, name);
  const source = path.join(src, `${name}.swift`);
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(source).mtimeMs) return bin;
  log(`building ${name}…`);
  fs.mkdirSync(dir, { recursive: true });
  if (spawnSync('swiftc', ['-O', source, '-o', bin], { stdio: 'inherit' }).status !== 0)
    throw new Error(`swiftc failed to build ${name}`);
  return bin;
}

/* Where speech resumes after each silence, in seconds into the file. Cached by file identity: the editor asks often. */
const onsetCache = new Map();
export function voiceOnsets(file) {
  const st = fs.statSync(file);
  const id = `${file}:${st.size}:${st.mtimeMs}`;
  if (!onsetCache.has(id)) {
    const args = ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.08', '-f', 'null', '-'];
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.error) throw new Error(`ffmpeg: ${r.error.message}`);
    onsetCache.set(id, [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((x) => +x[1]));
  }
  return onsetCache.get(id);
}

/* timeline()'s caption inputs: per beat with a VO, its cues (captions.mjs) and voice onsets, or the error making them.
 * A beat whose timing file doesn't exist yet is left out, which timeline() reports as stale. */
export function captionInputs(data, build) {
  const out = {};
  for (const b of data.beats.filter((x) => !x.skip)) {
    const s = build.beats[b.id] ?? {};
    if (!s.vo?.file || !fs.existsSync(s.vo.file)) continue;
    const label = `beat "${b.id}"`;
    const subs = data.voice.human ? s.txt?.file : (s.vo.subs ?? s.vo.file.replace(/\.[^./]+$/, '.srt'));
    if (!subs || !fs.existsSync(subs)) continue;
    try {
      const cues = data.voice.human ? whisperCues(subs, label, data.spellings) : ttsCues(subs, b.text, label);
      out[b.id] = { cues, onsets: voiceOnsets(s.vo.file) };
    } catch (err) {
      out[b.id] = { error: err.message.split('\n')[0].replace(`${label}: `, '') };
    }
  }
  return out;
}

async function main([cmd, ...args]) {
  if (cmd === 'build' && args.length === 1 && ['mousectl', 'camrec'].includes(args[0]))
    return console.log(ensureBuilt(args[0], { log: console.error }));
  if (cmd !== 'use' || args.length !== 3)
    throw new Error('usage: node project.mjs use <dir> <id> <file>\n       node project.mjs build mousectl|camrec');
  const [dir, id, file] = args;
  const p = loadProject(dir);
  const scene = useVariant(p, id, file);
  console.log(`${id}: scene is now ${p.rel(scene.file)} (raw ${p.rel(scene.raw)})`);
}

// Run as a script, not imported. Resolve symlinks: an installed skill may be linked.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
