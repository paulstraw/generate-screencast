# Human-read voiceover

The user narrates in their own voice. This replaces the TTS steps of §3; the takes' measured durations still drive every
scene length, so the voice is recorded **before** filming.

Preflight adds `sox` (`brew install sox`) for capture and `uvx` with Apple Silicon for `mlx-whisper` transcription.
With the camera on, it adds `swiftc` and the camera checks in [Camera](#camera) below.

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
one kept as `beatN.prev.wav`); `vo/beatN.wav` is the silence-trimmed copy (150ms pad) that the rest of the skill uses,
and `vo/trims.json` records which `[start, end]` seconds of the raw take it covers. Re-record individual beats with
`node <skill>/assets/record-vo.mjs 3 5`.

- **Input**: the system default input unless `--device "<name>"` (names from
  `ffmpeg -f avfoundation -list_devices true -i ""` or Audio MIDI Setup). On a two-input interface, `--channel 0` (the
  default) is input 1, `--channel 1` input 2, `--channel mix` both. A Scarlett Solo has the mic on input 1.
- **Listening gate**: after beat 1, stop. The user plays the raw take back (`! afplay vo/raw/beat1.wav`) and confirms it
  sounds clean before recording the rest. You can't hear the audio, and no measurement substitutes: crackling takes have
  passed levels, dropout detection, spectrograms and click detection. Ten seconds here saves a full re-record.
- **Capture is sox's CoreAudio driver only** (or `camrec` with the camera on, below). ffmpeg's avfoundation audio input
  drops buffers, and the damage (crackle, stutter) is unrecoverable and invisible to every automated check. When writing your own capture: sox takes ~0.6s to
  open the device, so start it before any countdown; stop it with SIGINT, which finalizes the WAV header.
- **Fallback**: the user records in Audio Hijack or QuickTime and drops `vo/beat1.wav`…`vo/beatN.wav` into the workdir.
  Trim them the way the recorder does, to 150ms either side of the speech:
  `ffmpeg -i in.wav -af "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse" vo/beatN.wav`

Done when the user has confirmed beat 1 by ear and every beat has a take. Scene length = 0.5s lead + `ffprobe` duration
of `vo/beatN.wav` + tail, as in §3.

## Camera

The user's face can go in the video too: a Loom-style bubble over the screen (`pip`), or the camera fullscreen in place
of the screen (`full`). The camera records during the same teleprompter takes, so each beat's footage is exactly as long
as its VO and, apart from the camera's own latency (the clap test below), in sync with it. In Shape, ask whether they want it, and mark each beat `pip`, `full` or `off`. Only a beat
that isn't narrating the UI can be `full`, because the truth rule still holds: an intro, an outro, a "here's why I built
this".

**Preflight**, before any take:

1. Build the recorder and list devices: `swiftc -O <skill>/assets/camrec.swift -o <workdir>/camrec`, then
   `<workdir>/camrec list`. It prints the Camera and Microphone permission status for the app running the terminal, each
   camera with the format it would record (read from the device, because capture cards and Continuity Camera only accept
   their own exact formats), and the mics. A camera flagged below 30fps stutters once assembly converts it to 30fps.
   Behind a capture card, that means the camera's HDMI output is set to 24p (often 4K24): have the user switch it to
   1080p30 or 1080p60, which also makes the files much smaller. Denied permission is fixed in System Settings ▸ Privacy & Security ▸ Camera
   (or Microphone); the first capture prompts if it was never asked.
2. Check framing: `<workdir>/camrec snapshot "<camera>" cam/snapshot.jpg` waits 2s for exposure to settle, saves one
   frame, and you look at it. Check framing, lighting and focus, and the room as a privacy check: what's behind the
   user, other people, other screens, anything on the walls. An all-black frame means the camera feeding a capture card
   is off or asleep.
3. Measure the camera's lag with a clap test. A camera behind a capture card (Cam Link, Elgato) delivers each frame
   100–200ms after the moment it shows, because of HDMI output and conversion latency, while USB audio arrives almost
   at once. A USB webcam is usually close to zero, so test either way. The user runs
   `<workdir>/camrec record "<camera>" "<mic>" cam/clap.mov`, waits for `rec`, claps three times slowly with their hands
   in frame, and presses Ctrl+C. Find the claps in the decoded audio:
   `ffmpeg -i cam/clap.wav -af "pan=mono|c0=c0,asetnsamples=48,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level" -f null -`
   Each onset is the first time a 1ms peak rises above −20 dB after a quiet stretch. For each onset, tile the frames
   that follow it, with their times (`-copyts -ss <onset − 0.1> -i cam/clap.mov -vf showinfo,…,tile=8x2`). Find the
   first frame where the hands are together, not just blurred mid-swing. Lag = contact time − onset. Take the value that
   fits every clap, to the nearest 10ms. A Cam Link 4K behind a mirrorless camera measured 150ms with 4K24 output and
   180ms with 4K30, so measure again whenever the camera's output mode changes.

**Record** with `--camera`:

```bash
cd <workdir> && node <skill>/assets/record-vo.mjs --camera "Cam Link 4K" --device "Scarlett Solo USB" --cam-delay 0.15
```

`camrec` (built on first use if it isn't in the workdir) replaces sox for these takes: one AVFoundation capture session
writes camera and mic into `cam/raw/beatN.mov` (H.264 video, 24-bit audio). The recorder waits for the camera to open
before the 3-2-1 countdown, so exposure has settled by the first word. It pulls the take's audio out to
`vo/raw/beatN.wav`, picking `--channel` there with an ffmpeg `pan`. Trimming then runs as usual, so `vo/trims.json`
offsets index the camera footage too. `--device` names the mic as `camrec list` shows it. With the camera on, `p` plays
the trimmed take with its picture (in an `ffplay` window, when ffplay is installed), delayed by `--cam-delay` (the
clap-test lag) so it plays in sync.

- **ffmpeg can't read AVFoundation's raw 24-bit audio.** It stores samples "unpacked in 4 bytes" under a plain `lpcm`
  tag, and ffmpeg decodes that as loud static with the voice faintly underneath. Asking AVFoundation for 16- or 32-bit
  doesn't change how it stores the samples, and float stops recording from ever starting. So when a take stops,
  `camrec` decodes the audio with Apple's own reader into a WAV aligned to the movie's t=0, and the recorder swaps it
  into the `.mov` (the video is copied, not re-encoded). A `.mov` straight out of AVFoundation that sounds like static
  can be repaired with `camrec decode in.mov out.wav`.

Camera audio comes from Apple's capture pipeline (the one QuickTime uses), not sox, and that's not yet proven to stay
clean on every interface, so the **listening gate matters more** here. If beat 1 crackles, fall back: record the camera
takes with scratch audio, record the VO with sox as normal, and line them up by cross-correlating the two audio tracks
before trimming.

**Assemble**: each camera beat's scene gets the raw take and its trim:

```json
{ "video": "scenes/s2.webm", "vo": "vo/beat2.wav", "cam": "cam/raw/beat2.mov", "camTrim": [2.13, 9.87], "camMode": "pip" }
```

`camTrim` is the beat's `vo/trims.json` entry. Put the clap-test lag in the manifest as `"camDelay": 0.15`; assembly
takes each camera frame that much later, which puts the lips back on the words. A `full` scene needs no `video`. The bubble defaults to a circle 22% of
the frame's short side, 48px in from the bottom-left corner. Set the manifest-level
`"bubble": { "position": "bottom-right", "size": 0.18, "margin": 48 }` to change it, or `bubble` on a scene to override
it for that beat. The 0.5s lead and tail around each VO are real camera footage from the raw take: the end of the
countdown and the pause before the keypress.

**QA**, on top of §5:

- The bubble never covers the thing being narrated. Move it for that beat, or set the beat `off`.
- Every camera frame you pull also passes the room privacy check above.
- Spot-check lip sync on at least one beat: put a pulled frame where a hard consonant lands (a word timestamp from the
  transcript) next to the frame before it, and look for the lips closing on "p", "b" or "m".

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
