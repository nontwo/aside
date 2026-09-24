/**
 * The explicit "Save local note" from a scratch handoff, as ONE storage
 * command: the source, the passage anchor, the question and the Owner's note
 * are created in a single transaction, or nothing is.
 *
 * What is saved is what the preview shows: the passage (with the few words
 * around it that let Aside find it again), the question, and the Owner's own
 * note. No source turns, no prepared prompt, no provider link — the native
 * temporary conversation is not saved, converted or made resumable by this.
 * An excerpt the Owner pasted is labelled as theirs, never as a capture.
 */

import type { CreateQuestionCommand } from '../domain/commands';
import { autoTitle } from '../domain/commands';
import { fnv1a, newAnchorId, newNoteId, newQuestionId, sourceIdFor } from '../domain/ids';
import type { ScratchHandoff } from './types';

export const PASTED_EXCERPT_HEADING = 'Answer excerpt you pasted (added by you; not an automatic capture)';

export interface SaveNoteInput {
  note: string;
  excerpt: string;
  title: string;
}

export interface SaveNoteIds {
  questionId: string;
  anchorId: string;
  noteId: string;
}

export function freshSaveNoteIds(): SaveNoteIds {
  return { questionId: newQuestionId(), anchorId: newAnchorId(), noteId: newNoteId() };
}

/** The note text exactly as it will be stored. */
export function composeNoteText(note: string, excerpt: string): string {
  const parts: string[] = [];
  if (note.trim()) {
    parts.push(note.trim());
  }
  if (excerpt.trim()) {
    parts.push(`${PASTED_EXCERPT_HEADING}:\n${excerpt.trim()}`);
  }
  return parts.join('\n\n');
}

export function buildSaveNoteCommand(
  session: ScratchHandoff,
  input: SaveNoteInput,
  identity: { conversationId: string | null; containerId: string | null },
  ids: SaveNoteIds
): CreateQuestionCommand {
  const selection = session.selection;
  const sourceId = sourceIdFor(session.providerId, session.source.scopeKey);
  const focus = selection.structuredSelectedText || selection.selectedText;
  const anchorBlock =
    selection.selectedBlocks.find((block) => block.messageId === selection.branchBaseMessageId) ??
    selection.selectedBlocks[0];
  const question = session.draft.question.trim();
  return {
    type: 'CreateQuestion',
    source: {
      id: sourceId,
      providerId: session.providerId,
      scopeKey: session.source.scopeKey,
      conversationId: identity.conversationId,
      containerId: identity.containerId,
      url: selection.rootChatUrl,
      // Recorded when the question was created, so a later navigation of the
      // tab cannot put another conversation's title on this passage.
      title: session.source.title.trim().slice(0, 120) || (session.providerId === 'claude' ? 'Claude conversation' : 'ChatGPT conversation'),
      kind: 'assistant-answer',
      acquisition: 'selected-fragment',
      messageId: anchorBlock?.messageId ?? null
    },
    // Only the passage, via the anchor. Whole source turns are not saved.
    blocks: [],
    anchor: {
      id: ids.anchorId,
      sourceId,
      selectedText: focus,
      exact: selection.rangeQuotes.exact || selection.selectedText,
      prefix: selection.rangeQuotes.prefix,
      suffix: selection.rangeQuotes.suffix,
      messageId: anchorBlock?.messageId ?? selection.branchBaseMessageId,
      turnIndex: anchorBlock?.turnIndex ?? 0,
      role: anchorBlock?.role ?? 'assistant',
      contentHash: fnv1a(focus),
      scrollHint: selection.fallbackScrollY
    },
    question: {
      id: ids.questionId,
      sourceId,
      anchorId: ids.anchorId,
      parentQuestionId: null,
      parentMessageId: null,
      title: input.title.trim().slice(0, 200) || autoTitle(question, focus),
      titleSource: input.title.trim() ? 'user' : 'auto',
      retention: 'durable',
      providerMode: 'native-handoff',
      entryAction: session.entry
    },
    draft: { text: question, excludedBlockIds: [], background: '' },
    note: { id: ids.noteId, text: composeNoteText(input.note, input.excerpt) },
    // An existing saved source keeps its title; a note never renames it.
    keepExistingSourceTitle: true
  };
}
