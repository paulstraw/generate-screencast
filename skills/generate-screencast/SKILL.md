---
name: generate-screencast
description:
  Produce a short Loom-style screencast — a scripted recording of real running software with an AI voiceover or the
  user's own narration — in any project. Use when asked to make a video, demo, tour, or walkthrough of a web app,
  Storybook, a terminal workflow, a macOS app, or an iOS/Android app, or to refresh an existing one.
---

# Generate a screencast

Script → per-beat voiceover, TTS or the user's own voice (its measured durations drive every scene length) → scenes filmed
on a **clock** from real running surfaces → QA → ffmpeg assembly. Working files live in a **workdir**: a `screencast/`
folder in the session scratchpad if your harness provides one, otherwise in a fresh `mktemp -d`. Only the deliverables
leave it.

`<skill>` below means this skill's directory. QA depends on looking at frames, so this skill needs an agent that can
view images; macOS, iOS and the native helpers need macOS.

## 1. Shape the video

Interview the user, or confirm what's already specified. Nothing is produced until the script is approved verbatim.

- **Subject and audience** — what should the viewer understand or believe when it ends?
- **Beats** — one idea per ~10s beat; ~150 words ≈ 55s of narration. 30–90s is the sweet spot. For each beat, name its
  **surface**: browser, Storybook, terminal, macOS app, iOS Simulator, Android emulator.
- **Deliverable** — default `~/Downloads/<slug>-<YYYY-MM-DD>.mp4`, plus the approved script beside it as
  `<slug>-<YYYY-MM-DD>.script.md`. Offer a repo path (e.g. `docs/<slug>.mp4`) when the video belongs to the project.
- **Voice** — default `en-US-AndrewNeural`. Offer another voice or locale when the audience calls for it
  (`uvx edge-tts --list-voices`). When the user narrates in their own voice, load
  [references/human-vo.md](references/human-vo.md): it replaces §3. Then ask whether they want their camera in the
  video, and mark each beat `pip` (a face bubble over the screen), `full` (camera only) or `off`. Only beats that aren't
  narrating the UI can be `full`.
- **Aspect** — 1920×1080. When every beat is mobile, ask: 16:9 with the phone framed on a stage, or portrait 1080×1920.

The **truth rule** outranks any draft: the voiceover never claims something the screen doesn't show at that moment.
Overlays that are visibly annotation (numbered rings on "the chat, the thread, the console") are within it, and they make
an enumeration land.

- Footage that doesn't exist yet (a page, a flow, a state) is built for real. In the user's project: propose the change,
  get approval, and pass that project's own checks (its CLAUDE.md/AGENTS.md, tests, lint). For a purely illustrative beat,
  a throwaway page in the workdir is fine.
- Terminal footage is curated real output: run the command, keep the honest lines, drop noise. Never invent output.

## 2. Preflight

Detect everything the beats need and offer **one** `brew install …` (or equivalent) for whatever is missing:

| Need                    | Check                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| every video             | `ffmpeg`, `ffprobe`, `uvx` (for `edge-tts`), `node`                                 |
| browser/terminal beats  | Playwright in the workdir (below)                                                   |
| macOS / iOS beats       | `swiftc` (builds `mousectl`); the permission probe in [references/macos.md](references/macos.md) |
| iOS beats               | `xcrun simctl`, a booted simulator                                                  |
| Android beats           | `adb`, a running emulator                                                           |
| human-read voiceover    | `sox`; Apple Silicon for `mlx-whisper` (via `uvx`)                                  |
| camera (human VO only)  | `swiftc`; Camera permission, device and framing via `camrec` ([references/human-vo.md](references/human-vo.md#camera)) |

Playwright always installs into the workdir, never the project, so the project's lockfile is never touched:

```bash
cd <workdir> && npm init -y >/dev/null && npm i playwright && npx playwright install chromium
```

Then load the reference for every surface the script uses — each holds the recipe and the hard-won gotchas:

- Browser, local or deployed (incl. login) → [references/web.md](references/web.md)
- Storybook → [references/web.md](references/web.md) **and** [references/storybook.md](references/storybook.md)
- Terminal → [references/terminal.md](references/terminal.md)
- macOS app → [references/macos.md](references/macos.md)
- iOS Simulator → [references/macos.md](references/macos.md) **and** [references/ios.md](references/ios.md)
- Android emulator → [references/android.md](references/android.md)
- Any beat that can't be scripted reliably → [references/hybrid.md](references/hybrid.md)

Done when every tool is present, every needed permission is granted, and every surface to be filmed is running.

## 3. Voiceover

For a human-read voiceover, follow [references/human-vo.md](references/human-vo.md) instead.

- One clip per beat: `uvx edge-tts --voice <voice> --text "…" --write-media vo/beatN.mp3`. It's a free online service
  that occasionally hangs: wrap each call in a timeout and retry (`perl -e 'alarm 30; exec @ARGV' uvx edge-tts …`).
- Spell awkward tokens phonetically for TTS input only ("pnpm" → "P N P M"); the saved script keeps the real spelling.
- `ffprobe` each clip. Scene length = 0.5s lead + VO + 0.5s tail (1.0s tail on the final scene).
- When a cut or action must land on a spoken word, `--write-subtitles` yields sentence-level cues; interpolate within a
  sentence by word count. Word-level events are unreliable in the CLI.

Done when every beat has a clip and a computed scene length.

## 4. Film

Write one `film.mjs` in the workdir, one recorded scene per beat, every action scheduled on a `Clock` (from
`<skill>/assets/film-helpers.mjs`) against marks derived from the VO timing. Scenes record to `scenes/<name>.(webm|mp4)`
and accept a scene-name argv filter so single scenes can be re-shot (`node film.mjs s3`).

**Recon first**: screenshot every screen you plan to film and look at the image before writing choreography. What a screen
looks like, and where its controls sit, is never safe to assume. Reuse existing state before generating new state: a
project's prior dev sessions, seeded accounts or saved data often already hold every state the beats need, more cleanly
than a fresh nondeterministic run would.

Each recording starts early and ends exactly when its clock runs out — load and settle noise sits at the front and is
trimmed away in assembly. So clock marks are scene time: start the clock when the screen is ready, end it at
`SCENE_MS`, and the VO begins at 500ms.

Native beats (macOS, iOS) drive the user's real mouse and keyboard: tell them to keep hands off until you say you're
done, and tell them when they can have the machine back.

## 5. QA — non-negotiable

Extract frames across every scene's trim window and look at them. `<skill>/assets/qa-grid.sh` tiles a scene's frames at
given scene times (VO marks included) into one image, mapping them into the raw recording the way assembly trims it.
Check, at each VO moment:

- the thing being narrated is on screen (truth rule);
- the cursor or touch indicator is visible where action happens; mode or state flips happened;
- nothing private or stray is in frame — notifications, other apps, personal tabs, names, tokens, the menu-bar clock.

With the camera on, also check that the bubble never covers the thing being narrated, that camera frames pass the same
privacy check for the room (what's behind the user, other people, other screens), and spot-check lip sync on at least
one beat ([references/human-vo.md](references/human-vo.md#camera)).

Re-shoot failing scenes. Done when every frame you checked passes.

## 6. Assemble

Post-process first where a surface needs it (`device-frame.mjs` for framed mobile, `ripples.mjs` for macOS/iOS clicks —
see their references), then write a manifest and run `<skill>/assets/assemble.mjs`:

```json
{ "out": "~/Downloads/<slug>-<date>.mp4 (absolute)", "scenes": [{ "video": "scenes/s1.webm", "vo": "vo/beat1.mp3" }] }
```

It trims each recording to its **last** 0.5 + VO + 0.5s (1.0s tail on the final scene) — the 0.5s lead is a static hold,
so ±0.3s drift is invisible — concatenates, places each VO at its clip's actual start + 0.5s, muxes with faststart, and
prints per-scene timings plus loudness (healthy: mean −18…−26 dB, max < −1 dB). It fails loudly if a recording is shorter
than its scene. Add `"size": [1080, 1920]` for portrait, and `"normalize": true` for a human-read voiceover (two-pass
loudnorm on each clip before the mix, so the finished track needs no dynamic processing). Camera beats add `cam`,
`camTrim` and `camMode` per scene (see [references/human-vo.md](references/human-vo.md#camera)).

Write the `.script.md` beside the video, then spot-check frames at beat boundaries in the final file. For a human-read
voiceover, the user also listens to the final file once and confirms it sounds clean: frames check the picture, and only
a human ear checks the audio.

## Cleanup

Leave the user's dev servers, simulators and emulators running if they were running before; stop the ones you started.
Revert any device setting you changed (show-touches, bezels, Do Not Disturb reminder). Delete scaffolds that existed only
for footage. In a git repo, `git status` ends clean apart from intended deliverables. Hand the video over with its path,
and send the file itself if your harness can.
