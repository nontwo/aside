import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  allOriginMatchPatterns,
  chatgptAdapter,
  claudeAdapter,
  findAdapterForUrl,
  findChatAdapterForUrl,
  getAdapter
} from '../src/shared/providers';
import { surfaceIsAvailable } from '../src/shared/providers/types';

describe('provider routing', () => {
  it('routes each chat origin to its own adapter', () => {
    expect(findAdapterForUrl('https://chatgpt.com/c/abc')?.id).toBe('chatgpt');
    expect(findAdapterForUrl('https://chat.openai.com/c/abc')?.id).toBe('chatgpt');
    expect(findAdapterForUrl('https://claude.ai/chat/abc')?.id).toBe('claude');
  });

  it('does not claim origins Aside is not permitted on', () => {
    // A subdomain or a lookalike must not be treated as a supported provider.
    expect(findAdapterForUrl('https://support.claude.com/en/articles/123')).toBeNull();
    expect(findAdapterForUrl('https://claude.ai.evil.example/chat/1')).toBeNull();
    expect(findAdapterForUrl('https://openai.com/chatgpt')).toBeNull();
    expect(findAdapterForUrl('not a url')).toBeNull();
  });

  it('keeps Aside off non-chat routes that share the origin', () => {
    expect(findChatAdapterForUrl('https://claude.ai/settings/profile')).toBeNull();
    expect(findChatAdapterForUrl('https://claude.ai/login')).toBeNull();
    expect(findChatAdapterForUrl('https://chatgpt.com/auth/login')).toBeNull();
    expect(findChatAdapterForUrl('https://chatgpt.com/pricing')).toBeNull();

    expect(findChatAdapterForUrl('https://claude.ai/new')?.id).toBe('claude');
    expect(findChatAdapterForUrl('https://chatgpt.com/')?.id).toBe('chatgpt');
  });

  it('exposes match patterns that match the shipped manifest', () => {
    expect(allOriginMatchPatterns().sort()).toEqual(
      ['https://chat.openai.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*'].sort()
    );
  });

  it('throws on an unknown provider id rather than silently defaulting', () => {
    expect(() => getAdapter('gemini' as never)).toThrow(/Unknown Aside provider/);
  });
});

describe('ChatGPT identity', () => {
  it('reads a conversation id and keeps the scope keyed to it', () => {
    const identity = chatgptAdapter.identify('https://chatgpt.com/c/conv-1?model=gpt-4', 'sess');
    expect(identity.conversationId).toBe('conv-1');
    expect(identity.conversationUrl).toBe('https://chatgpt.com/c/conv-1');
    expect(identity.scopeKey).toBe('chatgpt:c:conv-1');
    expect(identity.launchUrl).toBe('https://chatgpt.com/');
  });

  it('keeps a project scope separate and launches new chats inside it', () => {
    const identity = chatgptAdapter.identify('https://chatgpt.com/g/g-p-proj1/project', 'sess');
    expect(identity.containerId).toBe('g-p-proj1');
    expect(identity.containerUrl).toBe('https://chatgpt.com/g/g-p-proj1');
    expect(identity.launchUrl).toBe('https://chatgpt.com/g/g-p-proj1/project');
    expect(identity.scopeKey).toBe('chatgpt:project:g-p-proj1:sess');
  });

  it('gives pages with no conversation distinct scopes instead of one catch-all', () => {
    // The old code collapsed all of these into a single "chat-home" bucket.
    const home = chatgptAdapter.identify('https://chatgpt.com/', 'sess-a');
    const project = chatgptAdapter.identify('https://chatgpt.com/g/g-p-proj1/project', 'sess-a');
    const otherSession = chatgptAdapter.identify('https://chatgpt.com/', 'sess-b');

    expect(new Set([home.scopeKey, project.scopeKey, otherSession.scopeKey]).size).toBe(3);
  });

  it('treats the temporary-chat parameter as a hint, never as proof', () => {
    const temporary = chatgptAdapter.identify('https://chatgpt.com/?temporary-chat=true', 'sess');
    expect(temporary.urlPrivacyHint).toBe('private');

    // A persistent-looking URL is only a hint in the other direction.
    const saved = chatgptAdapter.identify('https://chatgpt.com/c/conv-1', 'sess');
    expect(saved.urlPrivacyHint).toBe('persistent');

    // And an ordinary new chat tells us nothing at all.
    expect(chatgptAdapter.identify('https://chatgpt.com/', 'sess').urlPrivacyHint).toBe('unknown');
  });

  it('recognises only its own conversation URLs', () => {
    expect(chatgptAdapter.isConversationUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(chatgptAdapter.isConversationUrl('https://chatgpt.com/')).toBe(false);
    // Claude's URL shape must not read as a ChatGPT conversation.
    expect(chatgptAdapter.isConversationUrl('https://claude.ai/chat/abc')).toBe(false);
  });
});

describe('Claude identity', () => {
  it('reads a chat id from Claude-shaped URLs, not the ChatGPT /c/ shape', () => {
    const identity = claudeAdapter.identify('https://claude.ai/chat/uuid-1?q=1', 'sess');
    expect(identity.conversationId).toBe('uuid-1');
    expect(identity.conversationUrl).toBe('https://claude.ai/chat/uuid-1');
    expect(identity.scopeKey).toBe('claude:chat:uuid-1');

    expect(claudeAdapter.isConversationUrl('https://claude.ai/c/uuid-1')).toBe(false);
    expect(claudeAdapter.isConversationUrl('https://claude.ai/chat/uuid-1')).toBe(true);
  });

  it('launches a new chat from /new, or from the project when inside one', () => {
    expect(claudeAdapter.identify('https://claude.ai/chat/uuid-1', 'sess').launchUrl).toBe(
      'https://claude.ai/new'
    );

    const project = claudeAdapter.identify('https://claude.ai/project/proj-1', 'sess');
    expect(project.containerId).toBe('proj-1');
    expect(project.launchUrl).toBe('https://claude.ai/project/proj-1');
    expect(project.scopeKey).toBe('claude:project:proj-1:sess');
  });

  it('never falls back to a ChatGPT URL from a Claude page', () => {
    const identity = claudeAdapter.identify('https://claude.ai/new', 'sess');
    expect(identity.launchUrl.startsWith('https://claude.ai/')).toBe(true);

    // Even an unparseable URL keeps the provider's own origin.
    const broken = claudeAdapter.identify('::::', 'sess');
    expect(broken.launchUrl).toBe('https://claude.ai/new');
    expect(broken.providerId).toBe('claude');
  });

  it('reports privacy as unknown from the URL alone', () => {
    // Claude has no documented incognito URL marker, so an addressable chat URL is
    // not evidence of persistence and its absence is not evidence of privacy.
    expect(claudeAdapter.identify('https://claude.ai/chat/uuid-1', 'sess').urlPrivacyHint).toBe(
      'unknown'
    );
    expect(claudeAdapter.identify('https://claude.ai/new', 'sess').urlPrivacyHint).toBe('unknown');
  });
});

describe('scope keys never collide across providers', () => {
  it('keeps a ChatGPT and a Claude conversation with the same id apart', () => {
    const chatgpt = chatgptAdapter.identify('https://chatgpt.com/c/same-id', 'sess');
    const claude = claudeAdapter.identify('https://claude.ai/chat/same-id', 'sess');

    expect(chatgpt.scopeKey).not.toBe(claude.scopeKey);
  });
});

describe('declared capabilities are explicit, not optimistic', () => {
  it('states Claude cannot be embedded and says why', () => {
    expect(claudeAdapter.surfaces.embedded).toBe('unsupported');
    expect(claudeAdapter.surfaces.detail).toMatch(/frame/i);
  });

  it('claims no surface as live-verified, because none has been run against a live account', () => {
    // `verified` is defined as "observed in the live DOM". Nothing in this build
    // observes a surface — the values are static — so claiming it would be an
    // unearned confidence level, which is the failure mode this test exists for.
    [chatgptAdapter, claudeAdapter].forEach((adapter) => {
      expect(adapter.surfaces.embedded).not.toBe('verified');
      expect(adapter.surfaces.nativeWindow).not.toBe('verified');
    });
  });

  it('still offers the surfaces it has fixture evidence for', () => {
    // Honesty about evidence must not turn into refusing to run: `fixture-only`
    // is offered, `unsupported` is not.
    expect(surfaceIsAvailable(claudeAdapter.surfaces.nativeWindow)).toBe(true);
    expect(surfaceIsAvailable(claudeAdapter.surfaces.embedded)).toBe(false);
    expect(surfaceIsAvailable(chatgptAdapter.surfaces.embedded)).toBe(true);
  });

  it('records that Claude Incognito leaves a project but ChatGPT Temporary Chat does not', () => {
    expect(claudeAdapter.privacy.leavesContainer).toBe(true);
    expect(chatgptAdapter.privacy.leavesContainer).toBe(false);
    expect(claudeAdapter.privacy.constraints.join(' ')).toMatch(/project/i);
    expect(chatgptAdapter.privacy.constraints.join(' ')).toMatch(/personaliz/i);
  });
});

describe('manifest stays in step with the provider registry', () => {
  it('requests exactly the origins the adapters claim, and no more', async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), 'public/manifest.json'), 'utf8')
    );

    const expected = allOriginMatchPatterns().sort();
    expect([...manifest.host_permissions].sort()).toEqual(expected);
    expect([...manifest.content_scripts[0].matches].sort()).toEqual(expected);

    // Broad permissions would let Aside inject into pages it has no business on.
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(JSON.stringify(manifest)).not.toMatch(/\*:\/\/\*/);
  });
});
