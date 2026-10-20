/*
 * The project data layer: one folder per screencast, whose screencast.json is the single source of truth for every
 * beat (script, voice, surface, camera, captions, edit decisions). Machine state lives beside it in build.json.
 *
 *   import { validate } from './project.mjs';
 *   const errors = validate(JSON.parse(fs.readFileSync('screencast.json', 'utf8')));
 *   // [{ path: 'beats[2].cam', message: 'must be pip | full | off' }, …]
 *
 * screencast.schema.json describes the same shape for editor autocomplete. Validation is hand-rolled rather than a
 * schema library because the skill has no npm dependencies; `validateShape` mirrors the schema rule for rule (a test
 * walks the schema and checks they agree), and `validate` adds the cross-field rules a schema can't express.
 */

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
