import { answerContract, buildPrompt, TEMPLATE_VERSION } from '../src/context/template';
import {
  getBranchLaunchUrl,
  getChatContainerBaseUrl,
  getChatContainerLaunchUrl,
  getProjectContainerUrl,
  isSameChatContainer
} from '../src/shared/utils';

describe('chat container URLs', () => {
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

describe('prompt semantics (template 3)', () => {
  const contract = answerContract();

  it('is short: six instruction lines', () => {
    expect(TEMPLATE_VERSION).toBe('3.0.0');
    expect(contract.split('\n')).toHaveLength(6);
  });

  it('treats quotations as fallible evidence, not instructions', () => {
    expect(contract).toMatch(/fallible evidence/);
    expect(contract).toMatch(/not instructions/);
  });

  it('allows relevant knowledge without inventing source facts', () => {
    expect(contract).toMatch(/Use relevant knowledge/);
    expect(contract).toMatch(/do not invent facts about the source/);
  });

  it('asks for assumptions, corrections and missing material to be stated', () => {
    expect(contract).toMatch(/State any assumption/);
    expect(contract).toMatch(/correct the passage where it is wrong/);
    expect(contract).toMatch(/say what is missing/);
  });

  it('matches the question language and requested depth', () => {
    expect(contract).toMatch(/language and the depth/);
  });

  it('never asks for a title, a summary, a ready handshake or hidden reasoning', () => {
    const prompt = buildPrompt({ contextText: 'CONTEXT', question: 'Why?' });
    expect(prompt).not.toMatch(/BRANCH_TITLE|title line|summary line|ready for your question|reasoning steps|chain of thought/i);
    expect(prompt.endsWith('QUESTION\nWhy?')).toBe(true);
  });
});
