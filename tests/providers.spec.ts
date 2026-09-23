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
import { surfaceIsAvailable, surfaceMayBeAttempted } from '../src/shared/providers/types';

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
  it('explains what happens to a Claude branch, without claiming the surface works', () => {
    expect(claudeAdapter.surfaces.detail).toMatch(/frame/i);
    expect(surfaceIsAvailable(claudeAdapter.surfaces.embedded)).toBe(false);
  });

  it('claims no surface as live-verified', () => {
    // `verified` means the adapter positively observes the capability in the live
    // DOM. The runtime observation does that per session; the static declaration
    // must not claim it for every account in advance.
    [chatgptAdapter, claudeAdapter].forEach((adapter) => {
      expect(adapter.surfaces.embedded).not.toBe('verified');
      expect(adapter.surfaces.nativeWindow).not.toBe('verified');
    });
  });

  it('still offers the surfaces it has fixture evidence for', () => {
    // Honesty about evidence must not turn into refusing to run: `fixture-only`
    // is offered, `unverified` is not *claimed*.
    expect(surfaceIsAvailable(claudeAdapter.surfaces.nativeWindow)).toBe(true);
    expect(surfaceIsAvailable(claudeAdapter.surfaces.embedded)).toBe(false);
    expect(surfaceIsAvailable(chatgptAdapter.surfaces.embedded)).toBe(true);
  });

  it('separates what may be attempted from what may be claimed', () => {
    // The defect this exists for: Claude's embedded surface was marked
    // unsupported on an unchecked assumption, and because the same flag gated the
    // attempt, nothing could ever check it.
    expect(surfaceMayBeAttempted('unverified')).toBe(true);
    expect(surfaceIsAvailable('unverified')).toBe(false);
  });

  it('records that the Claude panel frame has been observed to load', () => {
    // A live run logged frameRefused:false at claude.ai/new. Not 'verified':
    // one account is not every account, and a refusal still falls back.
    expect(claudeAdapter.surfaces.embedded).toBe('fixture-only');
    expect(surfaceMayBeAttempted(claudeAdapter.surfaces.embedded)).toBe(true);
  });

  it('stops attempting a surface once it has been observed to fail', () => {
    expect(surfaceMayBeAttempted('fixture-only', 'refused')).toBe(false);
    expect(surfaceMayBeAttempted('unverified', 'worked')).toBe(true);
  });

  it('never attempts a surface declared unsupported, whatever was observed', () => {
    // An observation must not be able to grant a surface a provider does not have.
    expect(surfaceMayBeAttempted('unsupported', 'unknown')).toBe(false);
    expect(surfaceMayBeAttempted('unsupported', 'refused')).toBe(false);
  });

  it('no longer states as fact that claude.ai refuses to be framed', () => {
    // It sends X-Frame-Options: SAMEORIGIN and no frame-ancestors directive, and
    // Aside's frame is a same-origin child of the claude.ai page.
    expect(claudeAdapter.surfaces.detail).not.toMatch(/refuses to be embedded/i);
    expect(claudeAdapter.surfaces.detail).toMatch(/falls back/i);
  });

  it('records that private mode leaves a project on both providers', () => {
    // ChatGPT was `false` here on an assumption. A live run launched a Temporary
    // branch at a project route and found the Temporary Chat control present but
    // unrendered — a 0x0 box — which is what "not offered here" looks like from
    // the DOM. Both providers now say what they do with the project.
    expect(claudeAdapter.privacy.leavesContainer).toBe(true);
    expect(chatgptAdapter.privacy.leavesContainer).toBe(true);
    expect(claudeAdapter.privacy.constraints.join(' ')).toMatch(/project/i);
    expect(chatgptAdapter.privacy.constraints.join(' ')).toMatch(/project/i);
    expect(chatgptAdapter.privacy.constraints.join(' ')).toMatch(/personaliz/i);
  });

  it('offers a container-free launch url for a private branch', () => {
    // The root cause of the live refusal: a private branch launched at the
    // project route, where the provider does not offer its private mode at all.
    const inProject = chatgptAdapter.identify(
      'https://chatgpt.com/g/g-p-abc/c/conv-1',
      'sess'
    );
    expect(inProject.containerId).toBeTruthy();
    expect(inProject.launchUrl).toMatch(/\/project$/);
    expect(inProject.rootLaunchUrl).toBe('https://chatgpt.com/');

    const claudeProject = claudeAdapter.identify('https://claude.ai/project/p-1', 'sess');
    expect(claudeProject.rootLaunchUrl).toBe('https://claude.ai/new');
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
