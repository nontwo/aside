/**
 * Stable local identities.
 *
 * None of these depend on array order, DOM position, tab ids or labels. Content
 * hashes are FNV-1a over the structured text so identical material captured twice
 * shares one block record.
 */

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newQuestionId(): string {
  return `q_${randomSuffix()}`;
}

export function newSnapshotId(): string {
  return `snap_${randomSuffix()}`;
}

export function newMessageId(): string {
  return `m_${randomSuffix()}`;
}

export function newLinkId(): string {
  return `link_${randomSuffix()}`;
}

export function newNoteId(): string {
  return `note_${randomSuffix()}`;
}

export function newAnchorId(): string {
  return `a_${randomSuffix()}`;
}

/**
 * A source id is derived from provider + scope so two tabs on the same
 * conversation resolve to one source. Pages without a conversation id (a fresh
 * "new chat") get a random id and are aliased later when the id appears.
 */
export function sourceIdFor(providerId: string, scopeKey: string): string {
  return `src_${providerId}_${fnv1a(scopeKey)}`;
}

export function blockIdFor(sourceId: string, contentHash: string): string {
  return `blk_${sourceId}_${contentHash}`;
}
