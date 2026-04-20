import { DEFAULT_BRANCH_TITLE } from './constants';
import type {
  BranchDraft,
  BranchMessage,
  BranchRecord,
  BranchRunState,
  ExtensionState,
  OriginAnchor,
  RootConversationState,
  SelectionPayload
} from './types';
import { clipText, randomId } from './utils';

export function ensureConversation(
  state: ExtensionState,
  rootConversationId: string,
  rootChatUrl: string
): RootConversationState {
  const existing = state.conversations[rootConversationId];

  if (existing) {
    existing.rootChatUrl = rootChatUrl;
    return existing;
  }

  const created: RootConversationState = {
    rootConversationId,
    rootChatUrl,
    branchIds: [],
    activeBranchId: null
  };
  state.conversations[rootConversationId] = created;
  return created;
}

export function setTabConversation(
  state: ExtensionState,
  tabId: number,
  rootConversationId: string,
  rootChatUrl: string
): void {
  ensureConversation(state, rootConversationId, rootChatUrl);
  state.tabConversations[String(tabId)] = {
    rootConversationId,
    rootChatUrl
  };
}

export function createDraft(selection: SelectionPayload): BranchDraft {
  return {
    draftId: randomId('draft'),
    selection,
    createdAt: Date.now()
  };
}

export function setConversationDraft(state: ExtensionState, selection: SelectionPayload): BranchDraft {
  const conversation = ensureConversation(state, selection.rootConversationId, selection.rootChatUrl);
  const draft = createDraft(selection);
  conversation.draft = draft;
  return draft;
}

export function clearConversationDraft(state: ExtensionState, rootConversationId: string): void {
  const conversation = state.conversations[rootConversationId];
  if (!conversation) {
    return;
  }

  delete conversation.draft;
}

function createOriginAnchor(selection: SelectionPayload): OriginAnchor {
  return {
    rootConversationId: selection.rootConversationId,
    rootChatUrl: selection.rootChatUrl,
    selectedText: selection.selectedText,
    selectedBlocks: selection.selectedBlocks,
    rangeQuotes: selection.rangeQuotes,
    fallbackScrollY: selection.fallbackScrollY
  };
}

export function createBranchRecord(selection: SelectionPayload, initialQuestion: string): BranchRecord {
  const createdAt = Date.now();
  const branchId = randomId('branch');
  const focusPreview = clipText(selection.selectedText, 260);
  const userMessage: BranchMessage = {
    id: randomId('msg'),
    role: 'user',
    displayText: initialQuestion,
    streamState: 'done',
    source: 'visible',
    createdAt
  };
  const assistantPlaceholder: BranchMessage = {
    id: randomId('msg'),
    role: 'assistant',
    displayText: '',
    streamState: 'pending',
    source: 'visible',
    createdAt: createdAt + 1
  };

  return {
    branchId,
    rootConversationId: selection.rootConversationId,
    mode: 'local',
    title: DEFAULT_BRANCH_TITLE,
    titleStatus: 'pending',
    focusPreview,
    originAnchor: createOriginAnchor(selection),
    messages: [userMessage, assistantPlaceholder],
    runState: 'queued',
    minimized: false,
    createdAt,
    updatedAt: createdAt
  };
}

export function addBranchToConversation(state: ExtensionState, branch: BranchRecord): void {
  state.branches[branch.branchId] = branch;
  const conversation = ensureConversation(
    state,
    branch.rootConversationId,
    branch.originAnchor.rootChatUrl
  );

  if (!conversation.branchIds.includes(branch.branchId)) {
    conversation.branchIds.push(branch.branchId);
  }

  conversation.activeBranchId = branch.branchId;
}

export function setActiveBranch(
  state: ExtensionState,
  rootConversationId: string,
  branchId: string
): void {
  const conversation = state.conversations[rootConversationId];
  if (!conversation || !conversation.branchIds.includes(branchId)) {
    return;
  }

  conversation.activeBranchId = branchId;
  Object.values(state.branches).forEach((branch) => {
    if (branch.branchId === branchId) {
      branch.minimized = false;
    }
  });
}

export function updateBranch(
  state: ExtensionState,
  branchId: string,
  updates: Partial<BranchRecord>
): BranchRecord | undefined {
  const branch = state.branches[branchId];
  if (!branch) {
    return undefined;
  }

  Object.assign(branch, updates, { updatedAt: Date.now() });
  return branch;
}

export function setBranchRunState(
  state: ExtensionState,
  branchId: string,
  runState: BranchRunState,
  extras?: Partial<BranchRecord>
): BranchRecord | undefined {
  return updateBranch(state, branchId, {
    runState,
    ...extras
  });
}

export function appendBranchMessage(
  state: ExtensionState,
  branchId: string,
  message: BranchMessage
): BranchRecord | undefined {
  const branch = state.branches[branchId];
  if (!branch) {
    return undefined;
  }

  branch.messages.push(message);
  branch.updatedAt = Date.now();
  return branch;
}

export function appendVisibleUserMessage(
  state: ExtensionState,
  branchId: string,
  question: string
): BranchRecord | undefined {
  const branch = state.branches[branchId];
  if (!branch) {
    return undefined;
  }

  branch.messages.push({
    id: randomId('msg'),
    role: 'user',
    displayText: question,
    streamState: 'done',
    source: 'visible',
    createdAt: Date.now()
  });
  branch.messages.push({
    id: randomId('msg'),
    role: 'assistant',
    displayText: '',
    streamState: 'pending',
    source: 'visible',
    createdAt: Date.now() + 1
  });
  branch.updatedAt = Date.now();
  return branch;
}

export function upsertAssistantSnapshot(
  state: ExtensionState,
  branchId: string,
  cleanText: string
): BranchRecord | undefined {
  const branch = state.branches[branchId];
  if (!branch) {
    return undefined;
  }

  const assistant = [...branch.messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant) {
    return undefined;
  }

  assistant.displayText = cleanText;
  assistant.streamState = 'streaming';
  branch.updatedAt = Date.now();
  return branch;
}

export function finalizeAssistantMessage(
  state: ExtensionState,
  branchId: string,
  cleanText: string
): BranchRecord | undefined {
  const branch = state.branches[branchId];
  if (!branch) {
    return undefined;
  }

  const assistant = [...branch.messages].reverse().find((message) => message.role === 'assistant');
  if (!assistant) {
    return undefined;
  }

  assistant.displayText = cleanText;
  assistant.streamState = 'done';
  branch.updatedAt = Date.now();
  return branch;
}
