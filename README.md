# Aside

Aside is a Chromium extension for asking focused follow-up questions from long ChatGPT and Claude answers without losing your place in the main conversation.

It keeps the reading flow centered on the selected passage:
- select text inside an assistant answer on ChatGPT or Claude
- open a branch with `Ask` or `Why`, or `New-tab` for its own window
- review the Context section to see exactly what will be sent, then adjust it
- type the question and press `Enter` to send it (`Shift+Enter` for a new line)
- keep reading while branches run in parallel
- press `Escape` to tuck the open branch back into the rail
- restore minimized branches later and jump back to the original selected text

A branch always runs on the provider you selected in. Aside never moves a
selection from one provider to the other, and copying context into a new
conversation is not a server-side fork: it does not carry attachments, project
knowledge, memory, hidden reasoning or model state.

## What Aside does

- Opens a branch workspace beside the main conversation instead of making you scroll the original chat.
- Shows the exact context it will submit before it submits it — the selected passage, the answer blocks it touched, an optional preceding question, and anything you add — and lets you remove any of it.
- Runs the branch on the same provider, in an embedded panel where the provider allows it and in a window Aside drives where it does not.
- Preserves minimized branches so several questions can run at once, saved per conversation so leaving a chat and coming back does not discard them.
- Fails with a real error and a way to retry instead of an endless spinner.

### Coexisting with the provider's own interface

Aside does not hide, disable, restyle or reparent anything the provider renders.
Its own controls are labelled `Aside`, measured against the provider's selection
toolbar, sidebar, header, composer and tool panes, and placed where they do not
overlap. When there is no safe position the toolbar collapses to a compact `Aside`
entry rather than covering a native control.

Minimized branches live in free whitespace in the **left gutter** — between the
provider's own navigation and the reading column. Where the gutter is too narrow
to be readable, the rail is replaced by the compact entry in verified free space.

### Provider support

| | ChatGPT | Claude |
| --- | --- | --- |
| Origins | `chatgpt.com`, `chat.openai.com` | `claude.ai` |
| Branch surface | embedded panel | window Aside drives (claude.ai refuses framing) |
| Private mode | Temporary Chat | Incognito chat |
| Private mode caveats | controls history, not personalization; can later be saved to history from ChatGPT | unavailable inside projects, so starting one leaves the project; a closed Incognito chat cannot be reopened |
| Verified against | offline fixtures and the live site's DOM conventions | offline fixtures only — **not live-verified** |

Claude's selectors are candidates ordered semantic-first and are re-detected after
navigation. Claude's interface is mid-migration between the current and previous
experiences, so a rollout may change them; Aside reports a capability as
unavailable rather than guessing.

### Private branches

A private branch is only sent once Aside can positively see that the provider's
private mode is on. Missing, disabled, unreadable, unchanged or unconfirmed — all
of them stop the branch **before anything is typed**, with the question preserved
so you can retry or switch to a persistent branch. Nothing is ever downgraded from
private to persistent automatically, and a selection made inside a private chat
defaults to a private branch.

Private branch text, prompts, answers and logs are kept in session storage, which
the browser clears when the session ends. They never reach durable storage. That
is a statement about this extension only: Aside can observe the page, and cannot
make any claim about what a provider retains on its servers.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Open `chrome://extensions/`, enable Developer Mode, and load the `dist/` directory as an unpacked extension.

4. If you are upgrading an already-loaded copy, press **Reload** on the Aside card.
   The manifest now requests `https://claude.ai/*`, and Chrome will not grant a new
   host permission to an extension that is only refreshed in the page — check the
   card shows claude.ai under "Site access" and approve it if prompted.

5. Reload `chatgpt.com` **and** `claude.ai` (the content script is only injected on
   a fresh load), select assistant text, and try `Ask`, `Why`, or `New-tab`.

## Course submission package

The Text as Data course submission lives in [`course-submission/`](./course-submission/). It includes a static public demo, synthetic sample data, a report, replication notes, and a preserved extension artifact.

Folder structure:
- root source files are the Chromium extension and shared build/test tooling
- `course-submission/` is the canonical course website and replication package
- generated exports or zip-ready packages should live outside the repo, such as `/tmp/aside-course-submission`

```bash
npm run build:submission
npm run audit:submission
npm run smoke:submission
npm run package:submission
```

The GitHub Pages workflow publishes `course-submission/` as the public project site.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
npm run smoke:local
```

`npm run smoke:local` runs the extension against fake `chatgpt.com` and `claude.ai`
fixtures in a disposable Chrome profile: selection toolbar, context preview, branch
creation, privacy verification, the cross-tab panel protocol, and the layout matrix
across widths, themes and sidebar states. Requests are intercepted at the browser
level, so windows the extension opens itself are covered too, and any request to a
host the harness does not serve **fails the run** — the default smoke can never
reach a real ChatGPT or Claude account.

Set `CAPTURE_SCREENSHOTS=<dir>` to write the layout-matrix screenshots to disk.

The native-window scenarios (`Why` recovery and `New-tab`) run as part of that command. To skip them for a faster loop:

```bash
SKIP_NATIVE_WINDOW_SMOKE=true npm run smoke:local
```

## Safe open-source release workflow

This workspace is intentionally kept separate from the final public GitHub export.

Before publishing:

```bash
npm run audit:public
npm run export:public -- ../aside-public
```

The audit checks for obvious release blockers such as:
- old reference/provenance markers
- personal machine paths
- `.DS_Store`
- maintainer-only debug artifacts

The export script creates a clean staged repo tree in a separate directory so you can inspect it before running `git init` and pushing it publicly.

## Privacy note

Aside’s branch debug logs can include selected text, the generated first prompt, root and branch URLs, and branch status details. Review logs before sharing them in issues or public discussions.

## License

MIT. See [LICENSE](./LICENSE).
