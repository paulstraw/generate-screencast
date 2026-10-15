# Human-read voiceover

The user narrates in their own voice. This replaces the TTS steps of §3; the takes' measured durations still drive every
scene length, so the voice is recorded **before** filming.

Preflight adds `sox` (`brew install sox`) for capture and `uvx` with Apple Silicon for `mlx-whisper` transcription.

## Script file

Write the approved script to `<workdir>/<slug>.script.md`, one `## N · Title` section per beat with the VO as a `>`
blockquote. The recorder parses exactly this shape:

```markdown
## 1 · The chat

> This is the chat, where the learner and the coach talk.
```

## Record

The user runs the teleprompter in a terminal of their own (it reads raw keystrokes, so it needs a real TTY):

```bash
cd <workdir> && node <skill>/assets/record-vo.mjs
```

It shows one beat per screen with a 3-2-1 countdown; any key stops the take, then `p` plays it back, `r` retakes, `n`/`b`
move between beats. Each take is flagged when it clips or runs quiet. Raw takes land in `vo/raw/beatN.wav` (the previous
one kept as `beatN.prev.wav`); `vo/beatN.wav` is the silence-trimmed copy (150ms pad) that the rest of the skill uses.
Re-record individual beats with `node <skill>/assets/record-vo.mjs 3 5`.

- **Input**: the system default input unless `--device "<name>"` (names from
  `ffmpeg -f avfoundation -list_devices true -i ""` or Audio MIDI Setup). On a two-input interface, `--channel 0` (the
  default) is input 1, `--channel 1` input 2, `--channel mix` both. A Scarlett Solo has the mic on input 1.
- **Listening gate**: after beat 1, stop. The user plays the raw take back (`! afplay vo/raw/beat1.wav`) and confirms it
  sounds clean before recording the rest. You can't hear the audio, and no measurement substitutes: crackling takes have
  passed levels, dropout detection, spectrograms and click detection. Ten seconds here saves a full re-record.
- **Capture is sox's CoreAudio driver only.** ffmpeg's avfoundation audio input drops buffers, and the damage (crackle,
  stutter) is unrecoverable and invisible to every automated check. When writing your own capture: sox takes ~0.6s to
  open the device, so start it before any countdown; stop it with SIGINT, which finalizes the WAV header.
- **Fallback**: the user records in Audio Hijack or QuickTime and drops `vo/beat1.wav`…`vo/beatN.wav` into the workdir.
  Trim them the way the recorder does:
  `ffmpeg -i in.wav -af "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse" vo/beatN.wav`

Done when the user has confirmed beat 1 by ear and every beat has a take. Scene length = 0.5s lead + `ffprobe` duration
of `vo/beatN.wav` + tail, as in §3.

## Transcribe what was actually said

People riff, and the truth rule applies to the take, not the script. Transcribe each take, **one file per invocation**
(given several inputs, it writes every result to the first `--output-name`):

```bash
uvx --from mlx-whisper mlx_whisper --model mlx-community/whisper-large-v3-turbo --language en \
  --word-timestamps True --output-format json --output-dir vo/txt --output-name beatN \
  --initial-prompt "<beat N of the approved script>" vo/beatN.wav
```

The prompt steers spelling and punctuation, not words. Without it, the turbo model sometimes returns a take
unpunctuated and lowercase, and it spells product names however it likes. With it, a riff is still transcribed as it
was said.

Word timestamps are relative to the trimmed clip, so they become choreography marks directly: scene time = 500ms + word
time.

These words are also the captions. They show what was actually said, which is what the truth rule requires, split at
sentence ends and pauses. If whisper still misspells a term, fix it with `"spellings"` in the assembly manifest
(`{ "lock file": "lockfile" }`). Don't hand-edit the transcript: its times are the cue times.

Check every deviation from the script against its planned footage. A riff that names something new gets footage that
shows it (a cut to the pane it mentions); a line that's factually loose goes back to the user — re-record or accept —
rather than being filmed around.

Done when every beat's transcript matches what its scene will show, and every loose line is resolved with the user.

## Deliverables

Assemble with `"normalize": true` and no `"text"` on the scenes, so captions come from `vo/txt/beatN.json`. Finish with
the user's listen of the final file (both in §6). Beside the video,
the `.script.md` holds the approved script followed by an `## As recorded` section with each beat's transcript, ready for
a post.
