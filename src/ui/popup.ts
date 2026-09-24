/**
 * The toolbar popup: the ACTIVE scratch handoffs, reachable while the Owner is
 * looking at the native chat. Separate from the library on purpose — this is not
 * a history; a handoff shows here only while it exists.
 *
 * Everything is an explicit click. The popup opens, focuses, copies or ends; it
 * never types into a provider page.
 */

import { BUILD_ID } from '../shared/build-info';
import { preparePrompt } from '../handoff/prompt';
import { routeFor } from '../handoff/routes';
import type { AnchorResult, HandoffRequest, HandoffResponse, ScratchHandoff } from '../handoff/types';

async function send(message: HandoffRequest): Promise<HandoffResponse | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as HandoffResponse;
  } catch {
    return null;
  }
}

function text(tag: string, value: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) {
    node.className = className;
  }
  return node;
}

function button(label: string, role: string, primary = false): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.dataset.asideRole = role;
  if (primary) {
    node.className = 'primary';
  }
  return node;
}

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function anchorText(anchor: AnchorResult | undefined): string {
  switch (anchor) {
    case 'exact':
      return 'Back at the passage.';
    case 'message-only':
      return 'Back at the source; the passage has changed, so its message is shown.';
    case 'ambiguous':
      return 'Back at the source; the passage appears more than once, so Aside did not pick one.';
    case 'different-conversation':
      return 'The source tab now shows a different conversation.';
    case 'source-closed':
      return 'The source tab was closed.';
    default:
      return 'Back at the source; the passage was not found on the page.';
  }
}

function targetText(session: ScratchHandoff): string {
  const label = routeFor(session.providerId).label;
  const target = session.target;
  if (target.state === 'open') {
    return target.ownership === 'owned'
      ? `${label} ${target.kind === 'tab' ? 'tab' : 'window'} open for this question.`
      : `${label} tab open, but it has moved on; Aside will not close it.`;
  }
  if (target.state === 'opening') {
    return `${label} is opening.`;
  }
  return `No ${label} page opened yet.`;
}

function renderSession(session: ScratchHandoff, container: HTMLElement): void {
  const route = routeFor(session.providerId);
  const card = document.createElement('div');
  card.className = 'session';
  card.dataset.sessionId = session.sessionId;

  const question = session.draft.question.trim() || session.selection.structuredSelectedText || session.selection.selectedText;
  card.append(
    text('p', clip(question, 140)),
    text('p', `${route.label} · ${session.entry === 'why' ? 'Why' : session.entry === 'new_tab' ? 'New tab' : 'Ask'} · temporary handoff`, 'meta')
  );
  const status = text('p', `${targetText(session)}${session.source.open ? '' : ' The source tab was closed.'}`, 'status');
  card.append(status);

  const actions = document.createElement('div');
  actions.className = 'row';
  const back = button('Return to source', 'popup-return');
  back.disabled = !session.source.open;
  const open = button(session.target.state === 'open' ? `Continue in ${route.label}` : `Open ${route.label}`, 'popup-open', true);
  const copy = button('Copy prompt', 'popup-copy');
  const end = button('End & discard…', 'popup-end');
  actions.append(back, open, copy, end);
  card.append(actions);

  const confirm = document.createElement('div');
  confirm.className = 'confirm';
  confirm.hidden = true;
  const closes = session.target.state === 'open' && session.target.ownership === 'owned';
  confirm.append(
    text(
      'p',
      `This clears the question and its prompt from Aside.${
        closes
          ? ` It also closes the ${route.label} tab Aside opened; that temporary conversation cannot be reopened.`
          : session.target.state === 'open'
            ? ` The ${route.label} tab stays open.`
            : ''
      } What you copied stays on the clipboard until you copy something else.`
    )
  );
  const confirmRow = document.createElement('div');
  confirmRow.className = 'row';
  const confirmEnd = button('End & discard', 'popup-end-confirm', true);
  const keep = button('Keep', 'popup-end-keep');
  confirmRow.append(confirmEnd, keep);
  confirm.append(confirmRow);
  card.append(confirm);

  back.addEventListener('click', async () => {
    const response = await send({ type: 'HANDOFF_RETURN', buildId: BUILD_ID, sessionId: session.sessionId });
    status.textContent = response ? anchorText(response.anchor) : 'Aside could not reach its worker.';
  });
  open.addEventListener('click', async () => {
    const response = await send({
      type: 'HANDOFF_OPEN',
      buildId: BUILD_ID,
      sessionId: session.sessionId,
      kind: session.target.kind,
      focusOnly: session.target.state === 'open'
    });
    if (response?.code === 'target-closed') {
      status.textContent = `That ${route.label} tab was closed; its temporary conversation cannot be reopened.`;
    } else if (!response?.ok) {
      status.textContent = `${route.label} could not be opened.`;
    }
  });
  copy.addEventListener('click', async () => {
    const prompt = preparePrompt(session.selection, session.draft, session.copied);
    try {
      await navigator.clipboard.writeText(prompt.text);
      status.textContent = 'Copied: the prepared prompt is on the clipboard. Nothing has been sent.';
      await send({
        type: 'HANDOFF_COPIED',
        buildId: BUILD_ID,
        sessionId: session.sessionId,
        ok: true,
        code: 'ok',
        prompt
      });
    } catch {
      status.textContent = 'Not copied: the browser did not allow clipboard access here. Copy it from the card on the source page.';
    }
  });
  end.addEventListener('click', () => {
    confirm.hidden = false;
  });
  keep.addEventListener('click', () => {
    confirm.hidden = true;
  });
  confirmEnd.addEventListener('click', async () => {
    const response = await send({
      type: 'HANDOFF_END',
      buildId: BUILD_ID,
      sessionId: session.sessionId,
      closeTarget: closes
    });
    card.replaceChildren(
      text(
        'p',
        !response
          ? 'Aside could not reach its worker.'
          : closes && !response.targetClosed
            ? `Local material cleared; the ${route.label} tab is still open.`
            : 'Cleared from Aside.',
        'status'
      )
    );
  });

  container.append(card);
}

async function render(): Promise<void> {
  const container = document.getElementById('sessions') as HTMLElement;
  const buildEl = document.getElementById('build') as HTMLElement;
  const response = await send({ type: 'HANDOFF_LIST_ACTIVE', buildId: BUILD_ID });
  buildEl.textContent = `Aside build ${BUILD_ID}${response && response.buildId !== BUILD_ID ? ` · worker ${response.buildId}` : ''}`;
  container.replaceChildren();
  const sessions = response?.sessions ?? [];
  if (!sessions.length) {
    container.append(
      text('p', 'No temporary handoffs are active. Select text in a ChatGPT or Claude answer and choose Ask or Why.', 'empty')
    );
    return;
  }
  sessions
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .forEach((session) => renderSession(session, container));
}

document.getElementById('open-library')?.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'OPEN_LIBRARY' }).finally(() => window.close());
});

void render();
