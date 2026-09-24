# Layout evidence

Captured by the offline smoke harness from **synthetic fixtures** — no real
ChatGPT or Claude account, no personal content. Regenerate with:

```bash
CAPTURE_SCREENSHOTS=/tmp/aside-screens npm run smoke:local
```

The fixtures render realistic chrome: a left navigation, a centred reading column,
a header and an in-column composer. `Ask ChatGPT | Share highlighted` is a
stand-in for the provider's own selection action, injected by the harness so
coexistence can be measured.

| File | Shows |
| --- | --- |
| `toolbar-1440-open-light.png` | Aside's toolbar beside the provider's own selection action, both fully visible |
| `card-1440-open-light.png` | The handoff card: `Temporary handoff · Not saved in Aside`, the passage, the question, the one-line context summary, **Copy & open temporary chat** with the separate recovery actions, and the native-page instruction with ChatGPT's steps |
| `card-1024-open-dark.png` | Dark theme at laptop width; the card stops above the provider's composer instead of covering it |
| `card-1152-zoom125-open-light.png` | A 1440px window at 125% browser zoom |
| `handoff-claude-current.png` | The Claude card, with Claude's own Incognito steps |
| `rail-1440-collapsed-dark.png` | A hidden card as a `temporary` entry in the left-gutter rail, sidebar collapsed |
| `rail-1024-open-light.png` | The rail at laptop width with the sidebar open |
| `rail-768-open-light.png` | No usable gutter: the rail is replaced by the compact `Aside` launcher in verified free space |

These are evidence, not assertions. The acceptance checks are measured geometry
and `elementFromPoint` hit tests in `runLayoutMatrixScenario` (toolbar and native
popup both reachable, rail clear of the sidebar and the column, composer still
reachable while the card is open).

Known: while the card is open it occupies the right of the page, and at narrower
widths it can sit over reading text and over the injected selection stand-in (the
stand-in is static; see the 1024px capture). Focusing the card's question box
moves the browser selection into it, and the provider's own popup is tied to the
page selection, so it is expected to close — not verified on a live page. **Hide**
or Escape returns the space.
