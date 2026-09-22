import {
  getSendCandidateProfile,
  inferTemporaryChatState,
  isAcceptableSendControl
} from '../src/shared/send-controls';

describe('embedded send control helpers', () => {
  it('rejects temporary and accessory controls even when they are submit buttons', () => {
    document.body.innerHTML = `
      <form>
        <textarea id="prompt-textarea"></textarea>
        <button id="temporary" type="submit" aria-label="开启临时聊天">开启临时聊天</button>
        <button id="group" type="submit" aria-label="开始群聊">开始群聊</button>
      </form>
    `;

    const composer = document.getElementById('prompt-textarea') as HTMLTextAreaElement;
    const temporary = document.getElementById('temporary') as HTMLButtonElement;
    const group = document.getElementById('group') as HTMLButtonElement;

    expect(isAcceptableSendControl(getSendCandidateProfile(temporary, composer))).toBe(false);
    expect(isAcceptableSendControl(getSendCandidateProfile(group, composer))).toBe(false);
  });

  it('accepts an unlabeled same-form submit icon after negative controls are filtered out', () => {
    document.body.innerHTML = `
      <form id="composer-form">
        <textarea id="prompt-textarea"></textarea>
        <button id="temporary" type="submit" aria-label="开启临时聊天">开启临时聊天</button>
        <button id="send" type="submit"><svg aria-hidden="true"></svg></button>
      </form>
    `;

    const composer = document.getElementById('prompt-textarea') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    const sendProfile = getSendCandidateProfile(send, composer);

    expect(sendProfile.sameForm).toBe(true);
    expect(sendProfile.submitLike).toBe(true);
    expect(sendProfile.explicitSend).toBe(false);
    expect(isAcceptableSendControl(sendProfile)).toBe(true);
  });

  it('infers temporary chat state from label and aria-pressed state', () => {
    document.body.innerHTML = `
      <button id="inactive" aria-label="开启临时聊天" aria-pressed="false">开启临时聊天</button>
      <button id="active" aria-label="关闭临时聊天" aria-pressed="true">关闭临时聊天</button>
    `;

    const inactive = document.getElementById('inactive') as HTMLButtonElement;
    const active = document.getElementById('active') as HTMLButtonElement;

    expect(inferTemporaryChatState(inactive)).toBe('inactive');
    expect(inferTemporaryChatState(active)).toBe('active');
  });
});

describe('temporary chat state inference', () => {
  function makeToggle(attributes: Record<string, string>, text = ''): HTMLElement {
    const button = document.createElement('button');
    Object.entries(attributes).forEach(([name, value]) => button.setAttribute(name, value));
    button.textContent = text;
    return button;
  }

  it('does not read Tailwind variant classes as toggle state', () => {
    // The regression: `open:`/`enabled:` variants used to match the state word list and
    // report temporary chat as ON while it was OFF.
    const toggle = makeToggle(
      {
        'aria-label': '开启临时聊天',
        class: 'open:bg-white enabled:hover:bg-token-main-surface group-open:rotate-180'
      },
      '开启临时聊天'
    );

    expect(inferTemporaryChatState(toggle)).toBe('inactive');
  });

  it('trusts explicit aria state above everything else', () => {
    expect(inferTemporaryChatState(makeToggle({ 'aria-pressed': 'true' }, 'Temporary chat'))).toBe(
      'active'
    );
    expect(inferTemporaryChatState(makeToggle({ 'aria-checked': 'false' }, 'Temporary chat'))).toBe(
      'inactive'
    );
  });

  it('reads the label when no aria state is exposed', () => {
    expect(
      inferTemporaryChatState(makeToggle({ 'aria-label': 'Turn off temporary chat' }))
    ).toBe('active');
    expect(
      inferTemporaryChatState(makeToggle({ 'aria-label': 'Turn on temporary chat' }))
    ).toBe('inactive');
  });

  it('stays unknown rather than guessing from an ambiguous control', () => {
    expect(
      inferTemporaryChatState(makeToggle({ 'aria-label': 'Temporary chat', class: 'rounded-lg' }))
    ).toBe('unknown');
  });
});
