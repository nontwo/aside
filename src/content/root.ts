import {
  ASK_BUTTON_ID,
  WHY_BUTTON_ID,
  NEW_TAB_BUTTON_ID,
  SELECTION_TOOLBAR_ID,
  DEFAULT_BRANCH_TITLE,
  HIGHLIGHT_OVERLAY_ID,
  LEGACY_LAST_BRANCH_KIND_STORAGE_KEY,
  LEGACY_PANEL_STORAGE_PREFIX,
  ROOT_STYLE_ID,
  LAST_BRANCH_KIND_STORAGE_KEY
} from '../shared/constants';
import {
  buildSelectionPayloadFromDraft,
  captureSelectionDraftFromRange,
  extractTranscript,
  findQuotedTextRangeInElement,
  findTurnElementByAnchor
} from '../shared/dom';
import type { SelectionDraft } from '../shared/dom';
import {
  buildLocalInitialPrompt,
  buildNativeBootstrapPrompt,
  stripHiddenTitle
} from '../shared/prompts';
import { attachElementToHost, ensureExtensionHostElement } from './ui-host';
import {
  getActionLabel,
  getSendCandidateProfile,
  inferTemporaryChatState,
  isAcceptableSendControl,
  isTemporaryChatControl
} from '../shared/send-controls';
import type {
  BranchCreationMode,
  BranchEntryAction,
  BranchKind,
  BranchPanelEvent,
  BranchPanelState,
  BranchPanelStatus,
  CreateBranchWindowResponse,
  FocusBranchWindowResponse,
  ForwardBranchPanelEventMessage,
  RunBranchPromptInTabMessage,
  SelectionPayload
} from '../shared/types';
import {
  clipText,
  compactWhitespace,
  getBranchLaunchUrl,
  getChatContainerBaseUrl,
  getRootConversationId,
  normalizeChatUrl,
  randomId,
  sleep
} from '../shared/utils';

interface PanelRuntime {
  state: BranchPanelState;
  element: HTMLDivElement;
  titleEl: HTMLElement;
  statusEl: HTMLElement;
  errorEl: HTMLElement;
  focusTextEl: HTMLElement;
  formEl: HTMLFormElement;
  branchKindField: HTMLDivElement;
  persistentKindButton: HTMLButtonElement;
  temporaryKindButton: HTMLButtonElement;
  questionInput: HTMLTextAreaElement;
  submitButton: HTMLButtonElement;
  iframeShell: HTMLDivElement;
  iframeEl: HTMLIFrameElement;
  iframeOverlay: HTMLDivElement;
  iframeOverlayTitle: HTMLParagraphElement;
  iframeOverlayText: HTMLParagraphElement;
  debugLogShell: HTMLDivElement;
  debugLogTextarea: HTMLTextAreaElement;
  copyLogButton: HTMLButtonElement;
  openTabHeaderButton: HTMLButtonElement;
  pendingFramePrompt?: string;
  frameReady: boolean;
  frameStartSent: boolean;
}

type AutomationTransport = 'frame' | 'background';

type ThemeMode = 'light' | 'dark';

interface FrameStartBranchMessage {
  source: 'aside';
  target: 'frame';
  type: 'SB_FRAME_START_BRANCH';
  panelId: string;
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
}

interface FrameReadyMessage {
  source: 'aside';
  target: 'parent';
  type: 'SB_FRAME_READY';
  currentUrl: string;
}

interface FrameBranchEventMessage {
  source: 'aside';
  target: 'parent';
  type: 'SB_FRAME_EVENT';
  panelId: string;
  event: BranchPanelEvent;
}

type FrameIncomingMessage = FrameReadyMessage | FrameBranchEventMessage;

declare global {
  interface Window {
    __asideCleanup?: () => void;
  }
}

const PANEL_CLASS = 'aside-panel';
const PANEL_TABBAR_ID = 'aside-tabbar';
const PANEL_STORAGE_PREFIX = 'aside:panels:';
const FRAME_AUTOMATION_STYLE_ID = 'aside-frame-automation-style';
const EXTENSION_HOST_ID = 'aside-root';
const TITLE_WATCH_TIMEOUT_MS = 120_000;
const MIN_SELECTION_LENGTH = 4;
const ASK_TRIGGER_SYNC_DELAY_MS = 120;
const SELECTION_ACTION_PATTERNS = [
  /ask\s*chatgpt/i,
  /询问\s*chatgpt/i,
  /问\s*chatgpt/i,
  /向\s*chatgpt\s*提问/i,
  /chat\s+with\s+chatgpt/i,
  /与\s*chatgpt\s*聊天/i
];

let currentSelectionPayload: SelectionPayload | null = null;
let currentSelectionDraft: SelectionDraft | null = null;
let currentSelectionRect: DOMRect | null = null;
let extensionHost: HTMLDivElement | null = null;
let selectionToolbar: HTMLDivElement | null = null;
let askButton: HTMLButtonElement | null = null;
let whyButton: HTMLButtonElement | null = null;
let newTabButton: HTMLButtonElement | null = null;
let tabBar: HTMLDivElement | null = null;
let highlightOverlay: HTMLDivElement | null = null;
let highlightOverlayTimer: number | undefined;
let selectionTimer: number | undefined;
let askTriggerTimer: number | undefined;
let lastKnownUrl = normalizeChatUrl(window.location.href);
let cleanupFns: Array<() => void> = [];
const panelRuntimes = new Map<string, PanelRuntime>();
let selectionActionObserver: MutationObserver | null = null;
let themeObserver: MutationObserver | null = null;
let activeTheme: ThemeMode | null = null;
let pendingUrlChangeToken = 0;
let lastUsedBranchKind: BranchKind = 'persistent';
let selectionActionMutationMuted = false;
let selectionActionRefreshTimer: number | undefined;
let isEvaluatingSelection = false;
let pendingDraftFocusPanelId: string | null = null;
const suppressedSelectionActions = new Set<HTMLElement>();

interface PersistedPanelBucket {
  key: string;
  panels: BranchPanelState[];
}

type TemporaryChatVerification = 'confirmed' | 'assumed';

function hasRuntimeAccess(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isInvalidatedError(error: unknown): boolean {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}

function isTopFrame(): boolean {
  return window.top === window.self;
}

function getPanelStorageKeyForConversationId(conversationId: string): string {
  return `${PANEL_STORAGE_PREFIX}${conversationId}`;
}

function getConversationStorageKey(url = lastKnownUrl): string {
  return getPanelStorageKeyForConversationId(getRootConversationId(url));
}

function getPanelStorageKeyForState(
  state: Pick<BranchPanelState, 'rootConversationId' | 'rootChatUrl'>
): string {
  return getPanelStorageKeyForConversationId(
    state.rootConversationId || getRootConversationId(state.rootChatUrl)
  );
}

function formatDebugLogEntry(message: string, details?: unknown): string {
  let suffix = '';
  if (details !== undefined) {
    try {
      suffix = ` ${JSON.stringify(details)}`;
    } catch {
      suffix = ` ${String(details)}`;
    }
  }

  return `[${new Date().toISOString()}] ${message}${suffix}`;
}

function recordAutomationLog(message: string, details?: unknown): string {
  const entry = formatDebugLogEntry(message, details);
  console.info('[Aside]', entry);

  if (activeAutomationPanelId) {
    void sendAutomationEvent({
      kind: 'debug-log',
      message: entry
    });
  }

  return entry;
}

function appendPanelLog(runtime: PanelRuntime, message: string, details?: unknown): void {
  const entry = formatDebugLogEntry(message, details);
  runtime.state.debugLog = [...(runtime.state.debugLog ?? []), entry].slice(-250);
  runtime.state.updatedAt = Date.now();
  console.info('[Aside]', entry);
}

function appendPanelLogEntries(runtime: PanelRuntime, entries: string[]): void {
  if (!entries.length) {
    return;
  }

  runtime.state.debugLog = [...(runtime.state.debugLog ?? []), ...entries].slice(-250);
  runtime.state.updatedAt = Date.now();
}

async function readPersistedPanels(url = lastKnownUrl): Promise<BranchPanelState[]> {
  if (!hasRuntimeAccess()) {
    return [];
  }

  const key = getConversationStorageKey(url);

  try {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;
    const raw = stored[key];
    return Array.isArray(raw) ? (raw as BranchPanelState[]) : [];
  } catch (error) {
    if (isInvalidatedError(error)) {
      return [];
    }
    throw error;
  }
}

async function migrateLegacyPanelStorage(): Promise<void> {
  if (!hasRuntimeAccess()) {
    return;
  }

  try {
    const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const nextEntries: Record<string, unknown> = {};

    Object.entries(stored).forEach(([key, value]) => {
      if (!key.startsWith(LEGACY_PANEL_STORAGE_PREFIX)) {
        return;
      }

      const nextKey = `${PANEL_STORAGE_PREFIX}${key.slice(LEGACY_PANEL_STORAGE_PREFIX.length)}`;
      if (!(nextKey in stored) && !(nextKey in nextEntries)) {
        nextEntries[nextKey] = value;
      }
    });

    if (
      !(LAST_BRANCH_KIND_STORAGE_KEY in stored) &&
      LEGACY_LAST_BRANCH_KIND_STORAGE_KEY in stored
    ) {
      nextEntries[LAST_BRANCH_KIND_STORAGE_KEY] = stored[LEGACY_LAST_BRANCH_KIND_STORAGE_KEY];
    }

    if (Object.keys(nextEntries).length) {
      await chrome.storage.local.set(nextEntries);
    }
  } catch (error) {
    if (!isInvalidatedError(error)) {
      throw error;
    }
  }
}

async function readAllPersistedPanelBuckets(): Promise<PersistedPanelBucket[]> {
  if (!hasRuntimeAccess()) {
    return [];
  }

  try {
    const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    return Object.entries(stored)
      .filter(([key]) => key.startsWith(PANEL_STORAGE_PREFIX))
      .map(([key, value]) => ({
        key,
        panels: Array.isArray(value) ? (value as BranchPanelState[]) : []
      }));
  } catch (error) {
    if (isInvalidatedError(error)) {
      return [];
    }
    throw error;
  }
}

async function writePersistedPanels(): Promise<void> {
  if (!hasRuntimeAccess()) {
    return;
  }

  const grouped = new Map<string, BranchPanelState[]>();
  sortPanels().forEach((runtime) => {
    const key = getPanelStorageKeyForState(runtime.state);
    const existing = grouped.get(key) ?? [];
    existing.push(runtime.state);
    grouped.set(key, existing);
  });

  const nextEntries = Object.fromEntries(grouped.entries());

  try {
    const stored = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const staleKeys = Object.keys(stored).filter(
      (key) => key.startsWith(PANEL_STORAGE_PREFIX) && !grouped.has(key)
    );

    if (staleKeys.length) {
      await chrome.storage.local.remove(staleKeys);
    }

    if (Object.keys(nextEntries).length) {
      await chrome.storage.local.set(nextEntries);
    }
  } catch (error) {
    if (!isInvalidatedError(error)) {
      throw error;
    }
  }
}

function persistPanels(): void {
  void writePersistedPanels();
}

async function loadLastUsedBranchKind(): Promise<void> {
  if (!hasRuntimeAccess()) {
    lastUsedBranchKind = 'persistent';
    return;
  }

  try {
    const stored = (await chrome.storage.local.get(LAST_BRANCH_KIND_STORAGE_KEY)) as Record<string, unknown>;
    lastUsedBranchKind =
      stored[LAST_BRANCH_KIND_STORAGE_KEY] === 'temporary' ? 'temporary' : 'persistent';
  } catch (error) {
    if (!isInvalidatedError(error)) {
      throw error;
    }
    lastUsedBranchKind = 'persistent';
  }
}

function persistLastUsedBranchKind(kind: BranchKind): void {
  lastUsedBranchKind = kind;
  if (!hasRuntimeAccess()) {
    return;
  }

  void chrome.storage.local
    .set({ [LAST_BRANCH_KIND_STORAGE_KEY]: kind })
    .catch((error) => {
      if (!isInvalidatedError(error)) {
        console.warn('[Aside] Failed to persist branch kind', error);
      }
    });
}

async function createNativeBranchWindow(options: {
  panelId: string;
  prompt: string;
  launchUrl: string;
  branchKind: BranchKind;
  focusWindow?: boolean;
  arrangeSideBySide?: boolean;
}): Promise<CreateBranchWindowResponse> {
  if (!hasRuntimeAccess()) {
    return {
      ok: false,
      reason: 'Chrome extension runtime is unavailable.'
    };
  }

  try {
    return (await chrome.runtime.sendMessage({
      type: 'CREATE_BRANCH_WINDOW',
      panelId: options.panelId,
      prompt: options.prompt,
      launchUrl: options.launchUrl,
      branchKind: options.branchKind,
      focusWindow: options.focusWindow,
      arrangeSideBySide: options.arrangeSideBySide
    })) as CreateBranchWindowResponse;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function focusNativeBranchWindow(options: {
  panelId: string;
  launchTabId?: number;
  launchWindowId?: number;
  branchChatUrl?: string;
}): Promise<FocusBranchWindowResponse> {
  if (!hasRuntimeAccess()) {
    return {
      ok: false,
      reason: 'Chrome extension runtime is unavailable.'
    };
  }

  try {
    return (await chrome.runtime.sendMessage({
      type: 'FOCUS_BRANCH_WINDOW',
      panelId: options.panelId,
      launchTabId: options.launchTabId,
      launchWindowId: options.launchWindowId,
      branchChatUrl: options.branchChatUrl
    })) as FocusBranchWindowResponse;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function detectChatGptTheme(): ThemeMode {
  const themeCandidates = [document.documentElement, document.body].filter(
    (element): element is HTMLElement => element instanceof HTMLElement
  );

  for (const element of themeCandidates) {
    const dataTheme = element.dataset.theme?.toLowerCase();
    if (dataTheme === 'dark' || dataTheme === 'light') {
      return dataTheme;
    }

    const attrTheme = element.getAttribute('data-theme')?.toLowerCase();
    if (attrTheme === 'dark' || attrTheme === 'light') {
      return attrTheme;
    }

    if (element.classList.contains('dark')) {
      return 'dark';
    }
  }

  for (const element of themeCandidates) {
    const colorScheme = window.getComputedStyle(element).colorScheme.toLowerCase();
    if (colorScheme.includes('dark')) {
      return 'dark';
    }
    if (colorScheme.includes('light')) {
      return 'light';
    }
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme = detectChatGptTheme()): void {
  if (activeTheme === theme) {
    return;
  }

  activeTheme = theme;
  document.documentElement.dataset.asideTheme = theme;
}

function installThemeObserver(): void {
  applyTheme();

  themeObserver?.disconnect();
  themeObserver = new MutationObserver(() => {
    applyTheme();
  });

  const observerConfig: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  };

  themeObserver.observe(document.documentElement, observerConfig);
  if (document.body) {
    themeObserver.observe(document.body, observerConfig);
  }

  const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const colorSchemeListener = () => applyTheme();
  colorSchemeMedia.addEventListener('change', colorSchemeListener);

  cleanupFns.push(() => {
    themeObserver?.disconnect();
    themeObserver = null;
    colorSchemeMedia.removeEventListener('change', colorSchemeListener);
  });
}

function ensureStyles(): void {
  if (document.getElementById(ROOT_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = ROOT_STYLE_ID;
  style.textContent = `
    html[data-aside-theme="light"] {
      --sb-color-scheme: light;
      --sb-text: #111827;
      --sb-muted: #6b7280;
      --sb-border: rgba(15, 23, 42, 0.08);
      --sb-border-strong: rgba(15, 23, 42, 0.14);
      --sb-panel-bg: rgba(255, 255, 255, 0.98);
      --sb-panel-header-bg: rgba(249, 250, 251, 0.95);
      --sb-surface-bg: rgba(248, 250, 252, 0.96);
      --sb-input-bg: #ffffff;
      --sb-frame-bg: #ffffff;
      --sb-frame-overlay: rgba(249, 250, 251, 0.96);
      --sb-primary: #111827;
      --sb-primary-text: #ffffff;
      --sb-chip-bg: rgba(255, 255, 255, 0.98);
      --sb-shadow-chip: 0 10px 26px rgba(15, 23, 42, 0.12);
      --sb-shadow-panel: 0 28px 80px rgba(15, 23, 42, 0.16);
      --sb-danger: #991b1b;
      --sb-danger-muted: #4b5563;
    }

    html[data-aside-theme="dark"] {
      --sb-color-scheme: dark;
      --sb-text: #f3f4f6;
      --sb-muted: #9ca3af;
      --sb-border: rgba(148, 163, 184, 0.18);
      --sb-border-strong: rgba(148, 163, 184, 0.28);
      --sb-panel-bg: rgba(15, 23, 42, 0.94);
      --sb-panel-header-bg: rgba(17, 24, 39, 0.96);
      --sb-surface-bg: rgba(30, 41, 59, 0.9);
      --sb-input-bg: rgba(15, 23, 42, 0.82);
      --sb-frame-bg: rgba(15, 23, 42, 0.96);
      --sb-frame-overlay: rgba(15, 23, 42, 0.92);
      --sb-primary: #10a37f;
      --sb-primary-text: #f9fafb;
      --sb-chip-bg: rgba(17, 24, 39, 0.96);
      --sb-shadow-chip: 0 12px 26px rgba(0, 0, 0, 0.35);
      --sb-shadow-panel: 0 28px 80px rgba(0, 0, 0, 0.45);
      --sb-danger: #fca5a5;
      --sb-danger-muted: #d1d5db;
    }

    #${EXTENSION_HOST_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483643;
      pointer-events: none;
    }

    #${EXTENSION_HOST_ID} > * {
      pointer-events: auto;
    }

    html[data-aside-theme] #${SELECTION_TOOLBAR_ID},
    html[data-aside-theme] #${PANEL_TABBAR_ID},
    html[data-aside-theme] .${PANEL_CLASS} {
      color-scheme: var(--sb-color-scheme, light);
    }

    #${SELECTION_TOOLBAR_ID} {
      position: fixed;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      border-radius: 999px;
      padding: 8px;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
      backdrop-filter: blur(18px);
    }

    #${SELECTION_TOOLBAR_ID}[hidden] {
      display: none;
    }

    #${SELECTION_TOOLBAR_ID} button {
      border: none;
      border-radius: 999px;
      padding: 10px 14px;
      font: 600 13px/1.1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
    }

    #${ASK_BUTTON_ID} {
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.22);
    }

    #${WHY_BUTTON_ID},
    #${NEW_TAB_BUTTON_ID} {
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
    }

    #${SELECTION_TOOLBAR_ID} button:hover,
    #${SELECTION_TOOLBAR_ID} button:focus-visible {
      transform: translateY(-1px);
    }

    .aside-selection-suppressed {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .aside-kind-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      padding: 6px;
      border-radius: 999px;
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-kind-toggle button {
      border: none;
      border-radius: 999px;
      padding: 8px 12px;
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      background: transparent;
      color: var(--sb-muted, #6b7280);
    }

    .aside-kind-toggle button[data-selected="true"] {
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
    }

    #${PANEL_TABBAR_ID} {
      --sb-tab-width: 96px;
      position: fixed;
      top: 96px;
      bottom: 20px;
      z-index: 2147483645;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: var(--sb-tab-width);
      overflow-y: auto;
      overflow-x: visible;
      overscroll-behavior: contain;
      padding-right: 0;
      align-items: stretch;
      pointer-events: none;
      scrollbar-width: none;
    }

    #${PANEL_TABBAR_ID}[data-placement="edge"] {
      right: 8px;
    }

    #${PANEL_TABBAR_ID}[hidden] {
      display: none;
    }

    .aside-tab {
      display: flex;
      align-items: stretch;
      flex-direction: column;
      gap: 6px;
      width: var(--sb-tab-width);
      min-width: var(--sb-tab-width);
      box-sizing: border-box;
      padding: 10px 10px 12px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      border-radius: 18px;
      background: var(--sb-chip-bg, rgba(255, 255, 255, 0.98));
      box-shadow: var(--sb-shadow-chip, 0 10px 26px rgba(15, 23, 42, 0.12));
      color: var(--sb-text, #111827);
      font: 600 13px/1.1 ui-sans-serif, system-ui, sans-serif;
      transition:
        background 180ms ease,
        box-shadow 180ms ease;
      pointer-events: auto;
    }

    .aside-tab:hover,
    .aside-tab:focus-within {
      box-shadow: var(--sb-shadow-panel, 0 18px 48px rgba(15, 23, 42, 0.18));
    }

    .aside-tab button {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
    }

    .aside-tab button:first-child {
      display: -webkit-box;
      overflow: hidden;
      min-height: 30px;
      text-align: left;
      text-overflow: ellipsis;
      white-space: normal;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-height: 1.2;
    }

    .aside-tab small {
      display: inline-flex;
      align-self: flex-start;
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-muted, #6b7280);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }

    .aside-tab-close {
      align-self: flex-end;
      color: #9ca3af !important;
      font-size: 14px !important;
      line-height: 1 !important;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }

    .aside-tab:hover .aside-tab-close,
    .aside-tab:focus-within .aside-tab-close {
      opacity: 1;
      pointer-events: auto;
    }

    .aside-tab button:first-child:focus-visible,
    .aside-tab-close:focus-visible {
      outline: 2px solid rgba(37, 99, 235, 0.45);
      outline-offset: 2px;
      border-radius: 10px;
    }

    .aside-tab small {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .${PANEL_CLASS} {
      position: fixed;
      top: 80px;
      right: 16px;
      width: min(460px, calc(100vw - 32px));
      max-height: min(82vh, 980px);
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
      box-shadow: var(--sb-shadow-panel, 0 28px 80px rgba(15, 23, 42, 0.16));
      backdrop-filter: blur(18px);
    }

    .${PANEL_CLASS}[hidden] {
      display: none;
    }

    .aside-panel-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-header-bg, rgba(249, 250, 251, 0.95));
    }

    .aside-panel-heading h2 {
      margin: 0;
      font: 700 18px/1.18 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-text, #111827);
    }

    .aside-panel-heading p {
      margin: 6px 0 0;
      font: 500 13px/1.4 ui-sans-serif, system-ui, sans-serif;
      color: var(--sb-muted, #6b7280);
    }

    .aside-panel-heading .aside-error-copy {
      margin-top: 8px;
      color: var(--sb-danger, #991b1b);
      white-space: pre-wrap;
    }

    .aside-panel-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .aside-panel-actions button,
    .aside-panel-primary,
    .aside-panel-secondary {
      border-radius: 999px;
      padding: 9px 12px;
      font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      border: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
      color: var(--sb-text, #111827);
    }

    .aside-panel-primary {
      border: none;
      background: var(--sb-primary, #111827);
      color: var(--sb-primary-text, #ffffff);
    }

    .aside-panel-secondary {
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-panel-body {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-focus {
      padding: 14px 18px 16px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-focus small {
      display: block;
      margin-bottom: 8px;
      font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--sb-muted, #6b7280);
    }

    .aside-focus p {
      margin: 0;
      color: var(--sb-text, #111827);
      font: 500 14px/1.45 ui-sans-serif, system-ui, sans-serif;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 5;
      overflow: hidden;
    }

    .aside-launcher {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-launcher textarea {
      width: 100%;
      min-height: 96px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 16px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      background: var(--sb-input-bg, #ffffff);
      color: var(--sb-text, #111827);
      padding: 14px 16px;
      font: 500 14px/1.45 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-launcher textarea:disabled {
      opacity: 0.7;
      cursor: default;
    }

    .aside-launcher-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .aside-launcher button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .aside-frame-shell {
      position: relative;
      min-height: 380px;
      flex: 1 1 auto;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-frame-shell[hidden] {
      display: none !important;
    }

    .aside-frame {
      display: block;
      width: 100%;
      min-height: 560px;
      height: min(72vh, 900px);
      border: 0;
      background: var(--sb-panel-bg, rgba(255, 255, 255, 0.98));
    }

    .aside-frame-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      text-align: center;
      background:
        linear-gradient(
          180deg,
          rgba(255, 255, 255, 0.78),
          rgba(255, 255, 255, 0.9)
        );
      backdrop-filter: blur(6px);
    }

    :root[data-aside-theme="dark"] .aside-frame-overlay {
      background:
        linear-gradient(
          180deg,
          rgba(15, 23, 42, 0.72),
          rgba(15, 23, 42, 0.88)
        );
    }

    .aside-frame-overlay[hidden] {
      display: none !important;
    }

    .aside-frame-overlay-card {
      max-width: 360px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .aside-frame-overlay-title {
      margin: 0;
      color: var(--sb-text, #111827);
      font: 700 15px/1.35 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-frame-overlay-text {
      margin: 0;
      color: var(--sb-muted, #6b7280);
      font: 500 13px/1.5 ui-sans-serif, system-ui, sans-serif;
      white-space: pre-wrap;
    }

    .aside-debug-log {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--sb-border, rgba(15, 23, 42, 0.08));
      background: var(--sb-surface-bg, rgba(248, 250, 252, 0.96));
    }

    .aside-debug-log[hidden] {
      display: none !important;
    }

    .aside-debug-log strong {
      color: var(--sb-text, #111827);
      font: 700 14px/1.35 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-debug-log p {
      margin: 0;
      color: var(--sb-muted, #6b7280);
      font: 500 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }

    .aside-debug-log textarea {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      box-sizing: border-box;
      border-radius: 14px;
      border: 1px solid var(--sb-border-strong, rgba(15, 23, 42, 0.14));
      background: var(--sb-input-bg, #ffffff);
      color: var(--sb-text, #111827);
      padding: 12px;
      font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre;
    }

    .aside-debug-log-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .aside-origin-flash {
      outline: 3px solid rgba(16, 185, 129, 0.6);
      outline-offset: 6px;
      transition: outline-color 180ms ease;
    }

    #${HIGHLIGHT_OVERLAY_ID} {
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 2147483644;
    }

    #${HIGHLIGHT_OVERLAY_ID} .aside-highlight-rect {
      position: fixed;
      border-radius: 10px;
      background: rgba(16, 185, 129, 0.18);
      box-shadow: 0 0 0 2px rgba(5, 150, 105, 0.22);
    }
  `;
  document.head.append(style);
}

function ensureFrameAutomationStyles(): void {
  if (document.getElementById(FRAME_AUTOMATION_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = FRAME_AUTOMATION_STYLE_ID;
  style.textContent = `
    article[data-message-author-role] [class*="opacity-0"],
    article[data-message-author-role] [class*="invisible"],
    article[data-message-author-role] [class*="pointer-events-none"],
    main [data-testid^="conversation-turn-"] [class*="opacity-0"],
    main [data-testid^="conversation-turn-"] [class*="invisible"],
    main [data-testid^="conversation-turn-"] [class*="pointer-events-none"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }

    article[data-message-author-role] button,
    article[data-message-author-role] [role="button"],
    main [data-testid^="conversation-turn-"] button,
    main [data-testid^="conversation-turn-"] [role="button"] {
      pointer-events: auto !important;
    }
  `;
  document.head.append(style);
}

function ensureExtensionHost(): HTMLDivElement {
  if (extensionHost?.isConnected && extensionHost.parentElement === document.documentElement) {
    return extensionHost;
  }

  if (!extensionHost) {
    const existing = document.getElementById(EXTENSION_HOST_ID);
    if (existing && !(existing instanceof HTMLDivElement)) {
      existing.remove();
    } else if (existing instanceof HTMLDivElement) {
      existing.replaceChildren();
    }
  }

  extensionHost = ensureExtensionHostElement(document, EXTENSION_HOST_ID);
  return extensionHost;
}

function mountInExtensionHost<T extends HTMLElement>(element: T): T {
  return attachElementToHost(ensureExtensionHost(), element);
}

function ensureSelectionToolbar(): HTMLDivElement {
  if (!selectionToolbar) {
    document.getElementById(SELECTION_TOOLBAR_ID)?.remove();

    selectionToolbar = document.createElement('div');
    selectionToolbar.id = SELECTION_TOOLBAR_ID;
    selectionToolbar.hidden = true;

    askButton = document.createElement('button');
    askButton.id = ASK_BUTTON_ID;
    askButton.type = 'button';
    askButton.textContent = 'Ask';

    whyButton = document.createElement('button');
    whyButton.id = WHY_BUTTON_ID;
    whyButton.type = 'button';
    whyButton.textContent = 'Why';

    newTabButton = document.createElement('button');
    newTabButton.id = NEW_TAB_BUTTON_ID;
    newTabButton.type = 'button';
    newTabButton.textContent = 'New-tab';

    askButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('ask');
    });
    whyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('why');
    });
    newTabButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftFromCurrentSelection('new_tab');
    });

    selectionToolbar.append(askButton, whyButton, newTabButton);
  }

  return mountInExtensionHost(selectionToolbar);
}

function hideSelectionToolbar(): void {
  if (selectionToolbar) {
    selectionToolbar.hidden = true;
  }
}

function restoreSuppressedSelectionActions(): void {
  selectionActionMutationMuted = true;
  suppressedSelectionActions.forEach((element) => {
    if (element.isConnected) {
      element.classList.remove('aside-selection-suppressed');
    }
  });
  suppressedSelectionActions.clear();
  selectionActionMutationMuted = false;
}

function hideAskButton(clearSelection = true): void {
  if (clearSelection) {
    currentSelectionDraft = null;
    currentSelectionPayload = null;
    currentSelectionRect = null;
  }
  hideSelectionToolbar();
  restoreSuppressedSelectionActions();
}

function getSelectionDraftFromWindow(): SelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  try {
    return captureSelectionDraftFromRange(selection.getRangeAt(0));
  } catch {
    return null;
  }
}

function materializeSelectionPayload(
  draft: SelectionDraft | null | undefined
): SelectionPayload | null {
  if (!draft) {
    return null;
  }

  try {
    return buildSelectionPayloadFromDraft(draft);
  } catch {
    return null;
  }
}

function getBranchKindForNewDraft(): BranchKind {
  return lastUsedBranchKind;
}

function openDraftFromCurrentSelection(entryAction: BranchEntryAction): void {
  const draft = currentSelectionDraft ?? getSelectionDraftFromWindow();
  const payload = currentSelectionPayload ?? materializeSelectionPayload(draft);
  if (!payload) {
    hideAskButton();
    return;
  }
  currentSelectionPayload = payload;

  const branchKind = getBranchKindForNewDraft();
  if (entryAction === 'new_tab') {
    void openSelectionInNewTab(payload, branchKind);
  } else if (entryAction === 'why') {
    createBranchDraft(payload, {
      entryAction,
      branchKind,
      initialQuestion: 'Why?',
      autoStart: true
    });
  } else {
    createBranchDraft(payload, {
      entryAction,
      branchKind
    });
  }
  window.getSelection()?.removeAllRanges();
  hideAskButton();
}

function positionSelectionToolbar(rect: DOMRect): void {
  const toolbar = ensureSelectionToolbar();
  currentSelectionRect = rect;
  toolbar.hidden = false;
  const estimatedWidth = 236;
  const left = Math.max(
    16,
    Math.min(window.innerWidth - estimatedWidth - 16, rect.left + rect.width / 2 - estimatedWidth / 2)
  );
  toolbar.style.top = `${Math.max(16, rect.top - 56)}px`;
  toolbar.style.left = `${left}px`;
}

function isElementVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity || '1') > 0.01
  );
}

function isSelectionActionNearRect(element: HTMLElement, rect: DOMRect): boolean {
  const elementRect = element.getBoundingClientRect();
  const horizontalGap =
    elementRect.left > rect.right
      ? elementRect.left - rect.right
      : rect.left > elementRect.right
        ? rect.left - elementRect.right
        : 0;
  const verticalGap =
    elementRect.top > rect.bottom
      ? elementRect.top - rect.bottom
      : rect.top > elementRect.bottom
        ? rect.top - elementRect.bottom
        : 0;

  return horizontalGap <= 220 && verticalGap <= 140;
}

function syncAskTriggerVisibility(): void {
  if (!currentSelectionDraft || !currentSelectionRect) {
    hideAskButton();
    return;
  }

  refreshSelectionActionButtons();
  positionSelectionToolbar(currentSelectionRect);
}

function scheduleAskTriggerSync(delayMs = ASK_TRIGGER_SYNC_DELAY_MS): void {
  window.clearTimeout(askTriggerTimer);
  askTriggerTimer = window.setTimeout(() => {
    syncAskTriggerVisibility();
  }, delayMs);
}

function scheduleSelectionActionRefresh(delayMs = ASK_TRIGGER_SYNC_DELAY_MS): void {
  window.clearTimeout(selectionActionRefreshTimer);
  selectionActionRefreshTimer = window.setTimeout(() => {
    refreshSelectionActionButtons();
  }, delayMs);
}

function evaluateSelection(): void {
  if (isEvaluatingSelection) {
    return;
  }

  isEvaluatingSelection = true;
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideAskButton();
      return;
    }

    const anchorNode =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;

    if (anchorNode?.closest(`.${PANEL_CLASS}, #${PANEL_TABBAR_ID}`)) {
      hideAskButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const draft = captureSelectionDraftFromRange(range);
    if (!draft || draft.selectedText.length < MIN_SELECTION_LENGTH) {
      hideAskButton();
      return;
    }

    currentSelectionDraft = draft;
    currentSelectionPayload = null;
    currentSelectionRect = draft.selectionRect;
    positionSelectionToolbar(draft.selectionRect);
    scheduleSelectionActionRefresh(0);
    scheduleAskTriggerSync();
  } catch {
    hideAskButton();
  } finally {
    isEvaluatingSelection = false;
  }
}

function normalizeButtonLabel(element: Element): string {
  if (!(element instanceof HTMLElement)) {
    return '';
  }

  return compactWhitespace(
    element.getAttribute('aria-label') || element.innerText || element.textContent || ''
  ).toLowerCase();
}

function isLikelySelectionActionButton(element: Element): boolean {
  const label = normalizeButtonLabel(element);
  if (!label) {
    return false;
  }

  return SELECTION_ACTION_PATTERNS.some((pattern) => pattern.test(label));
}

function containsLikelySelectionAction(element: Element): boolean {
  if (isLikelySelectionActionButton(element)) {
    return true;
  }

  return Array.from(element.querySelectorAll('button, [role="button"]')).some((candidate) =>
    isLikelySelectionActionButton(candidate)
  );
}

function refreshSelectionActionButtons(_root: ParentNode = document): void {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (element, index, elements) => {
      return elements.indexOf(element) === index && isLikelySelectionActionButton(element);
    }
  );

  restoreSuppressedSelectionActions();

  const selectionRect = currentSelectionRect;
  if (!currentSelectionDraft || !selectionRect) {
    return;
  }

  const suppressAllWhileToolbarVisible = Boolean(selectionToolbar && !selectionToolbar.hidden);

  selectionActionMutationMuted = true;
  candidates.forEach((button) => {
    if (
      isElementVisible(button) &&
      (suppressAllWhileToolbarVisible || isSelectionActionNearRect(button, selectionRect))
    ) {
      button.classList.add('aside-selection-suppressed');
      suppressedSelectionActions.add(button);
    }
  });
  selectionActionMutationMuted = false;
}

function installSelectionActionObserver(): void {
  selectionActionObserver?.disconnect();
  selectionActionObserver = new MutationObserver((mutations) => {
    if (selectionActionMutationMuted || !selectionToolbar || selectionToolbar.hidden || !currentSelectionDraft) {
      return;
    }

    const shouldRefresh = mutations.some((mutation) => {
      if (
        mutation.target instanceof Element &&
        mutation.target.closest(`#${SELECTION_TOOLBAR_ID}, .${PANEL_CLASS}, #${PANEL_TABBAR_ID}`)
      ) {
        return false;
      }

      if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        return isLikelySelectionActionButton(mutation.target);
      }

      return Array.from(mutation.addedNodes).some((node) => {
        if (!(node instanceof Element)) {
          return false;
        }
        if (node.closest(`#${SELECTION_TOOLBAR_ID}, .${PANEL_CLASS}, #${PANEL_TABBAR_ID}`)) {
          return false;
        }
        return containsLikelySelectionAction(node);
      });
    });

    if (shouldRefresh) {
      scheduleSelectionActionRefresh(0);
    }
  });

  selectionActionObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    childList: true,
    subtree: true
  });

  cleanupFns.push(() => {
    selectionActionObserver?.disconnect();
    selectionActionObserver = null;
    window.clearTimeout(askTriggerTimer);
    window.clearTimeout(selectionActionRefreshTimer);
  });
}

function ensureTabBar(): HTMLDivElement {
  if (!tabBar) {
    document.getElementById(PANEL_TABBAR_ID)?.remove();
    tabBar = document.createElement('div');
    tabBar.id = PANEL_TABBAR_ID;
    tabBar.hidden = true;
  }

  return mountInExtensionHost(tabBar);
}

function sortPanels(): PanelRuntime[] {
  return [...panelRuntimes.values()].sort((left, right) => left.state.createdAt - right.state.createdAt);
}

function getVisiblePanels(): PanelRuntime[] {
  return sortPanels().filter((runtime) => !runtime.state.minimized);
}

function minimizeOtherPanels(exceptPanelId: string): void {
  sortPanels().forEach((runtime) => {
    if (runtime.state.panelId !== exceptPanelId && !runtime.state.minimized) {
      runtime.state.minimized = true;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
    }
  });
  persistPanels();
}

function getNonRootContainerUrl(url: string): string | undefined {
  const containerUrl = getChatContainerBaseUrl(url);

  try {
    return new URL(containerUrl).pathname === '/' ? undefined : containerUrl;
  } catch {
    return undefined;
  }
}

interface CreateDraftOptions {
  entryAction: BranchEntryAction;
  branchKind: BranchKind;
  initialQuestion?: string;
  autoStart?: boolean;
  hostChatUrl?: string;
}

function createDraftState(selection: SelectionPayload, options: CreateDraftOptions): BranchPanelState {
  const hostChatUrl = normalizeChatUrl(options.hostChatUrl ?? selection.rootChatUrl);
  return {
    panelId: randomId('panel'),
    rootConversationId: getRootConversationId(hostChatUrl),
    rootChatUrl: hostChatUrl,
    rootProjectUrl: getNonRootContainerUrl(hostChatUrl),
    selection,
    focusPreview: clipText(selection.selectedText, 280),
    branchKind: options.branchKind,
    entryAction: options.entryAction,
    surfaceMode: 'embedded',
    launchUrl: undefined,
    creationMode: 'pending',
    title: DEFAULT_BRANCH_TITLE,
    titleStatus: 'pending',
    minimized: false,
    status: 'draft',
    statusLabel: 'Ask a focused follow-up about this selected passage.',
    initialQuestion: options.initialQuestion,
    debugLog: [
      formatDebugLogEntry('Branch draft created', {
        rootChatUrl: selection.rootChatUrl,
        rootConversationId: selection.rootConversationId,
        selectedTextLength: selection.selectedText.length,
        branchKind: options.branchKind,
        entryAction: options.entryAction,
        selectedBlocks: selection.selectedBlocks.map((block) => ({
          role: block.role,
          turnIndex: block.turnIndex,
          messageId: block.messageId
        })),
        branchBaseMessageId: selection.branchBaseMessageId
      })
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function focusDraftQuestionInput(runtime: PanelRuntime): void {
  if (!runtime.questionInput.isConnected) {
    return;
  }
  if (runtime.state.status !== 'draft' && runtime.state.status !== 'failed') {
    return;
  }
  runtime.questionInput.click();
  runtime.questionInput.focus({ preventScroll: true });
  runtime.questionInput.setSelectionRange(
    runtime.questionInput.value.length,
    runtime.questionInput.value.length
  );
}

function scheduleDraftQuestionFocus(runtime: PanelRuntime): void {
  const deadline = Date.now() + 4_000;
  const focusUntilSettled = () => {
    if (!panelRuntimes.has(runtime.state.panelId)) {
      return;
    }

    if (runtime.state.status !== 'draft' && runtime.state.status !== 'failed') {
      return;
    }

    focusDraftQuestionInput(runtime);
    if (document.activeElement === runtime.questionInput || Date.now() >= deadline) {
      return;
    }

    window.requestAnimationFrame(focusUntilSettled);
  };

  window.requestAnimationFrame(focusUntilSettled);
  window.requestAnimationFrame(() => {
    focusDraftQuestionInput(runtime);
  });
  [0, 50, 150, 350, 750, 1500, 3000].forEach((delayMs) => {
    window.setTimeout(() => {
      focusDraftQuestionInput(runtime);
    }, delayMs);
  });
}

function focusPendingDraftQuestionInput(): void {
  if (!pendingDraftFocusPanelId) {
    return;
  }

  const runtime = panelRuntimes.get(pendingDraftFocusPanelId);
  if (!runtime || runtime.state.status !== 'draft') {
    pendingDraftFocusPanelId = null;
    return;
  }

  focusDraftQuestionInput(runtime);
  if (document.activeElement === runtime.questionInput) {
    pendingDraftFocusPanelId = null;
  }
}

function createBranchDraft(selection: SelectionPayload, options: CreateDraftOptions): PanelRuntime {
  const state = createDraftState(selection, options);
  minimizeOtherPanels(state.panelId);
  const runtime = createPanelRuntime(state);
  if (state.entryAction === 'new_tab' && state.status === 'draft') {
    pendingDraftFocusPanelId = state.panelId;
    focusDraftQuestionInput(runtime);
    scheduleDraftQuestionFocus(runtime);
  }
  renderTabs();
  persistPanels();

  if (options.initialQuestion) {
    runtime.questionInput.value = options.initialQuestion;
    runtime.state.initialQuestion = options.initialQuestion;
    syncPanelUI(runtime);
  }

  if (options.autoStart && options.initialQuestion?.trim()) {
    void startBranch(state.panelId, options.initialQuestion.trim());
  }

  return runtime;
}

function createPanelRuntime(state: BranchPanelState): PanelRuntime {
  const element = document.createElement('div');
  element.className = PANEL_CLASS;
  element.dataset.panelId = state.panelId;

  const header = document.createElement('div');
  header.className = 'aside-panel-header';

  const headingWrap = document.createElement('div');
  headingWrap.className = 'aside-panel-heading';
  const titleEl = document.createElement('h2');
  const statusEl = document.createElement('p');
  const errorEl = document.createElement('p');
  errorEl.className = 'aside-error-copy';
  headingWrap.append(titleEl, statusEl, errorEl);

  const actions = document.createElement('div');
  actions.className = 'aside-panel-actions';
  const jumpButton = document.createElement('button');
  jumpButton.type = 'button';
  jumpButton.textContent = 'Jump to origin';
  const openTabHeaderButton = document.createElement('button');
  openTabHeaderButton.type = 'button';
  openTabHeaderButton.textContent = 'Open branch';
  const copyLogButton = document.createElement('button');
  copyLogButton.type = 'button';
  copyLogButton.textContent = 'Copy log';
  copyLogButton.title = 'Copy a diagnostic report with the selected text, sent prompt, URLs, and automation steps.';
  const minimizeButton = document.createElement('button');
  minimizeButton.type = 'button';
  minimizeButton.textContent = 'Minimize';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  actions.append(jumpButton, openTabHeaderButton, copyLogButton, minimizeButton, closeButton);
  header.append(headingWrap, actions);

  const body = document.createElement('div');
  body.className = 'aside-panel-body';

  const focus = document.createElement('div');
  focus.className = 'aside-focus';
  const focusLabel = document.createElement('small');
  focusLabel.textContent = 'Selected local focus';
  const focusTextEl = document.createElement('p');
  focus.append(focusLabel, focusTextEl);

  const formEl = document.createElement('form');
  formEl.className = 'aside-launcher';
  const branchKindField = document.createElement('div');
  branchKindField.className = 'aside-kind-toggle';
  const persistentKindButton = document.createElement('button');
  persistentKindButton.type = 'button';
  persistentKindButton.textContent = 'Persistent';
  const temporaryKindButton = document.createElement('button');
  temporaryKindButton.type = 'button';
  temporaryKindButton.textContent = 'Temporary';
  const questionInput = document.createElement('textarea');
  questionInput.placeholder = 'Ask a local question about this passage';
  questionInput.autocomplete = 'off';
  questionInput.autocapitalize = 'sentences';
  questionInput.autofocus = state.entryAction === 'new_tab' && state.status === 'draft';
  const launcherActions = document.createElement('div');
  launcherActions.className = 'aside-launcher-actions';
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'aside-panel-primary';
  submitButton.textContent = 'Start branch';
  branchKindField.append(persistentKindButton, temporaryKindButton);
  launcherActions.append(submitButton);
  formEl.append(branchKindField, questionInput, launcherActions);

  const iframeShell = document.createElement('div');
  iframeShell.className = 'aside-frame-shell';
  iframeShell.hidden = true;
  const iframeEl = document.createElement('iframe');
  iframeEl.className = 'aside-frame';
  iframeEl.title = 'ChatGPT embedded branch';
  iframeEl.setAttribute('loading', 'eager');
  iframeEl.referrerPolicy = 'strict-origin-when-cross-origin';
  iframeEl.src = 'about:blank';
  const iframeOverlay = document.createElement('div');
  iframeOverlay.className = 'aside-frame-overlay';
  const iframeOverlayCard = document.createElement('div');
  iframeOverlayCard.className = 'aside-frame-overlay-card';
  const iframeOverlayTitle = document.createElement('p');
  iframeOverlayTitle.className = 'aside-frame-overlay-title';
  const iframeOverlayText = document.createElement('p');
  iframeOverlayText.className = 'aside-frame-overlay-text';
  iframeOverlayCard.append(iframeOverlayTitle, iframeOverlayText);
  iframeOverlay.append(iframeOverlayCard);
  iframeShell.append(iframeEl, iframeOverlay);

  const debugLogShell = document.createElement('div');
  debugLogShell.className = 'aside-debug-log';
  debugLogShell.hidden = true;
  const debugLogTitle = document.createElement('strong');
  debugLogTitle.textContent = 'Copyable debug log';
  const debugLogHelp = document.createElement('p');
  debugLogHelp.textContent =
    'Clipboard access was blocked, so select this log and paste it here. It may include selected text and the first prompt.';
  const debugLogTextarea = document.createElement('textarea');
  debugLogTextarea.readOnly = true;
  debugLogTextarea.spellcheck = false;
  const debugLogActions = document.createElement('div');
  debugLogActions.className = 'aside-debug-log-actions';
  const selectDebugLogButton = document.createElement('button');
  selectDebugLogButton.type = 'button';
  selectDebugLogButton.className = 'aside-panel-secondary';
  selectDebugLogButton.textContent = 'Select log';
  const closeDebugLogButton = document.createElement('button');
  closeDebugLogButton.type = 'button';
  closeDebugLogButton.className = 'aside-panel-secondary';
  closeDebugLogButton.textContent = 'Hide log';
  debugLogActions.append(selectDebugLogButton, closeDebugLogButton);
  debugLogShell.append(debugLogTitle, debugLogHelp, debugLogTextarea, debugLogActions);

  body.append(focus, formEl, iframeShell, debugLogShell);
  element.append(header, body);
  mountInExtensionHost(element);

  const runtime: PanelRuntime = {
    state,
    element,
    titleEl,
    statusEl,
    errorEl,
    focusTextEl,
    formEl,
    branchKindField,
    persistentKindButton,
    temporaryKindButton,
    questionInput,
    submitButton,
    iframeShell,
    iframeEl,
    iframeOverlay,
    iframeOverlayTitle,
    iframeOverlayText,
    debugLogShell,
    debugLogTextarea,
    copyLogButton,
    openTabHeaderButton,
    frameReady: false,
    frameStartSent: false
  };

  questionInput.value = state.initialQuestion ?? '';

  jumpButton.addEventListener('click', () => {
    scrollToOrigin(runtime.state.selection);
  });
  openTabHeaderButton.addEventListener('click', () => {
    void openBranchInNewTab(runtime.state.panelId);
  });
  copyLogButton.addEventListener('click', () => {
    void copyBranchDebugLog(runtime.state.panelId);
  });
  selectDebugLogButton.addEventListener('click', () => {
    debugLogTextarea.focus();
    debugLogTextarea.select();
  });
  closeDebugLogButton.addEventListener('click', () => {
    debugLogShell.hidden = true;
  });
  minimizeButton.addEventListener('click', () => {
    minimizePanel(runtime.state.panelId);
  });
  closeButton.addEventListener('click', () => {
    closePanel(runtime.state.panelId);
  });
  iframeEl.addEventListener('load', () => {
    appendPanelLog(runtime, 'Embedded branch frame load event', {
      iframeSrc: iframeEl.src,
      panelStatus: runtime.state.status
    });
    syncPanelUI(runtime);
  });
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = questionInput.value.trim();
    if (!question) {
      return;
    }
    await startBranch(runtime.state.panelId, question);
  });
  persistentKindButton.addEventListener('click', () => {
    runtime.state.branchKind = 'persistent';
    runtime.state.updatedAt = Date.now();
    persistLastUsedBranchKind('persistent');
    syncPanelUI(runtime);
    persistPanels();
  });
  temporaryKindButton.addEventListener('click', () => {
    runtime.state.branchKind = 'temporary';
    runtime.state.updatedAt = Date.now();
    persistLastUsedBranchKind('temporary');
    syncPanelUI(runtime);
    persistPanels();
  });
  questionInput.addEventListener('input', () => {
    runtime.state.initialQuestion = questionInput.value;
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
  });

  panelRuntimes.set(state.panelId, runtime);
  syncPanelUI(runtime);

  return runtime;
}

function getDisplayTitle(state: BranchPanelState): string {
  if (state.titleStatus === 'ready' && state.title.trim()) {
    return state.title.trim();
  }

  if (state.status === 'draft') {
    return 'New branch';
  }

  return 'Naming branch...';
}

function canShowForm(state: BranchPanelState): boolean {
  if (state.surfaceMode === 'native_window') {
    return false;
  }
  return state.status === 'draft' || (state.status === 'failed' && !state.branchChatUrl);
}

function canShowBranchKindToggle(state: BranchPanelState): boolean {
  return canShowForm(state) && (state.entryAction === 'ask' || state.entryAction === 'new_tab');
}

function canShowFrame(state: BranchPanelState): boolean {
  if (state.surfaceMode === 'native_window') {
    return false;
  }
  return state.status !== 'draft' || Boolean(state.branchChatUrl) || Boolean(state.launchUrl);
}

function syncPanelUI(runtime: PanelRuntime): void {
  const { state } = runtime;
  const showForm = canShowForm(state);
  const showFrame = canShowFrame(state);
  const showOpenBranch = Boolean(
    state.branchChatUrl || state.launchTabId || state.launchWindowId
  );
  const overlayVisible = state.status !== 'live';

  runtime.element.hidden = state.minimized;
  runtime.titleEl.textContent = getDisplayTitle(state);
  runtime.statusEl.textContent = state.statusLabel;
  runtime.errorEl.textContent = state.status === 'failed' ? state.errorMessage ?? '' : '';
  runtime.errorEl.style.display = runtime.errorEl.textContent ? 'block' : 'none';
  runtime.focusTextEl.textContent = state.focusPreview;

  runtime.formEl.style.display = showForm ? 'flex' : 'none';
  runtime.branchKindField.style.display = canShowBranchKindToggle(state) ? 'inline-flex' : 'none';
  runtime.persistentKindButton.dataset.selected = String(state.branchKind === 'persistent');
  runtime.temporaryKindButton.dataset.selected = String(state.branchKind === 'temporary');
  runtime.questionInput.disabled = !showForm;
  runtime.persistentKindButton.disabled = !showForm;
  runtime.temporaryKindButton.disabled = !showForm;
  runtime.submitButton.disabled =
    !runtime.questionInput.value.trim() ||
    state.status === 'creating_branch' ||
    state.status === 'opening_branch';
  runtime.submitButton.textContent = state.status === 'failed' ? 'Try again' : 'Start branch';
  runtime.iframeShell.hidden = !showFrame;
  runtime.iframeOverlay.hidden = !overlayVisible;
  runtime.iframeOverlayTitle.textContent =
    state.surfaceMode === 'native_window'
      ? state.status === 'failed'
        ? 'Native branch could not finish loading'
        : state.status === 'live'
          ? ''
          : 'Branch continued in a native ChatGPT window'
      : state.status === 'failed'
      ? 'Branch could not finish loading'
      : state.status === 'live'
        ? ''
        : 'Opening branch in this window';
  runtime.iframeOverlayText.textContent =
    state.status === 'failed'
      ? state.errorMessage ?? state.statusLabel
      : state.statusLabel;
  runtime.openTabHeaderButton.style.display = showOpenBranch ? 'inline-flex' : 'none';
  if (state.status === 'live') {
    ensureLiveFrameLocation(runtime);
  }
}

function renderTabs(): void {
  const container = ensureTabBar();
  container.innerHTML = '';

  const minimized = sortPanels().filter((runtime) => runtime.state.minimized);
  container.hidden = minimized.length === 0;
  container.dataset.placement = 'edge';

  minimized.forEach((runtime) => {
    const tab = document.createElement('div');
    tab.className = 'aside-tab';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = clipText(getDisplayTitle(runtime.state), 28);

    const badge = document.createElement('small');
    if (runtime.state.status === 'draft') {
      badge.textContent = 'draft';
    } else if (runtime.state.status === 'failed') {
      badge.textContent = 'failed';
    } else if (runtime.state.status === 'live') {
      badge.textContent = 'live';
    } else {
      badge.textContent = 'opening';
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'aside-tab-close';
    closeButton.textContent = '×';

    openButton.addEventListener('click', () => {
      expandPanel(runtime.state.panelId);
    });
    closeButton.addEventListener('click', () => {
      closePanel(runtime.state.panelId);
    });

    tab.append(openButton, badge, closeButton);
    container.append(tab);
  });
}

function syncMountedUi(): void {
  ensureExtensionHost();

  if (selectionToolbar) {
    mountInExtensionHost(selectionToolbar);
    if (!selectionToolbar.hidden && currentSelectionRect) {
      positionSelectionToolbar(currentSelectionRect);
    }
  }

  sortPanels().forEach((runtime) => {
    mountInExtensionHost(runtime.element);
    syncPanelUI(runtime);
  });

  renderTabs();

  if (highlightOverlay?.childElementCount) {
    mountInExtensionHost(highlightOverlay);
  }

  focusPendingDraftQuestionInput();
}

function scheduleMountedUiSync(delayMs: number): void {
  const timer = window.setTimeout(() => {
    syncMountedUi();
  }, delayMs);
  cleanupFns.push(() => window.clearTimeout(timer));
}

function createStateFromRestore(raw: BranchPanelState): BranchPanelState | null {
  if (!raw?.panelId || !raw.selection?.selectedText) {
    return null;
  }

  const normalizedRootChatUrl = normalizeChatUrl(raw.rootChatUrl ?? raw.selection.rootChatUrl);
  const normalizedLaunchUrl = raw.launchUrl ? normalizeChatUrl(raw.launchUrl) : undefined;
  const normalizedBranchChatUrl = raw.branchChatUrl ? normalizeChatUrl(raw.branchChatUrl) : undefined;
  const branchKind: BranchKind = raw.branchKind === 'temporary' ? 'temporary' : 'persistent';
  const surfaceMode = raw.surfaceMode === 'native_window' ? 'native_window' : 'embedded';
  const entryAction: BranchEntryAction =
    raw.entryAction === 'why' || raw.entryAction === 'new_tab' ? raw.entryAction : 'ask';
  const rawStatus = String(raw.status ?? '');
  const allowedStatuses = new Set<string>([
    'draft',
    'creating_branch',
    'opening_branch',
    'live',
    'failed'
  ]);
  let status: BranchPanelStatus = allowedStatuses.has(rawStatus)
    ? (rawStatus as BranchPanelStatus)
    : rawStatus
      ? 'failed'
      : normalizedBranchChatUrl
        ? 'live'
        : 'draft';
  const rawCreationMode = String(raw.creationMode ?? '');
  let creationMode: BranchCreationMode =
    rawCreationMode === 'failed'
      ? 'failed'
      : rawCreationMode === 'local_temporary'
        ? 'local_temporary'
      : rawCreationMode === 'pending'
        ? 'pending'
        : normalizedBranchChatUrl
          ? 'local_persistent'
          : 'pending';
  let errorMessage = raw.errorMessage;

  if (
    (status === 'creating_branch' || status === 'opening_branch') &&
    !normalizedBranchChatUrl
  ) {
    status = 'failed';
    creationMode = 'failed';
    errorMessage = 'Branch creation was interrupted. Start it again.';
  }

  if (branchKind === 'temporary' && status === 'live' && !normalizedBranchChatUrl) {
    status = 'failed';
    creationMode = 'failed';
    errorMessage = 'Temporary branch ended after reload. Start it again.';
  }

  return {
    panelId: raw.panelId,
    rootConversationId: raw.rootConversationId ?? raw.selection.rootConversationId,
    rootChatUrl: normalizedRootChatUrl,
    rootProjectUrl: raw.rootProjectUrl ?? getNonRootContainerUrl(normalizedRootChatUrl),
    selection: raw.selection,
    focusPreview: raw.focusPreview || clipText(raw.selection.selectedText, 280),
    branchKind,
    entryAction,
    surfaceMode,
    launchUrl: normalizedLaunchUrl,
    branchChatUrl: normalizedBranchChatUrl,
    launchTabId: typeof raw.launchTabId === 'number' ? raw.launchTabId : undefined,
    launchWindowId: typeof raw.launchWindowId === 'number' ? raw.launchWindowId : undefined,
    creationMode,
    title: raw.title || DEFAULT_BRANCH_TITLE,
    titleStatus: raw.titleStatus ?? 'pending',
    minimized: Boolean(raw.minimized),
    initialQuestion: raw.initialQuestion,
    initialPrompt: raw.initialPrompt,
    status,
    statusLabel:
      raw.statusLabel ||
      (status === 'live'
        ? 'Branch answer is ready in this window.'
        : status === 'failed'
          ? errorMessage ?? 'Branch creation failed.'
          : 'Ask a focused follow-up about this selected passage.'),
    errorMessage,
    debugLog: Array.isArray(raw.debugLog) ? raw.debugLog.slice(-250) : undefined,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now()
  };
}

async function restorePanels(): Promise<void> {
  const urlAtStart = lastKnownUrl;
  const currentStorageKey = getConversationStorageKey(urlAtStart);
  const restored = await readAllPersistedPanelBuckets();
  if (urlAtStart !== lastKnownUrl) {
    return;
  }

  restored
    .flatMap(({ key, panels }) =>
      panels
        .filter((raw) => key === currentStorageKey || Boolean(raw?.minimized))
        .map((raw) => {
          const restoredState = createStateFromRestore(raw);
          if (!restoredState) {
            return null;
          }

          // Minimized tabs from other chats should remain available globally,
          // but only the current chat gets its full panel restore state.
          if (key !== currentStorageKey) {
            restoredState.minimized = true;
          }
          return restoredState;
        })
    )
    .filter((state): state is BranchPanelState => Boolean(state))
    .filter((state, index, states) => states.findIndex((item) => item.panelId === state.panelId) === index)
    .forEach((state) => {
      if (!panelRuntimes.has(state.panelId)) {
        createPanelRuntime(state);
      }
    });

  syncMountedUi();
}

function minimizePanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  runtime.state.minimized = true;
  runtime.state.updatedAt = Date.now();
  syncPanelUI(runtime);
  renderTabs();
  persistPanels();
}

function expandPanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  minimizeOtherPanels(panelId);
  runtime.state.minimized = false;
  runtime.state.updatedAt = Date.now();
  syncPanelUI(runtime);
  renderTabs();
  persistPanels();
  scrollToOrigin(runtime.state.selection);
}

function closePanel(panelId: string): void {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  runtime.element.remove();
  panelRuntimes.delete(panelId);
  renderTabs();
  persistPanels();
}

function clearPanelsForCurrentConversation(): void {
  panelRuntimes.forEach((runtime) => {
    runtime.element.remove();
  });
  panelRuntimes.clear();
  renderTabs();
}

async function openBranchInNewTab(panelId: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  appendPanelLog(runtime, 'Open branch requested', {
    branchChatUrl: runtime.state.branchChatUrl,
    launchTabId: runtime.state.launchTabId,
    launchWindowId: runtime.state.launchWindowId,
    surfaceMode: runtime.state.surfaceMode
  });

  if (runtime.state.launchTabId || runtime.state.launchWindowId || runtime.state.branchChatUrl) {
    const response = await focusNativeBranchWindow({
      panelId,
      launchTabId: runtime.state.launchTabId,
      launchWindowId: runtime.state.launchWindowId,
      branchChatUrl: runtime.state.branchChatUrl
    });

    if (response.ok) {
      return;
    }
  }

  if (runtime.state.branchChatUrl) {
    window.open(runtime.state.branchChatUrl, '_blank', 'noopener,noreferrer');
  }
}

async function promotePersistentBranchToNativeWindow(runtime: PanelRuntime): Promise<void> {
  if (
    runtime.state.surfaceMode === 'native_window' ||
    runtime.state.branchKind !== 'persistent' ||
    !runtime.state.initialPrompt ||
    !runtime.state.launchUrl
  ) {
    return;
  }

  runtime.pendingFramePrompt = undefined;
  runtime.state.surfaceMode = 'native_window';
  runtime.state.status = 'opening_branch';
  runtime.state.statusLabel = 'Continuing this branch in a native ChatGPT window...';
  runtime.state.errorMessage = undefined;
  runtime.state.updatedAt = Date.now();
  appendPanelLog(runtime, 'Promoting persistent branch to a native ChatGPT window', {
    launchUrl: runtime.state.launchUrl
  });
  syncPanelUI(runtime);
  persistPanels();

  const response = await createNativeBranchWindow({
    panelId: runtime.state.panelId,
    prompt: runtime.state.initialPrompt,
    launchUrl: runtime.state.launchUrl,
    branchKind: runtime.state.branchKind,
    focusWindow: true,
    arrangeSideBySide: true
  });

  if (!response.ok) {
    appendPanelLog(runtime, 'Native branch window promotion failed', {
      reason: response.reason
    });
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'Native branch recovery failed.';
    runtime.state.errorMessage = response.reason ?? 'The native ChatGPT recovery window could not be opened.';
    runtime.state.updatedAt = Date.now();
    syncPanelUI(runtime);
    persistPanels();
    return;
  }

  runtime.state.launchTabId = response.tabId;
  runtime.state.launchWindowId = response.windowId;
  runtime.state.updatedAt = Date.now();
  appendPanelLog(runtime, 'Native branch recovery window created', {
    launchTabId: response.tabId,
    launchWindowId: response.windowId
  });
  syncPanelUI(runtime);
  persistPanels();
}

async function openSelectionInNewTab(
  selection: SelectionPayload,
  branchKind: BranchKind
): Promise<void> {
  const launchUrl = normalizeChatUrl(getBranchLaunchUrl(selection.rootChatUrl));
  const prompt = buildNativeBootstrapPrompt(selection).prompt;
  const panelId = randomId('native');
  persistLastUsedBranchKind(branchKind);
  const response = await createNativeBranchWindow({
    panelId,
    prompt,
    launchUrl,
    branchKind,
    focusWindow: true,
    arrangeSideBySide: true
  });

  if (!response.ok) {
    console.warn('[Aside] Failed to open native New-tab window', response.reason);
  }
}

function buildBranchDebugLogText(runtime: PanelRuntime): string {
  const { state } = runtime;
  return [
    'Aside Debug Log',
    'This report may include the selected text and the first prompt so we can debug wrong-output failures.',
    `generatedAt: ${new Date().toISOString()}`,
    `panelId: ${state.panelId}`,
    `rootChatUrl: ${state.rootChatUrl}`,
    `rootProjectUrl: ${state.rootProjectUrl ?? '(none)'}`,
    `branchKind: ${state.branchKind}`,
    `entryAction: ${state.entryAction}`,
    `surfaceMode: ${state.surfaceMode}`,
    `launchUrl: ${state.launchUrl ?? '(none)'}`,
    `branchChatUrl: ${state.branchChatUrl ?? '(none)'}`,
    `launchTabId: ${state.launchTabId ?? '(none)'}`,
    `launchWindowId: ${state.launchWindowId ?? '(none)'}`,
    `status: ${state.status}`,
    `statusLabel: ${state.statusLabel}`,
    `creationMode: ${state.creationMode}`,
    `title: ${state.title}`,
    `titleStatus: ${state.titleStatus}`,
    `createdAt: ${new Date(state.createdAt).toISOString()}`,
    `updatedAt: ${new Date(state.updatedAt).toISOString()}`,
    `focusPreview: ${state.focusPreview}`,
    `selectedTextLength: ${state.selection.selectedText.length}`,
    `initialQuestion: ${state.initialQuestion ?? '(none)'}`,
    `branchBaseMessageId: ${state.selection.branchBaseMessageId}`,
    `rangeQuotes: ${JSON.stringify(state.selection.rangeQuotes, null, 2)}`,
    `selectedBlocks: ${JSON.stringify(
      state.selection.selectedBlocks.map((block) => ({
        role: block.role,
        turnIndex: block.turnIndex,
        messageId: block.messageId,
        excerpt: block.excerpt
      })),
      null,
      2
    )}`,
    '',
    'SELECTED TEXT',
    state.selection.selectedText,
    '',
    'FIRST PROMPT SENT TO CHATGPT',
    state.initialPrompt ?? '(none)',
    '',
    'AUTOMATION LOG',
    '',
    ...(state.debugLog ?? ['(no debug log entries)'])
  ].join('\n');
}

function showCopyableDebugLog(runtime: PanelRuntime, logText: string): void {
  runtime.debugLogTextarea.value = logText;
  runtime.debugLogShell.hidden = false;
  runtime.debugLogTextarea.focus();
  runtime.debugLogTextarea.select();
}

async function copyBranchDebugLog(panelId: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  const logText = buildBranchDebugLogText(runtime);
  try {
    await navigator.clipboard.writeText(logText);
    appendPanelLog(runtime, 'Debug log copied to clipboard');
    runtime.debugLogShell.hidden = true;
    const previousStatus = runtime.state.statusLabel;
    runtime.state.statusLabel =
      'Debug log copied. Paste it here so we can inspect selection, branch URL, and prompt submission.';
    syncPanelUI(runtime);
    persistPanels();
    window.setTimeout(() => {
      if (panelRuntimes.get(panelId) === runtime) {
        runtime.state.statusLabel = previousStatus;
        syncPanelUI(runtime);
      }
    }, 2500);
  } catch (error) {
    const copyError = error instanceof Error ? error.message : String(error);
    appendPanelLog(runtime, 'Debug log copy failed', copyError);
    runtime.state.statusLabel = 'Clipboard copy was blocked. Select the diagnostic log below and paste it here.';
    showCopyableDebugLog(runtime, buildBranchDebugLogText(runtime));
    syncPanelUI(runtime);
    persistPanels();
  }
}

function buildEmbeddedFrameUrl(launchUrl: string): string {
  try {
    const url = new URL(launchUrl);
    url.hash = `aside-${Date.now()}`;
    return url.toString();
  } catch {
    return launchUrl;
  }
}

function loadEmbeddedBranchFrame(runtime: PanelRuntime, launchUrl: string): void {
  runtime.frameReady = false;
  runtime.frameStartSent = false;
  const iframeUrl = buildEmbeddedFrameUrl(launchUrl);
  runtime.iframeEl.src = iframeUrl;
  appendPanelLog(runtime, 'Loading embedded branch frame', {
    targetUrl: launchUrl,
    iframeSrc: iframeUrl,
    panelStatus: runtime.state.status
  });
}

function ensureLiveFrameLocation(runtime: PanelRuntime): void {
  const desiredUrl = runtime.state.branchChatUrl;
  if (!desiredUrl || runtime.pendingFramePrompt) {
    return;
  }

  if (runtime.frameStartSent || runtime.frameReady) {
    return;
  }

  const currentSrc = runtime.iframeEl.src;
  if (!currentSrc || currentSrc === 'about:blank') {
    runtime.iframeEl.src = desiredUrl;
    return;
  }

  if (normalizeChatUrl(currentSrc) !== normalizeChatUrl(desiredUrl)) {
    runtime.iframeEl.src = desiredUrl;
  }
}

function postToEmbeddedFrame(runtime: PanelRuntime, message: FrameStartBranchMessage): void {
  const targetWindow = runtime.iframeEl.contentWindow;
  if (!targetWindow) {
    return;
  }

  let targetOrigin = '*';
  try {
    targetOrigin = new URL(runtime.state.launchUrl ?? runtime.state.rootChatUrl).origin;
  } catch {
    targetOrigin = '*';
  }

  targetWindow.postMessage(message, targetOrigin);
}

function tryDispatchPendingFrameStart(runtime: PanelRuntime): void {
  if (!runtime.pendingFramePrompt || runtime.frameStartSent || !runtime.frameReady || !runtime.state.launchUrl) {
    return;
  }

  const prompt = runtime.pendingFramePrompt;
  runtime.frameStartSent = true;
  runtime.state.status = 'opening_branch';
  runtime.state.statusLabel = 'Sending the local branch question inside the branch window...';
  runtime.state.updatedAt = Date.now();
  appendPanelLog(runtime, 'Dispatching embedded branch start command', {
    launchUrl: runtime.state.launchUrl,
    promptLength: prompt.length
  });
  syncPanelUI(runtime);
  persistPanels();

  postToEmbeddedFrame(runtime, {
    source: 'aside',
    target: 'frame',
    type: 'SB_FRAME_START_BRANCH',
    panelId: runtime.state.panelId,
    prompt,
    launchUrl: runtime.state.launchUrl,
    branchKind: runtime.state.branchKind
  });
}

function findRuntimeByFrameWindow(source: MessageEventSource | null): PanelRuntime | null {
  if (!source) {
    return null;
  }

  for (const runtime of panelRuntimes.values()) {
    if (runtime.iframeEl.contentWindow === source) {
      return runtime;
    }
  }

  return null;
}

function handleEmbeddedFrameMessage(event: MessageEvent<FrameIncomingMessage>): void {
  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    data.source !== 'aside' ||
    data.target !== 'parent'
  ) {
    return;
  }

  const runtime = findRuntimeByFrameWindow(event.source);
  if (!runtime) {
    return;
  }

  if (data.type === 'SB_FRAME_READY') {
    runtime.frameReady = true;
    appendPanelLog(runtime, 'Embedded branch frame ready', {
      currentUrl: data.currentUrl,
      panelStatus: runtime.state.status,
      hasPendingPrompt: Boolean(runtime.pendingFramePrompt),
      iframeSrc: runtime.iframeEl.src
    });
    tryDispatchPendingFrameStart(runtime);
    return;
  }

  if (data.type === 'SB_FRAME_EVENT') {
    if (data.panelId !== runtime.state.panelId) {
      return;
    }
    applyBranchPanelEvent(runtime, data.event);
  }
}

function handleForwardedBranchPanelEvent(message: ForwardBranchPanelEventMessage): void {
  const runtime = panelRuntimes.get(message.panelId);
  if (!runtime) {
    return;
  }

  applyBranchPanelEvent(runtime, message.event);
}

function installRuntimeMessageListener(): void {
  if (!hasRuntimeAccess()) {
    return;
  }

  const runtimeMessageListener = (
    message: RunBranchPromptInTabMessage | ForwardBranchPanelEventMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (!isTopFrame() || !message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'BRANCH_PANEL_EVENT') {
      handleForwardedBranchPanelEvent(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'RUN_BRANCH_PROMPT_IN_TAB') {
      if (automationTaskRunning) {
        sendResponse({
          ok: false,
          reason: 'Another branch automation is already running in this ChatGPT window.'
        });
        return false;
      }

      void runBranchPromptAutomation(message, 'background');
      sendResponse({ ok: true });
      return false;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(runtimeMessageListener);
  cleanupFns.push(() => {
    chrome.runtime.onMessage.removeListener(runtimeMessageListener);
  });
}

async function startBranch(panelId: string, question: string): Promise<void> {
  const runtime = panelRuntimes.get(panelId);
  if (!runtime) {
    return;
  }

  const prompt = buildLocalInitialPrompt(runtime.state.selection, question).prompt;
  const launchUrl = normalizeChatUrl(getBranchLaunchUrl(runtime.state.rootChatUrl));
  appendPanelLog(runtime, 'Start branch requested', {
    questionLength: question.length,
    rootChatUrl: runtime.state.rootChatUrl,
    launchUrl,
    branchKind: runtime.state.branchKind,
    entryAction: runtime.state.entryAction,
    selectedTextLength: runtime.state.selection.selectedText.length,
    selectedAssistantBlockIds: runtime.state.selection.selectedBlocks
      .filter((block) => block.role === 'assistant')
      .map((block) => block.messageId),
    promptLength: prompt.length
  });
  runtime.state.initialQuestion = question;
  runtime.state.initialPrompt = prompt;
  runtime.state.surfaceMode = 'embedded';
  runtime.state.launchUrl = launchUrl;
  runtime.state.branchChatUrl = undefined;
  runtime.state.launchTabId = undefined;
  runtime.state.launchWindowId = undefined;
  runtime.state.creationMode =
    runtime.state.branchKind === 'temporary' ? 'local_temporary' : 'local_persistent';
  runtime.state.title = DEFAULT_BRANCH_TITLE;
  runtime.state.titleStatus = 'pending';
  runtime.state.status = 'creating_branch';
  runtime.state.statusLabel = 'Loading the embedded ChatGPT branch window...';
  runtime.state.errorMessage = undefined;
  runtime.state.updatedAt = Date.now();
  persistLastUsedBranchKind(runtime.state.branchKind);
  runtime.pendingFramePrompt = prompt;
  runtime.frameReady = false;
  runtime.frameStartSent = false;

  minimizeOtherPanels(panelId);
  loadEmbeddedBranchFrame(runtime, launchUrl);
  syncPanelUI(runtime);
  renderTabs();
  persistPanels();
  if (!runtime.state.launchUrl) {
    runtime.state.status = 'failed';
    runtime.state.creationMode = 'failed';
    runtime.state.statusLabel = 'Local branch creation failed.';
    runtime.state.errorMessage = 'Could not determine a launch URL for this ChatGPT branch.';
    syncPanelUI(runtime);
    persistPanels();
    return;
  }
}

function applyBranchPanelEvent(runtime: PanelRuntime, event: BranchPanelEvent): void {
  switch (event.kind) {
    case 'status':
      appendPanelLog(runtime, 'Embedded branch status', {
        status: event.status,
        statusLabel: event.statusLabel
      });
      runtime.state.status = event.status;
      runtime.state.statusLabel = event.statusLabel;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      persistPanels();
      return;

    case 'debug-log':
      appendPanelLogEntries(runtime, [event.message]);
      syncPanelUI(runtime);
      persistPanels();
      return;

    case 'title':
      appendPanelLog(runtime, 'Branch title detected', event.title);
      runtime.state.title = event.title;
      runtime.state.titleStatus = 'ready';
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      renderTabs();
      persistPanels();
      return;

    case 'live':
      runtime.pendingFramePrompt = undefined;
      runtime.state.launchTabId = event.launchTabId ?? runtime.state.launchTabId;
      runtime.state.launchWindowId = event.launchWindowId ?? runtime.state.launchWindowId;
      runtime.state.branchChatUrl = event.branchChatUrl
        ? normalizeChatUrl(event.branchChatUrl)
        : runtime.state.branchChatUrl;
      appendPanelLog(runtime, 'Branch is live', {
        branchChatUrl: runtime.state.branchChatUrl,
        launchTabId: runtime.state.launchTabId,
        launchWindowId: runtime.state.launchWindowId,
        surfaceMode: runtime.state.surfaceMode
      });
      runtime.state.status = 'live';
      runtime.state.creationMode =
        runtime.state.branchKind === 'temporary' ? 'local_temporary' : 'local_persistent';
      runtime.state.statusLabel =
        runtime.state.surfaceMode === 'native_window'
          ? 'Branch continued in a native ChatGPT window.'
          : 'Branch answer is ready in this window.';
      runtime.state.errorMessage = undefined;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      renderTabs();
      persistPanels();
      return;

    case 'failed':
      appendPanelLog(runtime, 'Branch reported failure', {
        reason: event.reason,
        branchChatUrl: event.branchChatUrl,
        launchTabId: event.launchTabId,
        launchWindowId: event.launchWindowId,
        surfaceMode: runtime.state.surfaceMode
      });
      runtime.state.launchTabId = event.launchTabId ?? runtime.state.launchTabId;
      runtime.state.launchWindowId = event.launchWindowId ?? runtime.state.launchWindowId;
      runtime.state.branchChatUrl = event.branchChatUrl
        ? normalizeChatUrl(event.branchChatUrl)
        : runtime.state.branchChatUrl;
      if (
        runtime.state.branchKind === 'persistent' &&
        runtime.state.surfaceMode === 'embedded' &&
        /never became a persistent chat url/i.test(event.reason)
      ) {
        void promotePersistentBranchToNativeWindow(runtime);
        return;
      }

      runtime.pendingFramePrompt = undefined;
      runtime.state.status = 'failed';
      runtime.state.creationMode = 'failed';
      runtime.state.statusLabel =
        runtime.state.surfaceMode === 'native_window'
          ? 'Native branch creation failed.'
          : 'Local branch creation failed.';
      runtime.state.errorMessage = event.reason;
      runtime.state.updatedAt = Date.now();
      syncPanelUI(runtime);
      persistPanels();
  }
}

function clearHighlightOverlay(): void {
  window.clearTimeout(highlightOverlayTimer);
  highlightOverlay?.remove();
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
  highlightOverlay = null;
  highlightOverlayTimer = undefined;
}

function renderHighlightRects(rects: DOMRect[]): void {
  clearHighlightOverlay();
  highlightOverlay = document.createElement('div');
  highlightOverlay.id = HIGHLIGHT_OVERLAY_ID;
  rects.forEach((rect) => {
    const highlight = document.createElement('div');
    highlight.className = 'aside-highlight-rect';
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlightOverlay?.append(highlight);
  });
  mountInExtensionHost(highlightOverlay);
  highlightOverlayTimer = window.setTimeout(clearHighlightOverlay, 2200);
}

function getFirstRangeRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  if (!rects.length) {
    return null;
  }

  rects.sort((left, right) => {
    if (left.top !== right.top) {
      return left.top - right.top;
    }
    return left.left - right.left;
  });

  return rects[0] ?? null;
}

function getScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;

  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY.toLowerCase();
    const isScrollable = /(auto|scroll|overlay)/.test(overflowY);
    if (isScrollable && current.scrollHeight > current.clientHeight + 4) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function scrollRectIntoView(rect: DOMRect, anchorElement: HTMLElement): void {
  const topOffset = Math.max(96, Math.round(window.innerHeight * 0.18));
  const scrollParent = getScrollableAncestor(anchorElement);

  if (!scrollParent) {
    const absoluteTop = window.scrollY + rect.top;
    window.scrollTo({
      top: Math.max(0, absoluteTop - topOffset),
      behavior: 'smooth'
    });
    return;
  }

  const parentRect = scrollParent.getBoundingClientRect();
  const delta = rect.top - parentRect.top - topOffset;
  scrollParent.scrollTo({
    top: Math.max(0, scrollParent.scrollTop + delta),
    behavior: 'smooth'
  });
}

function scrollToOrigin(selection: SelectionPayload): void {
  const target = findTurnElementByAnchor(selection);
  if (!target) {
    window.scrollTo({ top: selection.fallbackScrollY, behavior: 'smooth' });
    return;
  }

  const exactRange = findQuotedTextRangeInElement(target, {
    selectedText: selection.selectedText,
    rangeQuotes: selection.rangeQuotes
  });

  if (exactRange) {
    const firstRect = getFirstRangeRect(exactRange);
    if (firstRect) {
      target.classList.add('aside-origin-flash');
      window.setTimeout(() => target.classList.remove('aside-origin-flash'), 2200);
      scrollRectIntoView(firstRect, target);
      window.setTimeout(() => {
        renderHighlightRects(Array.from(exactRange.getClientRects()).map((rect) => rect as DOMRect));
      }, 250);
      return;
    }
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('aside-origin-flash');
  window.setTimeout(() => target.classList.remove('aside-origin-flash'), 2200);
  window.setTimeout(() => {
    renderHighlightRects([target.getBoundingClientRect()]);
  }, 250);
}

async function handleUrlChange(): Promise<void> {
  const nextUrl = normalizeChatUrl(window.location.href);
  if (nextUrl === lastKnownUrl) {
    return;
  }

  const currentConversationId = getRootConversationId(lastKnownUrl);
  const nextConversationId = getRootConversationId(nextUrl);

  if (nextConversationId === currentConversationId) {
    lastKnownUrl = nextUrl;
    panelRuntimes.forEach((runtime) => {
      if (runtime.state.rootConversationId === currentConversationId) {
        runtime.state.rootChatUrl = nextUrl;
        runtime.state.rootProjectUrl = getNonRootContainerUrl(nextUrl);
        runtime.state.updatedAt = Date.now();
      }
    });
    persistPanels();
    syncMountedUi();
    return;
  }

  if (
    nextConversationId === 'chat-home' &&
    currentConversationId !== 'chat-home' &&
    panelRuntimes.size > 0
  ) {
    const token = ++pendingUrlChangeToken;
    await sleep(1200);
    if (token !== pendingUrlChangeToken) {
      return;
    }

    const settledUrl = normalizeChatUrl(window.location.href);
    if (settledUrl !== nextUrl) {
      await handleUrlChange();
      return;
    }
  }

  await writePersistedPanels();
  clearPanelsForCurrentConversation();
  hideAskButton();
  lastKnownUrl = nextUrl;
  await restorePanels();
  syncMountedUi();
  scheduleMountedUiSync(350);
}

function installUrlObservers(): void {
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    const result = originalPushState(...args);
    queueMicrotask(() => {
      pendingUrlChangeToken += 1;
      void handleUrlChange();
    });
    return result;
  };

  history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    queueMicrotask(() => {
      pendingUrlChangeToken += 1;
      void handleUrlChange();
    });
    return result;
  };

  const popstateListener = () => {
    pendingUrlChangeToken += 1;
    void handleUrlChange();
  };

  window.addEventListener('popstate', popstateListener);

  cleanupFns.push(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener('popstate', popstateListener);
  });
}

function initTopFrame(): void {
  installThemeObserver();
  ensureStyles();
  ensureFrameAutomationStyles();
  installRuntimeMessageListener();
  syncMountedUi();
  void (async () => {
    await migrateLegacyPanelStorage();
    await loadLastUsedBranchKind();
    await restorePanels();
    syncMountedUi();
    scheduleMountedUiSync(350);
    scheduleMountedUiSync(1500);
  })();
  installSelectionActionObserver();
  refreshSelectionActionButtons();

  const selectionListener = () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(evaluateSelection, 120);
  };
  const mouseupListener = () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(evaluateSelection, 80);
  };
  const scrollListener = () => {
    if (selectionToolbar && !selectionToolbar.hidden) {
      hideSelectionToolbar();
      restoreSuppressedSelectionActions();
    }
  };
  const resizeListener = () => {
    syncMountedUi();
    scheduleAskTriggerSync(0);
  };
  const pageshowListener = () => {
    syncMountedUi();
    scheduleMountedUiSync(350);
  };
  const focusListener = () => {
    focusPendingDraftQuestionInput();
  };
  const visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      focusPendingDraftQuestionInput();
    }
  };
  const keydownListener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      const latestVisible = getVisiblePanels().at(-1);
      if (latestVisible) {
        minimizePanel(latestVisible.state.panelId);
      }
    }
  };

  document.addEventListener('selectionchange', selectionListener);
  document.addEventListener('mouseup', mouseupListener);
  window.addEventListener('scroll', scrollListener);
  window.addEventListener('resize', resizeListener);
  window.addEventListener('pageshow', pageshowListener);
  window.addEventListener('focus', focusListener);
  document.addEventListener('visibilitychange', visibilityListener);
  document.addEventListener('keydown', keydownListener);
  installUrlObservers();

  const frameMessageListener = (event: MessageEvent<FrameIncomingMessage>) => {
    handleEmbeddedFrameMessage(event);
  };
  window.addEventListener('message', frameMessageListener);
  cleanupFns.push(() => {
    window.removeEventListener('message', frameMessageListener);
  });

  cleanupFns.push(() => document.removeEventListener('selectionchange', selectionListener));
  cleanupFns.push(() => document.removeEventListener('mouseup', mouseupListener));
  cleanupFns.push(() => window.removeEventListener('scroll', scrollListener));
  cleanupFns.push(() => window.removeEventListener('resize', resizeListener));
  cleanupFns.push(() => window.removeEventListener('pageshow', pageshowListener));
  cleanupFns.push(() => window.removeEventListener('focus', focusListener));
  cleanupFns.push(() => document.removeEventListener('visibilitychange', visibilityListener));
  cleanupFns.push(() => document.removeEventListener('keydown', keydownListener));
}

function getDeepQueryRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [];
  const seen = new Set<Node>();

  const visit = (candidate: ParentNode | null | undefined): void => {
    if (!candidate) {
      return;
    }

    const node = candidate as unknown as Node;
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    roots.push(candidate);

    const traversalRoot =
      candidate instanceof Document
        ? candidate.documentElement
        : candidate instanceof ShadowRoot || candidate instanceof Element
          ? candidate
          : null;
    if (!traversalRoot) {
      return;
    }

    const walker = document.createTreeWalker(traversalRoot, NodeFilter.SHOW_ELEMENT);
    let current: Node | null = traversalRoot;
    while (current) {
      if (current instanceof HTMLElement && current.shadowRoot?.mode === 'open') {
        visit(current.shadowRoot);
      }
      current = walker.nextNode();
    }
  };

  visit(root);
  return roots;
}

function queryOne<T extends Element = HTMLElement>(selectors: string[], root: ParentNode = document): T | null {
  const searchRoots = getDeepQueryRoots(root);
  for (const selector of selectors) {
    for (const searchRoot of searchRoots) {
      const match = searchRoot.querySelector<T>(selector);
      if (match) {
        return match;
      }
    }
  }
  return null;
}

function queryMany<T extends Element = HTMLElement>(selectors: string[], root: ParentNode = document): T[] {
  const results: T[] = [];
  const seen = new Set<Element>();
  const searchRoots = getDeepQueryRoots(root);
  selectors.forEach((selector) => {
    searchRoots.forEach((searchRoot) => {
      Array.from(searchRoot.querySelectorAll<T>(selector)).forEach((match) => {
        if (seen.has(match)) {
          return;
        }
        seen.add(match);
        results.push(match);
      });
    });
  });
  return results;
}

function getComposerCandidates(): Array<HTMLElement | HTMLTextAreaElement> {
  const selectors = [
    '#prompt-textarea',
    'textarea#prompt-textarea',
    'textarea[placeholder]',
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-testid]',
    'div[role="textbox"][contenteditable="true"]'
  ];
  const seen = new Set<Element>();
  const candidates: Array<HTMLElement | HTMLTextAreaElement> = [];

  queryMany<HTMLElement | HTMLTextAreaElement>(selectors).forEach((candidate) => {
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  });
  return candidates;
}

function isDisabledElement(element: Element): boolean {
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.disabled;
  }

  return element.getAttribute('aria-disabled') === 'true';
}

function scoreComposerCandidate(candidate: HTMLElement | HTMLTextAreaElement): number {
  if (!isElementVisible(candidate) || isDisabledElement(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (candidate.getAttribute('readonly') === 'true' || candidate.hasAttribute('readonly')) {
    return Number.NEGATIVE_INFINITY;
  }

  const rect = candidate.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 24) {
    return Number.NEGATIVE_INFINITY;
  }

  const label = compactWhitespace(
    [
      candidate.id,
      candidate.getAttribute('name'),
      candidate.getAttribute('placeholder'),
      candidate.getAttribute('aria-label'),
      candidate.getAttribute('data-testid'),
      candidate.getAttribute('role')
    ]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  let score = 0;
  if (candidate.id === 'prompt-textarea') {
    score += 500;
  }
  if (candidate.closest('form')) {
    score += 120;
  }
  if (candidate instanceof HTMLTextAreaElement) {
    score += 80;
  }
  if (candidate.matches('div[contenteditable="true"]')) {
    score += 40;
  }
  if (candidate.getAttribute('role') === 'textbox') {
    score += 40;
  }
  if (/prompt|message|ask|chatgpt|question|send|发送|提问|问题|消息/.test(label)) {
    score += 140;
  }
  if (candidate.getAttribute('placeholder')) {
    score += 30;
  }

  score += Math.min(200, Math.round(rect.width / 4));
  score += Math.min(120, Math.round(rect.height * 2));
  score += Math.max(0, Math.round(rect.top / 3));
  score += Math.max(0, Math.round((window.innerHeight - Math.max(0, window.innerHeight - rect.bottom)) / 6));

  return score;
}

function describeComposerCandidate(candidate: HTMLElement | HTMLTextAreaElement): Record<string, unknown> {
  const rect = candidate.getBoundingClientRect();
  return {
    tag: candidate.tagName,
    id: candidate.id || null,
    name: candidate.getAttribute('name'),
    placeholder: candidate.getAttribute('placeholder'),
    ariaLabel: candidate.getAttribute('aria-label'),
    dataTestId: candidate.getAttribute('data-testid'),
    role: candidate.getAttribute('role'),
    hasForm: Boolean(candidate.closest('form')),
    rect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    score: scoreComposerCandidate(candidate)
  };
}

function findComposer(): HTMLElement | HTMLTextAreaElement | null {
  const candidates = getComposerCandidates()
    .map((candidate) => ({
      candidate,
      score: scoreComposerCandidate(candidate)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.candidate ?? null;
}

async function waitForComposer(timeoutMs = 20_000): Promise<HTMLElement | HTMLTextAreaElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = findComposer();
    if (composer) {
      return composer;
    }
    await sleep(250);
  }

  throw new Error('ChatGPT composer did not appear in time.');
}

function getComposerValueLength(composer: HTMLElement | HTMLTextAreaElement): number {
  return composer instanceof HTMLTextAreaElement
    ? composer.value.length
    : compactWhitespace(composer.textContent || '').length;
}

function refreshComposerReference(
  composer: HTMLElement | HTMLTextAreaElement
): HTMLElement | HTMLTextAreaElement {
  return findComposer() ?? composer;
}

async function focusComposerForFollowUp(timeoutMs = 5_000): Promise<void> {
  const composer = await waitForComposer(timeoutMs);
  composer.click();
  composer.focus();

  if (composer instanceof HTMLTextAreaElement) {
    const nextPosition = composer.value.length;
    composer.setSelectionRange(nextPosition, nextPosition);
  }

  recordAutomationLog('Composer focused for manual follow-up', {
    composerCandidate: describeComposerCandidate(composer)
  });
}

function describeComposerCandidateForLog(
  composer: HTMLElement | HTMLTextAreaElement,
  fallback?: Record<string, unknown>
): Record<string, unknown> {
  if (composer.isConnected) {
    const description = describeComposerCandidate(composer);
    const rect = description.rect as Record<string, number> | undefined;
    if (rect && ((rect.width ?? 0) > 0 || (rect.height ?? 0) > 0)) {
      return description;
    }
  }

  return fallback ?? describeComposerCandidate(composer);
}

function fillComposer(
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string,
  inputType: 'insertText' | 'insertFromPaste' = 'insertText'
): void {
  composer.click();
  composer.focus();

  if (composer instanceof HTMLTextAreaElement) {
    composer.setSelectionRange(0, composer.value.length);
    composer.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: prompt,
        inputType
      })
    );
    try {
      composer.setRangeText(prompt, 0, composer.value.length, 'end');
    } catch {
      // Fall back to the native setter below if setRangeText is unavailable.
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(composer, prompt);
    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: prompt,
        inputType
      })
    );
    composer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA' }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', code: 'KeyA' }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  try {
    document.execCommand('insertText', false, prompt);
  } catch {
    composer.textContent = prompt;
  }

  composer.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: prompt,
      inputType
    })
  );
}

async function fillComposerWithStrategies(
  composer: HTMLElement | HTMLTextAreaElement,
  prompt: string
): Promise<{
  composer: HTMLElement | HTMLTextAreaElement;
  strategy: 'insertText' | 'insertFromPaste';
  valueLength: number;
}> {
  const strategies: Array<'insertText' | 'insertFromPaste'> = ['insertText', 'insertFromPaste'];
  let activeComposer = composer;
  let bestResult = {
    composer: activeComposer,
    strategy: strategies[0],
    valueLength: getComposerValueLength(activeComposer)
  };

  for (const strategy of strategies) {
    fillComposer(activeComposer, prompt, strategy);
    await sleep(120);
    activeComposer = refreshComposerReference(activeComposer);
    const valueLength = getComposerValueLength(activeComposer);
    recordAutomationLog('Composer fill strategy attempted', {
      strategy,
      valueLength,
      composerCandidate: describeComposerCandidateForLog(activeComposer)
    });

    if (valueLength >= bestResult.valueLength) {
      bestResult = {
        composer: activeComposer,
        strategy,
        valueLength
      };
    }

    if (valueLength >= prompt.length) {
      return {
        composer: activeComposer,
        strategy,
        valueLength
      };
    }
  }

  return bestResult;
}

function getSendButtonCandidates(scope: ParentNode): HTMLElement[] {
  return queryMany<HTMLElement>(
    [
      'button',
      '[role="button"]',
      'input[type="submit"]',
      'input[type="image"]',
      '[data-testid="send-button"]'
    ],
    scope
  );
}

function describeSendButtonCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null,
  score = scoreSendButtonCandidate(candidate, composer)
): Record<string, unknown> {
  const rect = candidate.getBoundingClientRect();
  const profile = getSendCandidateProfile(candidate, composer);
  return {
    tag: candidate.tagName,
    role: candidate.getAttribute('role'),
    type: candidate instanceof HTMLButtonElement ? candidate.type : null,
    ariaLabel: candidate.getAttribute('aria-label'),
    title: candidate.getAttribute('title'),
    dataTestId: candidate.getAttribute('data-testid'),
    label: getActionLabel(candidate),
    disabled: isDisabledElement(candidate),
    explicitSend: profile.explicitSend,
    negative: profile.negative,
    temporaryChat: profile.temporaryChat,
    submitLike: profile.submitLike,
    sameForm: profile.sameForm,
    rect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    score
  };
}

function getTemporaryChatControlCandidates(scope: ParentNode): HTMLElement[] {
  const selectors = [
    'button[aria-label*="临时聊天"]',
    'button[title*="临时聊天"]',
    '[role="button"][aria-label*="临时聊天"]',
    '[role="button"][title*="临时聊天"]',
    'button[aria-label*="temporary"]',
    'button[title*="temporary"]',
    '[role="button"][aria-label*="temporary"]',
    '[role="button"][title*="temporary"]'
  ];
  const seen = new Set<HTMLElement>();
  const matches = queryMany<HTMLElement>(selectors, scope);
  const buttons = getSendButtonCandidates(scope).filter((candidate) => isTemporaryChatControl(candidate));

  return [...matches, ...buttons].filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function getComposerSearchScopes(
  composer?: HTMLElement | HTMLTextAreaElement | null
): ParentNode[] {
  const scopes: ParentNode[] = [];
  const localScope = composer?.closest('form') ?? composer?.parentElement ?? null;
  if (localScope) {
    scopes.push(localScope);
  }
  scopes.push(document);
  return scopes;
}

function findDirectTemporaryChatControl(
  composer?: HTMLElement | HTMLTextAreaElement | null,
  targetState: 'active' | 'any' = 'any'
): HTMLElement | null {
  const activeSelectors = [
    'button[aria-label*="临时聊天"][aria-pressed="true"]',
    'button[aria-label*="临时聊天"][aria-checked="true"]',
    '[role="button"][aria-label*="临时聊天"][aria-pressed="true"]',
    '[role="button"][aria-label*="临时聊天"][aria-checked="true"]',
    'button[aria-label*="temporary"][aria-pressed="true"]',
    'button[aria-label*="temporary"][aria-checked="true"]',
    '[role="button"][aria-label*="temporary"][aria-pressed="true"]',
    '[role="button"][aria-label*="temporary"][aria-checked="true"]'
  ];
  const anySelectors = [
    'button[aria-label*="临时聊天"]',
    'button[title*="临时聊天"]',
    '[role="button"][aria-label*="临时聊天"]',
    '[role="button"][title*="临时聊天"]',
    'button[aria-label*="temporary"]',
    'button[title*="temporary"]',
    '[role="button"][aria-label*="temporary"]',
    '[role="button"][title*="temporary"]'
  ];

  for (const scope of getComposerSearchScopes(composer)) {
    const direct =
      targetState === 'active'
        ? queryOne<HTMLElement>(activeSelectors, scope)
        : queryOne<HTMLElement>(anySelectors, scope);
    if (direct) {
      return direct;
    }
  }

  return null;
}

function scoreTemporaryChatCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): number {
  if (isDisabledElement(candidate) || !isTemporaryChatControl(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  const rect = candidate.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  const inferredState = inferTemporaryChatState(candidate);
  let score = 0;

  if (isElementVisible(candidate)) {
    score += 120;
  }
  if (composer?.closest('form') && candidate.closest('form') === composer.closest('form')) {
    score += 250;
  }
  if (candidate instanceof HTMLButtonElement && candidate.type === 'submit') {
    score += 120;
  }
  if (inferredState === 'active') {
    score += 180;
  }
  if (inferredState === 'inactive') {
    score += 60;
  }
  if (composerRect) {
    const horizontalGap = Math.abs(rect.left - composerRect.right);
    const verticalGap = Math.abs(rect.top - composerRect.top);
    score += Math.max(0, 200 - Math.round(horizontalGap));
    score += Math.max(0, 140 - Math.round(verticalGap));
  }

  return score;
}

function describeTemporaryChatCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null,
  score = scoreTemporaryChatCandidate(candidate, composer)
): Record<string, unknown> {
  return {
    ...describeSendButtonCandidate(candidate, composer, score),
    inferredState: inferTemporaryChatState(candidate)
  };
}

function activateControl(candidate: HTMLElement): void {
  candidate.focus();
  const rect = candidate.getBoundingClientRect();
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2)
  };

  if (window.PointerEvent) {
    ['pointerdown', 'pointerup'].forEach((type) => {
      candidate.dispatchEvent(
        new window.PointerEvent(type, {
          ...eventInit,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        })
      );
    });
  }

  ['mousedown', 'mouseup', 'click'].forEach((type) => {
    candidate.dispatchEvent(new MouseEvent(type, eventInit));
  });
}

function getRankedTemporaryChatControls(
  composer?: HTMLElement | HTMLTextAreaElement | null
): Array<{ candidate: HTMLElement; score: number }> {
  const seen = new Set<HTMLElement>();
  return getComposerSearchScopes(composer)
    .flatMap((scope) => getTemporaryChatControlCandidates(scope))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: scoreTemporaryChatCandidate(candidate, composer)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
}

async function ensurePersistentChatMode(
  composer: HTMLElement | HTMLTextAreaElement
): Promise<void> {
  const directActiveControl = findDirectTemporaryChatControl(composer, 'active');
  const directAnyControl = directActiveControl ?? findDirectTemporaryChatControl(composer, 'any');
  const candidates = getRankedTemporaryChatControls(composer);
  recordAutomationLog('Detected temporary chat controls', {
    directActiveControl: directActiveControl
      ? describeTemporaryChatCandidate(directActiveControl, composer)
      : null,
    directAnyControl: directAnyControl ? describeTemporaryChatCandidate(directAnyControl, composer) : null,
    candidates: candidates
      .slice(0, 8)
      .map((entry) => describeTemporaryChatCandidate(entry.candidate, composer, entry.score))
  });

  const primaryCandidate = directActiveControl ?? directAnyControl ?? candidates[0]?.candidate ?? null;
  const primaryScore = primaryCandidate ? scoreTemporaryChatCandidate(primaryCandidate, composer) : undefined;

  if (!primaryCandidate) {
    return;
  }

  const primaryState = inferTemporaryChatState(primaryCandidate);

  if (primaryState === 'inactive') {
    recordAutomationLog('Temporary chat control is present but inactive', {
      control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore),
      toggledOff: false
    });
    return;
  }

  if (primaryState === 'unknown') {
    throw new Error(
      'ChatGPT temporary-chat mode could not be determined confidently; persistent branch creation cannot continue.'
    );
  }

  recordAutomationLog('Temporary chat mode appears active; disabling it before send', {
    control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore),
    toggledOff: false
  });
  primaryCandidate.click();

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const refreshedActive = findDirectTemporaryChatControl(composer, 'active');
    const refreshedAny = refreshedActive ?? findDirectTemporaryChatControl(composer, 'any');
    if (!refreshedAny) {
      recordAutomationLog('Temporary chat control disappeared after toggle', {
        toggledOff: true
      });
      return;
    }

    const nextState = inferTemporaryChatState(refreshedAny);
    if (nextState === 'inactive') {
      recordAutomationLog('Temporary chat mode disabled successfully', {
        control: describeTemporaryChatCandidate(refreshedAny, composer),
        toggledOff: true
      });
      return;
    }

    await sleep(200);
  }

  throw new Error(
    'ChatGPT is in temporary-chat mode; persistent branch creation cannot continue.'
  );
}

async function ensureTemporaryChatMode(
  composer: HTMLElement | HTMLTextAreaElement
): Promise<TemporaryChatVerification> {
  const directActiveControl = findDirectTemporaryChatControl(composer, 'active');
  const directAnyControl = directActiveControl ?? findDirectTemporaryChatControl(composer, 'any');
  const candidates = getRankedTemporaryChatControls(composer);
  recordAutomationLog('Detected temporary chat controls for temporary branch', {
    directActiveControl: directActiveControl
      ? describeTemporaryChatCandidate(directActiveControl, composer)
      : null,
    directAnyControl: directAnyControl ? describeTemporaryChatCandidate(directAnyControl, composer) : null,
    candidates: candidates
      .slice(0, 8)
      .map((entry) => describeTemporaryChatCandidate(entry.candidate, composer, entry.score))
  });

  const primaryCandidate = directActiveControl ?? directAnyControl ?? candidates[0]?.candidate ?? null;
  const primaryScore = primaryCandidate ? scoreTemporaryChatCandidate(primaryCandidate, composer) : undefined;

  if (!primaryCandidate) {
    throw new Error(
      'ChatGPT temporary-chat mode could not be enabled confidently; temporary branch creation cannot continue.'
    );
  }

  const primaryState = inferTemporaryChatState(primaryCandidate);
  if (primaryState === 'active') {
    recordAutomationLog('Temporary chat mode is already active', {
      control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore)
    });
    return 'confirmed';
  }

  if (primaryState === 'unknown') {
    throw new Error(
      'ChatGPT temporary-chat mode could not be determined confidently; temporary branch creation cannot continue.'
    );
  }

  recordAutomationLog('Temporary chat mode appears inactive; enabling it before send', {
    control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore)
  });
  activateControl(primaryCandidate);

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const refreshedActive = findDirectTemporaryChatControl(composer, 'active');
    const refreshedAny = refreshedActive ?? findDirectTemporaryChatControl(composer, 'any');
    if (!refreshedAny) {
      recordAutomationLog('Temporary chat control disappeared after activation; proceeding optimistically', {
        verification: 'assumed'
      });
      return 'assumed';
    }

    const nextState = inferTemporaryChatState(refreshedAny);
    if (nextState === 'active') {
      recordAutomationLog('Temporary chat mode enabled successfully', {
        control: describeTemporaryChatCandidate(refreshedAny, composer)
      });
      return 'confirmed';
    }

    await sleep(200);
  }

  recordAutomationLog('Temporary chat mode could not be confirmed after activation; proceeding optimistically', {
    control: describeTemporaryChatCandidate(primaryCandidate, composer, primaryScore),
    verification: 'assumed'
  });
  return 'assumed';
}

async function ensureBranchKindMode(
  branchKind: BranchKind,
  composer: HTMLElement | HTMLTextAreaElement
): Promise<TemporaryChatVerification> {
  if (branchKind === 'temporary') {
    return ensureTemporaryChatMode(composer);
  }

  await ensurePersistentChatMode(composer);
  return 'confirmed';
}

function scoreSendButtonCandidate(
  candidate: HTMLElement,
  composer?: HTMLElement | HTMLTextAreaElement | null
): number {
  if (!isElementVisible(candidate) || isDisabledElement(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }

  const profile = getSendCandidateProfile(candidate, composer);
  const rect = candidate.getBoundingClientRect();
  const composerRect = composer?.getBoundingClientRect();
  let score = 0;

  if (!isAcceptableSendControl(profile)) {
    return Number.NEGATIVE_INFINITY;
  }

  if (candidate.getAttribute('data-testid') === 'send-button') {
    score += 900;
  }
  if (profile.submitLike) {
    score += 500;
  }
  if (profile.explicitSend) {
    score += 400;
  }
  if (profile.sameForm) {
    score += 200;
  }
  if (!profile.label && candidate.querySelector('svg')) {
    score += 60;
  }
  if (composerRect) {
    const horizontalGap = Math.abs(rect.left - composerRect.right);
    const verticalGap = Math.abs(rect.top - composerRect.top);
    score += Math.max(0, 220 - Math.round(horizontalGap));
    score += Math.max(0, 140 - Math.round(verticalGap));
    if (profile.sameForm) {
      score += Math.max(0, 180 - Math.round(horizontalGap * 1.4));
    }
  }

  return score;
}

function getRankedSendButtons(
  composer?: HTMLElement | HTMLTextAreaElement | null
): Array<{ candidate: HTMLElement; score: number }> {
  const scopes: ParentNode[] = [];
  const localScope = composer?.closest('form') ?? composer?.parentElement ?? null;
  if (localScope) {
    scopes.push(localScope);
  }
  scopes.push(document);

  const seen = new Set<HTMLElement>();
  const ranked = scopes
    .flatMap((scope) => getSendButtonCandidates(scope))
    .filter((candidate) => {
      if (seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: scoreSendButtonCandidate(candidate, composer)
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  const sameForm = ranked.filter((entry) => getSendCandidateProfile(entry.candidate, composer).sameForm);
  if (sameForm.length) {
    const nonSameForm = ranked.filter((entry) => !getSendCandidateProfile(entry.candidate, composer).sameForm);
    return [...sameForm, ...nonSameForm];
  }

  return ranked;
}

async function waitForAcceptedGenerationSignalOrNull(
  baselineTurnCount: number,
  initialUrl: string,
  timeoutMs = 2_500
): Promise<'persistent_url' | 'stop_button' | 'transcript_growth' | null> {
  try {
    return await waitForAcceptedGenerationSignal(baselineTurnCount, initialUrl, timeoutMs);
  } catch {
    return null;
  }
}

function findStopButton(): HTMLButtonElement | null {
  return queryOne<HTMLButtonElement>([
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    'button[aria-label*="停止"]'
  ]);
}

function isPersistentConversationUrl(url: string): boolean {
  try {
    return /\/c\/[^/?#]+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function waitForAcceptedGenerationSignal(
  baselineTurnCount: number,
  initialUrl: string,
  timeoutMs = 12_000
): Promise<'persistent_url' | 'stop_button' | 'transcript_growth'> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = normalizeChatUrl(window.location.href);
    if (currentUrl !== initialUrl && isPersistentConversationUrl(currentUrl)) {
      return 'persistent_url';
    }

    if (findStopButton()) {
      return 'stop_button';
    }

    if (extractTranscript(document).length > baselineTurnCount) {
      return 'transcript_growth';
    }

    await sleep(250);
  }

  throw new Error(
    'ChatGPT did not start generating the branch question. No persistent chat URL, stop button, or new transcript turn appeared.'
  );
}

async function submitComposer(
  prompt: string,
  branchKind: BranchKind
): Promise<{
  acceptedSignal: 'persistent_url' | 'stop_button' | 'transcript_growth';
  temporaryVerification: TemporaryChatVerification;
}> {
  recordAutomationLog('Submitting first branch prompt', {
    promptLength: prompt.length,
    currentUrl: normalizeChatUrl(window.location.href)
  });
  const initialUrl = normalizeChatUrl(window.location.href);
  const baselineTurnCount = extractTranscript(document).length;
  let composer = await waitForComposer();
  let composerSnapshot = describeComposerCandidate(composer);
  let form = composer.closest('form');
  recordAutomationLog('Composer found for first branch prompt', {
    composerTag: composer.tagName,
    composerCandidate: composerSnapshot,
    baselineTurnCount,
    hasForm: form instanceof HTMLFormElement
  });
  const fillResult = await fillComposerWithStrategies(composer, prompt);
  composer = fillResult.composer;
  composerSnapshot = describeComposerCandidateForLog(composer, composerSnapshot);
  form = composer.closest('form');
  recordAutomationLog('Composer filled for first branch prompt', {
    strategy: fillResult.strategy,
    valueLength: fillResult.valueLength,
    composerCandidate: composerSnapshot
  });
  await sleep(450);
  const temporaryVerification = await ensureBranchKindMode(branchKind, composer);

  const logVisibleButtonContext = (label: string) => {
    const currentComposer = refreshComposerReference(composer);
    const currentSnapshot = describeComposerCandidateForLog(currentComposer, composerSnapshot);
    recordAutomationLog(label, {
      composerCandidate: currentSnapshot,
      buttonCandidates: getSendButtonCandidates(document)
        .filter((candidate) => isElementVisible(candidate))
        .slice(0, 16)
        .map((candidate) => describeSendButtonCandidate(candidate, currentComposer)),
      temporaryChatCandidates: getRankedTemporaryChatControls(currentComposer)
        .slice(0, 8)
        .map((entry) => describeTemporaryChatCandidate(entry.candidate, currentComposer, entry.score)),
      temporaryVerification
    });
  };

  const attemptClickSendButton = async (
    stage: 'primary' | 'final_rescan',
    timeoutMs = 3_500
  ): Promise<'persistent_url' | 'stop_button' | 'transcript_growth' | null> => {
    composer = refreshComposerReference(composer);
    composerSnapshot = describeComposerCandidateForLog(composer, composerSnapshot);
    form = composer.closest('form');
    const rankedSendButtons = getRankedSendButtons(composer);
    const sendButton = rankedSendButtons[0]?.candidate ?? null;
    recordAutomationLog(
      stage === 'primary'
        ? 'Resolved send button for first branch prompt'
        : 'Resolved send button after fallback re-scan',
      {
        found: Boolean(sendButton),
        sendButtonLabel: sendButton ? getActionLabel(sendButton) : '(none)',
        sendButton: sendButton
          ? describeSendButtonCandidate(sendButton, composer, rankedSendButtons[0]?.score)
          : null,
        composerCandidate: composerSnapshot,
        sendButtonCandidates: rankedSendButtons
          .slice(0, 8)
          .map((entry) => describeSendButtonCandidate(entry.candidate, composer, entry.score))
      }
    );

    if (!sendButton) {
      return null;
    }

    recordAutomationLog(
      stage === 'primary'
        ? 'Clicking ChatGPT send button for first branch prompt'
        : 'Clicking send button after fallback re-scan',
      {
        sendButtonLabel: getActionLabel(sendButton),
        sendButton: describeSendButtonCandidate(sendButton, composer, rankedSendButtons[0]?.score)
      }
    );
    activateControl(sendButton);

    const signal = await waitForAcceptedGenerationSignalOrNull(
      baselineTurnCount,
      initialUrl,
      timeoutMs
    );
    if (signal) {
      recordAutomationLog('ChatGPT accepted the prompt after send button click', {
        stage,
        acceptedSignal: signal,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      return signal;
    }

    recordAutomationLog('No generation signal appeared after send button click', {
      stage,
      timeoutMs,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    return null;
  };

  const primarySendSignal = await attemptClickSendButton('primary');
  if (primarySendSignal) {
    return { acceptedSignal: primarySendSignal, temporaryVerification };
  }

  logVisibleButtonContext('No enabled send button produced a generation signal near the composer');
  recordAutomationLog('Dispatching Enter key fallback for first branch prompt', {
    hasForm: form instanceof HTMLFormElement
  });
  ['keydown', 'keypress', 'keyup'].forEach((eventType) => {
    composer.dispatchEvent(
      new KeyboardEvent(eventType, {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
        code: 'Enter'
      })
    );
  });

  const enterSignal = await waitForAcceptedGenerationSignalOrNull(
    baselineTurnCount,
    initialUrl,
    2_500
  );
  if (enterSignal) {
    recordAutomationLog('ChatGPT accepted the prompt after Enter fallback', {
      acceptedSignal: enterSignal,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    return { acceptedSignal: enterSignal, temporaryVerification };
  }

  recordAutomationLog('No generation signal appeared after Enter fallback', {
    currentUrl: normalizeChatUrl(window.location.href)
  });

  if (form instanceof HTMLFormElement) {
    recordAutomationLog('Attempting guarded synthetic submit fallback for first branch prompt', {
      action: 'dispatch-submit-event'
    });
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    const syntheticSignal = await waitForAcceptedGenerationSignalOrNull(
      baselineTurnCount,
      initialUrl,
      2_500
    );
    if (syntheticSignal) {
      recordAutomationLog('ChatGPT accepted the prompt after guarded synthetic submit', {
        acceptedSignal: syntheticSignal,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      return { acceptedSignal: syntheticSignal, temporaryVerification };
    }

    recordAutomationLog('No generation signal appeared after guarded synthetic submit', {
      currentUrl: normalizeChatUrl(window.location.href)
    });
  }

  const rescannedSignal = await attemptClickSendButton('final_rescan', 4_500);
  if (rescannedSignal) {
    return { acceptedSignal: rescannedSignal, temporaryVerification };
  }

  logVisibleButtonContext('All embedded submit strategies were attempted without a generation signal');

  const acceptedSignal = await waitForAcceptedGenerationSignal(baselineTurnCount, initialUrl);
  recordAutomationLog('ChatGPT accepted first branch prompt', {
    baselineTurnCount,
    currentTurnCount: extractTranscript(document).length,
    acceptedSignal,
    currentUrl: normalizeChatUrl(window.location.href),
    stopButtonVisible: Boolean(findStopButton())
  });
  return { acceptedSignal, temporaryVerification };
}

async function waitForConversationUrlAfterSubmit(launchUrl: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = normalizeChatUrl(window.location.href);
    if (isPersistentConversationUrl(currentUrl)) {
      recordAutomationLog('Persistent branch conversation URL detected', { branchChatUrl: currentUrl });
      return currentUrl;
    }
    await sleep(300);
  }

  const currentUrl = normalizeChatUrl(window.location.href) || launchUrl;
  recordAutomationLog('Persistent branch conversation URL was not detected before timeout', {
    launchUrl,
    currentUrl
  });
  throw new Error(
    `ChatGPT started responding, but the branch never became a persistent chat URL. It stayed at ${currentUrl}.`
  );
}

let activeAutomationPanelId: string | undefined;
let activeAutomationTransport: AutomationTransport | undefined;
let automationTaskRunning = false;
let titleWatcherId: number | undefined;
let observedBranchTitle = '';

async function sendAutomationEvent(event: BranchPanelEvent): Promise<void> {
  if (!activeAutomationPanelId || !activeAutomationTransport) {
    return;
  }

  if (activeAutomationTransport === 'frame') {
    if (isTopFrame()) {
      return;
    }

    window.parent.postMessage(
      {
        source: 'aside',
        target: 'parent',
        type: 'SB_FRAME_EVENT',
        panelId: activeAutomationPanelId,
        event
      } satisfies FrameBranchEventMessage,
      window.location.origin
    );
    return;
  }

  if (!hasRuntimeAccess()) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: 'BRANCH_AUTOMATION_EVENT',
      panelId: activeAutomationPanelId,
      event
    });
  } catch (error) {
    if (!isInvalidatedError(error)) {
      console.warn('[Aside] Failed to forward automation event', error);
    }
  }
}

function findBranchTitleFromTranscript(): string | null {
  const assistantTurns = extractTranscript(document)
    .filter((turn) => turn.role === 'assistant')
    .reverse();

  for (const turn of assistantTurns) {
    const parsed = stripHiddenTitle(turn.text);
    if (parsed.title) {
      return parsed.title;
    }
  }

  return null;
}

function stripTitleEnvelopeFromVisibleMessage(): void {
  const candidates = queryMany<HTMLElement>([
    '[data-message-author-role="assistant"] [data-message-content]',
    'article[data-message-author-role="assistant"] [data-message-content]',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose'
  ]);

  const markerPattern = /\[\[BRANCH_TITLE:.*?\]\]\s*/i;

  candidates.forEach((candidate) => {
    const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nextValue = (node.nodeValue ?? '').replace(markerPattern, '');
      if (nextValue !== (node.nodeValue ?? '')) {
        node.nodeValue = nextValue;
        return;
      }
    }
  });
}

function stopTitleWatcher(): void {
  if (titleWatcherId) {
    window.clearInterval(titleWatcherId);
    titleWatcherId = undefined;
  }
}

function startTitleWatcher(): void {
  if (titleWatcherId) {
    return;
  }

  const startedAt = Date.now();
  titleWatcherId = window.setInterval(() => {
    const title = findBranchTitleFromTranscript();
    if (title && title !== observedBranchTitle) {
      observedBranchTitle = title;
      void sendAutomationEvent({ kind: 'title', title });
      stripTitleEnvelopeFromVisibleMessage();
      stopTitleWatcher();
      return;
    }

    if (Date.now() - startedAt > TITLE_WATCH_TIMEOUT_MS) {
      stopTitleWatcher();
      stripTitleEnvelopeFromVisibleMessage();
    }
  }, 1200);
}

async function runBranchPromptAutomation(
  message: FrameStartBranchMessage | RunBranchPromptInTabMessage,
  transport: AutomationTransport
): Promise<void> {
  if (automationTaskRunning) {
    return;
  }
  activeAutomationPanelId = message.panelId;
  activeAutomationTransport = transport;
  observedBranchTitle = '';
  automationTaskRunning = true;
  recordAutomationLog('Resuming frame task', {
    taskStatus: 'submitting-prompt',
    branchKind: message.branchKind,
    launchUrl: message.launchUrl,
    currentUrl: normalizeChatUrl(window.location.href)
  });

  try {
    await sendAutomationEvent({
      kind: 'status',
      status: 'opening_branch',
      statusLabel:
        transport === 'background'
          ? 'Sending the local branch question in a native ChatGPT window...'
          : 'Sending the local branch question in this branch window...'
    });

    if (transport === 'background') {
      recordAutomationLog('Allowing the native ChatGPT window to settle before submit', {
        delayMs: 1200,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      await sleep(1200);
    }

    const { acceptedSignal, temporaryVerification } = await submitComposer(
      message.prompt,
      message.branchKind
    );
    const immediateBranchUrl = isPersistentConversationUrl(normalizeChatUrl(window.location.href))
      ? normalizeChatUrl(window.location.href)
      : undefined;

    if (message.branchKind === 'temporary') {
      if (temporaryVerification === 'assumed' && immediateBranchUrl) {
        throw new Error(
          'ChatGPT opened a persistent chat after temporary mode could not be confirmed.'
        );
      }
      recordAutomationLog('Temporary branch accepted generation signal', {
        acceptedSignal,
        temporaryVerification,
        branchChatUrl: immediateBranchUrl ?? null,
        currentUrl: normalizeChatUrl(window.location.href)
      });
      await sendAutomationEvent({ kind: 'live', branchChatUrl: immediateBranchUrl });
      startTitleWatcher();
      if (transport === 'background') {
        try {
          await focusComposerForFollowUp();
        } catch (error) {
          recordAutomationLog('Follow-up composer focus did not complete', {
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return;
    }

    await sendAutomationEvent({
      kind: 'status',
      status: 'opening_branch',
      statusLabel: 'Waiting for ChatGPT to create a persistent branch URL...'
    });
    recordAutomationLog('Waiting for persistent branch URL after accepted generation signal', {
      acceptedSignal,
      launchUrl: message.launchUrl,
      currentUrl: normalizeChatUrl(window.location.href)
    });
    const branchChatUrl = await waitForConversationUrlAfterSubmit(
      message.launchUrl ?? normalizeChatUrl(window.location.href)
    );
    await sendAutomationEvent({ kind: 'live', branchChatUrl });
    startTitleWatcher();
    if (transport === 'background') {
      try {
        await focusComposerForFollowUp();
      } catch (error) {
        recordAutomationLog('Follow-up composer focus did not complete', {
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown frame error';
    recordAutomationLog('Frame task failed', {
      reason
    });
    await sendAutomationEvent({
      kind: 'failed',
      reason
    });
  } finally {
    automationTaskRunning = false;
  }
}

function cleanup(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  stopTitleWatcher();
}

function initEmbeddedFrame(): void {
  ensureFrameAutomationStyles();

  const postReady = () => {
    window.parent.postMessage(
      {
        source: 'aside',
        target: 'parent',
        type: 'SB_FRAME_READY',
        currentUrl: normalizeChatUrl(window.location.href)
      } satisfies FrameReadyMessage,
      window.location.origin
    );
  };

  const frameMessageListener = (event: MessageEvent<FrameStartBranchMessage>) => {
    const data = event.data;
    if (
      !data ||
      typeof data !== 'object' ||
      data.source !== 'aside' ||
      data.target !== 'frame' ||
      data.type !== 'SB_FRAME_START_BRANCH'
    ) {
      return;
    }

    void runBranchPromptAutomation(data, 'frame');
  };

  window.addEventListener('message', frameMessageListener);
  window.addEventListener('pageshow', postReady);
  cleanupFns.push(() => window.removeEventListener('message', frameMessageListener));
  cleanupFns.push(() => window.removeEventListener('pageshow', postReady));

  postReady();
}

function init(): void {
  window.__asideCleanup?.();
  window.__asideCleanup = cleanup;

  if (isTopFrame()) {
    initTopFrame();
    return;
  }

  initEmbeddedFrame();
}

init();
