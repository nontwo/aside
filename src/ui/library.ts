/**
 * The library page: every source and question Aside has kept, with search,
 * status filters, read-only saved answers, Markdown export, JSON backup/restore,
 * migration status and an explicit legacy cleanup.
 *
 * This is an extension-owned page. It reads records through the worker and
 * renders them as text nodes only — nothing from a saved answer, an export or an
 * import is ever interpreted as HTML or executed. Opening a saved question here
 * never opens a provider tab or sends anything.
 */

import type {
  DomainBackupResponse,
  DomainExportResponse,
  DomainLegacyCleanupResponse,
  DomainQueryMessage,
  DomainQueryResponse,
  DomainRestoreResponse,
  QuestionChangedMessage
} from '../storage/protocol';
import type { QuestionBundle, QuestionListEntry, SearchHit, SourceListEntry } from '../storage/repository';
import type { QuestionLifecycle } from '../domain/types';
import { BUILD_ID } from '../shared/build-info';

type Filter = 'active' | 'resolved' | 'archived' | 'all';

const state: { sources: SourceListEntry[]; selectedSourceId: string | null; filter: Filter; search: string } = {
  sources: [],
  selectedSourceId: null,
  filter: 'active',
  search: ''
};

const el = {
  search: document.getElementById('search') as HTMLInputElement,
  filters: document.getElementById('filters') as HTMLDivElement,
  sources: document.getElementById('sources') as HTMLElement,
  content: document.getElementById('content') as HTMLElement,
  about: document.getElementById('about') as HTMLElement,
  backup: document.getElementById('backup') as HTMLButtonElement,
  restoreButton: document.getElementById('restore-button') as HTMLButtonElement,
  restore: document.getElementById('restore') as HTMLInputElement
};

async function send<T>(message: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}

async function query<TQuery extends DomainQueryMessage['query']>(
  message: Extract<DomainQueryMessage, { query: TQuery }>
): Promise<Extract<DomainQueryResponse, { ok: true; query: TQuery }> | null> {
  const response = await send<DomainQueryResponse>(message);
  if (!response || !response.ok || response.query !== message.query) {
    return null;
  }
  return response as Extract<DomainQueryResponse, { ok: true; query: TQuery }>;
}

function text(tag: string, content: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) {
    node.className = className;
  }
  return node;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  if (className) {
    node.className = className;
  }
  node.addEventListener('click', onClick);
  return node;
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function captureSummary(entry: QuestionListEntry): string {
  const link = entry.latestLink;
  if (!link) {
    return entry.draft?.text ? 'draft, not sent' : 'not sent';
  }
  if (link.run === 'failed') {
    return 'failed';
  }
  if (link.run === 'submission-unknown') {
    return 'submission outcome unknown';
  }
  if (link.capture === 'captured-through') {
    return `captured through message ${link.capturedThroughMessageId ?? '?'}`;
  }
  if (link.capture === 'partial') {
    return `partially captured${link.lastCaptureAt ? `, last at ${new Date(link.lastCaptureAt).toLocaleString()}` : ''}`;
  }
  return link.conversationUrl ? 'link only — transcript not captured' : link.run;
}

async function loadSources(): Promise<void> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'sources' });
  state.sources = response?.sources ?? [];
  renderSources();
}

function renderSources(): void {
  el.sources.replaceChildren();
  if (!state.sources.length) {
    el.sources.append(text('p', 'Nothing saved yet. Ask a question from a ChatGPT or Claude answer to start.', 'empty'));
    return;
  }
  state.sources.forEach((entry) => {
    const node = button(entry.source.title || entry.source.url, () => {
      state.selectedSourceId = entry.source.id;
      state.search = '';
      el.search.value = '';
      renderSources();
      void renderSource(entry.source.id);
    }, 'source');
    node.dataset.selected = String(entry.source.id === state.selectedSourceId);
    node.append(
      text('small', `${entry.source.providerId} · ${entry.activeCount} active / ${entry.questionCount} total`)
    );
    el.sources.append(node);
  });
}

function renderFilters(): void {
  el.filters.replaceChildren();
  (['active', 'resolved', 'archived', 'all'] as Filter[]).forEach((filter) => {
    const node = button(filter, () => {
      state.filter = filter;
      renderFilters();
      if (state.search) {
        void renderSearch(state.search);
      } else if (state.selectedSourceId) {
        void renderSource(state.selectedSourceId);
      }
    });
    node.dataset.selected = String(filter === state.filter);
    el.filters.append(node);
  });
}

async function renderSource(sourceId: string): Promise<void> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'questionsForSource', sourceId });
  const source = state.sources.find((entry) => entry.source.id === sourceId)?.source;
  el.content.replaceChildren();

  const head = document.createElement('div');
  head.className = 'row';
  head.append(text('h2', source?.title ?? 'Source'));
  if (source?.url) {
    const link = document.createElement('a');
    link.href = source.url;
    link.textContent = 'open source page';
    link.target = '_blank';
    link.rel = 'noopener';
    head.append(link);
  }
  head.append(
    button('Export as Markdown', async () => {
      const result = await send<DomainExportResponse>({ type: 'DOMAIN_EXPORT_MARKDOWN', sourceId });
      if (result?.ok) {
        downloadText(result.filename, result.markdown, 'text/markdown;charset=utf-8');
      }
    })
  );
  el.content.append(head);

  const entries = (response?.questions ?? []).filter(
    (entry) => state.filter === 'all' || entry.question.lifecycle === state.filter
  );
  if (!entries.length) {
    el.content.append(text('p', `No ${state.filter === 'all' ? '' : state.filter + ' '}questions for this source.`, 'empty'));
    return;
  }
  entries
    .sort((left, right) => right.question.updatedAt - left.question.updatedAt)
    .forEach((entry) => el.content.append(renderQuestionCard(entry)));
}

function renderQuestionCard(entry: QuestionListEntry): HTMLElement {
  const card = document.createElement('article');
  card.className = 'q';
  card.append(text('h3', entry.question.title));
  card.append(
    text(
      'small',
      `${entry.question.lifecycle} · ${captureSummary(entry)} · asked ${new Date(entry.question.createdAt).toLocaleString()}${
        entry.question.parentQuestionId ? ' · child question' : ''
      }`,
      'meta'
    )
  );
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.append(button('View', () => void renderBundle(entry.question.id)));
  const lifecycle = (type: 'ResolveQuestion' | 'ReopenQuestion' | 'ArchiveQuestion') => async () => {
    await send({ type: 'DOMAIN_COMMAND', command: { type, questionId: entry.question.id, baseRev: entry.question.rev } });
    await refresh();
  };
  if (entry.question.lifecycle === 'active') {
    actions.append(button('Resolve', lifecycle('ResolveQuestion')), button('Archive', lifecycle('ArchiveQuestion')));
  } else if (entry.question.lifecycle === 'resolved') {
    actions.append(button('Reopen', lifecycle('ReopenQuestion')), button('Archive', lifecycle('ArchiveQuestion')));
  } else {
    actions.append(button('Reopen', lifecycle('ReopenQuestion')));
  }
  actions.append(
    button('Rename', async () => {
      const next = window.prompt('Rename this question', entry.question.title);
      if (next?.trim()) {
        await send({
          type: 'DOMAIN_COMMAND',
          command: { type: 'RenameQuestion', questionId: entry.question.id, baseRev: entry.question.rev, title: next.trim() }
        });
        await refresh();
      }
    }),
    button('Delete', async () => {
      const subtree = window.confirm(
        'Delete this question from Aside? Provider history is not touched.\n\nOK = delete this question and keep any child questions.\nCancel = do nothing.'
      );
      if (!subtree) {
        return;
      }
      await send({
        type: 'DOMAIN_COMMAND',
        command: { type: 'DeleteQuestion', questionId: entry.question.id, descendants: 'reparent' }
      });
      await refresh();
    })
  );
  card.append(actions);
  return card;
}

async function renderBundle(questionId: string): Promise<void> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'bundle', questionId });
  const bundle = response?.bundle;
  el.content.replaceChildren();
  if (!bundle) {
    el.content.append(text('p', 'This question no longer exists.', 'empty'));
    return;
  }
  el.content.append(
    button('← back', () => {
      if (state.selectedSourceId) {
        void renderSource(state.selectedSourceId);
      } else {
        void loadSources();
      }
    })
  );
  el.content.append(text('h2', bundle.question.title));
  if (bundle.parent) {
    el.content.append(text('p', `Child of: ${bundle.parent.title}`, 'meta'));
  }
  el.content.append(text('p', `${bundle.question.lifecycle} · ${captureSummaryFromBundle(bundle)}`, 'meta'));

  if (bundle.anchor) {
    const passage = document.createElement('details');
    passage.open = true;
    passage.append(text('summary', 'Selected passage'));
    passage.append(text('pre', bundle.anchor.selectedText));
    el.content.append(passage);
  }

  const latestSnapshot = bundle.snapshots.at(-1);
  if (latestSnapshot) {
    const prompt = document.createElement('details');
    prompt.append(text('summary', `Exactly what was sent (${latestSnapshot.charCount.toLocaleString()} characters)`));
    prompt.append(text('pre', latestSnapshot.prompt));
    if (latestSnapshot.missing.length) {
      prompt.append(text('p', 'Known missing at submission:', 'warn'));
      const list = document.createElement('ul');
      latestSnapshot.missing.forEach((item) => list.append(text('li', item)));
      prompt.append(list);
    }
    el.content.append(prompt);
  } else if (bundle.draft?.text) {
    const draft = document.createElement('details');
    draft.open = true;
    draft.append(text('summary', 'Draft (not sent)'));
    draft.append(text('pre', bundle.draft.text));
    el.content.append(draft);
  }

  const thread = document.createElement('section');
  thread.append(text('h3', 'Saved thread'));
  if (!bundle.messages.length) {
    thread.append(
      text(
        'p',
        bundle.links.at(-1)?.conversationUrl
          ? 'No messages were captured for this question. The provider conversation link is the only record.'
          : 'Nothing has been sent for this question yet.',
        'empty'
      )
    );
  }
  bundle.messages.forEach((message) => {
    const node = text('div', message.text, 'msg');
    node.dataset.role = message.role;
    node.dataset.partial = String(message.partial);
    thread.append(node);
  });
  const link = bundle.links.at(-1);
  if (link?.conversationUrl) {
    const open = document.createElement('a');
    open.href = link.conversationUrl;
    open.textContent = 'Continue at the provider (opens the conversation)';
    open.target = '_blank';
    open.rel = 'noopener';
    thread.append(open);
  }
  el.content.append(thread);

  const notes = document.createElement('section');
  notes.append(text('h3', 'Notes'));
  bundle.notes.forEach((note) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(text('pre', note.text));
    row.append(
      button('Delete note', async () => {
        await send({ type: 'DOMAIN_COMMAND', command: { type: 'DeleteNote', noteId: note.id } });
        await renderBundle(questionId);
      })
    );
    notes.append(row);
  });
  const noteInput = document.createElement('textarea');
  noteInput.rows = 3;
  noteInput.placeholder = 'Save chosen text or your own note, with provenance';
  noteInput.style.width = '100%';
  notes.append(noteInput);
  notes.append(
    button('Save note', async () => {
      if (!noteInput.value.trim()) {
        return;
      }
      await send({
        type: 'DOMAIN_COMMAND',
        command: {
          type: 'SaveNote',
          note: {
            id: `note_${Math.random().toString(36).slice(2, 12)}`,
            questionId,
            sourceId: bundle.question.sourceId,
            text: noteInput.value.trim(),
            messageId: null
          }
        }
      });
      await renderBundle(questionId);
    }, 'primary')
  );
  el.content.append(notes);
}

function captureSummaryFromBundle(bundle: QuestionBundle): string {
  const link = bundle.links.at(-1);
  if (!link) {
    return bundle.draft?.text ? 'draft, not sent' : 'not sent';
  }
  if (link.capture === 'captured-through') {
    return `captured through message ${link.capturedThroughMessageId ?? '?'} — later remote changes are not guaranteed`;
  }
  if (link.capture === 'partial') {
    return 'partially captured';
  }
  return link.conversationUrl ? 'link only — transcript not captured' : link.run;
}

async function renderSearch(term: string): Promise<void> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'search', term });
  const hits: SearchHit[] = (response?.hits ?? []).filter(
    (hit) => state.filter === 'all' || hit.question.lifecycle === (state.filter as QuestionLifecycle)
  );
  el.content.replaceChildren(text('h2', `Search: ${term}`));
  if (!hits.length) {
    el.content.append(text('p', 'No matches.', 'empty'));
    return;
  }
  hits.forEach((hit) => {
    const card = document.createElement('article');
    card.className = 'q';
    card.append(text('h3', hit.question.title));
    card.append(text('small', `${hit.sourceTitle} · matched in ${hit.matchedIn} · ${hit.question.lifecycle}`, 'meta'));
    card.append(button('View', () => void renderBundle(hit.question.id)));
    el.content.append(card);
  });
}

async function renderAbout(): Promise<void> {
  const status = await query({ type: 'DOMAIN_QUERY', query: 'migrationStatus' });
  el.about.replaceChildren();
  el.about.append(text('span', `Aside build ${BUILD_ID}. `));
  if (!status) {
    el.about.append(text('span', 'Storage status unavailable.', 'warn'));
    return;
  }
  if (!status.storageHealthy) {
    el.about.append(text('span', 'Storage could not be opened; nothing was written or initialised. ', 'warn'));
  }
  const journal = status.journal;
  if (journal) {
    el.about.append(
      text(
        'span',
        `Legacy migration: ${journal.migrated.length} migrated, ${journal.tombstoned.length} deleted, ${journal.failed.length} failed` +
          (journal.skippedPrivate.length
            ? `, ${journal.skippedPrivate.length} private record(s) found on disk by an older build (left untouched, never staged)`
            : '') +
          (journal.completedAt ? '. Validated. ' : '. Not yet validated. ')
      )
    );
    if (journal.completedAt && !journal.cleanedUpAt) {
      el.about.append(
        button('Remove legacy copies', async () => {
          const ok = window.confirm(
            'Remove the migrated legacy records from extension storage? The new database is the only copy afterwards. Take a backup first if you want one.'
          );
          if (!ok) {
            return;
          }
          const result = await send<DomainLegacyCleanupResponse>({ type: 'DOMAIN_LEGACY_CLEANUP', confirm: true });
          window.alert(result?.ok ? `Removed ${result.removedKeys.length} legacy record(s).` : `Not removed: ${result?.reason ?? 'unknown'}`);
          await renderAbout();
        })
      );
    } else if (journal.cleanedUpAt) {
      el.about.append(text('span', `Legacy copies removed ${new Date(journal.cleanedUpAt).toLocaleString()}.`));
    }
  }
}

async function refresh(): Promise<void> {
  await loadSources();
  if (state.search) {
    await renderSearch(state.search);
  } else if (state.selectedSourceId) {
    await renderSource(state.selectedSourceId);
  }
}

el.search.addEventListener('input', () => {
  state.search = el.search.value.trim();
  if (state.search) {
    void renderSearch(state.search);
  } else if (state.selectedSourceId) {
    void renderSource(state.selectedSourceId);
  }
});

el.backup.addEventListener('click', async () => {
  const result = await send<DomainBackupResponse>({ type: 'DOMAIN_BACKUP' });
  if (!result?.ok) {
    window.alert(`Backup failed: ${result?.reason ?? 'unknown'}`);
    return;
  }
  const stamp = new Date(result.backup.exportedAt).toISOString().replace(/[:.]/g, '-');
  downloadText(`aside-backup-${stamp}.json`, JSON.stringify(result.backup, null, 2), 'application/json');
});

el.restoreButton.addEventListener('click', () => el.restore.click());
el.restore.addEventListener('change', async () => {
  const file = el.restore.files?.[0];
  if (!file) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    window.alert('That file is not valid JSON.');
    return;
  }
  const result = await send<DomainRestoreResponse>({ type: 'DOMAIN_RESTORE', backup: parsed });
  if (!result?.ok) {
    window.alert(`Restore refused: ${result?.reason ?? 'unknown'}\n${(result && 'problems' in result ? result.problems : [])?.join('\n') ?? ''}`);
  } else {
    const report = result.report;
    window.alert(
      `Restored. Imported: ${JSON.stringify(report.imported)}. Skipped older: ${report.skippedOlder.length}. Skipped deleted: ${report.skippedDeleted.length}.`
    );
  }
  el.restore.value = '';
  await refresh();
});

chrome.runtime.onMessage.addListener((message: QuestionChangedMessage | { type?: string }) => {
  if (message && message.type === 'QUESTION_CHANGED') {
    void refresh();
  }
  return false;
});

renderFilters();
void loadSources();
void renderAbout();
