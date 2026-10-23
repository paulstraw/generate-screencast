# Filming a macOS app

The real screen is captured with ffmpeg (`avfoundation`, real cursor included) while `mousectl` — a tiny CoreGraphics
driver compiled from this skill — moves, clicks and types on the same `Clock`. Click ripples are burned in afterwards
from the logged click timeline.

Nothing is copied into the project: `film.mjs` imports `<skill>/assets/project.mjs` and `native-helpers.mjs` by absolute
path. `startDriver` and `probePermissions` build the driver on first use (and again whenever `mousectl.swift` changes)
into the shared cache beside Playwright, which needs Xcode or the Command Line Tools.

## Hands off

Native takes drive the user's real mouse and keyboard. Before the first take, tell the user to keep their hands off the
machine until you say you're done, and to turn on Do Not Disturb — anything they click, or any notification that lands,
ends up in the take or derails it. Say clearly when they can have it back.

## Permissions — probe before anything else

Both are granted to the app hosting this session (iTerm, Terminal, Ghostty, VS Code, …).

```js
import os from 'node:os';
import { probePermissions } from '<skill>/assets/native-helpers.mjs';
console.log(await probePermissions(os.tmpdir())); // { frame, accessibility }
```

- **Screen Recording**: Look at `frame`. Real windows visible → granted. Wallpaper only, or no frame → denied: System
  Settings ▸ Privacy & Security ▸ Screen & System Audio Recording. Delete the frame right after looking — it's a grab of
  the user's whole desktop.
- **Accessibility** (`accessibility: false`): System Settings ▸ Privacy & Security ▸ Accessibility. If the host app is
  already switched on there and input still fails, toggle it off and on, then restart the host app.

## Before each take

- **Reset app state** to what the script assumes — empty document, default toggles, scroll at top. State left by a
  previous take silently breaks the truth rule (a "turn on bold" click that actually turns it off).
- Activate the app and size its window: `activate(app)`, `setWindowBounds(app, {x, y, w, h})`. A 16:9 window
  (e.g. 1280×720 pt) fills the frame with no letterboxing. `setWindowBounds` uses the app's own AppleScript `bounds` and
  falls back to System Events, which some apps refuse (-10003).
- Recon: start a 1s cropped capture (below), grab its last frame, look at it. Positions for `glide` are screen points:
  window origin + (frame pixel ÷ frame width × window width).

## Region and the privacy guard

Crop to the app window by default and always pass `guardApp`:

```js
const cap = startScreenCapture(b.file, { region: windowBounds('TextEdit'), guardApp: 'TextEdit' });
```

A crop region shows whatever is there — if the window leaves (focus change, Space switch, the user clicking), the take
records the desktop behind it. The guard refuses to start unless `guardApp` is frontmost, polls during the take, and on
any change kills ffmpeg, deletes the file, and makes `stop()` throw. Re-shoot when it fires. Capture full screen (omit
`region`) only when a beat genuinely spans apps, and QA every frame for anything private.

Rounded window corners show a sliver of wallpaper inside a rectangular crop; it's barely visible at 1080p.

## Recipe

```js
import { loadProject } from '<skill>/assets/project.mjs';
import { activate, nativeScene, windowBounds, startScreenCapture, startDriver, sleep } from '<skill>/assets/native-helpers.mjs';

const p = loadProject(import.meta.dirname);
const d = await startDriver();
try {
  await p.film({
    edit: nativeScene(p, async (b) => {
      activate('TextEdit');
      await sleep(600);
      const region = windowBounds('TextEdit');
      await d.move(region.x + 900, region.y + 500); // park the cursor in frame
      const cap = startScreenCapture(b.file, { region, guardApp: 'TextEdit' }); // b.file = scenes/<id>.mp4
      const clock = await b.ready(cap, d); // first frames in, head handle held: scene time 0
      await clock.until(b.at('bold') - 900);
      await d.glide(region.x + 68, region.y + 49, 900);
      await d.click();
      await clock.until(b.at('type'));
      await d.type('Hello');
    }), // held to b.sceneMs + the tail handle, then the capture stops
  });
} finally {
  d.close();
}
```

Every driver call resolves when the action has finished (`glide` takes exactly its `ms`; `type` ~40ms/char), so
`clock.until` marks are absolute deadlines. A `clock overrun` warning means the choreography doesn't fit its marks.
`nativeScene` records the beat's `scene` entry and writes `scenes/<id>.capture.json` (`t0`, `stoppedAt`, `duration`,
`region`, `scale`, `clicks`) for the ripple pass.

## Ripples

```js
import fs from 'node:fs';
import { clicksToVideo } from '<skill>/assets/native-helpers.mjs';
const log = JSON.parse(fs.readFileSync('scenes/edit.capture.json'));
const pts = clicksToVideo(log.clicks, { ...log, videoDuration: log.duration, srcW: log.region.w * log.scale, srcH: log.region.h * log.scale });
fs.writeFileSync('scenes/edit.ripples.json', JSON.stringify(pts));
```

Then burn them in and point the beat at the result (same length, so `build.json`'s timing still holds; `raw` keeps the
original):

```bash
node <skill>/assets/ripples.mjs scenes/edit.mp4 scenes/edit.ripples.json scenes/edit.r.mp4
node <skill>/assets/project.mjs use . edit scenes/edit.r.mp4
```

For a full-screen capture pass `srcW/srcH` as the display's pixel size and omit `region`. Re-filming a beat rewrites
`scenes/<id>.mp4` and points `scene.file` back at it, so run the ripple pass again after every take.
