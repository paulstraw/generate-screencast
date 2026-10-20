# Filming a terminal

Terminal beats are a **replay** of real output on a styled stage — not a recording of a live shell — so timing is exact
and noise can be curated out.

1. Run the real command and capture its output. Many tools print per-item lines or colours only under a TTY; capture with
   `script -q out.raw <cmd …>`, then strip ANSI (`sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g'`) and carriage-return rewrites.
2. Curate: keep the honest lines, drop noise (package-manager warnings, install spew, absolute home paths). Never invent,
   reorder into a false story, or edit numbers.
3. In a `p.browserScene` (see [web.md](web.md)), open the stage straight from the skill with
   `page.goto('file://<skill>/assets/terminal.html')` (nothing is copied into the project), and drive it:

```js
const stage = { prompt: 'my-app', title: 'my-app — zsh' }; // prompt: after the arrow (the project folder name)
await page.goto('file://<skill>/assets/terminal.html');
await page.evaluate((s) => window.__prompt(s), stage); // idle prompt, so the handle and lead aren't an empty window
const clock = await b.ready();
const cmd = 'npm test';
await clock.until(b.at('test') - (350 + cmd.length * 42 + 260)); // Enter lands on the word
await page.evaluate((a) => window.__run(a), {
  ...stage,
  cmd,
  lines: [
    [300, '<span class="dim">> vitest run</span>'],
    [1400, '<span class="ok">✓</span> src/sum.test.ts <span class="dim">(3 tests)</span>'],
    [2200, '<span class="strong">Tests</span>  <span class="ok">3 passed</span>'],
  ],
});
```

`lines` are `[msAfterEnter, html]`. The command types at 42ms/char starting at 350ms, so Enter lands at
`350 + cmd.length*42 + 260` ms after `__run` — schedule it from the VO marks as above. `__prompt` before `b.ready()`
puts the window title and an idle prompt on screen, so the head handle and lead show the right window. Classes: `p` (prompt),
`cmd`, `dim`, `ok`, `strong`, `url`, `badge-run`/`badge-dark`/`badge-light`/`badge-unit` (pill labels). Escape `<`/`>`
in output text.

With burned-in captions, a long run of output reaches the window's bottom edge, where the captions sit. Give those
beats `"captionPosition": "top"`; at the top, captions overlap only the title bar.
