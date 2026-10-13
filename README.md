# generate-screencast

An agent skill that produces short, Loom-style screencasts of real running software: you approve a script, and the agent
records each scene on a timer, narrates it with text-to-speech, checks the frames, and hands you an MP4. Nobody has to
record their screen.

[![Demo: a browser, a terminal and an Android emulator, each filmed and narrated by the skill](media/demo.png)](media/demo.mp4)

_The demo above was made with this skill (23s, [MP4](media/demo.mp4))._

## What it can film

| Surface                            | How                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Web apps, local or deployed        | Playwright, with an injected cursor and click ripples; one-time headed login for authenticated pages |
| Storybook                          | Playwright, plus selector notes for the Storybook 8–10 manager UI             |
| Terminal workflows                 | Real command output, curated and replayed on a styled terminal stage          |
| macOS apps                         | ffmpeg screen capture cropped to the app window; real mouse and keyboard via a small CoreGraphics driver |
| iOS Simulator                      | `simctl` framebuffer recording; taps by clicking into the Simulator window    |
| Android emulator                   | `adb screenrecord` and `adb shell input`                                      |
| Anything that can't be scripted    | Hybrid mode: you perform the actions while the narration plays and the agent cues you |

Mobile scenes are framed on a 16:9 stage so they cut together with desktop scenes, or the whole video can be portrait.

## Install

With the [skills CLI](https://skills.sh):

```bash
npx skills add paulstraw/generate-screencast -g    # global, for every project
npx skills add paulstraw/generate-screencast       # this project only
```

Or by hand: clone the repo anywhere and link the skill folder into your agent's skills directory, e.g. for Claude Code:

```bash
git clone https://github.com/paulstraw/generate-screencast ~/src/generate-screencast
ln -s ~/src/generate-screencast/skills/generate-screencast ~/.claude/skills/generate-screencast
```

Then ask your agent for a video: _"make a 45-second walkthrough of the signup flow"_.

## Requirements

- **An agent that can look at images.** The skill checks recon screenshots and extracted frames before it writes or ships
  anything.
- `ffmpeg`, Node.js, and [`uv`](https://docs.astral.sh/uv/) (the narration runs `uvx edge-tts`). The agent checks for
  these and offers to install whatever is missing.
- Playwright installs into a temporary working directory, never into your project.
- **macOS apps and iOS:** macOS, Xcode Command Line Tools (to compile the input driver), and Screen Recording and
  Accessibility permission for the terminal or editor running your agent. iOS also needs Xcode and a simulator.
- **Android:** the Android SDK (`adb`, `emulator`) and an emulator.

Tested on macOS with Claude Code. Web and terminal scenes should work wherever Playwright and ffmpeg run; the hybrid mode
is not yet tested.

## Things to know before you use it

- **Native scenes drive your real mouse and keyboard and record your real screen.** Keep your hands off the machine
  during macOS and iOS takes. Recordings are cropped to the target window, and a guard kills and deletes a take if
  anything else comes to the front. That reduces the risk, but you should still turn on Do Not Disturb and look over the
  result before sharing it.
- **The narration text is sent to Microsoft's online TTS service.** [edge-tts](https://github.com/rany2/edge-tts) uses
  the read-aloud endpoint behind Microsoft Edge. It needs no API key, but it's an unofficial use of that service, and it's
  unclear whether you have commercial rights to the generated audio. Don't put anything confidential in a script, and
  check your own requirements before using the audio in client or commercial work.
- **The narration never claims anything the screen doesn't show.** If a scene needs something that doesn't exist yet,
  the agent proposes building it for real (with your approval) rather than faking it. Terminal output is real output
  with the noise removed, never invented.

## How it works

1. **Shape** — the agent interviews you about subject, audience, beats and where the video goes (default
   `~/Downloads/<slug>-<date>.mp4`). It produces nothing until you approve the script word for word.
2. **Voiceover** — one TTS clip per beat. Each clip's measured length sets its scene's length.
3. **Film** — each scene is recorded on a clock, so actions land on the spoken words.
4. **QA** — the agent extracts frames across every scene and looks at them, then re-shoots anything that's wrong or
   shows something private.
5. **Assemble** — [`assemble.mjs`](skills/generate-screencast/assets/assemble.mjs) trims, concatenates and places each voiceover clip based on the measured clip
   durations, so timing errors don't accumulate.

See [`SKILL.md`](skills/generate-screencast/SKILL.md) for the full procedure and
[`references/`](skills/generate-screencast/references) for the per-surface recipes.

## License

[MIT](LICENSE)
