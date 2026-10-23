# Filming an Android emulator

Everything goes through `adb`: `screenrecord` captures the framebuffer, `input tap/swipe/text` drives it, and the
system's own **show touches** dots are drawn into the framebuffer — no post-processed ripples needed.

## Setup

- Start an emulator if none is running: `emulator -list-avds`, then
  `emulator -avd <name> -no-snapshot-save &` (the binary lives in `$ANDROID_HOME/emulator` or
  `~/Library/Android/sdk/emulator`). Wait: `adb wait-for-device && adb shell getprop sys.boot_completed` → `1`.
- Clean status bar via demo mode (then `-e command enter`):
  `adb shell settings put global sysui_demo_allowed 1` then
  `adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941`,
  `… -e command battery -e level 100 -e plugged false`, `… -e command notifications -e visible false`.
  Exit at cleanup with `-e command exit` and `sysui_demo_allowed 0`. Stop the emulator only if you started it
  (`adb emu kill`).
- Recon before tapping into an app for the first time: first-run screens (Chrome's sign-in, permission prompts) change
  persistent emulator state when dismissed — prefer a screen that's already set up, or ask.
- Open the app: `adb shell monkey -p <package> 1`, or a URL: `adb shell am start -a android.intent.action.VIEW -d <url>`.
- Recon: `adb exec-out screencap -p > shot.png` and look at it. `input` coordinates are **device pixels** — the same as the
  screenshot.

## Recipe

```js
import { loadProject } from '<skill>/assets/project.mjs';
import { nativeScene, startAndroidRecording, tap, androidText } from '<skill>/assets/native-helpers.mjs';

const p = loadProject(import.meta.dirname);
await p.film({
  compose: nativeScene(p, async (b) => {
    const cap = startAndroidRecording(); // also turns on show_touches
    const clock = await b.ready(cap);
    await clock.until(b.at('Tap'));
    tap(540, 1200);
    await clock.until(b.at('type'));
    androidText('hello world');
  }),
});
```

`adb shell input` calls take ~100–300ms each; they're synchronous, so marks stay absolute deadlines. `screenrecord` only
writes frames when the screen changes; `stop()` re-times the file from the real start to the real stop, so the
end-aligned scene timing holds. It caps at 180s per file — one scene per recording keeps far under it. The tap's own
Material ripple plus show-touches is the touch indicator; no `ripples.mjs` pass. Turn `show_touches` back off at cleanup
(`adb shell settings put system show_touches 0`).

Framing for 16:9: `node <skill>/assets/device-frame.mjs scenes/compose.mp4 scenes/compose.framed.mp4` (add
`--height 820 --top 30` with burned-in captions), then `node <skill>/assets/project.mjs use . compose
scenes/compose.framed.mp4`. Or portrait throughout (see [ios.md](ios.md)).
