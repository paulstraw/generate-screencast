# Filming Storybook

Hard-won selector knowledge for Storybook 8–10's manager UI. Verify against the live instance
(`curl -s localhost:6006/index.json` lists story ids), but expect these to hold:

- Sidebar **group headers navigate** (to the group's Docs) instead of just expanding. To pre-expand, click the section
  header's `button[aria-label="Expand all"]`. Collapsed items are not in the DOM.
- Prefer deep links over sidebar clicks when the clicking isn't the point: `/?path=/story/<id>` or `/?path=/docs/<id>`.
- `&globals=<key>:<value>` sets toolbar globals on story views (e.g. `&globals=theme:Dark`). Toolbar toggles are under
  `[role="toolbar"] button` — scope to the toolbar, or a text match like /theme/i can hit a sidebar group of the same name.
- A toolbar global change re-renders the preview iframe: it can flash blank for a few hundred ms right after the
  click. Keep the VO's payoff word a beat after the click, and check a frame ~0.3s after it in QA.
- Docs pages theme through decorators that only run when a story renders — a story-less docs page may never change theme.
  For themed docs footage use a docs page that contains stories.
- Controls live-edit: a string control is `textarea[name="<prop>"]`; select-all is `ControlOrMeta+a`.
- Addon tabs are `div[id$="tab-<addon-id>/panel"]`, e.g. a11y is `div[id$="tab-storybook/a11y/panel"]`; their subtabs are
  real `button[role="tab"]`s.
- Hide the "Storybook x.y" promo/version box before the clock starts:

```js
await page.evaluate(() => {
  for (const el of document.querySelectorAll('a, div')) {
    const t = (el.textContent || '').trim();
    const h = el.getBoundingClientRect().height;
    if (/^Storybook \d/.test(t) && h > 0 && h < 140) el.style.display = 'none';
  }
});
```

- Test-runner output: a monorepo's root `test` may be a cache hit ("replaying logs") — run the package-scoped command for
  honest output. Per-test ✓ lines usually print only under a TTY; see [terminal.md](terminal.md) for capturing them.
