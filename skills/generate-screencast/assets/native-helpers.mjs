/*
 * Native filming helpers: macOS desktop apps, the iOS Simulator, and Android
 * emulators. Everything is driven on the same Clock as the browser helpers.
 *
 * Coordinates passed to the macOS helpers are global screen points (what
 * CoreGraphics and AppleScript speak). Video coordinates are derived from them
 * only at overlay time, through the `region` a capture was started with.
 *
 * Click times are logged as wall-clock instants and converted to video time
 * from the END of the recording (videoDuration - (stoppedAt - clickedAt)),
 * the same trim-from-the-end principle as assembly: capture start-up latency
 * is unknowable, stop is not.
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

/* ---------- macOS desktop ---------- */

export function screenDeviceIndex() {
  let out = '';
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = String(e.stderr || '');
  }
  const m = out.match(/\[(\d+)\] Capture screen 0/);
  if (!m) throw new Error('no "Capture screen 0" avfoundation device');
  return Number(m[1]);
}

/* Backing scale of the main display: pixels per point. */
export function backingScale() {
  const px = run('system_profiler', ['SPDisplaysDataType']).match(/Resolution: (\d+) x (\d+)/);
  const pt = run('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSScreen.mainScreen.frame.size.width']);
  return px ? Number(px[1]) / Number(pt) : 2;
}

/* Front window of an app, in screen points: { x, y, w, h }. */
export function windowBounds(appProcessName) {
  const out = run('osascript', [
    '-e',
    `tell application "System Events" to tell process "${appProcessName}" to get {position, size} of window 1`,
  ]);
  const [x, y, w, h] = out.split(',').map((n) => Number(n.trim()));
  return { x, y, w, h };
}

export function activate(appName) {
  run('osascript', ['-e', `tell application "${appName}" to activate`]);
}

/*
 * Scriptable apps take `bounds` from their own dictionary; System Events
 * UI scripting is the fallback and is refused (-10003) for some apps even
 * with Accessibility granted.
 */
export function setWindowBounds(app, { x, y, w, h }) {
  try {
    run('osascript', ['-e', `tell application "${app}" to set bounds of front window to {${x}, ${y}, ${x + w}, ${y + h}}`]);
  } catch {
    run('osascript', [
      '-e',
      `tell application "System Events" to tell process "${app}" to set {position, size} of window 1 to {{${x}, ${y}}, {${w}, ${h}}}`,
    ]);
  }
}

const FRONTMOST = 'tell application "System Events" to get name of first process whose frontmost is true';

export function frontmostApp() {
  return run('osascript', ['-e', FRONTMOST]);
}

/*
 * Starts an avfoundation screen capture with the real cursor. `region` (screen
 * points) crops to a window; omit it for full screen. Output is scaled and
 * padded to 1920x1080 so native scenes cut with browser scenes.
 *
 * `guardApp` is the privacy guard: the capture refuses to start unless that
 * process is frontmost, polls it during the take, and on any change kills
 * ffmpeg and DELETES the file — a crop region left without its window records
 * whatever is behind it. stop() then throws, so the scene is re-shot.
 */
export function startScreenCapture(out, { region, scale = backingScale(), fps = 30, guardApp } = {}) {
  if (guardApp && frontmostApp() !== guardApp) {
    throw new Error(`${guardApp} is not frontmost (${frontmostApp()} is); not starting capture`);
  }
  const dev = screenDeviceIndex();
  const vf = [];
  if (region) {
    const c = (n) => Math.round(n * scale / 2) * 2;
    vf.push(`crop=${c(region.w)}:${c(region.h)}:${c(region.x)}:${c(region.y)}`);
  }
  vf.push('scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12', 'setsar=1');
  const proc = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps),
      '-pixel_format', 'uyvy422', '-i', `${dev}:none`, '-vf', vf.join(','), '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  let breach = null;
  let polling = false;
  const timer = guardApp
    ? setInterval(() => {
        if (polling || breach) return;
        polling = true;
        execFile('osascript', ['-e', FRONTMOST], (err, stdout) => {
          polling = false;
          const front = String(stdout).trim();
          if (err || breach || front === guardApp) return;
          breach = front;
          clearInterval(timer);
          proc.kill('SIGKILL');
          proc.once('exit', () => fs.rmSync(out, { force: true }));
          console.error(`privacy guard: ${front} came to the front; capture killed and ${out} deleted`);
        });
      }, 150)
    : null;
  const h = captureHandle(proc, () => proc.stdin.write('q'), { kind: 'screen', region, scale });
  return {
    ...h,
    async stop() {
      if (timer) clearInterval(timer);
      if (breach) throw new Error(`take aborted: ${breach} took focus`);
      return h.stop();
    },
  };
}

function captureHandle(proc, stopFn, meta) {
  const done = new Promise((r) => proc.on('exit', r));
  return {
    ...meta,
    async stop() {
      const stoppedAt = Date.now();
      stopFn();
      await done;
      return stoppedAt;
    },
  };
}

/*
 * Mouse/keyboard driver: a long-lived mousectl process (compile it once with
 * `swiftc -O mousectl.swift -o mousectl`). Every call resolves when the action
 * has finished, so `await` + Clock marks stay exact. Clicks are logged into
 * `clicks` for the ripple overlay.
 */
export async function startDriver(bin = './mousectl') {
  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      waiting.shift()?.(line);
    }
  });
  const send = (cmd) =>
    new Promise((resolve, reject) => {
      waiting.push((line) => (line.startsWith('ok') ? resolve(line.slice(3)) : reject(new Error(line))));
      proc.stdin.write(cmd + '\n');
    });
  const pos = async () => {
    const [x, y] = (await send('pos')).split(',').map(Number);
    return { x, y };
  };
  let at = await pos();
  const clicks = [];
  return {
    clicks,
    pos,
    async glide(x, y, ms) {
      await send(`glide ${x} ${y} ${ms}`);
      at = { x, y };
    },
    async move(x, y) {
      await send(`move ${x} ${y}`);
      at = { x, y };
    },
    async click() {
      clicks.push({ at: Date.now(), ...at });
      await send('click');
    },
    type: (text) => send(`type ${text}`),
    key: (name) => send(`key ${name}`),
    close: () => proc.stdin.end(),
  };
}

/*
 * Converts a click log to video pixel coordinates and video seconds, ready for
 * ripples.mjs. `region`/`scale` are those the capture was started with.
 */
export function clicksToVideo(clicks, { stoppedAt, videoDuration, region, scale, srcW, srcH }) {
  const fit = Math.min(1920 / srcW, 1080 / srcH);
  const ox = (1920 - srcW * fit) / 2;
  const oy = (1080 - srcH * fit) / 2;
  const rx = region ? region.x : 0;
  const ry = region ? region.y : 0;
  return clicks.map((c) => ({
    t: +(videoDuration - (stoppedAt - c.at) / 1000).toFixed(3),
    x: Math.round(ox + (c.x - rx) * scale * fit),
    y: Math.round(oy + (c.y - ry) * scale * fit),
  }));
}

/*
 * Permission probe. Accessibility: moves the cursor 40pt and reads it back.
 * Screen Recording cannot be detected numerically — a denied capture returns
 * the wallpaper without windows, not black — so the probe frame is written to
 * `frame` for the agent to look at, and must be deleted afterwards (it is a
 * full-screen grab of the user's desktop).
 */
export async function probePermissions(tmpDir, bin = './mousectl') {
  const frame = `${tmpDir}/probe.jpg`;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-framerate', '30',
      '-pixel_format', 'uyvy422', '-i', `${screenDeviceIndex()}:none`, '-frames:v', '1', '-vf', 'scale=960:-1', frame],
      { stdio: 'ignore' });
  } catch {
    /* frame stays missing: capture itself failed */
  }
  const d = await startDriver(bin);
  const a = await d.pos();
  await d.move(a.x + 40, a.y);
  await sleep(100);
  const b = await d.pos();
  await d.move(a.x, a.y);
  d.close();
  return { frame: fs.existsSync(frame) ? frame : null, accessibility: b.x === a.x + 40 };
}

/* ---------- iOS Simulator ---------- */

/*
 * Framebuffer recording of the booted simulator (no host cursor, nothing
 * outside the device in it). Change-driven like screenrecord: stop(out)
 * re-times it from simctl's "Recording started" line to the true stop.
 */
export function startSimRecording(udid = 'booted') {
  const raw = `${fs.mkdtempSync('/tmp/simrec-')}/raw.mp4`;
  const proc = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', raw], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startedAt = null;
  const mark = (d) => {
    if (startedAt === null && /Recording started/i.test(String(d))) startedAt = Date.now();
  };
  proc.stdout.on('data', mark);
  proc.stderr.on('data', mark);
  const h = captureHandle(proc, () => proc.kill('SIGINT'), { kind: 'ios' });
  return {
    ...h,
    async stop(out) {
      const stoppedAt = await h.stop();
      normalizeVfr(raw, out, (stoppedAt - startedAt) / 1000);
      fs.rmSync(raw);
      return { stoppedAt, startedAt };
    },
  };
}

/*
 * Maps device points to screen points through the Simulator window. Needs
 * device bezels hidden (Window ▸ Show Device Bezels off): the window is then
 * the device screen plus a title bar, whose height is derived, not assumed.
 */
export function simMapper(deviceW, deviceH) {
  const b = windowBounds('Simulator');
  const s = b.w / deviceW;
  const titleBar = b.h - deviceH * s;
  if (titleBar < 0 || titleBar > 80) {
    throw new Error(`Simulator window ${b.w}x${b.h} doesn't fit a ${deviceW}x${deviceH}pt device; are bezels hidden?`);
  }
  return (dx, dy) => ({ x: Math.round(b.x + dx * s), y: Math.round(b.y + titleBar + dy * s) });
}

/* ---------- Android emulator ---------- */

export function adb(...args) {
  return run('adb', args);
}

/*
 * show_touches is drawn into the framebuffer, so screenrecord captures it.
 * screenrecord writes frames only when the screen changes, so the raw file
 * ends at the last change, not at stop. `--verbose` prints "Content area is"
 * the moment recording begins; stop() pads the tail out to the true wall-clock
 * length so trim-from-the-end stays honest.
 */
export function startAndroidRecording(remote = '/sdcard/scene.mp4') {
  adb('shell', 'settings', 'put', 'system', 'show_touches', '1');
  const proc = spawn('adb', ['shell', 'screenrecord', '--verbose', '--bit-rate', '12000000', remote], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let startedAt = null;
  proc.stdout.on('data', (d) => {
    if (startedAt === null && /Content area is/.test(String(d))) startedAt = Date.now();
  });
  const h = captureHandle(proc, () => {
    try {
      execFileSync('adb', ['shell', 'pkill', '-INT', 'screenrecord']);
    } catch {
      proc.kill('SIGINT');
    }
  }, { kind: 'android' });
  return {
    ...h,
    async stop(localOut) {
      const stoppedAt = await h.stop();
      await sleep(800);
      const raw = `${localOut}.raw.mp4`;
      adb('pull', remote, raw);
      adb('shell', 'rm', remote);
      normalizeVfr(raw, localOut, (stoppedAt - startedAt) / 1000);
      fs.rmSync(raw);
      return stoppedAt;
    },
  };
}

/*
 * Change-driven recorders (screenrecord, simctl) emit variable-rate video that
 * stops at the last change. Re-time to constant 30fps and hold the last frame
 * until `wallSeconds`, the recording's true length.
 */
export function normalizeVfr(raw, out, wallSeconds) {
  const rawDur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]));
  const pad = Math.max(0, wallSeconds - rawDur);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
    '-vf', `fps=30,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`,
    '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', out]);
}

export const tap = (x, y) => adb('shell', 'input', 'tap', String(x), String(y));
export const swipe = (x1, y1, x2, y2, ms = 300) =>
  adb('shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms));
export const androidText = (t) => adb('shell', 'input', 'text', t.replace(/ /g, '%s'));

/*
 * Maps simulator taps (device points, logged with `device: [x, y]`) into the
 * 1920x1080 layout device-frame.mjs produces, ready for ripples.mjs. Pass the
 * same `height` given to device-frame (default 960).
 */
export function tapsToFrame(clicks, { stoppedAt, videoDuration, devicePx, deviceScale, height = 960 }) {
  const [pw, ph] = devicePx;
  const k = height / ph;
  const w = Math.round((pw * k) / 2) * 2;
  const ox = (1920 - w) / 2;
  const oy = (1080 - height) / 2;
  return clicks.map((c) => ({
    t: +(videoDuration - (stoppedAt - c.at) / 1000).toFixed(3),
    x: Math.round(ox + c.device[0] * deviceScale * k),
    y: Math.round(oy + c.device[1] * deviceScale * k),
  }));
}
