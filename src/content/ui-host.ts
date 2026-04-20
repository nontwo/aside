export function ensureExtensionHostElement(
  ownerDocument: Document,
  hostId: string
): HTMLDivElement {
  const root = ownerDocument.documentElement;
  const existing = ownerDocument.getElementById(hostId);

  let host: HTMLDivElement;
  if (existing instanceof HTMLDivElement) {
    host = existing;
  } else {
    if (existing) {
      existing.remove();
    }
    host = ownerDocument.createElement('div');
    host.id = hostId;
  }

  if (!host.isConnected || host.parentElement !== root) {
    root.append(host);
  }

  return host;
}

export function attachElementToHost<T extends HTMLElement>(host: HTMLElement, element: T): T {
  if (!element.isConnected || element.parentElement !== host) {
    host.append(element);
  }

  return element;
}
