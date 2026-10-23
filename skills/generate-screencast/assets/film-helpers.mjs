/*
 * Browser choreography helpers: a fake cursor (Playwright's real one isn't
 * recorded), smooth glides, clicks with ripples, and the Clock that schedules
 * every action against scene-time marks. Recording itself is project.mjs's
 * p.browserScene(), which uses CURSOR_INIT and Clock from here.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The fake cursor lives in the top document only: fixed-position with a max
 * z-index, it paints above the preview iframe, so one element covers the
 * whole viewport and never duplicates across frames.
 */
export const CURSOR_INIT = `
if (window === window.top) {
  const install = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .25s;will-change:transform;';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M5.5 2.2 L5.5 18.6 L9.7 14.9 L12.3 21 L15 19.8 L12.4 13.8 L18 13.4 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    window.__setCur = (x, y) => { c.style.opacity = '1'; c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    window.__hideCur = () => { c.style.opacity = '0'; };
    window.__ripple = (x, y) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + (x - 18) + 'px;top:' + (y - 18) + 'px;width:36px;height:36px;border-radius:50%;border:2.5px solid rgba(56,132,255,.85);z-index:2147483646;pointer-events:none;';
      document.body.appendChild(r);
      r.animate([{ transform: 'scale(.35)', opacity: .95 }, { transform: 'scale(1.3)', opacity: 0 }], { duration: 480, easing: 'ease-out' }).onfinish = () => r.remove();
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
}
`;

const pos = new WeakMap();

export async function setCur(page, x, y) {
  pos.set(page, { x, y });
  await Promise.all([
    page.mouse.move(x, y),
    page.evaluate(([px, py]) => window.__setCur && window.__setCur(px, py), [x, y]).catch(() => {}),
  ]);
}

export async function glide(page, x, y, ms) {
  const from = pos.get(page) || { x: 960, y: 540 };
  const start = Date.now();
  while (true) {
    const t = Math.min(1, (Date.now() - start) / ms);
    const e = t * t * (3 - 2 * t);
    const cx = from.x + (x - from.x) * e;
    const cy = from.y + (y - from.y) * e;
    await Promise.all([
      page.mouse.move(cx, cy),
      page.evaluate(([px, py]) => window.__setCur && window.__setCur(px, py), [cx, cy]).catch(() => {}),
    ]);
    if (t >= 1) break;
    await sleep(18);
  }
  pos.set(page, { x, y });
}

export async function clickHere(page) {
  const p = pos.get(page);
  await page.evaluate(([x, y]) => window.__ripple && window.__ripple(x, y), [p.x, p.y]).catch(() => {});
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

export async function bboxCenter(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('no bbox for locator');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/* Schedules choreography against absolute marks so scene length is exact. */
export class Clock {
  constructor() {
    this.t0 = Date.now();
  }
  async until(ms) {
    let d = this.t0 + ms - Date.now();
    if (d < -400) console.warn(`clock overrun ${-d}ms at mark ${ms}`);
    // setTimeout can fire a millisecond early by Date.now(); never return before the mark.
    while (d > 0) {
      await sleep(d);
      d = this.t0 + ms - Date.now();
    }
  }
}
