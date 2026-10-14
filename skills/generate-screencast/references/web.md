# Filming a browser

Copy `<skill>/assets/film-helpers.mjs` into the workdir. In `film.mjs`, import Playwright from the workdir install
and pass `browser` into the helpers:

```js
import { chromium } from 'playwright';
import { makeRecorder, setCur, glide, clickHere, bboxCenter, Clock, sleep } from './film-helpers.mjs';

const browser = await chromium.launch();
const record = makeRecorder(browser, 'scenes', { storageState: AUTH }); // storageState only when logged in

await record('s1', async (page) => {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const clock = new Clock();
  await setCur(page, 960, 540);
  await clock.until(1500);
  const p = await bboxCenter(page.getByRole('button', { name: 'Save' }));
  await glide(page, p.x, p.y, 700);
  await clickHere(page);
  await clock.until(SCENE_MS); // context closes the moment the clock runs out
});
await browser.close();
```

- Recording is 1920×1080. The helpers inject a fake cursor and click ripples into the **top** document only — it paints
  above iframes, so one cursor covers the whole viewport.
- A full page load re-runs the init script and the cursor starts hidden until the next `setCur`/`glide` — call `setCur`
  after every `goto`. Client-side (SPA) navigation keeps the cursor.
- Recon the **result** of each click, not just its position: a click can move the app somewhere else (a dot that switches
  tabs), and the next mark's choreography starts from wherever it lands.
- Check the port a dev server actually printed before pointing Playwright at it. A busy port usually means an instance
  is already up — filming is read-only, so use it.

## Re-shootable takes

When a scene sends data (a reply, a save), hold writes so the server never sees them and the scene can be re-shot
indefinitely. Let boot-time writes through first (session resume, auth refresh), then fulfil nothing that writes:

```js
let booted = false;
await page.route('**/api/**', (route) =>
  !booted || route.request().method() === 'GET' ? route.continue() : undefined, // a held write never resolves
);
await page.goto(URL, { waitUntil: 'networkidle' });
booted = true;
```

UI that renders optimistically still shows the action on screen. Check in recon that it does; UI that waits for the
server needs its response faked with `route.fulfill` instead.

## Deployed or remote URLs

Same recipe, plus whatever the page throws at a fresh profile: cookie banners, consent modals, chat widgets, "what's new"
toasts. Find them in recon and dismiss or hide them (`el.style.display = 'none'`) before the clock starts.

## Logging in

Never put credentials in a film script. Capture a session once, headed, with the user doing the login:

```js
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(LOGIN_URL);
// tell the user: "log in in the window that just opened, then say done"
await page.waitForURL(POST_LOGIN_PATTERN, { timeout: 10 * 60_000 });
await ctx.storageState({ path: 'auth.json' });
await browser.close();
```

`auth.json` stays in the workdir and is deleted at cleanup. Pass it as `storageState` to `makeRecorder`. Filmed pages
show the logged-in account — check in QA that its name, email and avatar are acceptable on screen, and ask if unsure.
