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

- Opens a question beside the main conversation instead of making you scroll the original chat.
- Plans the context structurally and shows it before sending — the selected passage, the paragraph, step or code block it sits in, the question that produced the answer, definitions the passage refers to, and anything you add — with a preview that is the complete prompt, byte for byte.
- Runs the question on the same provider, in an embedded panel where the provider allows it and in a window Aside drives where it does not.
- Reads the answer back and keeps it with the question: every saved thread says whether it is link only, partially captured, or captured through a given message.
- Keeps questions attached to their source. Closing a view deletes nothing; a source's questions are listed on its page and in the library, where they can be resolved, reopened, archived, renamed, exported as Markdown, backed up, or explicitly deleted.
- Fails with a real error and a way to retry instead of an endless spinner.

### Questions, not windows

A question is a record attached to the passage it was asked about. The panel is a
view of it. **Close** and **Minimize** hide the view; **Resolved**, **Archived**
and **Delete** are separate, explicit actions on the question itself, and delete
removes only Aside's local record — provider history is never touched. Titles are
generated locally from the question and can be renamed; the model is never asked
to emit one.

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
| Branch surface | embedded panel | embedded panel attempted first; falls back to a window Aside drives if claude.ai refuses to be framed |
| Private mode | Temporary Chat | Incognito chat |
| Private mode caveats | controls history, not personalization; can later be saved to history from ChatGPT | unavailable inside projects, so starting one leaves the project; a closed Incognito chat cannot be reopened |
| Evidence level | `fixture-only` | `fixture-only` (embedded surface: `unverified`, attempted once and observed) |
| Verified against | offline fixtures and the live site's DOM conventions | offline fixtures only |

No surface is declared `verified`. In this codebase that level means the adapter
positively observed the capability in a live DOM, and nothing here does: neither
provider was run against a live logged-in account in this work. `fixture-only`
means implemented and exercised against local fixtures — Aside offers it, and does
not claim it is proven.

Claude's selectors are candidates ordered semantic-first and are re-detected after
navigation. Claude's interface is mid-migration between the current and previous
experiences, so a rollout may change them; Aside reports a capability as
unavailable rather than guessing.

### Private branches

Two things are kept apart: the provider's own conversation mode (normal, or its
verified Temporary/Incognito mode) and Aside's local retention (durable, or
session-only). A private question is session-only — it has no record in the
question database, no export, no backup — and it is only sent once Aside can
positively see that the provider's private mode is on. Nothing is ever downgraded
from private to persistent automatically, and a selection made inside a private
chat defaults to a private branch.

**Preparing the mode is a workflow, not a selector lookup.** Aside observes the
branch document as three separate facts — whether the mode is offered here at
all, what the page currently says the conversation is, and how far preparation
has got — and acts on the next step only:

| Observed | What Aside does |
| --- | --- |
| the provider's own control reads as on, or the provider's own active-mode interface is shown (Claude's "Incognito chat" label) | verified; the prompt is typed and sent once |
| the control reads as off | it is activated once, then re-observed; only a provider-owned on-state counts |
| the control exists but sits behind a menu (present, enabled, no box) | the menu opener is used, then the control; never reported as "unsupported" |
| the provider asks a question (ChatGPT's Personalized / Unpersonalized choice) | Aside stops without choosing and waits for you |
| the page navigated during preparation (Claude opens Incognito as a new page) | the pending question is carried to the new document — only while nothing has been typed yet |
| the control is disabled | reported as unavailable in this branch window (usually a project or workspace rule) |
| nothing observed yet | reported as not observed; unknown stays unknown |

Every stop happens **before anything is typed**, with the question preserved and
a recovery row under it: **Show branch window** (see the document Aside is
looking at, and act in it), **Check again** (re-observe the *same* document and
continue the pending question there — no reload, no new window), and, where it
makes sense, **Use ordinary mode…** — a two-step choice that sends the question
as an ordinary, saved chat only after you confirm. Aside never makes that switch
by itself. Try again after such a stop reuses the branch window you may just
have fixed.

Before a private branch runs, the panel shows what that provider documents about
its own private mode. The note stays collapsed until you open it; inside a
project it says once, on its own line, that the branch will start outside the
project. The toggle carries the provider's own name for the mode, so it is
recognisable in the provider's own interface.

Private branch text, prompts, answers and logs are kept in session storage, which
the browser clears when the session ends. They never reach durable storage. If a
browser does not make session storage available, Aside says so in the panel and
keeps refusing to write private branch content to disk — a private branch still
runs, it just cannot be kept. That is a statement about this extension only: Aside
can observe the page, and cannot make any claim about what a provider retains on
its servers.

The mode is re-checked after the composer is acquired and again before every
submit attempt, not only the first: the fallback chain that handles providers
where a click does not send spans several seconds of further attempts.

### Mathematics in a selection

A selection made inside a rendered formula (KaTeX, MathJax, MathML) is read
against the live selection, not the copied fragment: the whole equation's source
is recovered from the rendering's own annotation, so `$S_2 \ne S^2$` reaches the
preview and the prompt as written, never as `S2≠S2`. A selection that covers only
part of an equation is sent as that part, with the whole equation supplied
separately and labelled as context, not as the selection. Fidelity is disclosed
in the Context section (which equations were read, whether fully, and any that had
no readable source). Nothing is "cleaned up" by a model or a regex.

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

6. The toolbar icon opens Aside's **library**: every source and question, search,
   Markdown export, JSON backup and restore, and the build identifier of the
   installed copy. On first run after upgrading, existing branches are migrated
   into the question database; the legacy copies are kept until you remove them
   from the library footer. See [`docs/migration-and-recovery.md`](docs/migration-and-recovery.md).

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

`npm test` covers the question database (commands, conflicts, tombstones,
reference-counted deletion, migration, backup/restore) with an in-memory
IndexedDB, the context planner against a small grounding corpus, capture honesty,
placement geometry and the provider adapters.

`npm run smoke:local` runs the extension against fake `chatgpt.com` and `claude.ai`
fixtures in a disposable Chrome profile: selection toolbar, context preview equal
to the submitted prompt, branch creation, answer capture settling to "captured
through", local titles, New-tab drafting, close-without-delete and explicit delete
across two tabs, privacy verification, and the layout matrix across widths,
themes and sidebar states. Requests are intercepted at the browser
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

## Diagnostics

The panel header keeps the everyday actions; **More** holds the diagnostics:
**Copy log** (redacted: URLs, status, automation steps, private-mode
observations as attributes only), **Copy log + text** (adds your selected text
and the generated prompt) and **Select log** (shows the redacted report in the
panel when the clipboard is blocked). Every report starts with the build ids of
the page's content script, the service worker and the branch frame; the worker,
frame and branch-tab handshakes all carry their build, and a mismatch is logged
as `stale-client` and shown as a notice asking for a page reload.

## Privacy note

Aside's branch debug logs can include selected text, the generated first prompt, root and branch URLs, and branch status details (only with **Copy log + text**; the default report is redacted). Review logs before sharing them in issues or public discussions.

## License

MIT. See [LICENSE](./LICENSE).
