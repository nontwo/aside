# Aside

Aside is a Chromium extension that helps you ask about a passage of a long
ChatGPT or Claude answer **in the provider's own temporary chat**, without losing
your place in the conversation you are reading.

- Select text in an assistant answer on ChatGPT or Claude.
- Choose `Ask`, `Why` or `New-tab`. A card prepares one readable prompt from the
  passage and the context around it; you can see the whole prompt and change it.
- Press **Copy & open temporary chat**. Aside copies exactly that prompt and
  opens a new ChatGPT or Claude page in its own window (`New-tab`: a tab).
- In that native page you confirm Temporary Chat / Incognito chat, pick a model
  if you want, paste, and send. Answers and follow-ups stay there.
- Come back to the passage, and **End & discard** when you are done.

Aside is a helper for handing a question to the provider's web page yourself. It
does not use a provider API, does not type, paste or send anything in a provider
page, and does not read the answer back. It is not affiliated with or endorsed by
OpenAI or Anthropic.

## What happens automatically, and what you do

| Aside does | You do |
| --- | --- |
| Shows its toolbar next to (never over) the provider's own selection actions | Choose Ask, Why or New-tab |
| Prepares the prompt: the passage (formulas as their TeX source), its paragraph or block, the question before it, definitions it can find in what it read, and anything you add — with a preview that is exactly what will be copied | Edit the question; remove or add context |
| Copies the prompt only when you press Copy (or Copy & open) | Paste it yourself |
| Opens a new top-level provider page — no text in the URL, no referrer | Confirm the native temporary mode and personalization, choose a model, send |
| Nothing in the native page: no clicks, typing, paste, send, or answer capture | Read and follow up there |
| Brings you back to the passage | — |
| **End & discard**: clears the question from Aside, and closes the tab it opened while it can still prove that tab is its own | Decide when a question is done |
| **Save local note…**: a permanent library record of the passage, question and your note | Decide what is worth keeping |

### Temporary by default, not saved

Every new Ask/Why/New-tab question is a *scratch handoff*: temporary-intended,
and kept only for this browser session — in the extension's worker and
`chrome.storage.session` (restricted to the extension's own trusted contexts).
It is never written to extension local storage, the question database, logs,
exports or backups. It is cleared when you **End & discard** it, when its native
tab closes, or when the browser or the extension restarts. **Hide** (or Escape
inside the card) only tucks it into the left rail. Aside never switches a
question to an ordinary saved chat for you.

Separate things, not one guarantee:

- **The provider's mode** — you set it in the native page. Aside cannot see or
  verify it; the card tells you to check it before pasting.
- **Aside's local copy** — session-only, cleared as above ("Cleared from Aside"
  means Aside's copy; garbage collection and browser internals are outside that).
- **The clipboard** — keeps what you copied until you copy something else.
  **More → Clear clipboard now** replaces it with empty text in this browser;
  clipboard managers, synced clipboards and other apps may still hold a copy.
- **The provider's retention** — theirs. ChatGPT may keep a temporary chat for
  up to 30 days for safety; Anthropic keeps Incognito chats 30 days by default
  (longer under some organization settings). Saving a chat in the provider
  changes its lifecycle.

### Where the handoff goes

| | ChatGPT | Claude |
| --- | --- | --- |
| Opens | `https://chatgpt.com/?temporary-chat=true` — an observed entry that may pre-select Temporary; if it lands on an ordinary chat, a sign-in or a choice screen, select Temporary there. **Open a plain new chat instead** opens `https://chatgpt.com/`. | `https://claude.ai/new`, outside any Project; start Incognito with the ghost icon. An `incognito` URL shortcut is not used (not established on a signed-in page). |
| Mode name | Temporary Chat (choose Unpersonalized for a context-isolated answer; Personalized also keeps the chat out of memory) | Incognito chat (no memory; profile preferences and styles can still apply; may open in the previous chat experience) |
| Evidence | fixture-tested; the native steps are yours | fixture-tested; the native steps are yours |

Aside does not populate or change the model, the account's settings, memory, the
source conversation's mode, or its Project. A new native conversation does not
inherit attachments, Project files, tools or hidden state from the source.

### Different questions, different chats

Each Ask/Why/New-tab is a new session with its own native tab. **Continue in
ChatGPT/Claude** focuses the tab of *that* question; it never reuses another
question's chat and never copies again (follow-ups are typed in the native chat).
If that tab was closed, its temporary conversation cannot be reopened and the
question is cleared from Aside; select the passage again for a new one. Once a
native tab shows a conversation address (the provider giving the chat its own
URL, or you opening another chat in it), Aside can no longer prove it is the page
it opened: it will still focus it, but End leaves it for you to close.

The toolbar popup lists the active handoffs — useful while you are looking at the
native chat — with **Return to source**, **Continue**, **Copy prompt** and **End &
discard**. It is not a history.

### Saved records from earlier versions

Questions saved before this release stay in the library: search, view, rename,
resolve, archive, delete (with tombstones), Markdown export, backup and restore.
A saved branch shown on its source page is read-only: **Open conversation** opens
the saved provider chat as ordinary navigation, and **Ask about this passage**
starts a new temporary handoff, leaving the record unchanged. The earlier
automatic runner (framed chats, driven windows, private-mode switching,
typing/sending, answer capture) is retired; its requests are refused, including
from a page still running an older content script.

### Coexisting with the provider's own interface

Aside does not hide, disable, restyle or reparent anything the provider renders.
Its own controls are labelled `Aside`, measured against the provider's selection
toolbar, sidebar, header, composer and tool panes, and placed where they do not
overlap. When there is no safe position the toolbar collapses to a compact `Aside`
entry rather than covering a native control. Hidden cards live in free whitespace
in the **left gutter**; where the gutter is too narrow, the compact entry is used.
A native page Aside opened stays exactly as the provider made it: Aside mounts
nothing there.

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

```bash
npm ci
npm run build
```

Open `chrome://extensions/`, enable Developer Mode, and **Load unpacked** the
`dist/` directory. To update an already-loaded copy, replace the directory's
contents and press **Reload** on the Aside card — do not remove the extension,
which would delete its saved data. A browser restart alone can keep the previous
service worker running for a same-version unpacked extension; the card's Reload
is what switches it. Reloading clears session storage, so any open temporary
handoff is dropped. Then reload the open `chatgpt.com` / `claude.ai` tabs.

The toolbar icon opens the popup (active temporary handoffs, the build id, and
**Open library**).

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
npx tsc --noEmit
npm test
npm run build
npm run smoke:local
OLD_DIST=<previous build dir> node scripts/upgrade-smoke.mjs
```

`npm test` covers the scratch-handoff authority (retention, ownership, events,
authorization, retired requests), the prepared prompt (preview equals copied
text, revisions, context, math, delimiters, budget), the handoff card (copy/open
independence, double clicks, clipboard fallback, explicit clearing, End, local
note), passage re-anchoring, the question database, and the provider adapters.

`npm run smoke:local` runs the built extension against fake `chatgpt.com` and
`claude.ai` fixtures in a disposable Chrome profile. The fixtures record every
click, input, key and paste in the native page, so the smoke proves Aside never
touches it; the Owner's paste-and-send is simulated in the fixture, explicitly.
It observes durable writes while the lifecycle runs (storage change events and
storage-authority messages), covers Ask/Why/New-tab on both providers, the popup,
source and target closure, many sessions, saved-data retention, and the layout
matrix. Any request to a host the harness does not serve, or any provider page it
did not serve, **fails the run**. `CAPTURE_SCREENSHOTS=<dir>` writes screenshots.

`scripts/upgrade-smoke.mjs` loads a previous build from one directory, writes
data with it, replaces the directory's contents with the current `dist/`,
restarts on the same profile, reloads as the card would, and checks the extension
id, every pre-existing record, the migration journal and that a new handoff
writes nothing durable. Run it locally with the previous build; it is not part of
CI.

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

A handoff card's **More → Copy diagnostics** copies build ids (page and worker),
provider, route category, clipboard and target states and result codes — no
content, no URLs. A saved-record view keeps **Copy log** (redacted) and **Copy
log + text** (includes the selected text and prompt). Page and worker builds are
compared on every exchange; a mismatch is refused as `stale-client` and the page
asks for a reload.

## Privacy note

**Copy log + text** on a saved-record view includes selected text and prompts;
review it before sharing. Temporary handoffs are never written to disk by Aside.

## License

MIT. See [LICENSE](./LICENSE).
