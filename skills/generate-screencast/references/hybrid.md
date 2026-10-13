# Hybrid takes: the user drives

When a beat can't be scripted reliably (an app that ignores synthetic input, a hardware flow, a fiddly gesture), the
user performs it while the skill records and cues. The voiceover, assembly and QA stay automated.

1. Start the capture the surface would normally use (screen capture, `simctl`, `screenrecord`).
2. Wait ~1s, log `startedAt = Date.now()`, then play the scene's VO aloud: `afplay vo/beatN.mp3` — the user hears exactly
   what the viewer will hear and acts along with it.
3. In the terminal, print a countdown and each cue at its mark, from the same VO timing the clock would use
   (`3… 2… 1…`, then `▶ 2.4s — click "Export"`).
4. Stop the capture 0.5s after the VO ends (1.0s on the final scene).
5. Assembly trims the last target-seconds as usual; because the VO started at a known instant, the take lines up. If the
   user was early or late, re-take, or shift that clip's trim window by the observed offset.

Hybrid takes are on the real screen: Do Not Disturb, and a region crop, matter even more. Clicks the user makes are not
logged, so there are no ripples unless the surface draws its own (Android show-touches).
