/**
 * The source-scoped question list: "questions on this page".
 *
 * Aside-owned DOM only. It renders records from the question database and hands
 * every action back to the caller; it never writes storage itself and never
 * touches provider elements. Close/Minimize of a view do not appear here because
 * they are not question actions — the retention actions are.
 */

import type { QuestionListEntry } from '../storage/repository';

export interface QuestionListCallbacks {
  open: (questionId: string) => void;
  resolve: (entry: QuestionListEntry) => void;
  reopen: (entry: QuestionListEntry) => void;
  archive: (entry: QuestionListEntry) => void;
  rename: (entry: QuestionListEntry, title: string) => void;
  remove: (entry: QuestionListEntry) => void;
  exportSource: (sourceId: string) => void;
  openLibrary: () => void;
}

export type ListFilter = 'active' | 'resolved' | 'archived' | 'all';

function captureLabel(entry: QuestionListEntry): string {
  const link = entry.latestLink;
  if (!link) {
    return entry.draft?.text ? 'draft' : 'not sent';
  }
  if (link.run === 'failed') {
    return 'failed';
  }
  if (link.run === 'submission-unknown') {
    return 'sent? unknown';
  }
  switch (link.capture) {
    case 'captured-through':
      return `captured · ${entry.messageCount} msg`;
    case 'partial':
      return `partial · ${entry.messageCount} msg`;
    default:
      return link.conversationUrl ? 'link only' : link.run;
  }
}

export function renderQuestionList(
  container: HTMLElement,
  entries: QuestionListEntry[],
  sourceId: string | null,
  filter: ListFilter,
  callbacks: QuestionListCallbacks,
  onFilterChange: (filter: ListFilter) => void
): void {
  container.replaceChildren();

  const header = document.createElement('div');
  header.className = 'aside-qlist-header';
  const title = document.createElement('strong');
  const visible = entries.filter((entry) => filter === 'all' || entry.question.lifecycle === filter);
  title.textContent = `Questions on this page (${visible.length})`;
  header.append(title);

  const filters = document.createElement('div');
  filters.className = 'aside-qlist-filters';
  (['active', 'resolved', 'archived', 'all'] as ListFilter[]).forEach((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = value;
    button.dataset.selected = String(value === filter);
    button.addEventListener('click', () => onFilterChange(value));
    filters.append(button);
  });
  header.append(filters);
  container.append(header);

  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'aside-qlist-empty';
    empty.textContent =
      filter === 'active' ? 'No active questions here. Select a passage and press Ask.' : `No ${filter} questions here.`;
    container.append(empty);
  }

  visible
    .sort((left, right) => right.question.updatedAt - left.question.updatedAt)
    .forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'aside-qlist-row';
      row.dataset.questionId = entry.question.id;
      row.dataset.lifecycle = entry.question.lifecycle;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'aside-qlist-open';
      open.textContent = entry.question.title;
      open.title = 'Open this question';
      open.addEventListener('click', () => callbacks.open(entry.question.id));

      const meta = document.createElement('small');
      meta.className = 'aside-qlist-meta';
      meta.textContent = `${entry.question.lifecycle} · ${captureLabel(entry)}${
        entry.question.parentQuestionId ? ' · child question' : ''
      }`;

      const actions = document.createElement('div');
      actions.className = 'aside-qlist-actions';

      const action = (label: string, handler: () => void, titleText?: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (titleText) {
          button.title = titleText;
        }
        button.addEventListener('click', handler);
        actions.append(button);
      };

      if (entry.question.lifecycle === 'active') {
        action('Resolve', () => callbacks.resolve(entry), 'You consider this answered; the record is kept.');
        action('Archive', () => callbacks.archive(entry), 'Hide from the active list; still searchable.');
      } else if (entry.question.lifecycle === 'resolved') {
        action('Reopen', () => callbacks.reopen(entry));
        action('Archive', () => callbacks.archive(entry));
      } else {
        action('Reopen', () => callbacks.reopen(entry));
      }
      action('Rename', () => {
        const next = window.prompt('Rename this question', entry.question.title);
        if (next && next.trim() && next.trim() !== entry.question.title) {
          callbacks.rename(entry, next.trim());
        }
      });
      action(
        'Delete',
        () => {
          const confirmed = window.confirm(
            'Delete this question and its saved messages from Aside? This does not delete anything at the provider. Child questions are kept.'
          );
          if (confirmed) {
            callbacks.remove(entry);
          }
        },
        'Removes the local record only. Provider history is untouched.'
      );

      row.append(open, meta, actions);
      container.append(row);
    });

  const footer = document.createElement('div');
  footer.className = 'aside-qlist-footer';
  if (sourceId) {
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Export this page as Markdown';
    exportButton.addEventListener('click', () => callbacks.exportSource(sourceId));
    footer.append(exportButton);
  }
  const library = document.createElement('button');
  library.type = 'button';
  library.textContent = 'Open library';
  library.title = 'All sources and questions, with search and backup.';
  library.addEventListener('click', () => callbacks.openLibrary());
  footer.append(library);
  container.append(footer);
}
