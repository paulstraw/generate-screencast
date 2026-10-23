---
name: generate-screencast
description:
  Produce a short Loom-style screencast — a scripted recording of real running software with an AI voiceover or the
  user's own narration — in any project. Use when asked to make a video, demo, tour, or walkthrough of a web app,
  Storybook, a terminal workflow, a macOS app, or an iOS/Android app, or to refresh an existing one.
---

# Generate a screencast

Script → per-beat voiceover, TTS or the user's own voice (its measured durations drive every scene length) → scenes
filmed on a **clock** from real running surfaces → QA → ffmpeg assembly. Each video is a **project**: one folder whose
`screencast.json` is the single source of truth for every beat (script, voice, surface, camera, captions, edit), with
machine state beside it in `build.json`. `status.mjs` compares the two and says what to rebuild, so a first build and a
later refresh are the same loop, and the user can adjust the edit in a browser editor without you.

`<skill>` below means this skill's directory; every script is in `<skill>/assets/` and prints usage in its header. QA
depends on looking at frames, so this skill needs an agent that can view images; macOS, iOS and the native helpers need
macOS.

## 1. Shape the video

Interview the user, or confirm what's already specified. Nothing is produced until the script is approved verbatim.

- **Subject and audience** — what should the viewer understand or believe when it ends?
- **Beats** — one idea per ~10s beat; ~150 words ≈ 55s of narration. 30–90s is the sweet spot. For each beat, name its
  **surface**: web, Storybook, terminal, macOS app, iOS Simulator, Android emulator (or camera-only, below).
- **Where it lives** — ask **"~/Downloads, or somewhere else?"** and make the project folder `<that>/<slug>/`. Every
  file of the video lives in it; the deliverables `<slug>.mp4`, `.srt` and `.script.md` too, unless `"out"` points
  elsewhere. A folder inside a repo is fine when the video belongs to it: gitignore `vo/ cam/ scenes/ qa/ assembly/`
  there (or ask), since raw camera takes are private.
- **Captions** — always made: the `.srt` beside the video and a subtitle track inside it that viewers can switch on.
  Ask whether to also **burn them in** (`"captions": { "burn": true }`). That's worth it wherever video autoplays muted
  (Slack, LinkedIn, social feeds).
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
  a throwaway page in the project folder is fine (serve it, e.g. `python3 -m http.server`; `file://` blocks modules).
- Terminal footage is curated real output: run the command, keep the honest lines, drop noise. Never invent output.

The user approves the script as prose in conversation, never as JSON. Once they have, write `screencast.json`
(`<skill>/assets/screencast.schema.json` documents every field; point `"$schema"` at it for editor autocomplete):

```json
{
  "$schema": "file://<skill>/assets/screencast.schema.json",
  "version": 1,
  "slug": "drafts-that-sync",
  "title": "Drafts that sync",
  "voice": { "tts": "en-US-AndrewNeural" },
  "captions": { "burn": false },
  "beats": [
    { "id": "save", "title": "Saving syncs", "surface": "web", "text": "Hit Save and it syncs everywhere." }
  ]
}
```

Beat ids (`^[a-z0-9][a-z0-9-]*$`) are stable and name every file the beat owns; reordering is reordering the array.
`text` is the approved wording, used for captions and the exported script. Spell awkward tokens phonetically in `say`
("pnpm" → "P N P M"), TTS input only, and keep its sentence ends where `text` has them (TTS timing is matched to `text`
sentence by sentence). Optional per beat: `lead`/`tail` (seconds around the VO, default 0.5, 1.0 on the last beat's
tail), `cut` (§4), `captionPosition: "top"`, `cam`, `bubble`, `skip`. `loadProject` validates on every load and names
the bad path (`beats[2].cam: must be pip | full | off`).

## 2. Preflight

Detect everything the beats need and offer **one** `brew install …` (or equivalent) for whatever is missing:

| Need                    | Check                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| every video             | `ffmpeg`, `ffprobe`, `uvx` (for `edge-tts`), `node`                                 |
| browser/terminal beats, burned-in captions | Playwright in `~/.cache/generate-screencast` (below)             |
| macOS / iOS beats       | `swiftc` (`mousectl` builds itself on first use); the permission probe in [references/macos.md](references/macos.md) |
| iOS beats               | `xcrun simctl`, a booted simulator                                                  |
| Android beats           | `adb`, a running emulator                                                           |
| human-read voiceover    | `sox`; Apple Silicon for `mlx-whisper` (via `uvx`)                                  |
| camera (human VO only)  | `swiftc`; Camera permission, device and framing via `camrec` ([references/human-vo.md](references/human-vo.md#camera)) |

Playwright (pinned to `PLAYWRIGHT_VERSION` in `project.mjs`) and Chromium install once per machine into a shared
cache that every project reuses, never into the project or the user's repo, so no lockfile is touched. The skill keeps
its own copy on purpose rather than using one the project already has. `importPlaywright()` (from `project.mjs`) loads
it, and warns if the installed version differs from the pinned one. Check for it quietly; mention installing only when
it's actually missing:

```bash
mkdir -p ~/.cache/generate-screencast && cd ~/.cache/generate-screencast && npm init -y >/dev/null && npm i playwright@1.64.1 && npx playwright install chromium
```

Burn-in renders its captions with that Chromium, so an all-native video (macOS, iOS, Android) needs it too when the user
wants captions burned in.

Then load the reference for every surface the script uses — each holds the recipe and the hard-won gotchas:

- Browser, local or deployed (incl. login) → [references/web.md](references/web.md)
- Storybook → [references/web.md](references/web.md) **and** [references/storybook.md](references/storybook.md)
- Terminal → [references/terminal.md](references/terminal.md)
- macOS app → [references/macos.md](references/macos.md)
- iOS Simulator → [references/macos.md](references/macos.md) **and** [references/ios.md](references/ios.md)
- Android emulator → [references/android.md](references/android.md)
- Any beat that can't be scripted reliably → [references/hybrid.md](references/hybrid.md)

Done when every tool is present, every needed permission is granted, and every surface to be filmed is running.

## 3–6. The build loop

Run `node <skill>/assets/status.mjs <dir>` and do what it says, in its order; run it again after each step. It lists,
per beat, the steps needed (`vo` → `transcribe` → `film` → `qa`, then `assemble`) with the reason for each ("text
changed since the VO", "cut −2.1s exceeds the 1.5s handle"). A step implies the later ones for its beat. A new project
is simply everything stale. The `needs` flags in `screencast.json` (`reshoot`, `revo`, `qa`, each with a note) are for
judgment calls code can't see; the step that satisfies one clears it.

### 3. Voiceover

`node <skill>/assets/tts.mjs <dir>` makes every stale beat's VO (`vo/<id>.mp3` + `vo/<id>.srt`), with a timeout and
retries, checks the `.srt` splits into the same sentences as `text` (it stops and names the beat if not; usually a `say`
that added or dropped a sentence end, like "P.N.P.M."), and records the clip and its duration. Each beat's scene length
is lead + VO + tail. For a human-read voiceover, follow [references/human-vo.md](references/human-vo.md): `record-vo.mjs`
then `transcribe.mjs`.

### 4. Film

Write one `film.mjs` in the project folder: choreography only, one scene per beat id, every action scheduled on the
beat's `Clock` at marks from `b.at('Save')` (scene ms of that word in the VO) or `b.at(2)` (sentence 2). `p.film()`
films only the ids given on argv (`node film.mjs save`) and records each scene in `build.json`. The pattern, with
`setCur`/`glide`/`clickHere` from `<skill>/assets/film-helpers.mjs`, is in the `project.mjs` header; native surfaces
wrap their recorders with `nativeScene` from `native-helpers.mjs` (see their references).

```js
const p = loadProject(import.meta.dirname);
await p.film({
  save: p.browserScene(browser, async (page, b) => {
    await page.goto(URL, { waitUntil: 'networkidle' });
    const clock = await b.ready(); // screen settled → scene time 0
    await clock.until(b.at('Save'));
    await glide(page, x, y, 700);
  }),
});
```

**Recon first**: screenshot every screen you plan to film and look at the image before writing choreography. What a screen
looks like, and where its controls sit, is never safe to assume. Reuse existing state before generating new state: a
project's prior dev sessions, seeded accounts or saved data often already hold every state the beats need, more cleanly
than a fresh nondeterministic run would.

Call `b.ready()` only once the screen is settled: that's scene time 0, and the VO starts at the beat's lead. Every
recording also keeps a **handle** of 1.5s of the ready screen before 0 and of the final state after the scene ends, so
lead, tail and cuts can move later without a re-shoot. Leave the final state on screen; don't navigate away at the end.

**Cuts.** By default each beat's picture starts where its block (lead + VO + tail) does. `cut` on a beat moves the
picture boundary into it while the audio stays put: negative is an **L cut** (this beat's screen arrives while the
previous narration finishes), positive a **J cut** (its narration starts over the previous screen). Use them sparingly,
to get a slow screen up early or let a sentence bridge two beats. Beyond 1.5s either way, `status` asks for a re-shoot.
The truth rule applies to the overlap: the words heard over the other beat's picture must not point at the screen
("Next, …", "and that's it"), so put the boundary where the narration is non-referential.

Native beats (macOS, iOS) drive the user's real mouse and keyboard: tell them to keep hands off until you say you're
done, and tell them when they can have the machine back.

Post-process where a surface needs it (`device-frame.mjs` for framed mobile, with `--height 820 --top 30` when burning
in captions; `ripples.mjs` for macOS/iOS clicks; see their references), then point the beat at the variant:
`node <skill>/assets/project.mjs use <dir> <id> <file>`.

### 5. QA — non-negotiable

For every beat `status` lists for `qa`, run `node <skill>/assets/qa-grid.mjs <dir> <id> [scene times…]` and **look at**
the image it writes (`qa/<id>.png`). Pass the scene times (seconds) of every VO moment you narrate; it adds the picture's
first and last frames, the VO start and the middle of any L/J overlap by itself. Check, at each:

- the thing being narrated is on screen (truth rule), including inside every overlap;
- the cursor or touch indicator is visible where action happens; mode or state flips happened;
- nothing private or stray is in frame — notifications, other apps, personal tabs, names, tokens, the menu-bar clock.

With the camera on, also check that the bubble never covers the thing being narrated, that camera frames pass the same
privacy check for the room (what's behind the user, other people, other screens), and spot-check lip sync on at least
one beat ([references/human-vo.md](references/human-vo.md#camera)).

With burn-in or a camera, the frames only exist composited: run `node <skill>/assets/assemble.mjs <dir> --force` first,
and the grid is taken from that render (once every beat's QA is recorded, that render counts as the final one). Then
also check that:

- no caption covers the thing being narrated (truth rule). Move that beat's captions with `"captionPosition": "top"`,
  or re-frame;
- no cue is too brief to read. Assembly reports any cue under ~1s or over ~20 characters a second as `tooFast`; tighten
  that beat's `text` or give it more tail.

Re-shoot failing beats (`node film.mjs <id>`). When a beat's grid passes, record it:
`node <skill>/assets/status.mjs <dir> --qa <id> [--note "…"]`. That stores a hash of what you looked at, so any later
change to the beat's recording or its place in the edit lists it for QA again.

### 6. Assemble

`node <skill>/assets/assemble.mjs <dir>` refuses while any beat needs an earlier step (`--force` renders anyway and
says what's stale). It renders from the same timeline the editor previews: each VO at its fixed offset, each picture cut
from its recording by the beat's scene window (L/J cuts included), camera bubble or full-frame take where set, and
captions as the `.srt` beside the video and a `mov_text` track in it (burned in too with `captions.burn`). It writes
`<slug>.script.md` and records the render. It prints per beat the picture span, scene window and VO offset, the
`tooFast` cues, and loudness (healthy: mean −18…−26 dB, max < −1 dB). A human-read voiceover sets
`"voice": { "human": true, "normalize": true }` and `"spellings"` for anything whisper misspells.

Spot-check frames at every beat boundary in the final file. For a human-read voiceover, the user also listens to the
final file once and confirms it sounds clean: frames check the picture, and only a human ear checks the audio.

## 7. Hand over, then adjust

Hand the video over with its path (send the file itself if your harness can), and offer the editor:

```bash
node <skill>/assets/editor.mjs <dir>
```

"Open it to adjust cuts and trims or flag beats; tell me when you're done." In it the user can drag cuts and lead/tail
within the handles, reorder and skip beats, set camera and caption placement, edit `text`/`say`, flag beats `reshoot`,
`revo` or `qa` with a note, and render. Adding beats, VO takes and filming stay with you. When they say "update it":
run the build loop again (`status`, execute, re-QA, re-render) and summarise what changed.

## Refreshing a video later

Ask the user for the project folder, read `screencast.json`, run `status`, and preflight the surfaces. Provenance can't
see the app, so recon every beat's screen against its last QA grid and flag any that changed:
`{ "kind": "reshoot", "note": "the toolbar moved" }` in its `needs`. Then run the build loop.

## Cleanup

Leave the user's dev servers, simulators and emulators running if they were running before; stop the ones you started.
Revert any device setting you changed (show-touches, bezels, Do Not Disturb reminder). Delete scaffolds that existed only
for footage. In a git repo, `git status` ends clean apart from intended deliverables.
