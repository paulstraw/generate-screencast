# Filming a browser

Browser beats are `p.browserScene` scenes in the project's `film.mjs`, one per beat id. Import the skill's scripts by
absolute path (nothing is copied into the project), and Playwright through `importPlaywright()`, which loads the shared
install in `~/.cache/generate-screencast`:

```js
import { loadProject, importPlaywright } from '<skill>/assets/project.mjs';
import { setCur, glide, clickHere, bboxCenter } from '<skill>/assets/film-helpers.mjs';

const p = loadProject(import.meta.dirname);
const { chromium } = await importPlaywright();
const browser = await chromium.launch();
await p.film({
  save: p.browserScene(
    browser,
    async (page, b) => {
      await page.goto(URL, { waitUntil: 'networkidle' });
      await setCur(page, 960, 540);
      const clock = await b.ready(); // screen settled: holds the head handle, then scene time 0
      const at = await bboxCenter(page.getByRole('button', { name: 'Save' }));
      await clock.until(b.at('Save') - 700); // land the click on the word
      await glide(page, at.x, at.y, 700);
      await clickHere(page);
    }, // on return the final state is held to b.sceneMs + the tail handle, then the context closes
    { storageState: 'auth.json' }, // context options; storageState only when logged in
  ),
});
await browser.close();
```

`node film.mjs save` films just that beat and records it in `build.json`.

- Recording is the project's `size` (default 1920×1080). The helpers inject a fake cursor and click ripples into the
  **top** document only — it paints above iframes, so one cursor covers the whole viewport.
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
const { chromium } = await importPlaywright();
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(LOGIN_URL);
// tell the user: "log in in the window that just opened, then say done"
await page.waitForURL(POST_LOGIN_PATTERN, { timeout: 10 * 60_000 });
await ctx.storageState({ path: 'auth.json' });
await browser.close();
```

`auth.json` stays in the project folder (gitignored there if it's in a repo) and is deleted at cleanup. Pass it as
`storageState` in `p.browserScene`'s third argument, the context options, as above. Filmed pages
show the logged-in account — check in QA that its name, email and avatar are acceptable on screen, and ask if unsure.
