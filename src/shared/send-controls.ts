import { compactWhitespace } from './utils';

export type TemporaryChatState = 'active' | 'inactive' | 'unknown';

export interface SendCandidateProfile {
  label: string;
  explicitSend: boolean;
  negative: boolean;
  temporaryChat: boolean;
  submitLike: boolean;
  sameForm: boolean;
}

export function getActionLabel(element: HTMLElement): string {
  return compactWhitespace(
    [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-testid'),
      element.innerText,
      element.textContent
    ]
      .filter(Boolean)
      .join(' ')
  );
}

export function hasExplicitSendSemantics(candidate: HTMLElement): boolean {
  const label = getActionLabel(candidate).toLowerCase();
  return (
    candidate.getAttribute('data-testid') === 'send-button' ||
    /(?:^|[\s_-])(send|submit)(?:$|[\s_-])|发送|提交/.test(label)
  );
}

export function hasNegativeSendSemantics(candidate: HTMLElement): boolean {
  const label = getActionLabel(candidate).toLowerCase();
  return /group|voice|audio|upload|attach|search|share|sidebar|project|model|temporary\s*chat|群聊|语音|听写|上传|附件|搜索|分享|边栏|项目|模型|临时聊天/.test(
    label
  );
}

export function isTemporaryChatControl(candidate: HTMLElement): boolean {
  return /temporary\s*chat|临时聊天/.test(getActionLabel(candidate).toLowerCase());
}

export function isSubmitLikeControl(candidate: HTMLElement): boolean {
  if (candidate.getAttribute('data-testid') === 'send-button') {
    return true;
  }

  if (candidate instanceof HTMLButtonElement) {
    return candidate.type === 'submit';
  }

  if (candidate instanceof HTMLInputElement) {
    return candidate.type === 'submit' || candidate.type === 'image';
  }

  return false;
}

export function inferTemporaryChatState(candidate: HTMLElement): TemporaryChatState {
  const label = getActionLabel(candidate).toLowerCase();
  const ariaPressed = candidate.getAttribute('aria-pressed');
  const ariaChecked = candidate.getAttribute('aria-checked');
  const stateHints = compactWhitespace(
    [
      candidate.getAttribute('data-state'),
      candidate.getAttribute('data-status'),
      candidate.getAttribute('data-selected'),
      candidate.getAttribute('data-active'),
      candidate.getAttribute('aria-current'),
      candidate.getAttribute('class')
    ]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  if (
    ariaPressed === 'true' ||
    ariaChecked === 'true' ||
    /\b(active|checked|selected|enabled|on|open)\b/.test(stateHints)
  ) {
    return 'active';
  }

  if (
    ariaPressed === 'false' ||
    ariaChecked === 'false' ||
    /\b(inactive|unchecked|unselected|disabled|off|closed)\b/.test(stateHints)
  ) {
    return 'inactive';
  }

  if (
    /开启临时聊天|启用临时聊天|开始临时聊天|temporary chat off|turn on temporary chat|start temporary chat|enable temporary chat/.test(
      label
    )
  ) {
    return 'inactive';
  }

  if (
    /关闭临时聊天|退出临时聊天|结束临时聊天|停止临时聊天|temporary chat on|turn off temporary chat|disable temporary chat|exit temporary chat|leave temporary chat/.test(
      label
    )
  ) {
    return 'active';
  }

  return 'unknown';
}

export function getSendCandidateProfile(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): SendCandidateProfile {
  const sameForm = Boolean(composer?.closest('form') && candidate.closest('form') === composer.closest('form'));

  return {
    label: getActionLabel(candidate),
    explicitSend: hasExplicitSendSemantics(candidate),
    negative: hasNegativeSendSemantics(candidate),
    temporaryChat: isTemporaryChatControl(candidate),
    submitLike: isSubmitLikeControl(candidate),
    sameForm
  };
}

export function isAcceptableSendControl(profile: SendCandidateProfile): boolean {
  if (profile.negative || profile.temporaryChat) {
    return false;
  }

  return profile.explicitSend || profile.submitLike;
}
