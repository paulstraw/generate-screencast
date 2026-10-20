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
 *
 *   import { validate } from './project.mjs';
 *   const errors = validate(JSON.parse(fs.readFileSync('screencast.json', 'utf8')));
 *   // [{ path: 'beats[2].cam', message: 'must be pip | full | off' }, …]
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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

// The provenance key of a beat's VO (D5): what the VO says, and who says it. With `say` set, `text` is captions only.
export function voKey(project, beat) {
  if (project.voice?.human) return sha256(JSON.stringify(['human', beat.text]));
  return sha256(JSON.stringify(['tts', project.voice?.tts, beat.say ?? beat.text]));
}

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
