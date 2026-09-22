# Owner visual acceptance

Everything below is offline-verified except where marked. Live provider checks are
the part only you can do — no live ChatGPT or Claude account was used in this work.

## Load the build

```bash
npm ci
npm run build
```

1. `chrome://extensions/` → Developer Mode → **Load unpacked** → select `dist/`.
2. If Aside is already loaded, press **Reload** on its card. The manifest now
   requests `https://claude.ai/*`; Chrome does not grant a new host permission to
   an extension that is merely refreshed in the page. Confirm the card lists
   `claude.ai` under *Site access* and approve it if asked.
3. Hard-reload `chatgpt.com` and `claude.ai`. The content script is injected on
   page load only.

Reference images captured from the fixtures live in
[`docs/layout-evidence/`](./layout-evidence/).

## Checklist

### 1. Native options still work

- [ ] Select text in an assistant answer. The provider's own selection actions
      appear exactly as they did before, in the same place.
- [ ] Click one of them. It does what it always did.
- [ ] Aside's toolbar sits *beside* them, labelled `Aside`, overlapping nothing.
- [ ] Select with the keyboard (Shift+Arrow) and copy with Cmd/Ctrl+C. Both work.
- [ ] Open a provider menu and press Escape. The menu closes; Aside does not
      swallow it.
- [ ] Right-click a selection. The browser context menu appears normally.

### 2. Left rail

- [ ] Start a branch, then Minimize. The tab appears in the gutter **left** of the
      reading column and **right** of the provider's navigation.
- [ ] Collapse and expand the provider sidebar. The rail re-anchors and never
      overlaps it.
- [ ] Narrow the window until the gutter disappears. The rail is replaced by a
      compact `Aside (n)` entry in free space — not stacked on native chrome.
- [ ] Open a tool/artifact pane. The rail stays clear of it.

### 3. Branching, both providers

On ChatGPT and again on Claude:

- [ ] `Ask` opens a panel. The **Context** section shows the passage, the answer
      blocks it read, and a preview of the exact text that will be sent.
- [ ] Untick a block; the preview shrinks. Tick the preceding question; it appears.
- [ ] Send. The answer addresses the passage. On ChatGPT it runs in the panel; on
      Claude it runs in a window Aside opens (claude.ai refuses to be framed).
- [ ] Ask a follow-up inside the branch. It still works.
- [ ] Minimize, restore, and use **Jump to origin** — the original passage is
      highlighted and you have not lost your reading position.
- [ ] `Why` does the same in one click; `New-tab` opens its own window.

### 4. Private branches

- [ ] Choose Temporary (ChatGPT) / Incognito (Claude) and send. It only proceeds
      once the provider's own control reads as on.
- [ ] Turn the provider's private mode off, then try again. Aside must refuse
      **before typing anything**, keep your question, and offer a retry. Check the
      provider's composer is empty — nothing should have been typed into it.
- [ ] Select text inside a private chat and open a branch. It should default to
      private, not to whatever you last used.

### 5. Math and structure

- [ ] Select a passage containing an equation, a code block, and a list. The
      Context preview keeps the code's indentation and the list's items, and shows
      the formula rather than a flattened glyph run.
- [ ] Ask about a step that depends on an unstated condition — for example an
      inverse-based derivation that needs full column rank. The answer should
      *state the missing condition* rather than assert it silently.

### 6. Cross-tab

- [ ] Open the same conversation in two tabs. Edit a draft in one; the other
      picks it up.
- [ ] Close the branch in tab A. It disappears from tab B and does not come back.

## What to expect to be imperfect

- Claude's selectors are fixture-verified only. If Claude's interface has moved on
  your account, Aside should report the capability as unavailable rather than
  misbehave — if it does something else, that is a bug worth reporting.
- A branch still running is torn down if you navigate away; it comes back as a
  failed panel you can retry, not as a resumed one.
- The `[[BRANCH_TITLE: …]]` instruction is visible as your own first message inside
  the branch chat. That is unavoidable while the prompt is typed into the
  provider's composer.
- Up to ~300 ms of typing in a draft can be lost on a hard navigation; structural
  changes are written immediately.
