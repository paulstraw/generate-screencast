# Filming a terminal

Terminal beats are a **replay** of real output on a styled stage — not a recording of a live shell — so timing is exact
and noise can be curated out.

1. Run the real command and capture its output. Many tools print per-item lines or colours only under a TTY; capture with
   `script -q out.raw <cmd …>`, then strip ANSI (`sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g'`) and carriage-return rewrites.
2. Curate: keep the honest lines, drop noise (package-manager warnings, install spew, absolute home paths). Never invent,
   reorder into a false story, or edit numbers.
3. Copy `<skill>/assets/terminal.html` into the workdir, open it with `page.goto('file://<workdir>/terminal.html')`, and drive it:

```js
await page.evaluate((a) => window.__run(a), {
  cmd: 'npm test',
  prompt: 'my-app',          // shown after the arrow; use the project folder name
  title: 'my-app — zsh',     // window title bar
  lines: [
    [300, '<span class="dim">> vitest run</span>'],
    [1400, '<span class="ok">✓</span> src/sum.test.ts <span class="dim">(3 tests)</span>'],
    [2200, '<span class="strong">Tests</span>  <span class="ok">3 passed</span>'],
  ],
});
```

`lines` are `[msAfterEnter, html]`. The command types at 42ms/char starting at 350ms, so Enter lands at
`350 + cmd.length*42 + 260` ms — schedule the clock (and any VO sync) from there. Classes: `p` (prompt), `cmd`, `dim`,
`ok`, `strong`, `url`, `badge-run`/`badge-dark`/`badge-light`/`badge-unit` (pill labels). Escape `<`/`>` in output text.

With burned-in captions, a long run of output reaches the window's bottom edge, where the captions sit. Give those
scenes `"captionPosition": "top"`; at the top, captions overlap only the title bar.
