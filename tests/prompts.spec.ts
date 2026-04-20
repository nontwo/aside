import {
  buildLocalInitialPrompt,
  buildNativeBootstrapPrompt,
  stripHiddenTitle
} from '../src/shared/prompts';
import type { SelectionPayload } from '../src/shared/types';
import {
  getBranchLaunchUrl,
  getChatContainerBaseUrl,
  getChatContainerLaunchUrl,
  getProjectContainerUrl,
  isSameChatContainer
} from '../src/shared/utils';

function makeSelection(): SelectionPayload {
  return {
    rootConversationId: 'conv-1',
    rootChatUrl: 'https://chatgpt.com/c/conv-1',
    selectedText: 'convexity assumption guarantees the relaxation stays tight',
    selectedBlocks: [
      {
        messageId: 'assistant-7',
        role: 'assistant',
        turnIndex: 7,
        text: 'The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.',
        excerpt: 'convexity assumption guarantees'
      }
    ],
    branchBaseMessageId: 'assistant-7',
    rangeQuotes: {
      exact: 'convexity assumption guarantees the relaxation stays tight',
      prefix: 'The ',
      suffix: ' and keeps'
    },
    fallbackScrollY: 420
  };
}

describe('prompt builders', () => {
  it('builds a local-only prompt from selected passage and touched assistant answer', () => {
    const selection = makeSelection();
    const localPrompt = buildLocalInitialPrompt(selection, 'Why does this matter?');

    expect(localPrompt.prompt).toContain('Use only the local context below');
    expect(localPrompt.prompt).toContain('SELECTED PASSAGE');
    expect(localPrompt.prompt).toContain(selection.selectedText);
    expect(localPrompt.prompt).toContain('LOCAL SOURCE ANSWER 1');
    expect(localPrompt.prompt).toContain(selection.selectedBlocks[0].text);
    expect(localPrompt.prompt).toContain('Why does this matter?');
    expect(localPrompt.prompt).not.toContain('full conversation history');
    expect(localPrompt.prompt).not.toContain('native branch');
  });

  it('does not include non-assistant selected blocks as source answers', () => {
    const selection = makeSelection();
    selection.selectedBlocks.push({
      messageId: 'user-8',
      role: 'user',
      turnIndex: 8,
      text: 'This user turn should not be copied into the local source answer.',
      excerpt: 'This user turn should not be copied'
    });

    const localPrompt = buildLocalInitialPrompt(selection, 'Explain locally.');

    expect(localPrompt.prompt).toContain(selection.selectedBlocks[0].text);
    expect(localPrompt.prompt).not.toContain('This user turn should not be copied');
  });

  it('builds a native bootstrap prompt that only stages the branch', () => {
    const selection = makeSelection();
    const bootstrapPrompt = buildNativeBootstrapPrompt(selection);

    expect(bootstrapPrompt.prompt).toContain('Ready for your question.');
    expect(bootstrapPrompt.prompt).toContain('BRANCH TASK');
    expect(bootstrapPrompt.prompt).toContain(selection.selectedText);
    expect(bootstrapPrompt.prompt).toContain(selection.selectedBlocks[0].text);
    expect(bootstrapPrompt.prompt).not.toContain('USER QUESTION');
    expect(bootstrapPrompt.prompt).not.toContain('full conversation history');
  });

  it('removes the hidden title envelope from assistant text', () => {
    const parsed = stripHiddenTitle('[[BRANCH_TITLE: why convexity matters]]\nThis is the answer.');

    expect(parsed.title).toBe('why convexity matters');
    expect(parsed.cleanText).toBe('This is the answer.');
  });

  it('removes leading reasoning status before the hidden title envelope', () => {
    const parsed = stripHiddenTitle(
      '已思考 6s\n[[BRANCH_TITLE: 人民币亏损换算日元]]\n按当前大致汇率计算。'
    );

    expect(parsed.title).toBe('人民币亏损换算日元');
    expect(parsed.cleanText).toBe('按当前大致汇率计算。');
  });

  it('preserves the chat container path for project or custom-gpt chats', () => {
    expect(
      getChatContainerBaseUrl(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/69d3e806-5684-8327-828e-0df17a79b8e6'
      )
    ).toBe('https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash');

    expect(getChatContainerBaseUrl('https://chatgpt.com/c/abc123')).toBe('https://chatgpt.com/');
  });

  it('builds the correct launch url for project-contained chats', () => {
    expect(
      getChatContainerLaunchUrl(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/69d3e806-5684-8327-828e-0df17a79b8e6'
      )
    ).toBe('https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/project');

    expect(getChatContainerLaunchUrl('https://chatgpt.com/c/abc123')).toBe('https://chatgpt.com/');
  });

  it('uses persistent launch urls without temporary chats', () => {
    expect(
      getBranchLaunchUrl(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/69d3e806-5684-8327-828e-0df17a79b8e6'
      )
    ).toBe('https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/project');

    expect(getBranchLaunchUrl('https://chatgpt.com/c/abc123')).toBe('https://chatgpt.com/');
  });

  it('extracts project container urls only when the source chat is inside a project container', () => {
    expect(
      getProjectContainerUrl(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/69d3e806-5684-8327-828e-0df17a79b8e6'
      )
    ).toBe('https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash');

    expect(getProjectContainerUrl('https://chatgpt.com/c/abc123')).toBeUndefined();
  });

  it('compares container identity rather than conversation ids', () => {
    expect(
      isSameChatContainer(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/source',
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/branch'
      )
    ).toBe(true);

    expect(
      isSameChatContainer(
        'https://chatgpt.com/g/g-p-69c6a4b232148191aa5b3f399b5d340a-quick-trash/c/source',
        'https://chatgpt.com/c/branch'
      )
    ).toBe(false);
  });
});
