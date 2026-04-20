import { attachElementToHost, ensureExtensionHostElement } from '../src/content/ui-host';

describe('content host mounting helpers', () => {
  it('creates the extension host under document.documentElement', () => {
    const host = ensureExtensionHostElement(document, 'aside-root');

    expect(host.id).toBe('aside-root');
    expect(host.parentElement).toBe(document.documentElement);
    expect(document.body.contains(host)).toBe(false);
  });

  it('moves an existing host back under document.documentElement', () => {
    const existingHost = document.createElement('div');
    existingHost.id = 'aside-root';

    document.body.append(existingHost);

    const host = ensureExtensionHostElement(document, 'aside-root');
    expect(host.isConnected).toBe(true);
    expect(host.id).toBe('aside-root');
    expect(host.parentElement).toBe(document.documentElement);
  });

  it('moves mounted UI nodes under the extension host', () => {
    const host = ensureExtensionHostElement(document, 'aside-root');
    const panel = document.createElement('div');
    panel.id = 'panel';
    document.body.append(panel);

    const attached = attachElementToHost(host, panel);

    expect(attached).toBe(panel);
    expect(panel.parentElement).toBe(host);
  });

  it('reattaches disconnected nodes back into the host', () => {
    const host = ensureExtensionHostElement(document, 'aside-root');
    const toolbar = document.createElement('div');
    toolbar.id = 'toolbar';
    host.append(toolbar);
    toolbar.remove();

    const attached = attachElementToHost(host, toolbar);

    expect(attached).toBe(toolbar);
    expect(toolbar.parentElement).toBe(host);
    expect(toolbar.isConnected).toBe(true);
  });
});
