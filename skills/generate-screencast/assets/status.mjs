#!/usr/bin/env node
/*
 * What has to be rebuilt, and why: compares screencast.json (intent) with build.json (provenance) and lists, per beat
 * in order, the pipeline steps it needs. A fresh project is just "everything stale", so a first build and a refresh
 * are the same loop: run this, do what it says, run it again.
 *
 *   node status.mjs <dir>                    // a short table; then what to run, step by step
 *   node status.mjs <dir> --json             // the plan, machine-readable
 *   node status.mjs <dir> --qa <id> [--note "…"]   // record that you looked at this beat's QA grid and it passed
 *
 * Steps, in dependency order: vo (TTS or recording) → transcribe (human VO) → film (screen beats) → qa → assemble.
 * A step implies every later step for its beat, and any beat needing anything implies assemble. Most staleness is
 * computed from provenance keys (text changed since the VO, VO changed since filming, an edit reaching past a
 * recording's handles); `needs` flags in screencast.json are for the judgment calls code can't see, and the step that
 * satisfies a flag clears it (vo clears revo, film clears reshoot, qa clears qa).
 *
 *   import { plan, qaKey } from './status.mjs';
 *   const s = plan(project, build, facts);   // parsed screencast.json and build.json; facts below
 *   s.beats[0]   // { id, title, skip, steps: [{ step, reasons: ['text or voice changed since the VO'] }] }
 *   s.assemble   // reasons the video must be re-rendered; [] when it's current
 *   s.todo       // { vo: ['save'], transcribe: [], film: ['save'], qa: ['save', 'intro'], assemble: true }
 *   s.error      // set when the edit itself is impossible (cuts leaving a beat no picture)
 *
 * facts carries what plan() can't read itself, so it stays pure (the editor imports this module in the browser):
 * `exists` (the paths, as build.json has them, that exist on disk), `out` (the deliverable's path) and `captions`
 * (timeline()'s caption inputs). The CLI gathers them.
 *
 * QA is recorded, not remembered: `--qa` stores a hash of what the grid showed (the beat's recording and its place in
 * the edit: windows, mode, bubble, caption position and texts, burn-in), so any later change to those lists the beat
 * for QA again.
 */
import { timeline, sha256, voKey } from './timeline.mjs';

export const STEPS = ['vo', 'transcribe', 'film', 'qa'];
export const CLEARS = { vo: ['revo'], film: ['reshoot'], qa: ['qa'] };
const FLAG_STEP = { revo: 'vo', reshoot: 'film', qa: 'qa' };

const base = (file) => (typeof file === 'string' ? file.split(/[\\/]/).pop() : null);
const flagReason = (f) => `flagged ${f.kind}${f.note ? `: ${f.note}` : ''}`;

// The hash a QA pass vouches for: the beat's recording and everything about how its picture is shown (D10).
export function qaKey(project, build, entry) {
  const s = build?.beats?.[entry.id] ?? {};
  return sha256(
    JSON.stringify({
      scene: s.scene
        ? {
            file: base(s.scene.file),
            raw: base(s.scene.raw),
            duration: s.scene.duration,
            end: s.scene.end,
            lead: s.scene.lead,
            voKey: s.scene.voKey,
            at: s.scene.at,
          }
        : null,
      cam: s.cam ? { file: base(s.cam.file), trim: s.cam.trim } : null,
      sceneWindow: entry.sceneWindow,
      camWindow: entry.camWindow,
      camPad: entry.camPad,
      mode: entry.mode,
      bubble: entry.bubble,
      captionPosition: entry.captionPosition,
      cues: (entry.overlays ?? []).map((c) => c.text),
      burn: project.captions?.burn === true,
    }),
  );
}

export function plan(project, build = { version: 1, beats: {} }, facts = {}) {
  const exists = new Set(facts.exists ?? []);
  const has = (file) => typeof file === 'string' && exists.has(file);
  const human = project.voice?.human === true;

  let t = null;
  let error;
  try {
    t = timeline(project, build, facts.captions);
  } catch (err) {
    error = err.message;
  }
  const entries = new Map((t?.beats ?? []).map((e) => [e.id, e]));

  const beats = project.beats.map((b) => {
    if (b.skip) return { id: b.id, title: b.title, skip: true, steps: [] };
    const s = build?.beats?.[b.id] ?? {};
    const entry = entries.get(b.id);
    const screen = (b.cam ?? 'off') !== 'full';
    const why = { vo: [], transcribe: [], film: [], qa: [] };

    // vo: what the VO says (or who says it) changed, or it was never made.
    if (!s.vo) why.vo.push(human ? 'not recorded yet' : 'no VO yet');
    else if (!has(s.vo.file)) why.vo.push(`VO file missing (${s.vo.file})`);
    else if (s.vo.key !== voKey(project, b))
      why.vo.push(
        human ? 'text changed since the recording' : `${b.say !== undefined ? 'say' : 'text'} or voice changed since the VO`,
      );

    // transcribe: the transcript isn't of this take.
    if (human) {
      if (!s.txt) why.transcribe.push('no transcript yet');
      else if (!has(s.txt.file)) why.transcribe.push(`transcript missing (${s.txt.file})`);
      else if (s.vo && s.txt.voKey !== s.vo.key) why.transcribe.push('the recording changed since the transcript');
    }

    // film: the screen recording is missing, was timed to another VO, or the edit runs past its handles (timeline).
    if (screen) {
      if (!s.scene) why.film.push('not filmed yet');
      else if (!has(s.scene.file)) why.film.push(`recording missing (${s.scene.file})`);
      else if (s.vo && s.scene.voKey !== s.vo.key) why.film.push('the VO changed since filming');
    }

    // The timeline's own findings (footage overruns, missing caption timing, missing camera take), where the checks
    // above haven't already said why.
    for (const { step, reason } of entry?.stale ?? []) if (!why[step].length) why[step].push(reason);

    // qa: never passed, or something it vouched for moved.
    if (!s.qa) why.qa.push('not checked yet');
    else if (entry && s.qa.key !== qaKey(project, build, entry)) why.qa.push('the picture changed since QA');
    else if (!entry && error) why.qa.push('the edit is invalid');

    for (const f of b.needs ?? []) why[FLAG_STEP[f.kind]].push(flagReason(f));

    // A step implies every later step that applies to this beat.
    const applies = { vo: true, transcribe: human, film: screen, qa: true };
    const steps = [];
    let first = null;
    for (const step of STEPS) {
      if (!applies[step]) continue;
      if (why[step].length) {
        first ??= step;
        steps.push({ step, reasons: why[step] });
      } else if (first) steps.push({ step, reasons: [`follows ${first}`] });
    }
    return { id: b.id, title: b.title, skip: false, steps };
  });

  const live = beats.filter((b) => !b.skip);
  const assemble = [];
  if (error) assemble.push(error);
  const changed = live.filter((b) => b.steps.length);
  if (changed.length)
    assemble.push(
      `${changed.length} beat${changed.length === 1 ? '' : 's'} changed (${changed.map((b) => b.id).join(', ')})`,
    );
  if (!build?.assembly) assemble.push('never assembled');
  else {
    if (t && build.assembly.key !== t.key) assemble.push('the edit changed since the last render');
    if (facts.out && build.assembly.out !== facts.out) assemble.push(`the output moved to ${facts.out}`);
    else if (!has(facts.out ?? build.assembly.out)) assemble.push('the deliverable is missing');
  }

  const todo = Object.fromEntries(
    STEPS.map((step) => [step, live.filter((b) => b.steps.some((s) => s.step === step)).map((b) => b.id)]),
  );
  todo.assemble = assemble.length > 0;
  return { beats, assemble, todo, ...(error ? { error } : {}), timeline: t };
}

// --- CLI -------------------------------------------------------------------------------------------------------------

// Everything plan() needs from disk, for a loaded project.
export async function gather(p) {
  const fs = await import('node:fs');
  const { captionInputs } = await import('./project.mjs');
  const files = [p.out()];
  for (const steps of Object.values(p.build.beats))
    for (const entry of Object.values(steps))
      for (const k of ['file', 'raw', 'subs']) if (entry?.[k]) files.push(entry[k]);
  if (p.build.assembly?.out) files.push(p.build.assembly.out);
  return {
    exists: files.filter((f) => fs.existsSync(f)),
    out: p.out(),
    captions: captionInputs(p.data, p.build),
  };
}

const COMMANDS = {
  vo: (human, dir, ids) =>
    human ? `node record-vo.mjs ${dir} ${ids}   (Paul narrates)` : `node tts.mjs ${dir} ${ids}`,
  transcribe: (_, dir, ids) => `node transcribe.mjs ${dir} ${ids}`,
  film: (_, dir, ids) => `node ${dir}/film.mjs ${ids}`,
  qa: (_, dir, ids) => `node qa-grid.mjs ${dir} <id> [times…], look, then node status.mjs ${dir} --qa <id>   (${ids})`,
};

export function format(s, { dir = '<dir>', human = false } = {}) {
  const lines = [];
  const width = Math.max(8, ...s.beats.map((b) => b.id.length)) + 2;
  for (const b of s.beats) {
    if (b.skip) lines.push(`${b.id.padEnd(width)}skipped`);
    else if (!b.steps.length) lines.push(`${b.id.padEnd(width)}ok`);
    else
      b.steps.forEach((st, i) =>
        lines.push(`${(i ? '' : b.id).padEnd(width)}${st.step.padEnd(12)}${st.reasons.join('; ')}`),
      );
  }
  const assemble = s.assemble.length ? `${'needed'.padEnd(12)}${s.assemble.join('; ')}` : 'ok';
  lines.push(`${'assemble'.padEnd(width)}${assemble}`);
  if (s.error) lines.push('', `error: ${s.error}`);
  const todo = STEPS.filter((step) => s.todo[step].length);
  if (todo.length || s.todo.assemble) {
    lines.push('', 'next:');
    for (const step of todo) lines.push(`  ${COMMANDS[step](human, dir, s.todo[step].join(' '))}`);
    if (s.todo.assemble) lines.push(`  node assemble.mjs ${dir}`);
  } else lines.push('', 'up to date');
  return lines.join('\n');
}

async function main(argv) {
  const args = [...argv];
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const [, value] = args.splice(i, 2);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const qa = opt('--qa');
  const note = opt('--note');
  if (args.length !== 1 || args[0].startsWith('-'))
    throw new Error('usage: node status.mjs <dir> [--json] | <dir> --qa <id> [--note "…"]');
  if (note !== undefined && qa === undefined) throw new Error('--note goes with --qa');

  const { loadProject } = await import('./project.mjs');
  const p = loadProject(args[0]);
  let s = plan(p.data, p.build, await gather(p));

  if (qa !== undefined) {
    if (s.error) throw new Error(`can't record QA while the edit is invalid: ${s.error}`);
    const beat = p.find(qa);
    if (beat.skip) throw new Error(`"${qa}" is skipped; there's nothing to QA`);
    const pending = s.beats.find((b) => b.id === qa).steps.filter((st) => st.step !== 'qa');
    if (pending.length)
      throw new Error(
        `"${qa}" needs ${pending.map((st) => st.step).join(', ')} before QA:\n` +
          pending.map((st) => `  ${st.step}: ${st.reasons.join('; ')}`).join('\n'),
      );
    const entry = s.timeline.beats.find((e) => e.id === qa);
    p.recordBuild(qa, {
      qa: { key: qaKey(p.data, p.build, entry), at: new Date().toISOString(), ...(note ? { note } : {}) },
    });
    p.clearFlags(qa, CLEARS.qa);
    s = plan(p.data, p.build, await gather(p));
    if (!json) console.log(`recorded QA for "${qa}"\n`);
  }

  if (json) {
    const { timeline: _, ...out } = s;
    console.log(JSON.stringify(out, null, 2));
  } else console.log(format(s, { dir: args[0], human: p.data.voice.human === true }));
  if (s.error) process.exitCode = 1;
}

// Run as a script (not imported, and not in the browser): resolve symlinks, since an installed skill may be linked.
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.startsWith('file:')) {
  const { pathToFileURL } = await import('node:url');
  const { realpathSync } = await import('node:fs');
  if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
    main(process.argv.slice(2)).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
