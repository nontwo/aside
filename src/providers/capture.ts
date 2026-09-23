/**
 * Reading the branch conversation back, honestly.
 *
 * Runs in the branch page (embedded frame or driven window) and turns what is
 * visibly exposed into CapturedMessage records. Completion is decided from
 * evidence — a stop control still present, a streaming marker on the turn, text
 * that changed since the last read — never from a timeout. "Captured through
 * message N" means exactly that: nothing later is promised.
 */

import type { CapturedMessage, ChatRole } from '../shared/types';
import { fnv1a } from '../domain/ids';

export interface ObservedTurn {
  role: ChatRole;
  /** Structure-preserving text. */
  text: string;
  /** Provider message id when the page exposes one. */
  providerMessageId: string | null;
  /** True when the turn's own markup says it is still streaming. */
  streaming: boolean;
}

export interface CaptureEvidence {
  /** A provider stop/cancel control is visible. */
  stopControlVisible: boolean;
  /** Text of the last assistant turn changed since the previous read. */
  lastAssistantChanged: boolean;
}

export interface CaptureSnapshot {
  messages: CapturedMessage[];
  capture: 'partial' | 'captured-through';
  capturedThroughMessageId: string | null;
  /** A stable fingerprint of the exposed text, to detect change between reads. */
  fingerprint: string;
}

/** Messages after the submitted prompt: the prompt is the first user turn. */
export function snapshotTranscript(
  turns: ObservedTurn[],
  evidence: CaptureEvidence,
  options: { firstUserTurnIndex: number } = { firstUserTurnIndex: 0 }
): CaptureSnapshot {
  const relevant = turns.slice(options.firstUserTurnIndex);
  const generating = evidence.stopControlVisible || evidence.lastAssistantChanged || relevant.some((turn) => turn.streaming);

  const messages: CapturedMessage[] = relevant.map((turn, index) => {
    const isLast = index === relevant.length - 1;
    const partial = turn.streaming || (isLast && turn.role === 'assistant' && generating);
    return {
      role: turn.role,
      text: turn.text,
      partial,
      providerMessageId: turn.providerMessageId ?? `synthetic:${index}:${fnv1a(turn.text.slice(0, 240))}`,
      ordinal: index
    };
  });

  const lastComplete = [...messages].reverse().find((message) => !message.partial && message.role === 'assistant');
  const anyPartial = messages.some((message) => message.partial);

  return {
    messages,
    capture: anyPartial || !lastComplete ? 'partial' : 'captured-through',
    capturedThroughMessageId: anyPartial ? null : lastComplete?.providerMessageId ?? null,
    // The fingerprint includes completion state: a message that settles from
    // partial to complete without its text changing is a change worth emitting.
    fingerprint: fnv1a(
      messages.map((message) => `${message.role}:${message.partial ? 'p' : 'c'}:${message.text}`).join('\u0000')
    )
  };
}

export interface CaptureWatcherOptions {
  read: () => ObservedTurn[];
  stopControlVisible: () => boolean;
  emit: (snapshot: CaptureSnapshot) => void;
  observeTarget: () => Node | null;
  /** Fallback poll interval, bounded: the observer is the primary signal. */
  pollMs?: number;
  /** Stop after this many consecutive stable reads once nothing is generating. */
  stableReadsToStop?: number;
  /** Hard ceiling so a page that never settles cannot keep a timer alive forever. */
  maxLifetimeMs?: number;
}

/**
 * Event-driven observation with bounded fallback polling. Emits only when the
 * exposed text changed, and stops itself once the conversation is stable and
 * nothing is generating.
 */
export class TranscriptCaptureWatcher {
  private observer: MutationObserver | null = null;
  private timer: number | undefined;
  private lastFingerprint = '';
  private lastAssistantText = '';
  private stableReads = 0;
  private startedAt = 0;
  private stopped = false;
  private firstUserTurnIndex = 0;

  constructor(private readonly options: CaptureWatcherOptions) {}

  start(firstUserTurnIndex: number): void {
    this.firstUserTurnIndex = firstUserTurnIndex;
    this.startedAt = Date.now();
    this.stopped = false;
    const target = this.options.observeTarget();
    if (target && typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(() => this.tick());
      this.observer.observe(target, { childList: true, subtree: true, characterData: true });
    }
    this.timer = window.setInterval(() => this.tick(), this.options.pollMs ?? 1_500);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One read. Public so a caller can force a final read before tearing down. */
  tick(): void {
    if (this.stopped) {
      return;
    }
    const turns = this.options.read();
    const lastAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant')?.text ?? '';
    const evidence: CaptureEvidence = {
      stopControlVisible: this.options.stopControlVisible(),
      lastAssistantChanged: lastAssistant !== this.lastAssistantText
    };
    this.lastAssistantText = lastAssistant;

    const snapshot = snapshotTranscript(turns, evidence, { firstUserTurnIndex: this.firstUserTurnIndex });
    if (snapshot.fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = snapshot.fingerprint;
      this.stableReads = 0;
      this.options.emit(snapshot);
    } else if (!evidence.stopControlVisible && !evidence.lastAssistantChanged) {
      this.stableReads += 1;
      if (this.stableReads === 1 && snapshot.capture === 'partial' && snapshot.messages.length) {
        // A second identical read with no generating evidence: the last message is
        // complete as far as the page shows. Re-emit with that decided.
        const settled = snapshotTranscript(turns, { stopControlVisible: false, lastAssistantChanged: false }, { firstUserTurnIndex: this.firstUserTurnIndex });
        if (settled.capture === 'captured-through') {
          this.lastFingerprint = settled.fingerprint;
          this.options.emit(settled);
        }
      }
    }

    const lifetime = this.options.maxLifetimeMs ?? 30 * 60 * 1_000;
    const enough = this.options.stableReadsToStop ?? 20;
    if (this.stableReads >= enough || Date.now() - this.startedAt > lifetime) {
      this.stop();
    }
  }
}
