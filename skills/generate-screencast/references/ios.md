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
import os from 'node:os';
import { loadProject } from '<skill>/assets/project.mjs';
import { activate, frontmostApp, nativeScene, simMapper, startSimRecording, startDriver, sleep } from '<skill>/assets/native-helpers.mjs';

const p = loadProject(import.meta.dirname);
const d = await startDriver(`${os.homedir()}/.cache/generate-screencast/mousectl`);
try {
  await p.film({
    open: nativeScene(p, async (b) => {
      activate('Simulator');
      await sleep(700);
      if (frontmostApp() !== 'Simulator') throw new Error('Simulator not frontmost');
      const toScreen = simMapper(402, 874); // device size in points; throws if bezels are showing
      const cap = startSimRecording();
      const clock = await b.ready(cap, d);
      const at = toScreen(339, 422);
      await d.glide(at.x, at.y, 500);
      await clock.until(b.at('Open'));
      await d.click();
      d.clicks.at(-1).device = [339, 422]; // device coords, for the ripple overlay
    }),
  });
} finally {
  d.close();
}
```

`simctl` only writes frames when the screen changes; `stop()` re-times the file from the real start to the real stop
(constant 30fps), so the end-aligned scene timing holds. `nativeScene` writes `scenes/<id>.capture.json` with the
clicks and `stoppedAt`.

## Framing and ripples

16:9 (default for mixed videos): frame first, then ripple in framed coordinates. With burned-in captions, frame with
`--height 820 --top 30` and pass `height: 820, top: 30` to `tapsToFrame`, so the captions get a band below the phone.

```js
// node <skill>/assets/device-frame.mjs scenes/open.mp4 scenes/open.framed.mp4
import { tapsToFrame } from '<skill>/assets/native-helpers.mjs';
const log = JSON.parse(fs.readFileSync('scenes/open.capture.json'));
const pts = tapsToFrame(log.clicks, { stoppedAt: log.stoppedAt, videoDuration: log.duration, devicePx: [1206, 2622], deviceScale: 3 });
fs.writeFileSync('scenes/open.ripples.json', JSON.stringify(pts));
// node <skill>/assets/ripples.mjs scenes/open.framed.mp4 scenes/open.ripples.json scenes/open.r.mp4
// node <skill>/assets/project.mjs use . open scenes/open.r.mp4
```

Portrait (all-mobile videos, if the user chose it): skip `device-frame.mjs`, set `"size": [1080, 1920]` in
`screencast.json`, and map ripple coords by `1080 / devicePxWidth`.
