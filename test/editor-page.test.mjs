import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startEditor } from '../skills/generate-screencast/assets/editor.mjs';
import { PLAYWRIGHT_HOME, importPlaywright, loadProject, voKey } from '../skills/generate-screencast/assets/project.mjs';
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
  : { skip: playwright instanceof Error ? `Playwright not installed in ${PLAYWRIGHT_HOME}` : false, timeout: 60_000 };

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
