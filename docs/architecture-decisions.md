# Architecture decisions — reading Q&A refactor

One record of what was chosen and why. It describes the implementation that
shipped, not alternatives that were considered and dropped.

## D0. The execution contract is a native human handoff (current)

Aside prepares a question and hands it to the provider's own web page; the Owner
completes it there. The active path is:

selection → Ask / Why / New-tab → a scratch handoff card (context planned and
previewed) → explicit **Copy & open** → a new top-level provider page → the
Owner confirms Temporary/Incognito, personalization and model, pastes and sends
→ answers and follow-ups stay native → return to source → explicit **End &
discard** (or an explicit, previewed **Save local note**).

Aside never activates a provider mode, never types, pastes, presses Enter or
clicks Send in a provider page, never reads the new answer back, never frames a
provider page, and never creates a durable record for a new question by default.
The previous automatic runner (D5, D6, D9 below) is **retired**, not repaired:
its code was removed from the content script and the worker, the worker refuses
its message types from any client (`retired`), and the content script no longer
runs in frames. The live failures reported against that runner (ChatGPT
Temporary behind a menu, Claude Incognito shown as a label) are superseded by the
manual handoff, not fixed by it.

Why: a user-controlled handoff uses the Owner's existing sign-in and the
provider's own privacy UI as they are, and removes the class of failures where a
detector misreads a changing interface. The cost is explicit manual steps, which
the card makes short and says plainly.

Pieces (all under `src/handoff/` unless noted):

- `routes.ts` — the typed provider descriptor: convenience and base routes,
  hosts, short native steps and notes. Routes carry no content, ever.
- `prompt.ts` — `preparePrompt`: the same `ContextPlan` compiler and template,
  one frozen `PreparedPrompt` per revision; the preview and the clipboard both use
  its `text`. A revision advances only when the text changes.
- `authority.ts` — the worker's single writer for `ScratchHandoff` sessions:
  memory mirrored to `chrome.storage.session` (never local/sync; memory-only when
  session storage is unavailable), requests authorized by the sender's tab (or an
  extension page), build-checked, epoch-checked, never an implicit create; target
  ownership (blank tab first, registered, then navigated), focus-not-duplicate,
  closure only of a demonstrably owned tab, purge before closure, purge on target
  close, source close keeps the target, rehydration without any external action.
- `save-note.ts` — one `CreateQuestion` command that carries its note, so the
  explicit local note is atomic (`providerMode: 'native-handoff'`, no link, no
  captured messages, no snapshot).
- `src/content/handoff-card.ts` — the card; `src/ui/popup.ts` — the toolbar
  popup of active sessions; a native destination page is inert (the worker tells
  its content script it is a target, and nothing is mounted).

## D1. A question is a record, the panel is a view of it

Durable questions live in an extension-origin IndexedDB (`aside-questions`,
schema v1), owned by the service worker (`src/storage/`). The in-page panel
(`BranchPanelState`, `chrome.storage.local`/`.session`) is a per-view, per-run
projection: which question is open, minimized or closed here, what the frame is
doing. Closing a view therefore changes nothing about the question.

Records: `Source`, `SourceBlock` (immutable, shared by content hash), `Anchor`
(exact quote + prefix/suffix, message identity, content hash, scroll hint as a
fallback only), `Question` (lifecycle active/resolved/archived, retention
durable/session-only, parent question/message for explicit children),
`QuestionDraft`, `ContextSnapshot` (the complete prompt, immutable),
`Message` (partial vs complete, provider id when observable), `ProviderLink`
(run state, acknowledgement, capture state), `Note`, `Tombstone`.

One command boundary (`src/domain/commands.ts`), one transaction per command,
response only after commit. Explicit create; update of a missing id is rejected;
stale revision is a conflict that returns the stored draft text; a future
revision is rejected; tombstones block recreation; shared blocks are
reference-counted on delete; a failed read is an error, never an empty database.

## D2. Private stays out of the database

Provider conversation mode (normal / verified temporary or incognito) and Aside
local retention (durable / session-only) are separate concepts. A private
question has **no** durable record: its only state is the session-scoped panel
record, exactly as before. A draft switched to private before sending removes
the durable record it had. Backups and exports are ordinary-data-only by
construction, and a backup that claims a session-only question is refused.

## D3. Context is planned structurally, then serialised once

`src/context/plan.ts` builds a `ContextPlan` from structured source turns: the
selected passage (focus), its enclosing semantic unit (fenced code, list,
paragraph — not a character slice), the user question that produced the source
answer (included by default, untickable), definitions suggested by a simple
numbered-reference match against material Aside actually read, background the
Owner typed, and this thread's own history for follow-ups. Budget drops history
and suggestions first and records what it dropped; the focus and question are
never truncated — an over-budget plan refuses instead.

Delimiters are lengthened past any run present in the material, so quoted text
cannot close or open a section. This is a prompt-injection mitigation, not
immunity. The preview is the complete prompt string, produced by the same
functions as the submission, and the submission is frozen as a snapshot before
any external action.

## D4. Titles are local; no bootstrap message

The `[[BRANCH_TITLE: …]]` instruction is gone from every prompt. A title is
derived from the question (or the selection) and can be renamed. The legacy
stripper is kept only so an old answer that still carries the marker is not
displayed with it. New-tab no longer sends a "Ready for your question." message
to initialise a branch: it opens the same draft and sends the real question once.

## D5. Capture is honest (retired for new questions — see D0)

The branch page reads its exposed messages back with the same transcript
extraction the reading page uses, plus streaming markers and the provider's
stop control, and forwards them over the attempt-checked channel. Completion is
decided from evidence — a second identical read with no generating signal —
never from a timeout. Every saved thread carries one of three states: link only,
partially captured (with the last capture time), captured through message N.
"Captured through" is not a promise that nothing changed remotely afterwards.

## D6. Execution surface (retired — see D0)

Kept: the provider-native surface — the in-page frame where the provider allows
framing, a window Aside drives where it does not — behind the runtime boundary.
Evidence: on live accounts the embedded frame loaded and completed its handshake
on both chatgpt.com and claude.ai (`frameRefused: false` in an owner log);
against fixtures, send, capture and continuation work on both. Refusal to frame
is detected from the loaded frame's document and falls back automatically.

Not adopted: a Chrome Side Panel or a custom chat surface. A Side Panel needs a
new permission and cannot embed an authenticated provider site; a custom chat
whose answers could not be captured or continued would be decorative. Aside's
own presentation is the source-scoped question list and the library page
(`library.html`, opened from the toolbar action), which show saved threads read-
only and never open a provider tab by themselves.

## D7. Presentation is per tab

Minimized and closed are view state. A conflict merge keeps this tab's
`minimized`/`closedView`, so one tab closing its view never forces the Owner's
view shut in another. What tabs do share is the record.

## D8. Diagnostics carry a build id

`scripts/build.mjs` injects `<short sha>[-dirty]+<timestamp>` as `__ASIDE_BUILD__`;
it appears in the popup, the library footer, a card's diagnostics and a saved
view's Copy-log header, so an installed candidate can be matched to a commit.
Every handoff request carries the page's build and is refused as `stale-client`
when it differs from the worker's; `PANEL_LIST` answers with the worker's build.
A native destination page runs no Aside handshake (it is inert by design).

## D9. Private mode as a typed observation (retired — see D0)

`src/runtime/private-mode.ts` observes the branch document and returns three
separate facts — capability (`available` / `not-observed-yet` /
`unavailable-in-this-context` / `unknown`), observed mode (`normal` / `private`
/ `unknown`) and preparation step (`page-loading` … `awaiting-choice` …
`ready` / `blocked`) — with the evidence kind and the next action. It clicks
and types nothing; the frame-side workflow in `root.ts` acts on `nextAction`
under bounded budgets: open a menu opener identified by `aria-haspopup`,
activate an inactive control once, stop at a chooser dialog, re-observe after
remounts, verify before insert and before every submit. Only provider-owned
state counts — a pressed control, or the provider's own active-mode interface
marker — never Aside's UI, a quoted passage, a URL hint or a class substring.

Rejected: treating "no selector matched" as "unsupported". That was the dead end
behind both owner reports: the ChatGPT control existed inside a closed menu, and
the Claude interface shows the active state as a label rather than a button.
Also rejected: a silent switch to persistent when verification fails. Ordinary
mode is offered only where the observation supports it, as an explicit two-step
choice in the panel; the failure event carries the observation so **Check again**
can re-observe the *same* document and continue the pending prompt (embedded:
the start is re-posted to the existing frame; driven window: the worker
redelivers the stored run to the same tab). A provider navigation during
preparation is resumed only while the last reported step was before insertion,
so a resume can never resend.

## D10. Selection fidelity for mathematics

`extractStructuredSelection` (`src/shared/dom.ts`) resolves equations against the
live `Range`, not against `cloneContents()`: a selection made inside KaTeX's
visual subtree carries only glyphs and position spans, and the TeX annotation is
outside the cloned fragment — which is how `$S_2 \ne S^2$` became `S2≠S2` in
both the preview and the submitted prompt. Wrappers the range touches are widened
to the whole equation; coverage is judged by rendered text; a partial selection
keeps the selected part as the selection and supplies the whole equation as a
separately labelled context block (`enclosing-equation`); an equation without a
readable source is disclosed as a limitation. The plan and the snapshot carry the
fidelity record. No model or regex "cleanup" is applied anywhere.

## Verification levels

Per provider and capability the evidence label is one of implemented /
fixture-tested / live-tested / blocked / unsupported. Offline fixtures prove
behaviour against a fixture, not a live site; the owner acceptance walkthrough
is what settles live coverage.

## D11. Saved records stay; their old runner does not

Existing durable questions, notes, snapshots, captured threads and legacy panel
view records are kept and usable (library, question list, search, lifecycle,
delete with tombstones, export, backup/restore). A legacy panel on its source
page is a read-only view: its provider link opens as ordinary navigation (blank
tab first, then the URL), and "Ask about this passage" starts a new scratch
handoff without touching the record. The content script sends no panel writes
from these views except the per-tab view state (minimize/close).

## D12. Passage return is validated, not guessed

`locatePassage` accepts an occurrence only when its recorded context agrees; with
message identity it searches that message, without it the whole page — and more
than one agreeing place is reported as ambiguous rather than picked. A message
whose passage changed is shown as such. No positional or scroll-offset fallback.
