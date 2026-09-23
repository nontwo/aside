import { describe, expect, it } from 'vitest';

import { snapshotTranscript, type ObservedTurn } from '../src/providers/capture';

function turn(role: 'user' | 'assistant', text: string, extra: Partial<ObservedTurn> = {}): ObservedTurn {
  return { role, text, providerMessageId: null, streaming: false, ...extra };
}

describe('transcript capture honesty', () => {
  it('marks the last assistant turn partial while a stop control is visible', () => {
    const snapshot = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Hel')],
      { stopControlVisible: true, lastAssistantChanged: true }
    );
    expect(snapshot.capture).toBe('partial');
    expect(snapshot.messages[1].partial).toBe(true);
    expect(snapshot.capturedThroughMessageId).toBeNull();
  });

  it('marks a turn partial from its own streaming marker even with no stop control', () => {
    const snapshot = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Thinking…', { streaming: true })],
      { stopControlVisible: false, lastAssistantChanged: false }
    );
    expect(snapshot.capture).toBe('partial');
  });

  it('reports captured-through only when nothing is generating and text is stable', () => {
    const snapshot = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Hello world.', { providerMessageId: 'pm-1' })],
      { stopControlVisible: false, lastAssistantChanged: false }
    );
    expect(snapshot.capture).toBe('captured-through');
    expect(snapshot.capturedThroughMessageId).toBe('pm-1');
    expect(snapshot.messages[1].partial).toBe(false);
  });

  it('a timeout is not evidence: unchanged text with a stop control still counts as partial', () => {
    const snapshot = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Hello')],
      { stopControlVisible: true, lastAssistantChanged: false }
    );
    expect(snapshot.capture).toBe('partial');
  });

  it('appends a follow-up as new ordinals without merging unrelated messages', () => {
    const snapshot = snapshotTranscript(
      [
        turn('user', 'PROMPT'),
        turn('assistant', 'First answer.', { providerMessageId: 'a1' }),
        turn('user', 'Follow-up?'),
        turn('assistant', 'Second answer.', { providerMessageId: 'a2' })
      ],
      { stopControlVisible: false, lastAssistantChanged: false }
    );
    expect(snapshot.messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3]);
    expect(snapshot.capturedThroughMessageId).toBe('a2');
  });

  it('gives a regenerated alternative a different identity than the answer it replaced', () => {
    const before = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Answer A.')],
      { stopControlVisible: false, lastAssistantChanged: false }
    );
    const after = snapshotTranscript(
      [turn('user', 'PROMPT'), turn('assistant', 'Answer B, regenerated.')],
      { stopControlVisible: false, lastAssistantChanged: false }
    );
    expect(before.messages[1].providerMessageId).not.toBe(after.messages[1].providerMessageId);
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it('starts from the submitted prompt, ignoring turns that were already on the page', () => {
    const snapshot = snapshotTranscript(
      [turn('user', 'older'), turn('assistant', 'older answer'), turn('user', 'PROMPT'), turn('assistant', 'new')],
      { stopControlVisible: false, lastAssistantChanged: false },
      { firstUserTurnIndex: 2 }
    );
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].text).toBe('PROMPT');
  });
});
