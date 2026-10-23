import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formatErrors, validate, validateShape } from '../skills/generate-screencast/assets/project.mjs';

const schema = JSON.parse(
  fs.readFileSync(new URL('../skills/generate-screencast/assets/screencast.schema.json', import.meta.url), 'utf8'),
);

// A minimal JSON Schema walker for exactly the keywords screencast.schema.json uses. Anything else is an error, so
// the schema can't quietly grow a rule the hand-written checker doesn't know about.
const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description']);
const KEYWORDS = new Set([
  'type',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'pattern',
  'minItems',
  'maxItems',
  '$ref',
]);

function walk(s, v, path = '', errors = []) {
  const join = (k) => (path ? `${path}.${k}` : k);
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const fail = (p, keyword) => errors.push({ path: p, keyword });
  for (const k of Object.keys(s)) if (!ANNOTATIONS.has(k) && !KEYWORDS.has(k)) throw new Error(`unsupported ${k}`);
  if (s.$ref)
    walk(
      s.$ref
        .replace('#/$defs/', '')
        .split('/')
        .reduce((d, k) => d[k], schema.$defs),
      v,
      path,
      errors,
    );
  if (s.type) {
    const ok = s.type === 'integer' ? Number.isInteger(v) : kind === s.type;
    if (!ok) fail(path, 'type');
  }
  if (s.enum && !s.enum.includes(v)) fail(path, 'enum');
  if (kind === 'number') {
    if (s.minimum !== undefined && v < s.minimum) fail(path, 'minimum');
    if (s.maximum !== undefined && v > s.maximum) fail(path, 'maximum');
  }
  if (kind === 'string' && s.pattern && !new RegExp(s.pattern, 'u').test(v)) fail(path, 'pattern');
  if (kind === 'array') {
    if (s.minItems !== undefined && v.length < s.minItems) fail(path, 'minItems');
    if (s.maxItems !== undefined && v.length > s.maxItems) fail(path, 'maxItems');
    if (s.items) v.forEach((x, i) => walk(s.items, x, `${path}[${i}]`, errors));
  }
  if (kind === 'object') {
    for (const k of s.required || []) if (!(k in v)) fail(join(k), 'required');
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && k in s.properties) walk(s.properties[k], x, join(k), errors);
      else if (s.additionalProperties === false) fail(join(k), 'additionalProperties');
      else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, x, join(k), errors);
    }
  }
  return errors;
}

const paths = (errors) => errors.map((e) => e.path).sort();

const good = () => ({
  $schema: 'file:///skills/generate-screencast/assets/screencast.schema.json',
  version: 1,
  slug: 'drafts-that-sync',
  title: 'Drafts that sync',
  out: 'drafts-that-sync.mp4',
  size: [1920, 1080],
  voice: { tts: 'en-US-AndrewNeural' },
  lang: 'en-US',
  captions: { burn: false },
  beats: [
    { id: 'intro', title: 'Intro', surface: 'web', text: 'Here are drafts.' },
    {
      id: 'save',
      title: 'Saving syncs',
      surface: 'terminal',
      text: 'Hit Save and it syncs everywhere.',
      say: 'Hit save and it syncs everywhere.',
      lead: 0.3,
      tail: 0,
      cut: -0.6,
      captionPosition: 'top',
      skip: false,
      needs: [{ kind: 'reshoot', note: 'cursor missed Save' }, { kind: 'qa' }],
    },
  ],
});

const goodHuman = () => ({
  version: 1,
  slug: 'cam-demo',
  title: 'Camera demo',
  voice: { human: true, normalize: true },
  spellings: { 'lock file': 'lockfile' },
  camera: { delay: 0.15, bubble: { position: 'bottom-left', size: 0.22, margin: 48 } },
  beats: [
    { id: 'hello', title: 'Hello', surface: 'camera', text: 'Hi.', cam: 'full' },
    { id: 'tour', title: 'Tour', surface: 'macos', text: 'Look.', cam: 'pip', bubble: { position: 'top-right' } },
    { id: 'end', title: 'End', surface: 'web', text: 'Bye.', cam: 'off', cut: 0.4 },
  ],
});

// [name, mutate(good fixture), expected paths]; shape errors and cross-field errors both listed.
const bad = [
  ['not an object', () => {}, [''], () => []],
  ['missing required', (p) => (delete p.slug, delete p.beats), ['beats', 'slug']],
  ['unknown top-level key', (p) => (p.extra = 1), ['extra']],
  ['wrong version', (p) => (p.version = 2), ['version']],
  ['bad slug', (p) => (p.slug = 'Drafts That Sync'), ['slug']],
  ['size wrong length and type', (p) => (p.size = [1920, '1080', 4]), ['size', 'size[1]', 'size[2]']],
  ['size too small', (p) => (p.size = [8, 1080.5]), ['size[0]', 'size[1]']],
  ['voice unknown key', (p) => (p.voice = { tts: 'x', speed: 2 }), ['voice.speed']],
  ['voice neither', (p) => (p.voice = {}), ['beats[1].say', 'voice']],
  ['voice both', (p) => (p.voice = { tts: 'x', human: true }), ['voice']],
  ['normalize with tts', (p) => (p.voice.normalize = true), ['voice.normalize']],
  ['bad lang', (p) => (p.lang = 'english!'), ['lang']],
  ['captions.burn type', (p) => (p.captions = { burn: 'yes' }), ['captions.burn']],
  ['spellings value type', (p) => (p.spellings = { a: 1 }), ['spellings.a']],
  ['camera without human', (p) => (p.camera = { delay: 0.1 }), ['camera']],
  ['no beats', (p) => (p.beats = []), ['beats']],
  ['beat not an object', (p) => (p.beats[0] = 'intro'), ['beats[0]']],
  [
    'beat missing fields',
    (p) => (p.beats[0] = { id: 'intro' }),
    ['beats[0].surface', 'beats[0].text', 'beats[0].title'],
  ],
  ['beat bad id', (p) => (p.beats[0].id = 'Intro_1'), ['beats[0].id']],
  ['duplicate ids', (p) => (p.beats[1].id = 'intro'), ['beats[1].id']],
  ['bad surface', (p) => (p.beats[0].surface = 'desktop'), ['beats[0].surface']],
  ['bad cam value', (p) => (p.beats[0].cam = 'bubble'), ['beats[0].cam']],
  ['cam with tts', (p) => (p.beats[0].cam = 'pip'), ['beats[0].cam']],
  ['bubble with tts', (p) => (p.beats[0].bubble = {}), ['beats[0].bubble']],
  ['camera surface not full', (p) => (p.beats[0].surface = 'camera'), ['beats[0].cam']],
  ['negative lead', (p) => (p.beats[1].lead = -0.1), ['beats[1].lead']],
  ['cut not a number', (p) => (p.beats[1].cut = '-0.6'), ['beats[1].cut']],
  ['cut on first beat', (p) => (p.beats[0].cut = 0.5), ['beats[0].cut']],
  ['bad captionPosition', (p) => (p.beats[1].captionPosition = 'middle'), ['beats[1].captionPosition']],
  ['skip type', (p) => (p.beats[1].skip = 1), ['beats[1].skip']],
  ['steps field', (p) => (p.beats[1].steps = []), ['beats[1].steps']],
  [
    'bad flag',
    (p) => (p.beats[1].needs = [{ kind: 'redo', why: 'x' }, {}]),
    ['beats[1].needs[0].kind', 'beats[1].needs[0].why', 'beats[1].needs[1].kind'],
  ],
];

const badHuman = [
  ['say with human VO', (p) => (p.beats[0].say = 'hi'), ['beats[0].say']],
  ['cam without camera', (p) => delete p.camera, ['beats[0].cam', 'beats[1].bubble', 'beats[1].cam']],
  [
    'bubble out of range',
    (p) => (p.camera.bubble = { position: 'left', size: 2, margin: 4.5 }),
    ['camera.bubble.margin', 'camera.bubble.position', 'camera.bubble.size'],
  ],
  ['camera delay too big', (p) => (p.camera.delay = 5), ['camera.delay']],
];

// The paths validate() reports beyond the schema's: the cross-field rules.
const crossField = new Set([
  'voice',
  'voice.normalize',
  'camera',
  'beats[1].id',
  'beats[0].cam',
  'beats[0].bubble',
  'beats[1].cam',
  'beats[1].bubble',
  'beats[0].cut',
  'beats[0].say',
  'beats[1].say',
]);

test('good projects validate cleanly', () => {
  for (const p of [good(), goodHuman()]) {
    assert.deepEqual(validate(p), []);
    assert.deepEqual(walk(schema, p), []);
  }
});

const cases = [...bad.map(([n, f, e, b = good]) => [n, f, e, b]), ...badHuman.map(([n, f, e]) => [n, f, e, goodHuman])];

const build = (base, mutate) => {
  const p = base();
  mutate(p);
  return p;
};

for (const [name, mutate, expected, base] of cases) {
  test(`bad: ${name}`, () => {
    assert.deepEqual(paths(validate(build(base, mutate))), expected.sort());
  });
}

test('the checker and the schema agree on every fixture', () => {
  for (const [name, mutate, , base] of cases) {
    const obj = build(base, mutate);
    assert.deepEqual(paths(validateShape(obj)), paths(walk(schema, obj)), name);
    // The shape errors are everything validate() reports except the cross-field rules.
    const extra = validate(obj).slice(validateShape(obj).length);
    for (const e of extra) assert.ok(crossField.has(e.path), `${name}: unexpected cross-field path ${e.path}`);
  }
});

test('errors name the JSON path', () => {
  const p = good();
  p.beats[1].cam = 'bubble';
  assert.equal(formatErrors(validate(p)), 'beats[1].cam: must be pip | full | off');
  assert.equal(formatErrors(validate(null)), '(root): must be an object');
});

test('a zero cut on the first beat is allowed (the editor may reorder one there)', () => {
  const p = good();
  p.beats[0].cut = 0;
  assert.deepEqual(validate(p), []);
});
