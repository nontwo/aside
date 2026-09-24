/**
 * Content-side access to the question database, through the worker.
 *
 * Every call is a message; the worker owns the database. A null return means the
 * runtime was unreachable (extension reloaded, page detached) and the caller must
 * show unsaved/recovery state rather than assume success.
 */

import type { DomainCommand, CommandOutcome } from '../domain/commands';
import type {
  DomainCommandResponse,
  DomainExportResponse,
  DomainQueryMessage,
  DomainQueryResponse
} from '../storage/protocol';
import type { QuestionBundle, QuestionListEntry } from '../storage/repository';

async function send<T>(message: unknown): Promise<T | null> {
  try {
    if (!chrome?.runtime?.id) {
      return null;
    }
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}

export async function runCommand(command: DomainCommand): Promise<CommandOutcome | null> {
  const response = await send<DomainCommandResponse>({ type: 'DOMAIN_COMMAND', command });
  if (!response) {
    return null;
  }
  if (!response.ok) {
    return { status: 'error', reason: response.reason };
  }
  return response.outcome;
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

export async function listQuestionsForScope(
  scopeKey: string
): Promise<{ sourceId: string | null; questions: QuestionListEntry[] } | null> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'questionsForScope', scopeKey });
  return response ? { sourceId: response.sourceId, questions: response.questions } : null;
}

export async function fetchBundle(questionId: string): Promise<QuestionBundle | null> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'bundle', questionId });
  return response?.bundle ?? null;
}

export async function fetchBuildId(): Promise<string | null> {
  const response = await query({ type: 'DOMAIN_QUERY', query: 'buildInfo' });
  return response?.buildId ?? null;
}

export async function exportSourceMarkdown(sourceId: string): Promise<{ markdown: string; filename: string } | null> {
  const response = await send<DomainExportResponse>({ type: 'DOMAIN_EXPORT_MARKDOWN', sourceId });
  return response?.ok ? { markdown: response.markdown, filename: response.filename } : null;
}
