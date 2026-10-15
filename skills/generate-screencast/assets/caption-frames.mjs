/*
 * Renders burned-in captions as transparent PNGs with Chromium, one per cue,
 * for assemble.mjs to lay over each clip with ffmpeg's core `overlay` filter —
 * so burn-in works on any ffmpeg build, with or without libass or freetype.
 *
 *   const frames = await renderCaptionFrames(cues, { size: [W, H], dir, from });
 *   // → [{ png, x, y }] parallel to cues; each cue may carry position: 'top'
 *
 * Each PNG holds just the pill (plus its shadow), and x/y place it in the
 * W×H frame: bottom-center by default, clear of a portrait phone's tab and
 * home bars, or top-center. Playwright is resolved from `from` (the workdir),
 * where preflight installs it.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const page = ({ W, H, font, edge, side, position }) => `<!doctype html>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; overflow: hidden; }
  #wrap {
    position: absolute; left: ${side}px; right: ${side}px; ${position === 'top' ? 'top' : 'bottom'}: ${edge}px;
    display: flex; justify-content: center;
  }
  #shot { padding: ${Math.round(font * 0.4)}px; }
  #pill {
    font: 600 ${font}px/1.25 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
    color: #fff; text-align: center; white-space: pre; letter-spacing: 0.005em;
    padding: ${Math.round(font * 0.28)}px ${Math.round(font * 0.6)}px;
    border-radius: ${Math.round(font * 0.45)}px;
    background: rgba(12, 14, 20, 0.78);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 ${Math.round(font * 0.15)}px ${Math.round(font * 0.4)}px rgba(0, 0, 0, 0.35);
    -webkit-text-stroke: ${Math.max(1, Math.round(font / 40))}px rgba(0, 0, 0, 0.55);
    paint-order: stroke fill;
  }
</style>
<div id="wrap"><div id="shot"><div id="pill"></div></div></div>`;

export async function renderCaptionFrames(cues, { size: [W, H], dir, from }) {
  let chromium;
  try {
    ({ chromium } = createRequire(path.join(from, 'noop.js'))('playwright'));
  } catch {
    throw new Error(
      `"captions": "burn" renders captions with Playwright, which isn't installed in ${from}.\n` +
        `  cd ${from} && npm init -y >/dev/null && npm i playwright && npx playwright install chromium`,
    );
  }
  const portrait = H > W;
  const unit = Math.min(W, H);
  const font = Math.round(unit * 0.037);
  // Portrait output is usually a full-bleed phone screen: sit above its tab and
  // home bars at the bottom, below the status bar and island at the top.
  const edges = { bottom: Math.round(portrait ? H * 0.16 : H * 0.06), top: Math.round(portrait ? H * 0.09 : H * 0.04) };
  const side = Math.round(W * 0.04);

  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: W, height: H } });
    const out = [];
    let layout = null;
    for (const [i, cue] of cues.entries()) {
      const position = cue.position === 'top' ? 'top' : 'bottom';
      if (layout !== position) {
        await p.setContent(page({ W, H, font, edge: edges[position], side, position }));
        await p.evaluate(() => document.fonts.ready);
        layout = position;
      }
      // A wide-glyph line can outgrow a narrow frame: step the font down until it fits.
      await p.$eval('#pill', (el, [t, size]) => {
        el.textContent = t;
        const room = document.getElementById('wrap').clientWidth;
        for (let s = size; s > size * 0.7 && document.getElementById('shot').offsetWidth > room; s--) el.style.fontSize = `${s - 1}px`;
      }, [cue.text, font]);
      const shot = await p.$('#shot');
      const box = await shot.boundingBox();
      const png = path.join(dir, `cap${String(i + 1).padStart(3, '0')}.png`);
      await shot.screenshot({ path: png, omitBackground: true });
      out.push({ png, x: Math.round(box.x), y: Math.round(box.y) });
    }
    return out;
  } finally {
    await browser.close();
  }
}
