import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startEditor } from '../skills/generate-screencast/assets/editor.mjs';
import { CACHE_DIR, importPlaywright, loadProject, voKey } from '../skills/generate-screencast/assets/project.mjs';
import { gather, plan, qaKey } from '../skills/generate-screencast/assets/status.mjs';
import { makeTone, makeVideo, needsFfmpeg, probeDuration, tempDir } from './helpers.mjs';

// Set EDITOR_SHOTS=<dir> to keep the preview screenshots for a look.
const SHOTS = process.env.EDITOR_SHOTS;

// Three beats in solid colours, so a sampled pixel says whose picture is on screen: a J cut into `two` (its narration
// starts under `one`'s picture) and an L cut into `three` (its picture arrives under `two`'s narration).
const BEATS = [
  { id: 'one', title: 'Opening', surface: 'web', text: 'Hit Save now.' },
  { id: 'two', title: 'The list', surface: 'web', text: 'Next, your drafts.', cut: 1.0,
    needs: [{ kind: 'qa', note: 'check the J cut' }] },
  { id: 'three', title: 'Done', surface: 'terminal', text: 'That is all.', cut: -0.8 },
];
const COLORS = { one: 'red', two: 'lime', three: 'blue' };

async function fixture(t) {
  const dir = tempDir(t);
  const data = { version: 1, slug: 'demo', title: 'Demo', size: [320, 180], voice: { tts: 'en-US-AndrewNeural' },
    captions: { burn: false }, beats: BEATS };
  fs.writeFileSync(path.join(dir, 'screencast.json'), JSON.stringify(data, null, 2));
  const p = loadProject(dir);
  for (const b of BEATS) {
    makeTone(p.voFile(b.id), 1.2);
    fs.writeFileSync(p.subsFile(b.id), `1\n00:00:00,000 --> 00:00:01,200\n${b.text}\n`);
    p.recordBuild(b.id, { vo: { file: p.voFile(b.id), key: voKey(data, b), duration: probeDuration(p.voFile(b.id)),
      subs: p.subsFile(b.id) } });
  }
  for (const b of BEATS) {
    const end = p.beat(b.id).sceneMs / 1000 + 1.5;
    const file = makeVideo(p.sceneFile(b.id), end + 1.5, { color: COLORS[b.id] });
    p.recordBuild(b.id, { scene: { file, raw: file, voKey: p.build.beats[b.id].vo.key, lead: 0.5,
      duration: probeDuration(file), end, footage: [-1.5, end], at: new Date().toISOString() } });
  }
  const s = plan(p.data, p.build, await gather(p));
  for (const e of s.timeline.beats)
    p.recordBuild(e.id, { qa: { key: qaKey(p.data, p.build, e), at: new Date().toISOString() } });
  return dir;
}

const playwright = await importPlaywright().catch((err) => err);
const needsPlaywright = needsFfmpeg.skip
  ? needsFfmpeg
  : { skip: playwright instanceof Error ? `Playwright not installed in ${CACHE_DIR}` : false, timeout: 60_000 };

test('editor page: beat rows, and a preview that follows the timeline through J and L cuts', needsPlaywright, async (t) => {
  const dir = await fixture(t);
  const ed = await startEditor(dir, { port: 0 });
  t.after(() => ed.close());
  const browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  await page.goto(ed.url);
  await page.waitForFunction(() => window.editor?.state.timeline);

  // Rows: one per beat, badges from the status plan (two's QA flag), the render needed.
  const rows = await page.$$eval('#beats .beat', (els) =>
    els.map((r) => ({ id: r.dataset.id, badges: [...r.querySelectorAll('.badge')].map((b) => b.textContent) })),
  );
  assert.deepEqual(rows, [
    { id: 'one', badges: ['ready'] },
    { id: 'two', badges: ['QA', '⚑ qa: check the J cut'] },
    { id: 'three', badges: ['ready'] },
  ]);
  assert.match(await page.textContent('#render-status'), /render needed/);
  assert.equal(await page.$$eval('#lane-picture .overlap', (els) => els.length), 2);

  const tl = await page.evaluate(() => window.editor.state.timeline);
  const overlaps = await page.evaluate(() => window.editor.overlaps());
  const J = overlaps.find((o) => o.kind === 'J');
  const L = overlaps.find((o) => o.kind === 'L');
  assert.deepEqual([J.voice, J.picture, L.voice, L.picture], ['two', 'one', 'two', 'three']);

  // What the preview shows at timeline time x: whose clip, the sampled colour of its video, the video's file time
  // against the timeline's mapping, and the caption.
  const look = async (x, name) => {
    await page.evaluate((x) => window.editor.seek(x), x);
    await page.evaluate(() => window.editor.settled());
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    }
    return page.evaluate(() => {
      const clip = document.querySelector('#stage .clip:not([hidden])');
      const v = clip.querySelector('video');
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, 1, 1);
      return {
        id: clip.dataset.id,
        rgb: [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)],
        time: v.currentTime,
        caption: document.querySelector('#captions').textContent,
        active: document.querySelector('#beats .beat.active')?.dataset.id,
      };
    });
  };
  const fileTime = (id, x) => {
    const e = tl.beats.find((b) => b.id === id);
    const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
    const sc = build.beats[id].scene;
    return e.sceneWindow[0] + (x - e.picture[0]) + sc.duration - sc.end;
  };
  const dominant = (rgb) => ['red', 'lime', 'blue'][rgb.indexOf(Math.max(...rgb))];
  const checks = [
    { name: '1-one', x: 1.0, id: 'one', caption: 'Hit Save now.' },
    { name: '2-J-overlap', x: (J.range[0] + J.range[1]) / 2, id: 'one', caption: 'Next, your drafts.' },
    { name: '3-two', x: (tl.beats[1].picture[0] + tl.beats[1].picture[1]) / 2, id: 'two' },
    { name: '4-L-overlap', x: (L.range[0] + L.range[1]) / 2, id: 'three', caption: 'Next, your drafts.' },
    { name: '5-three', x: tl.beats[2].voAt + 0.6, id: 'three', caption: 'That is all.' },
  ];
  for (const c of checks) {
    const got = await look(c.x, c.name);
    assert.equal(got.id, c.id, `${c.name}: clip`);
    assert.equal(got.active, c.id, `${c.name}: active row`);
    assert.equal(dominant(got.rgb), COLORS[c.id], `${c.name}: colour ${got.rgb}`);
    assert.ok(Math.abs(got.time - fileTime(c.id, c.x)) < 0.05, `${c.name}: file time ${got.time}`);
    if (c.caption) assert.equal(got.caption, c.caption, `${c.name}: caption`);
  }

  // Playing advances the clock and the picture; pausing holds it.
  await page.evaluate(() => window.editor.seek(0));
  await page.click('#play');
  await page.waitForTimeout(1200);
  const playing = await page.evaluate(() => ({
    x: window.editor.now(),
    paused: document.querySelector('#stage .clip:not([hidden]) video').paused,
    label: document.querySelector('#play').textContent,
  }));
  assert.ok(playing.x > 0.8 && playing.x < 1.8, `played to ${playing.x}`);
  assert.equal(playing.paused, false);
  assert.equal(playing.label, 'Pause');
  await page.keyboard.press(' ');
  const held = await page.evaluate(() => window.editor.now());
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.editor.now()), held);

  // Playing across a cut switches clips on the clock.
  await page.evaluate((x) => window.editor.seek(x), tl.beats[2].picture[0] - 0.3);
  await page.click('#play');
  await page.waitForTimeout(700);
  const across = await page.evaluate(() => {
    const clip = document.querySelector('#stage .clip:not([hidden])');
    return { id: clip.dataset.id, paused: clip.querySelector('video').paused };
  });
  await page.click('#play');
  assert.deepEqual(across, { id: 'three', paused: false });

  // Scrubbing on the ruler seeks.
  const box = await page.locator('#lanes').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + 10);
  const scrubbed = await page.evaluate(() => window.editor.now());
  assert.ok(Math.abs(scrubbed - tl.total * 0.75) < 0.05, `scrubbed to ${scrubbed}`);

  assert.deepEqual(problems, []);
});

test('editor page: drag a cut within the handles, edit, save, render, and refuse a save over an external edit', { ...needsPlaywright, timeout: 120_000 }, async (t) => {
  const dir = await fixture(t);
  const file = path.join(dir, 'screencast.json');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const ed = await startEditor(dir, { port: 0 });
  t.after(() => ed.close());
  const browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  page.on('console', (m) => m.type() === 'error' && !/409|Conflict/.test(m.text()) && problems.push(m.text()));
  await page.goto(ed.url);
  await page.waitForFunction(() => window.editor?.state.timeline);
  const data = () => page.evaluate(() => window.editor.state.data);
  const badgesOf = (id) => page.$$eval(`#beats .beat[data-id="${id}"] .badges .badge`, (els) => els.map((b) => b.textContent));
  const row = (id) => page.locator(`#beats .beat[data-id="${id}"]`);
  const FRAME = 1 / 30 + 1e-3;

  // A typed timing: clear the L cut into `three`, which leaves room to drag the J cut into `two`.
  await row('three').locator('summary').click();
  await row('three').locator('input[name="cut"]').fill('');
  assert.equal((await data()).beats[2].cut, undefined);
  assert.equal(await page.textContent('#save-status'), 'Unsaved changes');

  // Drag the cut into `two` by pixels: the timeline maps them to seconds, rounded to frames.
  const lanes = await page.locator('#lanes').boundingBox();
  const T = await page.evaluate(() => window.editor.state.timeline.total);
  const pxPerSec = lanes.width / T;
  const dragCut = async (id, dv, { alt = false } = {}) => {
    const h = await page.locator(`#lane-picture .handle.cut[data-id="${id}"]`).boundingBox();
    const [x, y] = [h.x + h.width / 2, h.y + h.height / 2];
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dv * pxPerSec, y, { steps: 8 });
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
    return (await data()).beats.find((b) => b.id === id).cut;
  };
  const lim = await page.evaluate(() => window.editor.limits('two', 'cut'));
  assert.ok(Math.abs(lim.soft[1] - 1.5) <= FRAME, `the handle allows up to +1.5s, got ${lim.soft[1]}`);
  assert.ok(lim.hard[1] > lim.soft[1] + 0.3, `the timeline allows more: ${lim.hard[1]}`);

  let cut = await dragCut('two', 0.2);
  assert.ok(Math.abs(cut - 1.2) <= FRAME, `dragged to ${cut}`);
  assert.ok(!(await badgesOf('one')).includes('reshoot'));

  // Past the handle the drag stops at it...
  cut = await dragCut('two', 2);
  assert.ok(Math.abs(cut - lim.soft[1]) < 1e-6, `clamped to ${cut}`);
  assert.ok(!(await badgesOf('one')).includes('reshoot'));
  // ...unless Alt is held: then `one`'s picture runs past its footage and it shows as a re-shoot.
  cut = await dragCut('two', 0.4, { alt: true });
  assert.ok(cut > lim.soft[1] + 0.2, `alt-dragged to ${cut}`);
  assert.ok((await badgesOf('one')).includes('reshoot'), `badges ${await badgesOf('one')}`);
  assert.equal(await page.$$eval('#lane-picture .pic.over', (els) => els.map((e) => e.dataset.id).join()), 'one');
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  };
  await shot('edit-1-past-handle');
  // Back inside, without Alt.
  cut = await dragCut('two', 1.2 - cut);
  assert.ok(Math.abs(cut - 1.2) <= FRAME, `dragged back to ${cut}`);
  assert.ok(!(await badgesOf('one')).includes('reshoot'));

  // A lead drag changes the block (and the total), within `three`'s handles.
  const leadBefore = await page.evaluate(() => window.editor.state.timeline.total);
  const lh = await page.locator('#lane-voice .handle.lead[data-id="three"]').boundingBox();
  await page.mouse.move(lh.x + lh.width / 2, lh.y + lh.height / 2);
  await page.mouse.down();
  await page.mouse.move(lh.x + lh.width / 2 + 0.3 * pxPerSec, lh.y + lh.height / 2, { steps: 5 });
  await page.mouse.up();
  const lead = (await data()).beats[2].lead;
  assert.ok(Math.abs(lead - 0.8) <= FRAME, `lead ${lead}`);
  assert.ok(Math.abs((await page.evaluate(() => window.editor.state.timeline.total)) - leadBefore - (lead - 0.5)) < 1e-6);
  await row('three').locator('input[name="lead"]').fill('');

  // Save: the file on disk gets the edit; the page holds the new hash.
  await page.click('#save');
  await page.waitForFunction(() => !window.editor.state.dirty);
  const saved = disk();
  const savedCut = saved.beats.find((b) => b.id === 'two').cut;
  assert.ok(Math.abs(savedCut - 1.2) <= FRAME, `saved cut ${savedCut}`);
  assert.equal(saved.beats.find((b) => b.id === 'three').cut, undefined);
  assert.equal(saved.beats.find((b) => b.id === 'three').lead, undefined);

  // Render: a draft (QA is stale after the cut moved), streamed, then the result is loaded for playback.
  assert.equal(await page.textContent('#render'), 'Render draft');
  const code = await page.evaluate(() => window.editor.render());
  assert.equal(code, 0, await page.textContent('#render-log'));
  assert.match(await page.textContent('#render-log'), /Rendered\./);
  const total = await page.evaluate(() => window.editor.state.timeline.total);
  const out = path.join(dir, 'demo.mp4');
  assert.ok(Math.abs(probeDuration(out) - total) <= FRAME, `rendered ${probeDuration(out)}s, timeline ${total}s`);
  const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  assert.ok(build.assembly?.key, 'assembly recorded');
  assert.match(await page.getAttribute('#result', 'src'), /^\/media\/demo\.mp4\?v=\d+$/);
  assert.equal(await page.isHidden('#result'), false);

  // Rows: reorder, skip, caption position, flags; global burn-in. Each shows in the data and the timeline.
  await row('three').locator('button[name="up"]').click();
  assert.deepEqual((await data()).beats.map((b) => b.id), ['one', 'three', 'two']);
  await row('two').locator('input[name="skip"]').check();
  assert.deepEqual(await page.evaluate(() => window.editor.state.timeline.beats.map((e) => e.id)), ['one', 'three']);
  assert.ok((await badgesOf('two')).includes('skipped'));
  await row('three').locator('select[name="captionPosition"]').selectOption('top');
  assert.equal((await data()).beats[1].captionPosition, 'top');
  await row('two').locator('summary').click();
  await row('two').locator('.flags button').click(); // remove its QA flag
  await row('three').locator('select[name="flagKind"]').selectOption('reshoot');
  await row('three').locator('input[name="flagNote"]').fill('cursor missed Save');
  await row('three').locator('button[name="flagAdd"]').click();
  await page.check('#set-burn');
  const edited = await data();
  assert.equal(edited.beats[2].needs, undefined);
  assert.deepEqual(edited.beats[1].needs, [{ kind: 'reshoot', note: 'cursor missed Save' }]);
  assert.ok((await badgesOf('three')).includes('reshoot'));
  assert.ok((await badgesOf('three')).includes('⚑ reshoot: cursor missed Save'));
  assert.equal(edited.captions.burn, true);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.editor.state.dirty);
  assert.deepEqual(disk(), edited);

  // Text edits show their staleness as you type: no `say`, so `three` needs a new VO.
  await row('three').locator('textarea[name="text"]').fill('That is all, really.');
  assert.ok((await badgesOf('three')).includes('VO'), `badges ${await badgesOf('three')}`);
  assert.equal(await page.inputValue(`#beats .beat[data-id="three"] textarea[name="text"]`), 'That is all, really.');
  await shot('edit-2-rows');

  // Someone else writes screencast.json while the page has unsaved edits: the page says so, and Save is refused.
  fs.writeFileSync(file, `${JSON.stringify({ ...disk(), title: 'Edited elsewhere' }, null, 2)}\n`);
  await page.waitForFunction(() => window.editor.state.conflict);
  assert.match(await page.textContent('#notice'), /changed on disk — reload/);
  await page.evaluate(() => window.editor.save());
  assert.match(await page.textContent('#notice'), /Not saved: screencast\.json changed on disk — reload/);
  await shot('edit-3-conflict');
  assert.equal(disk().title, 'Edited elsewhere');
  assert.equal(disk().beats[1].text, 'That is all.');
  await page.click('#notice button');
  await page.waitForFunction(() => !window.editor.state.dirty && !window.editor.state.conflict);
  assert.equal(await page.textContent('#title'), 'Edited elsewhere');
  assert.equal(await page.isHidden('#notice'), true);

  // Without unsaved edits, a change on disk just reloads.
  fs.writeFileSync(file, `${JSON.stringify({ ...disk(), title: 'Again' }, null, 2)}\n`);
  await page.waitForFunction(() => document.querySelector('#title').textContent === 'Again');
  assert.equal(await page.evaluate(() => window.editor.state.conflict), false);

  assert.deepEqual(problems, []);
});
