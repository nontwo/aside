import { beforeEach, describe, expect, it } from 'vitest';

import { claudeAdapter } from '../src/shared/providers';
import {
  countTranscriptTurns,
  extractTranscript,
  getRecentAssistantTexts,
  setActiveTranscriptAdapter
} from '../src/shared/dom';

/**
 * Sanitized Claude fixtures, matching the shapes the offline smoke harness serves.
 * These are candidate shapes, not a capture of a live account; their job is to keep
 * the adapter's selectors valid and self-consistent.
 */
const CURRENT_CHAT = `
  <main>
    <div data-testid="user-message"><p>Tell me about convexity.</p></div>
    <div class="font-claude-message"><div class="standard-markdown">
      <p>The convexity assumption keeps the relaxation tight.</p>
    </div></div>
  </main>
`;

const LEGACY_CHAT = `
  <main>
    <div data-testid="user-message"><p>Tell me about convexity.</p></div>
    <div data-testid="assistant-message"><div class="standard-markdown">
      <p>The convexity assumption keeps the relaxation tight.</p>
    </div></div>
  </main>
`;

const STREAMING_CHAT = `
  <main>
    <div data-testid="user-message"><p>Tell me about convexity.</p></div>
    <div data-is-streaming="true"><div class="standard-markdown"><p>Thinking…</p></div></div>
  </main>
`;

describe('Claude selectors are valid CSS', () => {
  // An invalid selector throws inside querySelectorAll and takes the whole
  // reading of the page with it, so every candidate is exercised here.
  const groups: Array<[string, string[]]> = [
    ['native toolbar', claudeAdapter.layout.nativeSelectionToolbarSelectors],
    ['reserved', claudeAdapter.layout.reservedRegionSelectors.map((entry) => entry.selector)],
    ['transcript', [claudeAdapter.transcript.messageSelector]],
    ['content', claudeAdapter.transcript.contentSelectors],
    ['structured', [claudeAdapter.transcript.structuredContentSelector]],
    ['non-content', [claudeAdapter.transcript.nonContentSelector]]
  ];

  groups.forEach(([name, selectors]) => {
    it(`${name} selectors all parse`, () => {
      selectors.forEach((selector) => {
        expect(() => document.querySelectorAll(selector), `invalid selector: ${selector}`).not.toThrow();
      });
    });
  });
});

describe('Claude transcript reading', () => {
  beforeEach(() => {
    setActiveTranscriptAdapter(claudeAdapter.transcript);
  });

  it('reads the current interface shape', () => {
    document.body.innerHTML = CURRENT_CHAT;
    const turns = extractTranscript(document);

    expect(countTranscriptTurns(document)).toBe(2);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(getRecentAssistantTexts(1, document)[0]).toContain('convexity assumption');
  });

  it('reads the previous interface shape', () => {
    document.body.innerHTML = LEGACY_CHAT;
    const turns = extractTranscript(document);

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
  });

  it('treats a streaming turn as an assistant turn with status text', () => {
    document.body.innerHTML = STREAMING_CHAT;
    const turns = extractTranscript(document);

    expect(turns.at(-1)?.role).toBe('assistant');
    expect(claudeAdapter.transcript.isStatusText('Thinking…')).toBe(true);
    expect(claudeAdapter.transcript.isStatusText('The convexity assumption keeps it tight.')).toBe(
      false
    );
  });
});
