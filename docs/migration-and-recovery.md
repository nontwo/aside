# Migration and recovery

## What is migrated

Legacy panel records, both shapes:

- v1 per-panel records `aside:panel:<id>` in `chrome.storage.local`, with
  deletion tombstones `aside:gone:<id>`;
- v0 buckets `aside:panels:<conversation>` (and the pre-rename
  `side-branches:panels:` prefix) holding arrays of panel states.

Each ordinary (persistent-kind) panel becomes one `Question` with its `Source`,
`Anchor`, blocks and draft. A panel that was actually sent also gets its stored
prompt frozen as a `ContextSnapshot` and a **link-only** `ProviderLink` carrying
the branch conversation URL. No historical message is invented: old transcripts
were never captured, and the library says so.

Titles are preserved: a title the model produced is kept as the question title
(marked user-set so it is never regenerated).

## What is never migrated

- Anything in `chrome.storage.session` (private branches).
- A private-kind record found in **durable** storage by an older build. It is
  counted and reported (`skippedPrivate` in the journal, and in the library
  footer) and left exactly where it is. Nothing replicates it and nothing deletes
  it; that is the Owner's decision.

## How it runs

`src/storage/migration.ts`, invoked by the worker on every start. It is
journaled (`meta` store, mirrored to `chrome.storage.local` under
`aside:migration-journal`) and idempotent: already migrated ids are skipped, a
`CreateQuestion` rejected because the id exists is treated as the resume path,
and the journal is written after each panel, so an interruption resumes at the
next one without duplicates.

Legacy tombstones are applied first, as domain tombstones, so a deleted panel can
never come back through a replayed migration.

Validation (`journal.validation`) compares the count of eligible legacy panels
with the count migrated and requires zero failures. Only a validated, completed
journal enables cleanup.

## Cutover and fencing

The legacy records are **left in place** as the rollback source. A validated
journal writes `aside:legacy-fence` (`cutoverAt`, build id). Nothing in a newer
build reads legacy records as authoritative after that point, and an explicit
cleanup — the "Remove legacy copies" button in the library footer, confirmed —
is the only thing that removes them. Cleanup never touches session storage or
any private-kind record, and it is refused while validation has not passed.

Reloading the extension does not touch an active private session's storage.

## Rollback

Rolling back to a build without the question database loses nothing that
existed before migration: the legacy records are still there until cleanup.
Questions created **after** migration are only in the database. Before any
rollback, take a backup from the library (JSON, ordinary data only); a later
build restores it with identity and revision checks. Never clear the database
to "point at the old one" — the backup is the recovery path.

## Backup and restore

`Backup` in the library downloads `aside-backup-<timestamp>.json`: format
`aside-backup`, version 1, ordinary data only (a record claiming
`session-only` retention fails validation). `Restore…` validates the schema,
treats every field as data, skips any question tombstoned locally, skips any
record whose stored revision is at or above the incoming one, and reports
counts. Backups are local files; never commit or upload them.

## Storage failure

A read that fails is reported as an error, not treated as an empty database. The
worker records the failure; the panel shows the question as unsaved; the library
footer says storage could not be opened and that nothing was written or
initialised. No command overwrites or initialises over data it could not read.

## Installed-extension upgrade

The Owner's installed extension keeps its identity and storage scope; upgrading
is replacing the files in the same unpacked directory and pressing **Reload** on
the existing card — never an uninstall, which would delete the data.

Observed in `scripts/upgrade-smoke.mjs`: after the files are replaced, a browser
restart alone kept the previous build's service worker answering (same version
`0.1.0`); the card's Reload (loading the same directory again) switched it, with
the same extension id and the same storage. Pages still running the old content
script are refused by the new worker as `stale-client` and ask for a reload.

## Upgrading to the native-handoff build

No data migration is needed and none runs for it:

- The question database schema is unchanged (`aside-questions` v1). The only
  command change is additive: `CreateQuestion` may carry one `note`, written in
  the same transaction. `providerMode` gained `native-handoff` for such notes.
- Scratch handoffs are new and session-only; nothing is converted into them.
- Legacy panel view records stay in `chrome.storage.local` and are shown
  read-only. The journaled legacy migration keeps running on each worker start as
  before, so a legacy panel written after the previous cutover becomes a
  `q_legacy_…` question on the next start (observed in the upgrade check).
- `chrome.storage.session` is now restricted to trusted extension contexts; the
  worker was already the only reader. Reloading the extension clears session
  storage, so private legacy panels and open handoffs do not survive an update.
- The manifest drops the unused `scripting` permission, sets
  `all_frames: false` for the content script, and turns the toolbar action into
  a popup (library reachable from it). No permission is added.
- The last-used branch kind stored by earlier builds is left in place and no
  longer read: every new question is a temporary handoff.

Rollback to the previous build loses nothing that existed before; notes saved
from handoffs are ordinary durable questions and are included in backups.
