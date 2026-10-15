# Filming the iOS Simulator

The simulator's framebuffer is recorded with `simctl` — device resolution, nothing from the host desktop in it, so no
privacy guard is needed. Taps are real clicks into the Simulator window through `mousectl`, so set up the driver and
the hands-off rule from [macos.md](macos.md) (Accessibility only; Screen Recording isn't used). Taps are logged and
burned in as ripples after framing.

## Setup

- Boot and open: `xcrun simctl list devices available`, `xcrun simctl boot <udid>`, `open -a Simulator`, then
  `xcrun simctl launch booted <bundle-id>` or `xcrun simctl openurl booted <url>`.
- Hide device bezels so the window is exactly screen + title bar:
  `osascript -e 'tell application "System Events" to tell process "Simulator" to click menu item "Show Device Bezels" of menu "Window" of menu bar item "Window" of menu bar 1'`
  (it toggles — read `AXMenuItemMarkChar` of that item first; `✓` means on). Restore it at cleanup.
- Clean status bar: `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100
  --cellularBars 4 --wifiBars 3`; `xcrun simctl status_bar booted clear` at cleanup.
- Recon: `xcrun simctl io booted screenshot shot.png` and look at it. Tap coordinates are **device points** = screenshot
  pixels ÷ device scale (3 on current iPhones; e.g. iPhone 17 Pro is 1206×2622 px = 402×874 pt).

## Recipe

```js
import fs from 'node:fs';
import { Clock } from './film-helpers.mjs';
import { activate, frontmostApp, simMapper, startSimRecording, startDriver, sleep } from './native-helpers.mjs';

activate('Simulator');
await sleep(700);
if (frontmostApp() !== 'Simulator') throw new Error('Simulator not frontmost');
const toScreen = simMapper(402, 874);   // device size in points; throws if bezels are showing
const d = await startDriver();
const cap = startSimRecording();
await sleep(1200);
const clock = new Clock();
const p = toScreen(339, 422);
await d.glide(p.x, p.y, 500);
await clock.until(2400);
await d.click();
d.clicks.at(-1).device = [339, 422];    // device coords, for the ripple overlay
await clock.until(SCENE_MS);
const { stoppedAt } = await cap.stop('scenes/s2.mp4');   // re-timed to constant 30fps
d.close();
fs.writeFileSync('scenes/s2.clicks.json', JSON.stringify({ stoppedAt, clicks: d.clicks }));
```

`simctl` only writes frames when the screen changes; `stop(out)` re-times the file from the real start to the real stop,
so trim-from-the-end stays aligned.

## Framing and ripples

16:9 (default for mixed videos): frame first, then ripple in framed coordinates. With burned-in captions, frame with
`--height 820 --top 30` and pass `height: 820, top: 30` to `tapsToFrame`, so the captions get a band below the phone.

```js
// node device-frame.mjs scenes/s2.mp4 scenes/s2.framed.mp4
import { tapsToFrame } from './native-helpers.mjs';
const pts = tapsToFrame(log.clicks, { stoppedAt: log.stoppedAt, videoDuration /* of s2.framed.mp4 */, devicePx: [1206, 2622], deviceScale: 3 });
// node ripples.mjs scenes/s2.framed.mp4 s2.ripples.json scenes/s2.r.mp4
```

Portrait (all-mobile videos, if the user chose it): skip `device-frame.mjs`, set `"size": [1080, 1920]` in the assembly
manifest, and map ripple coords by `1080 / devicePxWidth`.
