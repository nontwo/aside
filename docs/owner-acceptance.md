# Owner visual acceptance

Everything below is offline-verified against fixtures unless marked **live**. Live
checks on real accounts are the part only you can do; this build has not been
run against one by the maintainer.

## Load the build

```bash
npm run build
```

1. `chrome://extensions/` → Developer Mode → **Load unpacked** → select `dist/`.
   If Aside is already loaded, press **Reload** on its card. Chrome will not grant
   a new host permission to an extension that is merely refreshed in the page;
   confirm the card lists `claude.ai` under *Site access*.
2. The card's toolbar icon now opens Aside's **library** (a toolbar action; no
   new permission was added).
3. Hard-reload `chatgpt.com` and `claude.ai`. The content script is injected on
   page load only.
4. The build identifier appears in the library footer and in any **Copy log**
   report as `build: <sha>[-dirty]+<timestamp>`. Compare it with the PR head.

Reference images captured from fixtures live in
[`docs/layout-evidence/`](./layout-evidence/).

## Walkthrough

### 1. Native controls still work

- [ ] Select text in an assistant answer. The provider's own selection actions
      appear as before, in the same place. Aside's toolbar sits beside them; both
      are fully clickable. Right-click, copy, keyboard selection and Escape on a
      provider menu all behave normally.

### 2. Ask, with visible context

- [ ] Select a **math** passage inside a longer derivation and press `Ask`. The
      panel shows *Selected local focus*, and **Context** summarises the actual
      plan: the passage, its enclosing step/paragraph, the question that produced
      the answer.
- [ ] Open Context. Untick the enclosing unit; the preview shrinks. Tick it back.
      The preview is the complete prompt, instructions and question included.
- [ ] Type a question and press **Start branch**. On ChatGPT the answer runs in
      the panel frame. On Claude it also tries the panel frame first; if claude.ai
      refuses framing on your account it moves to a window Aside opens, with no
      error — note which of the two you see (**live**).
- [ ] The title is taken from your question and is renameable from the list. No
      `[[BRANCH_TITLE …]]` line is requested from the model.
- [ ] As the answer streams, **Saved so far** appears in the panel and settles to
      *Captured through message N*.

### 3. Why and New-tab

- [ ] `Why` asks in one click and runs the same pipeline.
- [ ] `New-tab` opens a **draft** first; nothing is sent until you type and press
      Start branch, and then the real question is sent once, in its own window.

### 4. Follow-up and continuation

- [ ] Type a follow-up in the branch conversation itself. It stays in the same
      provider conversation; the panel's saved thread grows.
- [ ] Press **Close**. The panel disappears; nothing is deleted. Open
      **Questions (n)** in the left rail: the question is listed as active.
- [ ] Reload the page. The question is still listed. Open it: the saved thread is
      shown read-only; no provider tab opens by itself. **Open branch** continues
      at the provider.

### 5. Retention actions

- [ ] From the list: **Resolve**, then **Reopen**, then **Archive**; the status
      filter reflects each. **Rename** changes the title everywhere.
- [ ] **Delete** asks for confirmation, removes the local record only, and says
      provider history is untouched. The question does not come back after a
      reload or from another tab.

### 6. Library, export, backup

- [ ] Toolbar icon → library. Sources on the left; questions with status filters;
      search finds a word from a saved answer.
- [ ] **Export this page as Markdown** (from the list or the library) downloads a
      file with the selected passage, the exact prompt, the saved thread and its
      capture state.
- [ ] **Backup** downloads JSON. **Restore…** of that same file reports
      everything skipped as older (nothing duplicated).

### 7. Private branches (**live**)

- [ ] Choose the provider's private mode on the toggle (`Temporary Chat` /
      `Incognito chat`). Its documented constraints are shown before sending.
- [ ] Send. It proceeds only once the provider's own control reads as on. From a
      project conversation the branch starts outside the project and says so.
- [ ] Turn the provider's private mode off and try again: Aside refuses before
      typing anything, keeps your question, and the provider composer is empty.
- [ ] A private question never appears in the library, export or backup. Close
      and reopen keeps it in this session only; a browser restart loses it and
      the panel warns about that in advance.

### 8. Cross-tab

- [ ] Open the same conversation in two tabs. Edit a draft in one; the other
      shows it after you leave the box. Close the view in tab A; tab B's view is
      **not** closed.
- [ ] Delete from tab A. It disappears from tab B and does not come back.

## Known limitations

- Live provider coverage is pending until you run the steps marked **live**.
  Claude's composer and selection popup selectors are fixture-verified; a
  failure there now writes a structural census to the debug log (**Copy log**)
  instead of a bare timeout.
- Follow-ups are typed in the provider's own conversation; Aside does not offer a
  second composer of its own.
- A branch still running is not resumed after a hard navigation; it comes back as
  a saved thread with whatever was captured, and continuing is explicit.
- Attachment and file contents are never read; a referenced file is listed as
  missing in the plan, not fetched.
