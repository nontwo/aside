import { beforeEach, describe, expect, it } from 'vitest';

import { chatgptAdapter, claudeAdapter } from '../src/shared/providers';
import { setActiveComposerAdapter } from '../src/shared/send-controls';
import {
  adviseRecovery,
  describePreparationStep,
  observePrivateMode,
  summarizeObservation,
  type ObserveOptions
} from '../src/runtime/private-mode';

/**
 * jsdom lays nothing out, so "rendered" is stubbed per element: anything marked
 * data-rendered gets a real box, everything else stays 0x0 — which is exactly the
 * shape a control inside a closed menu presents on the live page.
 */
function stubLayout(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('*').forEach((element) => {
    const rendered = element.hasAttribute('data-rendered');
    const rect = rendered
      ? ({ x: 10, y: 10, width: 120, height: 32, top: 10, left: 10, right: 130, bottom: 42, toJSON: () => ({}) } as DOMRect)
      : ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
    element.getBoundingClientRect = () => rect;
    element.getClientRects = () => (rendered ? ([rect] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
  });
}

function options(provider: 'chatgpt' | 'claude', html: string): ObserveOptions {
  const adapter = provider === 'chatgpt' ? chatgptAdapter : claudeAdapter;
  setActiveComposerAdapter(adapter.composer);
  document.body.innerHTML = html;
  stubLayout(document);
  return {
    document,
    composer: adapter.composer,
    transcript: adapter.transcript,
    composerElement: document.querySelector<HTMLElement>('textarea, [contenteditable="true"]'),
    label: adapter.privacy.label
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('private-mode observation', () => {
  it('reads an explicitly pressed control as private and ready', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea>
          <button data-rendered type="button" aria-label="Temporary chat" aria-pressed="true">Temporary</button>
        </form></main>`
      )
    );
    expect(observation.mode).toBe('private');
    expect(observation.step).toBe('ready');
    expect(observation.evidence).toBe('control-state');
  });

  it('offers to activate a rendered control that reports inactive', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea>
          <button data-rendered type="button" aria-label="Turn on temporary chat" aria-pressed="false">Temporary</button>
        </form></main>`
      )
    );
    expect(observation.step).toBe('activating-mode');
    expect(observation.nextAction).toBe('activate-control');
    expect(observation.actionTarget?.tagName).toBe('BUTTON');
  });

  it('treats a control hidden inside a closed menu as a step, not as unsupported', () => {
    // This is the live ChatGPT shape from the owner's log: the control exists,
    // is not disabled, and has a 0x0 box.
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea>
          <button data-rendered type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Tools">+</button>
          <div role="menu" data-state="closed">
            <button type="button" aria-label="Temporary chat">Temporary</button>
          </div>
        </form></main>`
      )
    );
    expect(observation.availability).toBe('not-observed-yet');
    expect(observation.availability).not.toBe('unavailable-in-this-context');
    expect(observation.nextAction).toBe('open-menu');
    expect(observation.actionTarget?.getAttribute('aria-label')).toBe('Tools');
    expect(observation.control?.inClosedMenu).toBe(true);
  });

  it('never lets a quoted passage or Aside-s own warning satisfy the detector', () => {
    const observation = observePrivateMode(
      options(
        'claude',
        `<main>
          <div class="font-claude-message" data-rendered><p data-rendered>Open an Incognito chat to keep it private.</p>
            <button data-rendered type="button" aria-label="Leave incognito chat" aria-pressed="true">quoted</button>
          </div>
          <form><div contenteditable="true" data-rendered class="ProseMirror"></div></form>
        </main>
        <div id="aside-root"><p data-rendered aria-label="Incognito chat">What Incognito chat does and does not do</p>
          <button data-rendered aria-label="Leave incognito chat" aria-pressed="true">aside</button></div>`
      )
    );
    expect(observation.mode).not.toBe('private');
    expect(observation.availability).toBe('unknown');
  });

  it('accepts the provider-s own active interface marker when the launch control is gone', () => {
    // Claude documents the active state as a black border plus an "Incognito chat"
    // label in the upper left; the ghost icon is no longer there once inside.
    const observation = observePrivateMode(
      options(
        'claude',
        `<header><span data-rendered aria-label="Incognito chat">Incognito chat</span></header>
         <main><form><div contenteditable="true" data-rendered class="ProseMirror"></div></form></main>`
      )
    );
    expect(observation.mode).toBe('private');
    expect(observation.evidence).toBe('interface-marker');
    expect(observation.step).toBe('ready');
  });

  it('reports a personalization chooser as awaiting the Owner-s choice, never choosing itself', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea></form></main>
         <div role="dialog" data-rendered>
           <p data-rendered>Temporary chat: Personalized or Unpersonalized?</p>
           <button data-rendered type="button">Personalized</button>
           <button data-rendered type="button">Unpersonalized</button>
         </div>`
      )
    );
    expect(observation.step).toBe('awaiting-choice');
    expect(observation.nextAction).toBe('choose-personalization');
    expect(observation.mode).toBe('unknown');
    const advice = adviseRecovery(observation, 'Temporary Chat');
    expect(advice.offerCheckAgain).toBe(true);
    expect(advice.offerOrdinaryMode).toBe(false);
  });

  it('marks a disabled control as unavailable in this context, and only then', () => {
    const observation = observePrivateMode(
      options(
        'claude',
        `<main><form><div contenteditable="true" data-rendered class="ProseMirror"></div>
          <button data-rendered type="button" aria-label="Start incognito chat" disabled>Incognito</button>
        </form></main>`
      )
    );
    expect(observation.availability).toBe('unavailable-in-this-context');
    expect(observation.step).toBe('blocked');
  });

  it('keeps unknown as unknown when nothing is observed', () => {
    const observation = observePrivateMode(
      options('claude', `<main><form><div contenteditable="true" data-rendered class="ProseMirror"></div></form></main>`)
    );
    expect(observation.availability).toBe('unknown');
    expect(observation.mode).toBe('unknown');
    expect(observation.nextAction).toBe('check-again');
    expect(adviseRecovery(observation, 'Incognito chat').offerShowTarget).toBe(true);
  });

  it('distinguishes a sign-in page from a missing control', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<form data-rendered><h1>Log in</h1><input type="email" /><input type="password" /><button>Continue</button></form>`
      )
    );
    expect(observation.step).toBe('awaiting-login');
    expect(observation.nextAction).toBe('sign-in');
  });

  it('a rendered control with no readable state asks to check again rather than assuming', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea>
          <button data-rendered type="button" aria-label="Temporary chat">Temporary</button>
        </form></main>`
      )
    );
    expect(observation.mode).toBe('unknown');
    expect(observation.step).toBe('verifying-mode');
    expect(observation.nextAction).toBe('check-again');
  });
});

describe('private-mode reporting', () => {
  it('summarizes an observation without the DOM reference and with the advice folded in', () => {
    const observation = observePrivateMode(
      options(
        'chatgpt',
        `<main><form><textarea data-rendered></textarea>
          <button data-rendered type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Tools">+</button>
          <div role="menu" data-state="closed"><button type="button" aria-label="Temporary chat">Temporary</button></div>
        </form></main>`
      )
    );
    expect(observation.actionTarget).not.toBeNull();
    const recovery = summarizeObservation(observation, 'Temporary Chat', 'build-1');
    expect('actionTarget' in recovery).toBe(false);
    expect(recovery).toMatchObject({
      step: 'locating-control',
      availability: 'not-observed-yet',
      nextAction: 'open-menu',
      evidence: 'control-hidden',
      offerCheckAgain: true,
      offerShowTarget: true,
      offerOrdinaryMode: true,
      buildId: 'build-1'
    });
    // Attributes only: the label is short and there is no page text.
    expect(recovery.control?.label.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(recovery)).not.toMatch(/textarea/);
  });

  it('gives each step a short status line', () => {
    expect(describePreparationStep({ step: 'locating-control', nextAction: 'open-menu', reason: '' }, 'Temporary Chat')).toMatch(
      /opening the menu/
    );
    expect(describePreparationStep({ step: 'activating-mode', nextAction: 'activate-control', reason: '' }, 'Incognito chat')).toBe(
      'Turning on Incognito chat…'
    );
    expect(describePreparationStep({ step: 'ready', nextAction: 'none', reason: '' }, 'Incognito chat')).toMatch(/verified/);
    expect(
      describePreparationStep({ step: 'awaiting-choice', nextAction: 'choose-personalization', reason: 'Choose.' }, 'x')
    ).toBe('Choose.');
  });
});
