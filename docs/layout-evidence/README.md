# Layout evidence

Captured by the offline smoke harness from **synthetic fixtures** — no real
ChatGPT or Claude account, no personal content. Regenerate with:

```bash
CAPTURE_SCREENSHOTS=/tmp/aside-screens npm run smoke:local
```

The fixtures render realistic chrome: a left navigation, a centred reading column,
a header and an in-column composer. `Ask ChatGPT` is a stand-in for the provider's
own selection action, injected by the harness so coexistence can be measured.

| File | Shows |
| --- | --- |
| `toolbar-1440-open-light.png` | Aside's toolbar beside the provider's own selection action, both fully visible; the minimized rail in the left gutter |
| `rail-1440-collapsed-dark.png` | Dark theme, sidebar collapsed — the rail re-anchors into the freed space |
| `rail-1024-open-light.png` | Laptop width with the sidebar open |
| `rail-768-open-light.png` | No usable gutter: the rail is replaced by the compact `Aside (n)` launcher in verified free space, clear of the sidebar and the native action |

The branch count in the compact launcher reflects panels accumulated across
scenarios in the shared test profile, not a realistic session.

These are evidence, not assertions. The acceptance checks are measured geometry
and `elementFromPoint` hit tests in `runLayoutMatrixScenario`.
