# Architecture decisions — reading Q&A refactor

One record of what was chosen and why. It describes the implementation that
shipped, not alternatives that were considered and dropped.

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

## D5. Capture is honest

The branch page reads its exposed messages back with the same transcript
extraction the reading page uses, plus streaming markers and the provider's
stop control, and forwards them over the attempt-checked channel. Completion is
decided from evidence — a second identical read with no generating signal —
never from a timeout. Every saved thread carries one of three states: link only,
partially captured (with the last capture time), captured through message N.
"Captured through" is not a promise that nothing changed remotely afterwards.

## D6. Execution surface (evidence-based)

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
it appears in the panel's Copy-log header and the library footer so an installed
candidate can be matched to a commit. The id also travels in every handshake —
the worker's `PANEL_LIST` answer, the frame's `SB_FRAME_READY`, the branch tab's
run and re-check responses, and every preparation/failure event — and a
mismatch is logged as `stale-client` and surfaced as a reload notice. "It does
nothing" reports that were really two builds talking are now visible as such.

## D9. Private mode is a typed observation; preparation is a workflow

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
