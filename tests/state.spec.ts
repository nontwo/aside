import {
  addBranchToConversation,
  appendVisibleUserMessage,
  createBranchRecord,
  finalizeAssistantMessage,
  setConversationDraft,
  upsertAssistantSnapshot
} from '../src/shared/state';
import { createInitialState } from '../src/shared/storage';
import type { SelectionPayload } from '../src/shared/types';

function makeSelection(): SelectionPayload {
  return {
    rootConversationId: 'conv-2',
    rootChatUrl: 'https://chatgpt.com/c/conv-2',
    selectedText: 'selected theorem explanation',
    selectedBlocks: [
      {
        messageId: 'assistant:1:abc',
        role: 'assistant',
        turnIndex: 1,
        text: 'selected theorem explanation in context',
        excerpt: 'selected theorem explanation'
      }
    ],
    branchBaseMessageId: 'assistant:1:abc',
    rangeQuotes: {
      exact: 'selected theorem explanation',
      prefix: 'the ',
      suffix: ' in context'
    },
    fallbackScrollY: 128
  };
}

describe('branch state helpers', () => {
  it('stores a draft and branch under the root conversation', () => {
    const state = createInitialState();
    const selection = makeSelection();
    setConversationDraft(state, selection);

    expect(state.conversations['conv-2']?.draft?.selection.selectedText).toBe(selection.selectedText);

    const branch = createBranchRecord(selection, 'What does this theorem mean?');
    addBranchToConversation(state, branch);

    expect(state.conversations['conv-2']?.branchIds).toContain(branch.branchId);
    expect(state.conversations['conv-2']?.activeBranchId).toBe(branch.branchId);
  });

  it('updates the visible assistant transcript as streaming progresses', () => {
    const state = createInitialState();
    const branch = createBranchRecord(makeSelection(), 'What does this theorem mean?');
    addBranchToConversation(state, branch);

    upsertAssistantSnapshot(state, branch.branchId, 'Partial answer');
    expect(state.branches[branch.branchId].messages.at(-1)?.displayText).toBe('Partial answer');

    finalizeAssistantMessage(state, branch.branchId, 'Final answer');
    expect(state.branches[branch.branchId].messages.at(-1)?.displayText).toBe('Final answer');

    appendVisibleUserMessage(state, branch.branchId, 'Second question');
    expect(state.branches[branch.branchId].messages.at(-2)?.role).toBe('user');
    expect(state.branches[branch.branchId].messages.at(-1)?.role).toBe('assistant');
  });
});
