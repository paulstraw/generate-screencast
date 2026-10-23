# Hybrid takes: the user drives

When a beat can't be scripted reliably (an app that ignores synthetic input, a hardware flow, a fiddly gesture), the
user performs it while the skill records and cues. The voiceover, assembly and QA stay automated.

The beat is a `nativeScene` like any native one (see the surface's reference for the capture), with cues instead of a
driver. The user runs `node film.mjs <id>` in a terminal of their own, so they can see the cues:

```js
import { spawn } from 'node:child_process';
import { loadProject } from '<skill>/assets/project.mjs';
import { nativeScene, startScreenCapture, windowBounds } from '<skill>/assets/native-helpers.mjs';

const p = loadProject(import.meta.dirname);
const cues = [['Export', 'click "Export"']]; // [word in the VO, what to do]
await p.film({
  export: nativeScene(p, async (b) => {
    const cap = startScreenCapture(b.file, { region: windowBounds('Keynote'), guardApp: 'Keynote' });
    console.log('get ready…');
    const clock = await b.ready(cap);
    await clock.until(b.voAt);
    spawn('afplay', [p.voFile(b.id)], { stdio: 'ignore' }); // they hear exactly what the viewer will
    for (const [word, what] of cues) {
      const at = b.at(word);
      for (const n of [3, 2, 1]) await clock.until(at - n * 1000).then(() => console.log(`${n}…`));
      console.log(`▶ ${(at / 1000).toFixed(1)}s — ${what}`);
    }
  }), // held to b.sceneMs + the tail handle, then the capture stops
});
```

The VO starts at a known scene time, so the take lines up like any other. If the user was early or late, re-take it
(`node film.mjs export`).

Hybrid takes are on the real screen: Do Not Disturb, and a region crop, matter even more. Clicks the user makes are not
logged, so there are no ripples unless the surface draws its own (Android show-touches).
