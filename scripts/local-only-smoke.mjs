import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const extensionPath = path.join(root, 'dist');
const profilePath = process.env.SMOKE_PROFILE ?? '/tmp/aside-embedded-smoke';
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headless = process.env.HEADLESS !== 'false';
// The native-window scenarios used to be opt-in because extension-created windows raced
// request interception and loaded the real chatgpt.com. Interception is now installed
// before a new target runs, so they are part of the default run.
const includeNativeWindowSmoke = process.env.SKIP_NATIVE_WINDOW_SMOKE !== 'true';

let routeMap = {};

/** Paths the fixture server should refuse to let be framed. Reset per scenario. */
let refuseFramingForPaths = [];
let claudeRouteMap = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unique per-run text so a storage assertion cannot be satisfied by another
// scenario's content in the shared browser profile.
const PRIVATE_PROBE_QUESTION = 'private probe marker 4711';

const LAYOUT_CHROME_CSS = `    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, sans-serif; }
      nav[aria-label="Chat history"] {
        position: fixed; top: 0; left: 0; bottom: 0; width: 260px;
        background: #f6f6f6; border-right: 1px solid #e5e5e5; padding: 12px;
      }
      body[data-sidebar="collapsed"] nav[aria-label="Chat history"] { width: 56px; }
      main {
        margin-left: 260px; min-height: 100vh; padding: 72px 0 140px;
        display: flex; flex-direction: column; align-items: center;
      }
      body[data-sidebar="collapsed"] main { margin-left: 56px; }
      main article, main #turns { width: min(760px, 70%); }
      main header { position: fixed; top: 0; left: 260px; right: 0; height: 56px; background: #fff; }
      #composer-form, form#composer-form {
        position: sticky; bottom: 16px; width: min(760px, 70%); margin-top: auto;
      }
      #search-form { width: min(760px, 70%); }
    </style>`;

const SIDEBAR_MARKUP = '<nav aria-label="Chat history"><div>Recent chats</div></nav>';

function buildSourceHtml({ dark = false, sidebar = 'open' } = {}) {
  const htmlClass = dark ? ' class="dark" data-theme="dark"' : '';
  return `<!doctype html>
<html${htmlClass}>
  <head><meta charset="utf-8"><title>Fake ChatGPT Source</title>
${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="${sidebar}">
    ${SIDEBAR_MARKUP}
    <main>
      <header>Fake header</header>
      <article data-message-author-role="user">
        <p>Tell me about convexity.</p>
      </article>
      <article data-message-author-role="assistant">
        <div data-message-content>
          <p>The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.</p>
          <p>Older unrelated details should not matter.</p>
        </div>
      </article>
    </main>
  </body>
</html>`;
}

function buildSuccessComposerHtml({
  conversationPath,
  dark = false,
  includeDecoyComposer = false,
  includeConfusingAction = false,
  includeTemporaryChatToggle = false,
  temporaryChatInitiallyActive = false,
  temporaryChatDisableable = true,
  temporaryChatEnableable = true,
  temporaryChatActivationStyle = 'visible',
  temporaryChatChooser = false,
  temporaryModeSkipsConversationUrl = false,
  conversationUrlMode = 'always',
  conversationUrlStorageKey = '__asideSubmitCount',
  realComposerId = 'prompt-textarea',
  realSendMode = 'explicit',
  enterOnlySubmit = false,
  sendInShadowRoot = false,
  assistantReplyText = 'This uses only the selected passage.'
}) {
  const htmlClass = dark ? ' class="dark" data-theme="dark"' : '';
  const fakeAnswerMarkup = `
    <article data-message-author-role="user"><div data-message-content></div></article>
    <article data-message-author-role="assistant">
      <div data-message-content>${assistantReplyText}</div>
    </article>`;
  const decoyComposerMarkup = includeDecoyComposer
    ? `
    <form id="search-form">
      <textarea placeholder="Search chats"></textarea>
      <button type="button" aria-label="Search">Search</button>
    </form>`
    : '';
  const confusingActionMarkup = includeConfusingAction
    ? `<button type="button" aria-label="开始群聊" style="position:fixed;right:32px;bottom:48px;">开始群聊</button>`
    : '';
  // 'menu' models the live ChatGPT shape from the owner's log: the control exists,
  // is enabled, and has a 0x0 box because it sits inside a closed composer menu.
  // Once selected, the menu closes and the mode shows as an interface indicator.
  const temporaryChatMarkup = includeTemporaryChatToggle
    ? temporaryChatActivationStyle === 'menu'
      ? `<button id="composer-tools" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Tools">+</button>
      <div id="composer-menu" role="menu" data-state="closed" style="display:none">
        <button id="temporary-chat-toggle" type="button" role="menuitem" aria-label="开启临时聊天">开启临时聊天</button>
      </div>
      <div id="temporary-indicator" data-testid="temporary-chat-indicator" data-state="off" style="display:none">Temporary chat</div>`
      : `<button id="temporary-chat-toggle" type="submit" aria-label="开启临时聊天">开启临时聊天</button>`
    : '';
  const chooserMarkup = temporaryChatChooser
    ? `<div id="temporary-chooser" role="dialog" aria-modal="true" style="display:none;position:fixed;left:20%;top:30%;width:60%;background:#fff;border:1px solid #999;padding:16px;">
        <p>Temporary chat: Personalized or Unpersonalized?</p>
        <button id="chooser-personalized" type="button">Personalized</button>
        <button id="chooser-unpersonalized" type="button">Unpersonalized</button>
      </div>`
    : '';
  const sendButtonMarkup =
    sendInShadowRoot
      ? `<div id="shadow-send-host"></div>`
      : realSendMode === 'unlabeled'
        ? `<button class="real-send-icon" type="submit"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1 8h12M9 2l4 6-4 6"/></svg></button>`
        : realSendMode === 'none'
          ? ''
          : `<button data-testid="send-button" aria-label="发送" type="submit">Send</button>`;

  return `<!doctype html>
<html${htmlClass}>
  <head><meta charset="utf-8"><title>Fake ChatGPT Branch</title>${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="open">
    ${SIDEBAR_MARKUP}
    <main><header>Fake header</header><div id="turns"></div>
    ${decoyComposerMarkup}
    <form id="composer-form">
      <textarea ${realComposerId ? `id="${realComposerId}"` : ''} placeholder="有问题，尽管问" name="prompt-textarea" aria-label="与 ChatGPT 聊天"></textarea>
      ${temporaryChatMarkup}
      ${sendButtonMarkup}
    </form>
    </main>
    ${confusingActionMarkup}
    ${chooserMarkup}
    <script>
      const temporaryChatToggle = document.getElementById('temporary-chat-toggle');
      if (temporaryChatToggle) {
        let temporaryChatModeActive = ${temporaryChatInitiallyActive ? 'true' : 'false'};
        window.__temporaryChatModeActive = temporaryChatModeActive;
        const composerTools = document.getElementById('composer-tools');
        const composerMenu = document.getElementById('composer-menu');
        const temporaryIndicator = document.getElementById('temporary-indicator');
        const chooser = document.getElementById('temporary-chooser');
        const setMenuOpen = (open) => {
          if (!composerMenu) {
            return;
          }
          composerMenu.dataset.state = open ? 'open' : 'closed';
          composerMenu.style.display = open ? 'block' : 'none';
          composerTools?.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        if (composerTools) {
          composerTools.addEventListener('click', (event) => {
            event.preventDefault();
            window.__menuTriggerClicks = (window.__menuTriggerClicks || 0) + 1;
            setMenuOpen(composerMenu.dataset.state !== 'open');
          });
        }
        if (chooser) {
          chooser.querySelectorAll('button').forEach((button) => {
            button.addEventListener('click', () => {
              window.__personalizationChoice = button.id;
              chooser.style.display = 'none';
            });
          });
        }
        const reflectTemporaryChatState = (active) => {
          temporaryChatToggle.dataset.temporaryChatState = active ? 'active' : 'inactive';
          temporaryChatToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
          temporaryChatToggle.setAttribute('aria-label', active ? '关闭临时聊天' : '开启临时聊天');
          temporaryChatToggle.textContent = active ? '关闭临时聊天' : '开启临时聊天';
          if (temporaryIndicator) {
            temporaryIndicator.dataset.state = active ? 'on' : 'off';
            temporaryIndicator.style.display = active ? 'block' : 'none';
          }
        };
        // The owner fixing it by hand in the branch window: the harness's stand-in
        // for a real click on the provider's own control.
        window.__forceTemporaryChatState = (active) => {
          temporaryChatModeActive = active;
          window.__temporaryChatModeActive = active;
          reflectTemporaryChatState(active);
        };
        const setTemporaryChatState = (active) => {
          temporaryChatModeActive = active;
          window.__temporaryChatModeActive = active;
          if (${JSON.stringify(temporaryChatActivationStyle)} === 'silent' && active) {
            reflectTemporaryChatState(false);
            return;
          }
          reflectTemporaryChatState(active);
        };
        reflectTemporaryChatState(${temporaryChatInitiallyActive ? 'true' : 'false'});
        temporaryChatToggle.addEventListener('click', (event) => {
          event.preventDefault();
          window.__temporaryChatToggleClicks = (window.__temporaryChatToggleClicks || 0) + 1;
          if (${temporaryChatEnableable ? 'true' : 'false'} === false && temporaryChatToggle.dataset.temporaryChatState !== 'active') {
            return;
          }
          if (!${temporaryChatDisableable ? 'true' : 'false'} && temporaryChatToggle.dataset.temporaryChatState === 'active') {
            return;
          }
          setTemporaryChatState(temporaryChatToggle.dataset.temporaryChatState !== 'active');
          setMenuOpen(false);
          if (chooser && temporaryChatModeActive) {
            chooser.style.display = 'block';
          }
        });
      }

      if (${enterOnlySubmit ? 'true' : 'false'}) {
        const textarea = document.querySelector('#composer-form textarea');
        textarea.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          document.getElementById('composer-form').dispatchEvent(
            new SubmitEvent('submit', { bubbles: true, cancelable: true })
          );
        });
      }

      if (${sendInShadowRoot ? 'true' : 'false'}) {
        const host = document.getElementById('shadow-send-host');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<button type="submit" aria-label="发送"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1 8h12M9 2l4 6-4 6"/></svg></button>';
        root.querySelector('button').addEventListener('click', (event) => {
          event.preventDefault();
          document.getElementById('composer-form').dispatchEvent(
            new SubmitEvent('submit', { bubbles: true, cancelable: true })
          );
        });
      }

      document.getElementById('composer-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const textarea = document.querySelector('#composer-form textarea');
        const prompt = textarea.value;
        window.__lastPrompt = prompt;
        window.__submitCount = (window.__submitCount || 0) + 1;
        textarea.value = '';
        const temporaryModeActive = window.__temporaryChatModeActive === true;
        const nextSubmitCount = Number(localStorage.getItem(${JSON.stringify(conversationUrlStorageKey)}) || '0') + 1;
        localStorage.setItem(${JSON.stringify(conversationUrlStorageKey)}, String(nextSubmitCount));
        const shouldPersistConversationUrl =
          ${JSON.stringify(conversationUrlMode)} === 'never'
            ? false
            : ${JSON.stringify(conversationUrlMode)} === 'after-first-submit'
              ? nextSubmitCount > 1
              : true;
        if (
          shouldPersistConversationUrl &&
          !(temporaryModeActive && ${temporaryModeSkipsConversationUrl ? 'true' : 'false'})
        ) {
          history.pushState(null, '', ${JSON.stringify(conversationPath)});
        }
        const main = document.getElementById('turns');
        main.innerHTML = ${JSON.stringify(fakeAnswerMarkup)};
        main.querySelector('[data-message-author-role="user"] [data-message-content]').textContent = prompt;
      });
    </script>
  </body>
</html>`;
}

function buildFalsePositiveComposerHtml() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Fake ChatGPT Failure</title>${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="open">
    ${SIDEBAR_MARKUP}
    <main><header>Fake header</header><div id="turns"></div></main>
    <form id="composer-form">
      <textarea id="prompt-textarea" placeholder="有问题，尽管问" name="prompt-textarea" aria-label="与 ChatGPT 聊天"></textarea>
    </form>
    <script>
      const textarea = document.getElementById('prompt-textarea');
      document.getElementById('composer-form').addEventListener('submit', (event) => {
        event.preventDefault();
        window.__syntheticSubmitTriggered = true;
      });
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        window.__enterFallbackTriggered = true;
        textarea.value = '';
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      });
    </script>
  </body>
</html>`;
}

const NOT_FOUND_HTML = '<!doctype html><html><body>not found</body></html>';

/** Every host the harness is allowed to answer for. Anything else is an escape. */
const SERVED_HOSTS = new Set(['chatgpt.com', 'chat.openai.com', 'claude.ai']);

/**
 * Requests that reached a host the harness does not serve. The run fails on any
 * entry: a default smoke must never touch a real provider.
 */
const networkEscapes = [];

function resolveRouteBody(hostname, pathname) {
  const hostRoutes = hostname === 'claude.ai' ? claudeRouteMap : routeMap;
  return hostRoutes[pathname] ?? hostRoutes['*'] ?? NOT_FOUND_HTML;
}

async function fulfillPausedRequest(session, event) {
  const { requestId } = event;

  let url = null;
  try {
    url = new URL(event.request.url);
  } catch {
    url = null;
  }

  if (!url) {
    await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }

  if (!SERVED_HOSTS.has(url.hostname)) {
    // Everything that is not a fixture host is blocked outright and recorded, so
    // an accidental request to a real provider fails the run instead of silently
    // succeeding against a live account.
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      networkEscapes.push(url.origin + url.pathname);
      await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }

  const servedBody = resolveRouteBody(url.hostname, url.pathname);
  const headers = [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }];

  // Lets a scenario model a provider that refuses to be framed, so the fallback
  // is proved by observation rather than asserted from an assumption about
  // headers — which is exactly the assumption that turned out to be wrong.
  if (refuseFramingForPaths.some((path) => url.pathname.startsWith(path))) {
    headers.push({ name: 'X-Frame-Options', value: 'DENY' });
    headers.push({ name: 'Content-Security-Policy', value: "frame-ancestors 'none'" });
  }

  await session
    .send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: headers,
      body: Buffer.from(servedBody, 'utf8').toString('base64')
    })
    .catch(() => {});
}

async function prepareAttachedSession(session) {
  try {
    session.on('Fetch.requestPaused', (event) => {
      void fulfillPausedRequest(session, event);
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  } catch {
    // Some targets reject Fetch.enable; they still have to be resumed below.
  } finally {
    await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  }
}

// Windows opened by the extension navigate as soon as chrome.tabs.update resolves, which
// is faster than puppeteer's targetcreated -> page() -> setRequestInterception round trip.
// Auto-attaching at the browser level with waitForDebuggerOnStart pauses every new target
// before its first request, so the fake chatgpt.com routes always win that race.
async function installBrowserInterception(browser) {
  const browserSession = await browser.target().createCDPSession();
  browserSession.on('sessionattached', (session) => {
    void prepareAttachedSession(session);
  });
  await browserSession.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true
  });
}


/**
 * Read the extension's own storage through its service worker. Page contexts cannot
 * see chrome.storage, and asserting on what actually landed on disk is the only way
 * to prove a private branch stayed out of it.
 */
async function readExtensionStorage(browser) {
  const deadline = Date.now() + 15_000;
  let workerTarget = null;
  while (Date.now() < deadline && !workerTarget) {
    workerTarget = browser.targets().find((target) => target.type() === 'service_worker');
    if (!workerTarget) {
      await sleep(200);
    }
  }

  if (!workerTarget) {
    throw new Error('Extension service worker target was not found.');
  }

  const worker = await workerTarget.worker();
  return worker.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = chrome.storage.session ? await chrome.storage.session.get(null) : {};
    return { local: JSON.stringify(local), session: JSON.stringify(session) };
  });
}

async function createSourcePage(browser, pathName) {
  const page = await browser.newPage();
  page.__consoleMessages = [];
  page.__dialogs = [];
  page.on('console', (message) => {
    page.__consoleMessages.push(message.text());
  });
  // A modal dialog would freeze the page and time out every later evaluate.
  // Record it and move on; the product must never open one on a provider page.
  page.on('dialog', (dialog) => {
    page.__dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  await page.goto(`https://chatgpt.com${pathName}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  return page;
}

async function waitForAdditionalPage(browser, existingPages, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const extra = pages.find((candidate) => !existingPages.includes(candidate));
    if (extra) {
      return extra;
    }
    await sleep(200);
  }

  throw new Error('Expected a new browser page to open.');
}

async function selectAssistantText(page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector(
      'article[data-message-author-role="assistant"] [data-message-content] p'
    );
    const text = paragraph?.firstChild;
    if (!text) {
      throw new Error('Assistant paragraph text was not found.');
    }
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 55);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

/**
 * A stand-in for the provider's own selection popup.
 *
 * The first version of this was a bare <button> parked to the RIGHT of the
 * selection. That made the non-overlap assertion pass for a reason the harness
 * authored itself: Aside's preferred slot is centred ABOVE the anchor, so the two
 * rects could never collide whatever Aside did, and the test stayed green even
 * though the selectors meant to reserve the stand-in matched nothing.
 *
 * On the real site the popup is a pill of two actions, centred above the
 * selection — exactly where Aside wants to be — and it mounts a moment AFTER the
 * selection settles.
 *
 * Options:
 *   placement 'above' (default) reproduces the live collision; 'right' keeps the
 *             original case, where a fallback side is the one blocked.
 *   variant   'bare' carries no attributes at all, so only the paint-order
 *             recheck can find it; 'attributed' carries a plausible test id, so
 *             the selector layer is exercised too.
 *   delayMs   mounts the popup that long after the call returns, without touching
 *             the selection — the late-mount case, which only the MutationObserver
 *             path can catch.
 */
async function injectNativeAskButton(page, options = {}) {
  const {
    placement = 'right',
    variant = 'attributed',
    delayMs = 0,
    // A REALISTIC stacking value, not a near-maximum one. The first version of
    // this hard-coded 2147483646, which is above Aside's host: that guaranteed the
    // provider popup always painted on top, so the harness could only ever exercise
    // the "something covers Aside" direction. The live defect was the opposite one,
    // and at any ordinary z-index it is Aside that ends up on top.
    zIndex = 50,
    // 'flat' is a single positioned pill. 'nested' wraps a relative content box in
    // a fixed positioner, the shape popup libraries emit — which breaks any
    // detector that sniffs `position` on the element it happens to hit.
    shape = 'flat'
  } = options;

  await page.evaluate(
    (placementMode, variantMode, delay, zIndexValue, shapeMode) => {
      const range = getSelection()?.getRangeAt(0);
      if (!range) {
        throw new Error('No selection range was available.');
      }

      // The first client rect, matching what root.ts anchors to. getBoundingClientRect
      // spans every line of a multi-line selection and is a different box.
      const rects = Array.from(range.getClientRects()).filter(
        (candidate) => candidate.width > 0 || candidate.height > 0
      );
      const rect = rects[0] ?? range.getBoundingClientRect();

      const POPUP_WIDTH = 430;
      const POPUP_HEIGHT = 44;

      const pill = document.createElement('div');
      pill.dataset.nativeSelectionPopup = 'true';
      if (variantMode === 'attributed') {
        pill.setAttribute('data-testid', 'selection-toolbar');
      }
      pill.style.position = 'fixed';
      pill.style.display = 'flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '0px';
      pill.style.height = `${POPUP_HEIGHT}px`;
      pill.style.width = `${POPUP_WIDTH}px`;
      pill.style.borderRadius = '999px';
      pill.style.background = '#ffffff';
      pill.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
      pill.style.zIndex = String(zIndexValue);

      // Clamped into the viewport, as a real popup is. Without this the 'right'
      // placement pushes a 430px pill off the edge at 768px — and how far off
      // depends on where the selection's first line happens to end, which differs
      // between a mac and a Linux CI runner because the fonts differ. That made a
      // fixture artifact look like a product failure.
      const clampLeft = (value) =>
        Math.max(8, Math.min(value, window.innerWidth - POPUP_WIDTH - 8));
      const clampTop = (value) =>
        Math.max(8, Math.min(value, window.innerHeight - POPUP_HEIGHT - 8));

      if (placementMode === 'above') {
        pill.style.top = `${clampTop(rect.top - POPUP_HEIGHT - 8)}px`;
        pill.style.left = `${clampLeft(rect.left + rect.width / 2 - POPUP_WIDTH / 2)}px`;
      } else {
        pill.style.top = `${clampTop(rect.top - 40)}px`;
        pill.style.left = `${clampLeft(rect.right + 16)}px`;
      }

      // Where the buttons actually go: directly in the pill, or inside a
      // statically-positioned content box for the 'nested' shape.
      let content = pill;
      if (shapeMode === 'nested') {
        content = document.createElement('div');
        content.style.position = 'relative';
        content.style.display = 'flex';
        content.style.alignItems = 'center';
        content.style.width = '100%';
        content.style.height = '100%';
        pill.append(content);
      }

      ['Ask ChatGPT', 'Share highlighted'].forEach((label, index) => {
        if (index > 0) {
          const divider = document.createElement('span');
          divider.style.width = '1px';
          divider.style.height = '20px';
          divider.style.background = 'rgba(0,0,0,0.12)';
          content.append(divider);
        }
        const button = document.createElement('button');
        button.setAttribute('aria-label', label);
        button.textContent = label;
        button.style.flex = '1';
        button.style.height = '100%';
        button.style.border = 'none';
        button.style.background = 'transparent';
        content.append(button);
      });

      const mount = () => document.body.append(pill);
      if (delay > 0) {
        // Deliberately no reselection: on a real page the popup appears on its own
        // and Aside is told by nothing but its MutationObserver.
        window.setTimeout(mount, delay);
      } else {
        mount();
      }
    },
    placement,
    variant,
    delayMs,
    zIndex,
    shape
  );

  if (delayMs > 0) {
    await sleep(delayMs + 400);
  }
}

/**
 * Is every control in the provider's own popup still clickable?
 *
 * The mirror of readAsideOcclusion, and the one that matters more: Aside's host
 * sits near the maximum z-index, so Aside covering the provider is the likely
 * direction, not the other way round. Samples the centre and both horizontal
 * quartiles of each control, because a partial cover is still a cover — the live
 * screenshot showed a native label clipped mid-word.
 */
async function readNativePopupOcclusion(page) {
  return page.evaluate(() => {
    const popup = document.querySelector('[data-native-selection-popup]');
    if (!(popup instanceof HTMLElement)) {
      return { applicable: false, covered: [], allReachable: true };
    }

    const covered = [];
    Array.from(popup.querySelectorAll('button')).forEach((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const y = rect.top + rect.height / 2;
      [0.25, 0.5, 0.75].forEach((fraction) => {
        const x = rect.left + rect.width * fraction;
        const topmost = document.elementFromPoint(x, y);
        if (topmost?.closest('#aside-root')) {
          covered.push({ label: button.textContent?.trim() ?? '', at: fraction });
        }
      });
    });

    return { applicable: true, covered, allReachable: covered.length === 0 };
  });
}

/**
 * Is every one of Aside's own controls actually clickable?
 *
 * This is the exact property the live screenshot violated, and the one the
 * rectangle comparison could not express: Aside's toolbar was placed, was
 * visible, was the right size — and the provider's popup was painted on top of
 * half of it.
 */
async function readAsideOcclusion(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('#aside-selection-toolbar');
    if (!(toolbar instanceof HTMLElement) || toolbar.hidden) {
      return { applicable: false, covered: [], allReachable: true };
    }

    const covered = [];
    Array.from(toolbar.querySelectorAll('button')).forEach((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const topmost = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      );
      if (!topmost?.closest('#aside-root')) {
        covered.push({
          label: button.textContent?.trim() ?? '',
          coveredBy: topmost instanceof HTMLElement ? topmost.tagName.toLowerCase() : null
        });
      }
    });

    return { applicable: true, covered, allReachable: covered.length === 0 };
  });
}

function isDarkRgb(backgroundColor) {
  const match = backgroundColor.match(/\d+/g);
  if (!match || match.length < 3) {
    return false;
  }
  const [red, green, blue] = match.slice(0, 3).map(Number);
  return red < 80 && green < 90 && blue < 110;
}

async function waitForBranchFrame(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const iframeHandle = await page.$('.aside-panel:not([hidden]) .aside-frame');
    const frame = await iframeHandle?.contentFrame();
    if (frame) {
      return frame;
    }
    await sleep(200);
  }

  throw new Error('The embedded ChatGPT branch frame did not appear.');
}

async function dumpPanelState(page, label) {
  try {
    const state = await page.evaluate(() => {
      const panel = document.querySelector('.aside-panel:not([hidden])');
      return {
        status: panel?.querySelector('.aside-panel-heading p')?.textContent ?? null,
        error: panel?.querySelector('.aside-error-copy')?.textContent ?? null,
        submitDisabled: panel?.querySelector('button[type="submit"]')?.disabled ?? null,
        contextSize: panel?.querySelector('.aside-context-size')?.textContent ?? null,
        overBudget: panel?.querySelector('.aside-context-size')?.getAttribute('data-over-budget') ?? null
      };
    });
    console.error(`PANEL[${label}]`, JSON.stringify(state));
  } catch (error) {
    console.error(`PANEL[${label}] unavailable`, error instanceof Error ? error.message : error);
  }
}

async function waitForPanelStatus(page, matcher, timeoutMs = 30_000) {
  try {
    await page.waitForFunction(
      (patternSource) => {
        const panel = document.querySelector('.aside-panel:not([hidden])');
        const status = panel?.querySelector('.aside-panel-heading p');
        if (!(status instanceof HTMLElement)) {
          return false;
        }
        return new RegExp(patternSource).test(status.textContent || '');
      },
      { timeout: timeoutMs },
      matcher.source
    );
  } catch (error) {
    await dumpPanelState(page, 'status-timeout');
    throw error;
  }
}

async function waitForPanelTitle(page, title, timeoutMs = 15_000) {
  await page.waitForFunction(
    (expectedTitle) =>
      document.querySelector('.aside-panel:not([hidden]) h2')?.textContent?.trim() === expectedTitle,
    { timeout: timeoutMs },
    title
  );
}

async function clickPanelAction(page, label) {
  await page.evaluate((buttonLabel) => {
    const panel = document.querySelector('.aside-panel:not([hidden])');
    const button = Array.from(panel?.querySelectorAll('.aside-panel-actions button') ?? []).find((candidate) =>
      candidate.textContent?.trim() === buttonLabel
    );
    if (!(button instanceof HTMLElement)) {
      throw new Error(`Panel action not found: ${buttonLabel}`);
    }
    button.click();
  }, label);
}

// Selected by role, not by label: the private mode's visible name is the
// provider's own ("Temporary Chat" on ChatGPT, "Incognito chat" on Claude).
async function setPanelBranchKind(page, kind) {
  await page.evaluate((branchKind) => {
    const panel = document.querySelector('.aside-panel:not([hidden])');
    const button = panel?.querySelector(`.aside-kind-toggle button[data-aside-role="branch-kind-${branchKind}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Branch kind button not found: ${branchKind}`);
    }
    button.click();
  }, kind);
}

async function openDraft(page) {
  await selectAssistantText(page);
  await page.waitForFunction(() => {
    const toolbar = document.querySelector('#aside-selection-toolbar');
    return toolbar instanceof HTMLElement && !toolbar.hidden;
  });
  await page.evaluate(() => {
    const button = document.querySelector('#aside-ask-button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Ask button is not visible');
    }
    button.click();
  });
  await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', { timeout: 10_000 });
}

async function clickSelectionAction(page, selector) {
  await page.evaluate((actionSelector) => {
    const button = document.querySelector(actionSelector);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Selection action not found: ${actionSelector}`);
    }
    button.click();
  }, selector);
}

async function openDraftAndSubmit(page, question) {
  await openDraft(page);
  await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', question);
  const pageCountBefore = (await page.browser().pages()).length;
  await page.evaluate(() => {
    const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Panel submit button not found');
    }
    button.click();
  });
  const branchFrame = await waitForBranchFrame(page);
  return { branchFrame, pageCountBefore };
}

async function runNonProjectScenario(browser) {
  routeMap = {
    '/c/source-local': buildSourceHtml({ dark: true }),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-local',
      dark: true,
      includeDecoyComposer: true,
      includeConfusingAction: true,
      includeTemporaryChatToggle: true,
      realComposerId: '',
      realSendMode: 'none',
      sendInShadowRoot: true
    })
  };

  const page = await createSourcePage(browser, '/c/source-local');

  try {
    await selectAssistantText(page);
    await page.waitForSelector('#aside-selection-toolbar', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return toolbar instanceof HTMLElement && !toolbar.hidden;
    });
    // The live case: the popup is centred above the selection, exactly where Aside
    // wants to be, and carries nothing any selector was written for.
    await injectNativeAskButton(page, {
      placement: 'above',
      variant: 'bare',
      shape: 'nested'
    });
    await sleep(500);
    const askOcclusion = await readAsideOcclusion(page);
    const nativeOcclusion = await readNativePopupOcclusion(page);

    const askState = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('#aside-selection-toolbar button')
      ).filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.01
        );
      });
      const nativeAsk = document.querySelector('button[aria-label="Ask ChatGPT"]');
      const nativeStyle = nativeAsk instanceof HTMLElement ? getComputedStyle(nativeAsk) : null;
      const nativeRect = nativeAsk?.getBoundingClientRect();
      // Only when the toolbar is actually showing. A hidden toolbar has a zero rect
      // that overlaps nothing, so reading it unconditionally let "collapsed to the
      // launcher" and "placed clear of the native pill" share one green signal.
      const toolbarEl = document.querySelector('#aside-selection-toolbar');
      const toolbarShown = toolbarEl instanceof HTMLElement && !toolbarEl.hidden;
      const toolbarRect = toolbarShown ? toolbarEl.getBoundingClientRect() : null;

      // The provider's own action must stay fully usable, and Aside must sit beside
      // it rather than on top of it.
      const nativeAskUsable = Boolean(
        nativeAsk instanceof HTMLElement &&
          nativeStyle &&
          nativeStyle.display !== 'none' &&
          nativeStyle.visibility !== 'hidden' &&
          Number(nativeStyle.opacity || '1') > 0.01 &&
          nativeStyle.pointerEvents !== 'none' &&
          !nativeAsk.hasAttribute('disabled') &&
          nativeAsk.getAttribute('aria-hidden') !== 'true' &&
          (nativeRect?.width ?? 0) > 0 &&
          (nativeRect?.height ?? 0) > 0
      );

      // What the user's click would actually reach at the native button's centre.
      const hitTarget =
        nativeRect && nativeRect.width > 0
          ? document.elementFromPoint(
              nativeRect.left + nativeRect.width / 2,
              nativeRect.top + nativeRect.height / 2
            )
          : null;

      return {
        visibleActions: buttons.map((button) => button.textContent?.trim() ?? ''),
        toolbarIsLabelledAside:
          document.querySelector('#aside-selection-toolbar')?.getAttribute('aria-label') ??
          null,
        nativeAskUsable,
        toolbarShown,
        nativeAskHitTargetIsNative: hitTarget === nativeAsk || Boolean(nativeAsk?.contains(hitTarget)),
        nativeAskClassList: nativeAsk instanceof HTMLElement ? nativeAsk.className : null,
        asideOverlapsNativeAsk: Boolean(
          nativeRect &&
            toolbarRect &&
            nativeRect.left < toolbarRect.right &&
            nativeRect.right > toolbarRect.left &&
            nativeRect.top < toolbarRect.bottom &&
            nativeRect.bottom > toolbarRect.top
        )
      };
    });

    await clickSelectionAction(page, '#aside-ask-button');
    await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', { timeout: 10_000 });

    // The Context section must show exactly what will be submitted. The question
    // that produced the source answer is included by default and can be unticked.
    const contextBefore = await page.evaluate(() => {
      const panel = document.querySelector('.aside-panel:not([hidden])');
      const rows = Array.from(panel?.querySelectorAll('.aside-context-block') ?? []);
      return {
        preview: panel?.querySelector('.aside-context-preview')?.textContent ?? '',
        source: panel?.querySelector('.aside-context-source')?.textContent ?? '',
        blockLabels: rows.map((row) => row.querySelector('span')?.textContent ?? ''),
        precedingIncluded: rows
          .filter((row) => row.textContent?.includes('question that produced'))
          .map((row) => row.querySelector('input')?.checked ?? null)
      };
    });

    // Untick the preceding question and confirm it leaves the preview.
    await page.evaluate(() => {
      const row = Array.from(
        document.querySelectorAll('.aside-panel:not([hidden]) .aside-context-block')
      ).find((candidate) => candidate.textContent?.includes('question that produced'));
      row?.querySelector('input')?.click();
    });
    const contextAfterOptIn = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) .aside-context-preview')?.textContent ?? ''
    );
    // Put it back: the rest of the scenario asserts the default context.
    await page.evaluate(() => {
      const row = Array.from(
        document.querySelectorAll('.aside-panel:not([hidden]) .aside-context-block')
      ).find((candidate) => candidate.textContent?.includes('question that produced'));
      row?.querySelector('input')?.click();
    });

    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    // Captured after the question is typed: the preview is the complete prompt,
    // instructions and question included, and must equal what is submitted.
    const contextPreview = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) .aside-context-preview')?.textContent ?? ''
    );

    const darkThemeState = await page.evaluate(() => ({
      theme: document.documentElement.dataset.asideTheme ?? null,
      panelBackground: getComputedStyle(document.querySelector('.aside-panel:not([hidden])')).backgroundColor
    }));

    const pageCountBefore = (await browser.pages()).length;
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);
    // Titles are local: derived from the question, never from the model.
    await waitForPanelTitle(page, 'Why this assumption?');

    // The answer is read back from the branch conversation and shown, read-only,
    // in the panel — and its capture state is stated, not assumed.
    // Wait for the capture to SETTLE: the watcher promotes a message to complete
    // only after a second identical read with no generating evidence, so a
    // "partial" sample a moment earlier is expected, not a failure.
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-archive-message[data-role="assistant"]')
        ).some(
          (node) =>
            node.textContent?.includes('This uses only the selected passage.') &&
            node.getAttribute('data-partial') === 'false'
        ),
      { timeout: 25_000 }
    );
    const nonProjectPanelId = await page.evaluate(
      () => document.querySelector('.aside-panel:not([hidden])')?.getAttribute('data-panel-id') ?? null
    );
    const nonProjectQuestionId = nonProjectPanelId
      ? JSON.parse((await readExtensionStorage(browser)).local)[`aside:panel:${nonProjectPanelId}`]?.state?.questionId ?? null
      : null;
    const captureState = await page.evaluate(() => ({
      archiveStatus:
        document.querySelector('.aside-panel:not([hidden]) .aside-archive-status')?.textContent ?? null,
      assistantPartial:
        document
          .querySelector('.aside-panel:not([hidden]) .aside-archive-message[data-role="assistant"]')
          ?.getAttribute('data-partial') ?? null,
      dialogs: []
    }));

    const pageCountAfter = (await browser.pages()).length;
    const liveResult = await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        title: document.querySelector('.aside-panel:not([hidden]) h2')?.textContent ?? null,
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some((button) => button.textContent?.trim() === 'Open branch' && getComputedStyle(button).display !== 'none')
      })),
      branchFrame.evaluate(() => ({
        branchLocation: window.location.href,
        prompt: window.__lastPrompt ?? null,
        assistantText:
          document.querySelector('[data-message-author-role="assistant"] [data-message-content]')?.textContent ?? null
      }))
    ]).then(([source, branch]) => ({
      ...source,
      ...branch,
      pageCountBefore,
      pageCountAfter,
      captureState,
      questionId: nonProjectQuestionId,
      promptContainsSelectedPassage: Boolean(
        branch.prompt?.includes('convexity assumption guarantees the relaxation stays tight')
      ),
      promptContainsLocalSourceAnswer: Boolean(
        branch.prompt?.includes('The convexity assumption guarantees the relaxation stays tight')
      ),
      contextPreviewMatchesPrompt: Boolean(contextPreview && branch.prompt === contextPreview),
      contextSource: contextBefore.source,
      precedingQuestionOffered: contextBefore.blockLabels.some((label) =>
        label.includes('preceding question')
      ),
      // The question that produced the source answer is part of the default
      // plan now; unticking it removes it from the preview.
      precedingQuestionDefaultOn: contextBefore.precedingIncluded.every((checked) => checked === true),
      precedingQuestionPresentByDefault: contextBefore.preview.includes('Tell me about convexity'),
      precedingQuestionGoneWhenUnticked: !contextAfterOptIn.includes('Tell me about convexity')
    }));

    await clickPanelAction(page, 'Minimize');
    await page.waitForFunction(() => Boolean(document.querySelector('#aside-tabbar:not([hidden])')), {
      timeout: 10_000
    });

    const minimizedState = await page.evaluate(() => {
      const tabBar = document.querySelector('#aside-tabbar');
      const tab = document.querySelector('.aside-tab');
      const panel = document.querySelector('.aside-panel');
      const tabBarRect = tabBar?.getBoundingClientRect();
      const tabRect = tab?.getBoundingClientRect();
      const tabBarStyle = tabBar ? getComputedStyle(tabBar) : null;
      const sidebarRect = document.querySelector('nav[aria-label]')?.getBoundingClientRect();
      const columnRect = document.querySelector('main article, main #turns')?.getBoundingClientRect();
      const overlaps = (a, b) =>
        Boolean(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        placement: tabBar?.getAttribute('data-placement'),
        tabBarLeft: tabBarRect ? Math.round(tabBarRect.left) : null,
        sidebarRight: sidebarRect ? Math.round(sidebarRect.right) : null,
        readingColumnLeft: columnRect ? Math.round(columnRect.left) : null,
        overlapsSidebar: overlaps(tabBarRect, sidebarRect),
        overlapsReadingColumn: overlaps(tabBarRect, columnRect),
        // The hit target the user actually clicks must be inside the rail.
        tabHitInsideRail: Boolean(
          tabBarRect && tabRect && tabRect.left >= tabBarRect.left - 1 && tabRect.right <= tabBarRect.right + 1
        ),
        flexDirection: tabBar ? getComputedStyle(tabBar).flexDirection : null,
        tabVisible: Boolean(tab),
        panelHidden: panel instanceof HTMLElement ? panel.hidden : null,
        tabBarWidth: tabBarRect ? Math.round(tabBarRect.width) : null,
        tabWidth: tabRect ? Math.round(tabRect.width) : null,
        tabBarRight: tabBarRect ? Math.round(tabBarRect.right - window.innerWidth) : null,
        tabBarComputedRight: tabBarStyle?.right ?? null
      };
    });

    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(document.querySelector('#aside-tabbar:not([hidden])')), {
      timeout: 10_000
    });

    const homeRestoreState = await page.evaluate(() => {
      const tabBar = document.querySelector('#aside-tabbar');
      const tab = document.querySelector('.aside-tab');
      const panel = document.querySelector('.aside-panel');
      const tabBarRect = tabBar?.getBoundingClientRect();
      const tabRect = tab?.getBoundingClientRect();
      const sidebarRect = document.querySelector('nav[aria-label]')?.getBoundingClientRect();
      const columnRect = document
        .querySelector('main article, main #turns, main #composer-form')
        ?.getBoundingClientRect();
      const overlaps = (a, b) =>
        Boolean(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        location: window.location.href,
        placement: tabBar?.getAttribute('data-placement'),
        tabVisible: Boolean(tab),
        panelHidden: panel instanceof HTMLElement ? panel.hidden : null,
        tabBarWidth: tabBarRect ? Math.round(tabBarRect.width) : null,
        tabWidth: tabRect ? Math.round(tabRect.width) : null,
        tabBarLeft: tabBarRect ? Math.round(tabBarRect.left) : null,
        overlapsSidebar: overlaps(tabBarRect, sidebarRect),
        overlapsReadingColumn: overlaps(tabBarRect, columnRect)
      };
    });

    return {
      askState,
      askOcclusion,
      nativeOcclusion,
      darkThemeState,
      liveResult,
      minimizedState,
      homeRestoreState
    };
  } finally {
    await page.close();
  }
}

async function runWhyScenario(browser) {
  routeMap = {
    '/c/source-why': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-why',
      conversationUrlMode: 'after-first-submit',
      conversationUrlStorageKey: '__asideWhySubmitCount'
    })
  };

  const page = await createSourcePage(browser, '/c/source-why');

  try {
    await selectAssistantText(page);
    await page.waitForSelector('#aside-selection-toolbar', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return toolbar instanceof HTMLElement && !toolbar.hidden;
    });
    const existingPages = await browser.pages();
    await clickSelectionAction(page, '#aside-why-button');
    let newPage;
    try {
      newPage = await waitForAdditionalPage(browser, existingPages, 45_000);
    } catch (error) {
      const sourceDebug = await page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        error:
          document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ??
          null,
        title: document.querySelector('.aside-panel:not([hidden]) h2')?.textContent ?? null,
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some((button) => button.textContent?.trim() === 'Open branch' && getComputedStyle(button).display !== 'none'),
        debugTextarea:
          document.querySelector('.aside-panel:not([hidden]) .aside-debug-log textarea')
            ?.value ?? null
      }));
      throw new Error(
        `Why recovery did not open a native page: ${JSON.stringify(sourceDebug)} :: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    try {
      await newPage.waitForFunction(() => window.location.href.includes('/c/generated-why'), {
        timeout: 45_000
      });
    } catch (error) {
      await page.evaluate(() => {
        const button = Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).find((candidate) => candidate.textContent?.trim() === 'Copy log');
        if (button instanceof HTMLButtonElement) {
          button.click();
        }
      });
      const sourceDebug = await page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        error:
          document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ??
          null,
        title: document.querySelector('.aside-panel:not([hidden]) h2')?.textContent ?? null,
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some((button) => button.textContent?.trim() === 'Open branch' && getComputedStyle(button).display !== 'none'),
        debugTextarea:
          document.querySelector('.aside-panel:not([hidden]) .aside-debug-log textarea')
            ?.value ?? null
      }));
      const copiedLog = await page
        .evaluate(async () => {
          try {
            return await navigator.clipboard.readText();
          } catch {
            return null;
          }
        })
        .catch(() => null);
      const newPageDebug = await newPage.evaluate(() => ({
        location: window.location.href,
        assistantText:
          document.querySelector('[data-message-author-role="assistant"] [data-message-content]')?.textContent ?? null,
        userPrompt:
          document.querySelector('[data-message-author-role="user"] [data-message-content]')?.textContent ?? null,
        composerVisible: Boolean(
          document.querySelector('#prompt-textarea') ??
            document.querySelector('textarea[name="prompt-textarea"]')
        )
      }));
      throw new Error(
        `Why recovery native page did not become persistent: ${JSON.stringify({
          sourceDebug,
          newPageDebug,
          copiedLog
        })} :: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await waitForPanelStatus(page, /ready in its ChatGPT window/i, 30_000);

    return await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        formVisible:
          getComputedStyle(document.querySelector('.aside-panel:not([hidden]) form')).display !== 'none',
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some((button) => button.textContent?.trim() === 'Open branch' && getComputedStyle(button).display !== 'none')
      })),
      newPage.evaluate(() => ({
        branchLocation: window.location.href,
        prompt: window.__lastPrompt ?? null,
        assistantText:
          document.querySelector('[data-message-author-role="assistant"] [data-message-content]')?.textContent ?? null
      }))
    ]).then(([source, branch]) => ({ ...source, ...branch }));
  } finally {
    const pages = await browser.pages();
    const extraPages = pages.filter((candidate) => candidate !== page);
    await Promise.all(extraPages.map((candidate) => candidate.close().catch(() => {})));
    await page.close();
  }
}

async function runNewTabScenario(browser) {
  routeMap = {
    '/c/source-new-tab': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-new-window',
      assistantReplyText: 'This answers the question in its own window.'
    })
  };

  const page = await createSourcePage(browser, '/c/source-new-tab');

  try {
    await selectAssistantText(page);
    await page.waitForSelector('#aside-selection-toolbar', { timeout: 10_000 });
    const existingPages = await browser.pages();
    await clickSelectionAction(page, '#aside-new-tab-button');
    // New-tab opens a draft: nothing is sent merely because the button was
    // pressed. The real question is typed and sent once, in its own window.
    await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', { timeout: 10_000 });
    const pageCountAfterClick = (await browser.pages()).length;
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    await page.evaluate(() => {
      document.querySelector('.aside-panel:not([hidden]) button[type="submit"]')?.click();
    });
    const newPage = await waitForAdditionalPage(browser, existingPages);
    await newPage.waitForFunction(() => window.location.href.includes('/c/generated-new-window'), {
      timeout: 45_000
    });
    // The composer is focused asynchronously once the branch reports live, so wait for
    // that instead of sampling document.activeElement at an arbitrary moment.
    await newPage.waitForFunction(
      () => {
        const composer =
          document.querySelector('#prompt-textarea') ??
          document.querySelector('textarea[name="prompt-textarea"]');
        return composer instanceof HTMLElement && document.activeElement === composer;
      },
      { timeout: 20_000 }
    );

    return await Promise.all([
      page.evaluate(() => ({
        sourceLocation: window.location.href,
        panelVisible: Boolean(document.querySelector('.aside-panel:not([hidden])')),
        panelStatus:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ?? null
      })),
      newPage.evaluate(() => {
        const composer =
          document.querySelector('#prompt-textarea') ??
          document.querySelector('textarea[name="prompt-textarea"]');
        return {
          location: window.location.href,
          branchPanelVisible: Boolean(document.querySelector('.aside-panel:not([hidden])')),
          userPrompt:
            document.querySelector('[data-message-author-role="user"] [data-message-content]')?.textContent ?? null,
          assistantText:
            document.querySelector('[data-message-author-role="assistant"] [data-message-content]')?.textContent ?? null,
          composerVisible: composer instanceof HTMLElement,
          composerFocused: document.activeElement === composer
        };
      })
    ]).then(([source, branch]) => ({ ...source, ...branch, noWindowBeforeQuestion: pageCountAfterClick === existingPages.length }));
  } finally {
    const pages = await browser.pages();
    const extraPages = pages.filter((candidate) => candidate !== page);
    await Promise.all(extraPages.map((candidate) => candidate.close().catch(() => {})));
    await page.close();
  }
}

async function runEnterOnlyScenario(browser) {
  routeMap = {
    '/c/source-enter-only': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-enter-only',
      realComposerId: '',
      realSendMode: 'none',
      enterOnlySubmit: true
    })
  };

  const page = await createSourcePage(browser, '/c/source-enter-only');

  try {
    const { branchFrame } = await openDraftAndSubmit(page, 'Why this assumption?');
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);

    return await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null
      })),
      branchFrame.evaluate(() => ({
        branchLocation: window.location.href,
        prompt: window.__lastPrompt ?? null
      }))
    ]).then(([source, branch]) => ({ ...source, ...branch }));
  } finally {
    await page.close();
  }
}

async function runTemporaryChatUnconfirmedScenario(browser) {
  // The toggle flips internally but never reflects an active state in the DOM, so
  // Aside cannot positively verify privacy. Nothing may be typed or sent.
  routeMap = {
    '/c/source-temp-recovery': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-temp-recovery',
      includeTemporaryChatToggle: true,
      temporaryChatInitiallyActive: false,
      temporaryChatDisableable: true,
      temporaryChatActivationStyle: 'silent',
      temporaryModeSkipsConversationUrl: true,
      realComposerId: ''
    })
  };

  const page = await createSourcePage(browser, '/c/source-temp-recovery');

  try {
    await openDraft(page);
    await setPanelBranchKind(page, 'temporary');
    // Evidence for the owner checklist: the ChatGPT panel with its Context
    // section and ChatGPT's own name for the private mode.
    await page.evaluate(() => {
      const note = document.querySelector('.aside-panel:not([hidden]) .aside-privacy-note');
      if (note instanceof HTMLDetailsElement) {
        note.open = true;
      }
      const context = document.querySelector('.aside-panel:not([hidden]) .aside-context details');
      if (context instanceof HTMLDetailsElement) {
        context.open = true;
      }
    });
    await sleep(150);
    await capture(page, 'panel-chatgpt-context-and-privacy');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /This branch was not sent\./);
    await capture(page, 'panel-chatgpt-private-not-verified');

    const failed = await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        errorText:
          document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ??
          null,
        // The question must survive so the user can retry or switch mode.
        questionPreserved:
          document.querySelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]')?.value ?? null,
        formVisible:
          getComputedStyle(document.querySelector('.aside-panel:not([hidden]) form')).display !==
          'none'
      })),
      branchFrame.evaluate(() => {
        const composer = document.querySelector('#composer-form textarea');
        return {
          branchLocation: window.location.href,
          temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0,
          // The two facts that matter: nothing was typed, nothing was submitted.
          composerValue: composer instanceof HTMLTextAreaElement ? composer.value : null,
          lastPrompt: window.__lastPrompt ?? null,
          turnsRendered: document.querySelectorAll('#turns [data-message-author-role]').length
        };
      })
    ]).then(([source, branch]) => ({ ...source, ...branch }));

    const failedLayout = await readFailedPanelLayout(page);
    // Show branch window reveals the same frame; it was hidden, not destroyed.
    await page.evaluate(() => {
      document
        .querySelector('.aside-panel:not([hidden]) button[data-aside-role="recovery-show-target"]')
        ?.click();
    });
    const shellVisibleAfterShow = await page.evaluate(() => {
      const shell = document.querySelector('.aside-panel:not([hidden]) .aside-frame-shell');
      return shell instanceof HTMLElement && !shell.hidden && getComputedStyle(shell).display !== 'none';
    });

    // The owner turns the mode on in the branch window by hand, then asks Aside to
    // look again. The same document must be checked and the prompt sent there once.
    await branchFrame.evaluate(() => {
      window.__docToken = 'unconfirmed-doc';
      window.__forceTemporaryChatState(true);
    });
    await page.evaluate(() => {
      document
        .querySelector('.aside-panel:not([hidden]) button[data-aside-role="recovery-check-again"]')
        ?.click();
    });
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);
    const recheck = await branchFrame.evaluate(() => ({
      docToken: window.__docToken ?? null,
      submitCount: window.__submitCount ?? 0,
      lastPrompt: window.__lastPrompt ?? null,
      location: window.location.href,
      temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0
    }));
    recheck.status = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
        null
    );

    return { ...failed, failedLayout: { ...failedLayout, shellVisibleAfterShow }, recheck };
  } finally {
    await page.close();
  }
}

/** The failed-state layout the owner's screenshots objected to, measured. */
async function readFailedPanelLayout(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.aside-panel:not([hidden])');
    const shell = panel?.querySelector('.aside-frame-shell');
    const errors = Array.from(panel?.querySelectorAll('.aside-error-copy') ?? []).filter((element) =>
      (element.textContent || '').trim()
    );
    const visibleHeaderButtons = Array.from(panel?.querySelectorAll('.aside-panel-actions > button') ?? [])
      .filter((button) => getComputedStyle(button).display !== 'none')
      .map((button) => button.textContent?.trim());
    const more = panel?.querySelector('details.aside-panel-more');
    const moreButtons = Array.from(more?.querySelectorAll('button') ?? []).map((button) =>
      button.textContent?.trim()
    );
    const recovery = panel?.querySelector('.aside-recovery');
    const recoveryButtons = Array.from(recovery?.querySelectorAll(':scope > .aside-recovery-actions button') ?? [])
      .filter((button) => !button.hidden && getComputedStyle(button).display !== 'none')
      .map((button) => button.textContent?.trim());
    const note = panel?.querySelector('.aside-privacy-note');
    const text = panel?.innerText ?? '';
    return {
      frameShellHidden:
        shell instanceof HTMLElement && (shell.hidden || getComputedStyle(shell).display === 'none'),
      errorCount: errors.length,
      errorTextOccurrences: errors.length
        ? (text.match(new RegExp(errors[0].textContent.trim().slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [])
            .length
        : 0,
      visibleHeaderButtons,
      moreButtons,
      moreOpen: more instanceof HTMLDetailsElement ? more.open : null,
      recoveryVisible: recovery instanceof HTMLElement && !recovery.hidden,
      recoveryButtons,
      privacyNoteOpen: note instanceof HTMLDetailsElement ? note.open : null,
      projectWarningCount: (text.match(/project/gi) || []).length
    };
  });
}

async function runTemporaryChatVerifiedScenario(browser) {
  // The happy path: the toggle reports active, so the branch proceeds and stays
  // out of persistent history.
  routeMap = {
    '/c/source-temp-ok': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-temp-ok',
      includeTemporaryChatToggle: true,
      temporaryChatInitiallyActive: false,
      temporaryChatDisableable: true,
      temporaryChatActivationStyle: 'visible',
      temporaryModeSkipsConversationUrl: true,
      realComposerId: ''
    })
  };

  const page = await createSourcePage(browser, '/c/source-temp-ok');

  try {
    await openDraft(page);
    await setPanelBranchKind(page, 'temporary');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', PRIVATE_PROBE_QUESTION);
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);

    const storage = await readExtensionStorage(browser);

    return await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null
      })),
      branchFrame.evaluate(() => {
        const toggle = document.getElementById('temporary-chat-toggle');
        return {
          branchLocation: window.location.href,
          temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0,
          temporaryChatModeActive: window.__temporaryChatModeActive ?? false,
          temporaryChatState: toggle?.getAttribute('aria-pressed') ?? null,
          lastPrompt: window.__lastPrompt ?? null
        };
      })
    ]).then(([source, branch]) => ({
      ...source,
      ...branch,
      // The question text must be findable in session storage and absent from local.
      privateTextInLocalStorage: storage.local.includes(PRIVATE_PROBE_QUESTION),
      privateTextInSessionStorage: storage.session.includes(PRIVATE_PROBE_QUESTION)
    }));
  } finally {
    await page.close();
  }
}

async function runTemporaryChatBlockedScenario(browser) {
  routeMap = {
    '/c/source-temp-blocked': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-temp-blocked',
      includeTemporaryChatToggle: true,
      temporaryChatInitiallyActive: false,
      temporaryChatEnableable: false,
      realComposerId: ''
    })
  };

  const page = await createSourcePage(browser, '/c/source-temp-blocked');

  try {
    await openDraft(page);
    await setPanelBranchKind(page, 'temporary');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /This branch was not sent\./);

    const blocked = await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        errorText:
          document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ??
          null,
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some(
          (button) =>
            button.textContent?.trim() === 'Open branch' &&
            getComputedStyle(button).display !== 'none'
        ),
        bodyText: document.body.innerText
      })),
      branchFrame.evaluate(() => {
        const temporaryChatToggle = document.getElementById('temporary-chat-toggle');
        const composer = document.querySelector('#composer-form textarea');
        return {
          branchLocation: window.location.href,
          temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0,
          temporaryChatLabel: temporaryChatToggle?.getAttribute('aria-label') ?? null,
          temporaryChatText: temporaryChatToggle?.textContent ?? null,
          composerValue: composer instanceof HTMLTextAreaElement ? composer.value : null,
          lastPrompt: window.__lastPrompt ?? null,
          turnsRendered: document.querySelectorAll('#turns [data-message-author-role]').length
        };
      })
    ]).then(([source, branch]) => ({ ...source, ...branch }));
    const failedLayout = await readFailedPanelLayout(page);

    // Ordinary mode is an explicit two-step choice: the first click only asks.
    await page.evaluate(() => {
      document.querySelector('.aside-panel:not([hidden]) button[data-aside-role="recovery-ordinary"]')?.click();
    });
    const afterFirstClick = await Promise.all([
      page.evaluate(() => {
        const confirm = document.querySelector('.aside-panel:not([hidden]) .aside-recovery-confirm');
        return {
          confirmVisible: confirm instanceof HTMLElement && !confirm.hidden,
          confirmText: confirm?.textContent ?? '',
          status:
            document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
            null
        };
      }),
      branchFrame.evaluate(() => ({ lastPrompt: window.__lastPrompt ?? null }))
    ]).then(([panel, branch]) => ({ ...panel, ...branch }));

    await page.evaluate(() => {
      document
        .querySelector('.aside-panel:not([hidden]) button[data-aside-role="recovery-ordinary-confirm"]')
        ?.click();
    });
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);
    const ordinaryFrame = await waitForBranchFrame(page);
    const ordinary = await ordinaryFrame.evaluate(() => ({
      location: window.location.href,
      lastPrompt: window.__lastPrompt ?? null,
      temporaryChatModeActive: window.__temporaryChatModeActive ?? false
    }));
    ordinary.selectedKind = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) .aside-kind-toggle button[data-selected="true"]')
          ?.dataset.asideRole ?? null
    );

    return { ...blocked, failedLayout, afterFirstClick, ordinary };
  } finally {
    await page.close();
  }
}

/**
 * The live ChatGPT shape from the owner's log: the Temporary control is inside a
 * closed composer menu (present, enabled, 0x0), and ChatGPT asks Personalized /
 * Unpersonalized once it is selected. Aside opens the menu, selects the control,
 * stops at the chooser without choosing, and continues on the same document after
 * the owner chooses and presses Check again — with exactly one send.
 */
async function runTemporaryChatMenuChooserScenario(browser) {
  routeMap = {
    '/c/source-temp-menu': buildSourceHtml(),
    '/': buildSuccessComposerHtml({
      conversationPath: '/c/generated-temp-menu',
      includeTemporaryChatToggle: true,
      temporaryChatInitiallyActive: false,
      temporaryChatActivationStyle: 'menu',
      temporaryChatChooser: true,
      temporaryModeSkipsConversationUrl: true,
      realComposerId: ''
    })
  };

  const page = await createSourcePage(browser, '/c/source-temp-menu');

  try {
    await openDraft(page);
    await setPanelBranchKind(page, 'temporary');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', PRIVATE_PROBE_QUESTION);
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /This branch was not sent\./);
    await capture(page, 'panel-chatgpt-private-awaiting-choice');

    const awaiting = await page.evaluate(() => ({
      status:
        document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ?? null,
      errorText:
        document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ?? null,
      hint: document.querySelector('.aside-panel:not([hidden]) .aside-recovery > p')?.textContent ?? null
    }));
    Object.assign(awaiting, await readFailedPanelLayout(page));
    const frameBefore = await branchFrame.evaluate(() => {
      window.__docToken = 'menu-doc';
      const composer = document.querySelector('#composer-form textarea');
      const chooser = document.getElementById('temporary-chooser');
      return {
        menuTriggerClicks: window.__menuTriggerClicks ?? 0,
        toggleClicks: window.__temporaryChatToggleClicks ?? 0,
        chooserVisible: chooser instanceof HTMLElement && getComputedStyle(chooser).display !== 'none',
        choice: window.__personalizationChoice ?? null,
        composerValue: composer instanceof HTMLTextAreaElement ? composer.value : null,
        lastPrompt: window.__lastPrompt ?? null,
        submitCount: window.__submitCount ?? 0
      };
    });

    // The owner answers ChatGPT's question in the branch window, then Check again.
    await branchFrame.evaluate(() => document.getElementById('chooser-unpersonalized')?.click());
    await page.evaluate(() => {
      document
        .querySelector('.aside-panel:not([hidden]) button[data-aside-role="recovery-check-again"]')
        ?.click();
    });
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);
    const after = await branchFrame.evaluate(() => ({
      docToken: window.__docToken ?? null,
      submitCount: window.__submitCount ?? 0,
      lastPrompt: window.__lastPrompt ?? null,
      location: window.location.href,
      toggleClicks: window.__temporaryChatToggleClicks ?? 0,
      menuTriggerClicks: window.__menuTriggerClicks ?? 0,
      choice: window.__personalizationChoice ?? null,
      temporaryChatModeActive: window.__temporaryChatModeActive ?? false
    }));
    const storage = await readExtensionStorage(browser);

    return {
      awaiting,
      frameBefore,
      after,
      privateTextInLocalStorage: storage.local.includes(PRIVATE_PROBE_QUESTION),
      privateTextInSessionStorage: storage.session.includes(PRIVATE_PROBE_QUESTION)
    };
  } finally {
    await page.close();
  }
}

async function runProjectScenario(browser) {
  const sourcePath = '/g/g-p-demo-project/c/source-project';
  const launchPath = '/g/g-p-demo-project/project';
  const conversationPath = '/g/g-p-demo-project/c/generated-project';
  routeMap = {
    [sourcePath]: buildSourceHtml(),
    [launchPath]: buildSuccessComposerHtml({ conversationPath })
  };

  const page = await createSourcePage(browser, sourcePath);

  try {
    await openDraft(page);
    // Inside a project, choosing the private mode must say ONCE that the branch
    // leaves the project — as the note's own warning line, with the duplicate
    // bullet hidden — and must not pop the note open on the owner.
    await setPanelBranchKind(page, 'temporary');
    const privacyNote = await page.evaluate(() => {
      const note = document.querySelector('.aside-panel:not([hidden]) .aside-privacy-note');
      const warning = note?.querySelector('.aside-privacy-warning:not([hidden])');
      const bullets = Array.from(note?.querySelectorAll('li') ?? []);
      return {
        noteOpen: note instanceof HTMLDetailsElement ? note.open : null,
        containerWarningVisible: Boolean(warning && /project/i.test(warning.textContent ?? '')),
        projectBulletHidden: bullets
          .filter((item) => /project/i.test(item.textContent ?? ''))
          .every((item) => item.hidden),
        projectMentionsShown: (note instanceof HTMLElement ? note.innerText : '').match(/project/gi)?.length ?? 0
      };
    });
    await setPanelBranchKind(page, 'persistent');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);

    return await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null
      })),
      branchFrame.evaluate(() => ({
        branchLocation: window.location.href
      }))
    ]).then(([source, branch]) => ({ ...source, ...branch, privacyNote }));
  } finally {
    await page.close();
  }
}


async function runCrossTabScenario(browser) {
  // Two tabs on the SAME conversation, so both mount the same panel. Covers the
  // two failures the per-panel protocol exists to prevent: a stale whole-store
  // write losing another tab's edit, and a closed panel being resurrected.
  routeMap = {
    '/c/source-cross-tab': buildSourceHtml(),
    '/': buildSuccessComposerHtml({ conversationPath: '/c/generated-cross-tab' })
  };

  const tabA = await createSourcePage(browser, '/c/source-cross-tab');
  let tabB;

  try {
    await openDraft(tabA);
    // Pin the mode: a previous scenario may have left "Temporary" remembered, which
    // would route this panel to session storage and make the assertions ambiguous.
    await setPanelBranchKind(tabA, 'persistent');
    await tabA.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'question from tab A');
    // Finish editing in tab A before handing over, as a user would. Without this
    // both tabs keep saving and the test measures a race between two live editors
    // rather than the protocol.
    await tabA.evaluate(() => {
      document
        .querySelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]')
        ?.blur();
    });
    await sleep(900);

    // The panel under test, named explicitly: the shared profile also holds
    // minimized panels from earlier scenarios.
    const panelId = await tabA.evaluate(
      () => document.querySelector('.aside-panel:not([hidden])')?.getAttribute('data-panel-id') ?? null
    );
    if (!panelId) {
      throw new Error('Cross-tab scenario could not identify the panel under test.');
    }

    tabB = await createSourcePage(browser, '/c/source-cross-tab');
    // Wait until tab B has actually caught up with tab A's draft. Editing before
    // both tabs agree on a revision tests the race, not the protocol.
    try {
      await tabB.waitForFunction(
        (id) => {
          const textarea = document.querySelector(
            `.aside-panel[data-panel-id="${id}"] textarea[data-aside-role="question"]`
          );
          return textarea instanceof HTMLTextAreaElement && textarea.value === 'question from tab A';
        },
        { timeout: 15_000 },
        panelId
      );
    } catch (error) {
      // A bare timeout here says nothing about why. Report what the store holds
      // and what tab B actually mounted.
      const stored = await readExtensionStorage(browser);
      const mounted = await tabB.evaluate(() =>
        Array.from(document.querySelectorAll('.aside-panel')).map((panel) => ({
          panelId: panel.getAttribute('data-panel-id'),
          hidden: panel.hidden,
          question: panel.querySelector('textarea[data-aside-role="question"]')?.value ?? null
        }))
      );
      throw new Error(
        `Tab B never picked up tab A's draft: ${JSON.stringify({
          panelId,
          mounted,
          storedRecord: JSON.parse(stored.local)[`aside:panel:${panelId}`] ?? null,
          storedKeys: Object.keys(JSON.parse(stored.local))
        })}`
      );
    }

    // Tab B edits the shared panel; the authority accepts it.
    await tabB.evaluate((id) => {
      const textarea = document.querySelector(`.aside-panel[data-panel-id="${id}"] textarea[data-aside-role="question"]`);
      textarea.focus();
      textarea.value = 'edited in tab B';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.blur();
    }, panelId);
    await sleep(900);

    const tabBWriteState = await tabB.evaluate((id) => {
      const panel = document.querySelector(`.aside-panel[data-panel-id="${id}"]`);
      const textarea = panel?.querySelector('textarea');
      return {
        found: Boolean(panel),
        storeStatus: panel?.getAttribute('data-store-status') ?? null,
        unsaved: panel?.getAttribute('data-unsaved') ?? null,
        storeRev: panel?.getAttribute('data-store-rev') ?? null,
        textareaValue: textarea instanceof HTMLTextAreaElement ? textarea.value : null,
        hidden: panel instanceof HTMLElement ? panel.hidden : null
      };
    }, panelId);

    const afterEdit = await readExtensionStorage(browser);

    // Tab A closes its VIEW. That deletes nothing: the record stays, no
    // tombstone is written, and tab B's own view is not forced shut.
    await clickPanelAction(tabA, 'Close');
    await sleep(900);
    const afterCloseOnly = await readExtensionStorage(browser);
    const tabBAfterClose = await tabB.evaluate(
      (id) => {
        const panel = document.querySelector(`.aside-panel[data-panel-id="${id}"]`);
        return { mounted: Boolean(panel), hidden: panel instanceof HTMLElement ? panel.hidden : null };
      },
      panelId
    );

    // Now tab A deletes the question explicitly, from the question list. That is
    // the action that leaves a tombstone.
    await tabA.evaluate(() => {
      window.confirm = () => true;
      const button = Array.from(document.querySelectorAll('#aside-tabbar button')).find((candidate) =>
        candidate.textContent?.startsWith('Questions')
      );
      if (!(button instanceof HTMLElement)) {
        throw new Error('Questions list entry not found in the rail');
      }
      button.click();
    });
    await tabA.waitForSelector('#aside-qlist:not([hidden]) .aside-qlist-row', { timeout: 10_000 });
    const listRowCount = await tabA.evaluate(() => document.querySelectorAll('#aside-qlist .aside-qlist-row').length);
    await tabA.evaluate(() => {
      const row = document.querySelector('#aside-qlist .aside-qlist-row');
      const del = Array.from(row?.querySelectorAll('button') ?? []).find((b) => b.textContent === 'Delete');
      if (!(del instanceof HTMLElement)) {
        throw new Error('Delete action not found in the question list');
      }
      del.click();
    });
    await sleep(1200);

    // Tab B, which still had it mounted a moment ago, writes again. A stale
    // whole-store write would bring the panel straight back.
    await tabB.evaluate((id) => {
      const textarea = document.querySelector(`.aside-panel[data-panel-id="${id}"] textarea[data-aside-role="question"]`);
      if (textarea) {
        textarea.focus();
        textarea.value = 'late write from tab B';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.blur();
      }
    }, panelId);
    await sleep(900);

    const afterClose = await readExtensionStorage(browser);

    return {
      panelId,
      editVisibleInStore: afterEdit.local.includes('edited in tab B'),
      storedQuestionAfterEdit:
        JSON.parse(afterEdit.local)[`aside:panel:${panelId}`]?.state?.initialQuestion ?? null,
      storedRevAfterEdit: JSON.parse(afterEdit.local)[`aside:panel:${panelId}`]?.rev ?? null,
      tabBWriteState: tabBWriteState,
      panelStoredAfterEdit: afterEdit.local.includes(`aside:panel:${panelId}`),
      // Close is presentation only.
      panelKeptAfterClose: afterCloseOnly.local.includes(`aside:panel:${panelId}`),
      tombstoneAfterCloseOnly: afterCloseOnly.local.includes(`aside:gone:${panelId}`),
      tabBViewSurvivedClose: tabBAfterClose.mounted && tabBAfterClose.hidden === false,
      listRowCount,
      // Delete is explicit and leaves a tombstone.
      panelResurrectedAfterClose: afterClose.local.includes(`aside:panel:${panelId}`),
      tombstoneWritten: afterClose.local.includes(`aside:gone:${panelId}`),
      lateWriteLanded: afterClose.local.includes('late write from tab B'),
      // Tab B should have dropped the panel once the deletion was broadcast.
      tabBStillShowsPanel: await tabB.evaluate(
        (id) => Boolean(document.querySelector(`.aside-panel[data-panel-id="${id}"]`)),
        panelId
      )
    };
  } finally {
    if (tabB) {
      await tabB.close().catch(() => {});
    }
    await tabA.close();
  }
}


/**
 * Claude fixtures.
 *
 * Sanitized shapes built from the adapter's candidate selectors: user turns carry
 * data-testid="user-message", assistant turns render in .font-claude-message with
 * .standard-markdown content, and the composer is a ProseMirror contenteditable
 * with an aria-labelled send button. These exercise the adapter offline; they are
 * not a capture of a live Claude account.
 */
function buildClaudeSourceHtml({ variant = 'current' } = {}) {
  const assistantMarkup =
    variant === 'legacy'
      ? `<div data-testid="assistant-message"><div class="standard-markdown">
           <p>The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.</p>
           <p>Older unrelated details should not matter.</p>
         </div></div>`
      : `<div class="font-claude-message"><div class="standard-markdown">
           <p>The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.</p>
           <p>Older unrelated details should not matter.</p>
         </div></div>`;

  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Fake Claude Source</title>${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="open">
    <nav aria-label="Chat history"><div>Recents</div></nav>
    <main>
      <header>Fake Claude header</header>
      <div data-testid="user-message"><p>Tell me about convexity.</p></div>
      ${assistantMarkup}
    </main>
  </body>
</html>`;
}

function buildClaudeComposerHtml({ conversationPath = '/chat/generated-claude', incognito = 'available' } = {}) {
  // 'active-interface' models the documented ACTIVE state: no launch control, the
  // "Incognito chat" label in the provider's own header.
  const incognitoMarkup =
    incognito === 'none' || incognito === 'active-interface'
      ? ''
      : `<button id="incognito-toggle" type="button" aria-label="Start incognito chat" aria-pressed="false">Incognito</button>`;
  const headerMarkup =
    incognito === 'active-interface'
      ? `<header>Fake Claude header <span id="incognito-indicator" aria-label="Incognito chat">Incognito chat</span></header>`
      : `<header>Fake Claude header</header>`;

  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Fake Claude Branch</title>${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="open">
    <nav aria-label="Chat history"><div>Recents</div></nav>
    <main>
      ${headerMarkup}
      <div id="turns"></div>
      <form id="composer-form">
        <fieldset style="border:0;padding:0;margin:0;">
          <div id="prompt" class="ProseMirror" contenteditable="true" role="textbox"
               aria-label="Write your prompt to Claude"
               style="min-height:56px;width:100%;border:1px solid #ccc;padding:8px;box-sizing:border-box;"></div>
        </fieldset>
        ${incognitoMarkup}
        <button type="button" aria-label="Send message">Send</button>
      </form>
    </main>
    <script>
      const composer = document.getElementById('prompt');
      const incognitoToggle = document.getElementById('incognito-toggle');
      window.__incognitoActive = ${incognito === 'active-interface' ? 'true' : 'false'};
      if (incognitoToggle) {
        incognitoToggle.addEventListener('click', () => {
          const active = incognitoToggle.getAttribute('aria-pressed') === 'true';
          window.__incognitoClicks = (window.__incognitoClicks || 0) + 1;
          incognitoToggle.setAttribute('aria-pressed', active ? 'false' : 'true');
          incognitoToggle.setAttribute('aria-label', active ? 'Start incognito chat' : 'Leave incognito chat');
          window.__incognitoActive = !active;
        });
      }

      function submitPrompt() {
        const prompt = composer.innerText;
        if (!prompt.trim()) {
          return;
        }
        window.__lastPrompt = prompt;
        composer.innerHTML = '';
        if (!window.__incognitoActive) {
          history.pushState(null, '', ${JSON.stringify(conversationPath)});
        }
        document.getElementById('turns').innerHTML =
          '<div data-testid="user-message"><div class="standard-markdown"></div></div>' +
          '<div class="font-claude-message"><div class="standard-markdown">' +
          '<p>This answers the selected passage.</p>' +
          '</div></div>';
        document.querySelector('#turns [data-testid="user-message"] .standard-markdown').textContent = prompt;
      }

      document.querySelector('button[aria-label="Send message"]').addEventListener('click', (event) => {
        event.preventDefault();
        window.__sendClicks = (window.__sendClicks || 0) + 1;
        window.__sendSawText = composer.innerText.length;
        submitPrompt();
      });
      composer.addEventListener('keydown', (event) => {
        window.__enterKeys = (window.__enterKeys || 0) + 1;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitPrompt();
        }
      });
      window.__fixtureReady = true;
    </script>
  </body>
</html>`;
}

async function createClaudePage(browser, pathName) {
  const page = await browser.newPage();
  page.__consoleMessages = [];
  page.__dialogs = [];
  page.on('console', (message) => {
    page.__consoleMessages.push(message.text());
  });
  // A modal dialog would freeze the page and time out every later evaluate.
  // Record it and move on; the product must never open one on a provider page.
  page.on('dialog', (dialog) => {
    page.__dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  await page.goto(`https://claude.ai${pathName}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  return page;
}

async function selectClaudeAssistantText(page) {
  await page.evaluate(() => {
    const paragraph = document.querySelector(
      '.font-claude-message .standard-markdown p, [data-testid="assistant-message"] .standard-markdown p'
    );
    const text = paragraph?.firstChild;
    if (!text) {
      throw new Error('Claude assistant paragraph was not found.');
    }
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 55);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

async function runClaudeScenario(browser, { variant = 'current' } = {}) {
  routeMap = { '*': buildSourceHtml() };
  // These two scenarios model a Claude that DOES refuse to be framed, so the
  // driven-window fallback below is proved by observation. Whether the real
  // claude.ai refuses is not something this harness can know — which is the point:
  // the product now finds out by looking, instead of being told by a comment.
  refuseFramingForPaths = ['/new', '/chat/'];
  claudeRouteMap = {
    '/chat/source-claude': buildClaudeSourceHtml({ variant }),
    '/new': buildClaudeComposerHtml({}),
    '*': buildClaudeComposerHtml({})
  };

  const page = await createClaudePage(browser, '/chat/source-claude');
  const existingPages = await browser.pages();

  try {
    await selectClaudeAssistantText(page);
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector('#aside-selection-toolbar');
        return toolbar instanceof HTMLElement && !toolbar.hidden;
      },
      { timeout: 10_000 }
    );

    const toolbarState = await page.evaluate(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return {
        visible: toolbar instanceof HTMLElement && !toolbar.hidden,
        label: toolbar?.getAttribute('aria-label') ?? null,
        actions: Array.from(toolbar?.querySelectorAll('button') ?? []).map((b) => b.textContent)
      };
    });

    await page.evaluate(() => document.querySelector('#aside-ask-button')?.click());
    await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', {
      timeout: 10_000
    });

    const contextPreview = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) .aside-context-preview')?.textContent ?? ''
    );

    if (variant === 'current') {
      // Evidence for the owner checklist: the private toggle carries Claude's own
      // word for the mode, and its documented constraints are on screen before a
      // private branch runs.
      await setPanelBranchKind(page, 'temporary');
      await page.evaluate(() => {
        const note = document.querySelector('.aside-panel:not([hidden]) .aside-privacy-note');
        if (note instanceof HTMLDetailsElement) {
          note.open = true;
        }
      });
      await sleep(150);
      await capture(page, 'panel-claude-private-constraints');
    }

    await setPanelBranchKind(page, 'persistent');
    await page.type(
      '.aside-panel:not([hidden]) textarea[data-aside-role="question"]',
      'Why this assumption?'
    );
    if (variant === 'current') {
      await sleep(150);
      await capture(page, 'panel-claude-context');
    }
    await page.evaluate(() => {
      document.querySelector('.aside-panel:not([hidden]) button[type="submit"]')?.click();
    });

    // This fixture refuses framing, so the branch must fall back to a driven
    // window — and must do so from the frame's observed failure, not from a
    // hard-coded capability flag.

    const branchPage = await waitForAdditionalPage(browser, existingPages, 45_000);
    branchPage.on('pageerror', (err) => console.error('CLAUDE BRANCH PAGEERROR', err.message));
    try {
      await branchPage.waitForFunction(
        () => window.location.href.includes('/chat/generated-claude'),
        { timeout: 45_000 }
      );
    } catch (error) {
      const debug = await branchPage.evaluate(() => ({
        location: window.location.href,
        fixtureReady: window.__fixtureReady ?? false,
        composerText: (document.querySelector('#prompt')?.textContent ?? '').slice(0, 120),
        sendClicks: window.__sendClicks ?? 0,
        lastPrompt: window.__lastPrompt ? 'set' : null
      }));
      console.error('CLAUDE BRANCH DEBUG', JSON.stringify(debug));
      throw error;
    }

    await waitForPanelStatus(page, /Branch/);

    const branchState = await branchPage.evaluate(() => ({
      location: window.location.href,
      sendClicks: window.__sendClicks ?? 0,
      lastPrompt: window.__lastPrompt ?? null,
      assistantText:
        document.querySelector('#turns .font-claude-message .standard-markdown')?.textContent ?? null
    }));

    const panelState = await page.evaluate(() => {
      const panel = document.querySelector('.aside-panel:not([hidden])');
      const nativeRect = document
        .querySelector('nav[aria-label]')
        ?.getBoundingClientRect();
      const railRect = document.querySelector('#aside-tabbar')?.getBoundingClientRect();
      return {
        status: panel?.querySelector('.aside-panel-heading p')?.textContent ?? null,
        surface: panel?.querySelector('.aside-frame-overlay-title')?.textContent ?? null,
        railOverlapsSidebar: Boolean(
          nativeRect &&
            railRect &&
            railRect.left < nativeRect.right &&
            railRect.right > nativeRect.left
        )
      };
    });

    return { variant, toolbarState, contextPreview, branchState, panelState };
  } finally {
    const pages = await browser.pages();
    await Promise.all(
      pages.filter((candidate) => !existingPages.includes(candidate)).map((c) => c.close().catch(() => {}))
    );
    await page.close();
  }
}


/**
 * Claude with framing allowed: the branch must run in the in-page panel.
 *
 * The owner reported every Claude branch opening a separate window. The cause was
 * a capability flag set to 'unsupported' from an unchecked assumption — and
 * because the same flag gated the attempt, nothing could ever disprove it. This
 * asserts the attempt now happens.
 */
async function runClaudeEmbeddedScenario(browser) {
  routeMap = { '*': buildSourceHtml() };
  refuseFramingForPaths = [];
  claudeRouteMap = {
    '/chat/source-claude-embedded': buildClaudeSourceHtml({ variant: 'current' }),
    '/new': buildClaudeComposerHtml({}),
    '*': buildClaudeComposerHtml({})
  };

  const page = await createClaudePage(browser, '/chat/source-claude-embedded');
  const existingPages = await browser.pages();

  try {
    await selectClaudeAssistantText(page);
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector('#aside-selection-toolbar');
        return toolbar instanceof HTMLElement && !toolbar.hidden;
      },
      { timeout: 10_000 }
    );

    await page.evaluate(() => document.querySelector('#aside-ask-button')?.click());
    await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', {
      timeout: 10_000
    });
    await setPanelBranchKind(page, 'persistent');
    await page.type(
      '.aside-panel:not([hidden]) textarea[data-aside-role="question"]',
      'Why this assumption?'
    );
    await page.evaluate(() => {
      document.querySelector('.aside-panel:not([hidden]) button[type="submit"]')?.click();
    });

    // The frame is pointed at about:blank first to force a real document load, so
    // wait for the actual provider URL rather than sampling once.
    await page.waitForFunction(
      () => {
        const frame = document.querySelector('.aside-panel:not([hidden]) iframe.aside-frame');
        return frame instanceof HTMLIFrameElement && frame.src.includes('claude.ai');
      },
      { timeout: 20_000 }
    ).catch(() => {});

    const pagesAfter = await browser.pages();

    return {
      framedInPanel: await page.evaluate(() => {
        const frame = document.querySelector('.aside-panel:not([hidden]) iframe.aside-frame');
        const shell = document.querySelector('.aside-panel:not([hidden]) .aside-frame-shell');
        return (
          frame instanceof HTMLIFrameElement &&
          frame.src.includes('claude.ai') &&
          shell instanceof HTMLElement &&
          !shell.hidden
        );
      }),
      frameSrc: await page.evaluate(
        () =>
          document.querySelector('.aside-panel:not([hidden]) iframe.aside-frame')?.src ?? null
      ),
      panelStatus: await page.evaluate(
        () =>
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')
            ?.textContent ?? null
      ),
      // No separate window: the whole point of the report.
      openedSeparateWindow: pagesAfter.length > existingPages.length
    };
  } finally {
    const pages = await browser.pages();
    await Promise.all(
      pages.filter((candidate) => !existingPages.includes(candidate)).map((c) => c.close().catch(() => {}))
    );
    await page.close();
  }
}

/**
 * Claude with incognito ALREADY active in the branch document: no launch control,
 * only the documented interface label. That label is the verification, and the
 * private branch must run in the panel with a single send and no toggle click.
 */
async function runClaudeIncognitoActiveScenario(browser) {
  routeMap = { '*': buildSourceHtml() };
  refuseFramingForPaths = [];
  claudeRouteMap = {
    '/chat/source-claude-incognito': buildClaudeSourceHtml({ variant: 'current' }),
    '/new': buildClaudeComposerHtml({ incognito: 'active-interface' }),
    '*': buildClaudeComposerHtml({ incognito: 'active-interface' })
  };

  const page = await createClaudePage(browser, '/chat/source-claude-incognito');
  const existingPages = await browser.pages();

  try {
    await selectClaudeAssistantText(page);
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector('#aside-selection-toolbar');
        return toolbar instanceof HTMLElement && !toolbar.hidden;
      },
      { timeout: 10_000 }
    );
    await page.evaluate(() => document.querySelector('#aside-ask-button')?.click());
    await page.waitForSelector('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', {
      timeout: 10_000
    });
    await setPanelBranchKind(page, 'temporary');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', PRIVATE_PROBE_QUESTION);
    await page.evaluate(() => {
      document.querySelector('.aside-panel:not([hidden]) button[type="submit"]')?.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Branch answer is ready in this window\./);
    await capture(page, 'panel-claude-incognito-verified');

    const branch = await branchFrame.evaluate(() => ({
      location: window.location.href,
      sendClicks: window.__sendClicks ?? 0,
      incognitoClicks: window.__incognitoClicks ?? 0,
      lastPrompt: window.__lastPrompt ?? null
    }));
    const pagesAfter = await browser.pages();
    const storage = await readExtensionStorage(browser);
    const log = await page.evaluate(
      () =>
        document.querySelector('.aside-panel:not([hidden]) textarea[data-aside-role="debug-log"]')?.value ?? ''
    );

    return {
      ...branch,
      openedSeparateWindow: pagesAfter.length > existingPages.length,
      privateTextInLocalStorage: storage.local.includes(PRIVATE_PROBE_QUESTION),
      privateTextInSessionStorage: storage.session.includes(PRIVATE_PROBE_QUESTION),
      logMentionsMarker: /interface-marker/.test(log) || storage.session.includes('interface-marker')
    };
  } finally {
    const pages = await browser.pages();
    await Promise.all(
      pages.filter((candidate) => !existingPages.includes(candidate)).map((c) => c.close().catch(() => {}))
    );
    await page.close();
  }
}

const SCREENSHOT_DIR = process.env.CAPTURE_SCREENSHOTS ?? null;

async function capture(page, name) {
  if (!SCREENSHOT_DIR) {
    return;
  }
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

/**
 * Acceptance case 2: at representative widths, themes and sidebar states, the
 * minimized rail uses safe left space (or its documented fallback) and the native
 * selection action stays usable. Assertions are on measured geometry and real hit
 * targets, not on screenshots — screenshots are only captured as evidence.
 */
async function runLayoutMatrixScenario(browser) {
  const viewports = [
    { name: '1440', width: 1440, height: 900 },
    { name: '1024', width: 1024, height: 768 },
    { name: '768', width: 768, height: 800 }
  ];
  const results = [];

  for (const viewport of viewports) {
    for (const sidebar of ['open', 'collapsed']) {
      for (const dark of [false, true]) {
        const label = `${viewport.name}-${sidebar}-${dark ? 'dark' : 'light'}`;
        routeMap = {
          [`/c/layout-${label}`]: buildSourceHtml({ dark, sidebar }),
          '/': buildSuccessComposerHtml({ conversationPath: `/c/generated-${label}`, dark })
        };

        const page = await createSourcePage(browser, `/c/layout-${label}`);
        try {
          await page.setViewport({ width: viewport.width, height: viewport.height });
          await selectAssistantText(page);
          // Late mount, and no reselection: on a real page the popup appears on its
          // own after the selection has settled, and only the MutationObserver tells
          // Aside about it. Reselecting here re-ran the whole selection pipeline and
          // hid the fact that the observer path had no coverage at all.
          await injectNativeAskButton(page, { placement: 'above', delayMs: 200 });
          await page.waitForFunction(() => {
            const toolbar = document.querySelector('#aside-selection-toolbar');
            return toolbar instanceof HTMLElement && !toolbar.hidden;
          }, { timeout: 10_000 });

          const occlusion = await readAsideOcclusion(page);
          const nativeOcclusion = await readNativePopupOcclusion(page);

          await capture(page, `toolbar-${label}`);

          await openDraft(page);
          await page.type(
            '.aside-panel:not([hidden]) textarea[data-aside-role="question"]',
            'Why this assumption?'
          );
          await clickPanelAction(page, 'Minimize');
          await sleep(400);
          await capture(page, `rail-${label}`);

          const measured = await page.evaluate(() => {
            const rail = document.querySelector('#aside-tabbar');
            const launcher = document.querySelector('#aside-launcher');
            const toolbar = document.querySelector('#aside-selection-toolbar');
            const sidebarEl = document.querySelector('nav[aria-label]');
            const column = document.querySelector('main article, main #turns, main #composer-form');
            const nativeAsk = document.querySelector('button[aria-label="Ask ChatGPT"]');
            const rect = (el) => (el ? el.getBoundingClientRect() : null);
            const overlaps = (a, b) =>
              Boolean(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

            const railRect = rail && !rail.hidden ? rect(rail) : null;
            const launcherRect = launcher && !launcher.hidden ? rect(launcher) : null;
            const shown = railRect ?? launcherRect;
            const nativeRect = rect(nativeAsk);
            const hit =
              nativeRect && nativeRect.width > 0
                ? document.elementFromPoint(
                    nativeRect.left + nativeRect.width / 2,
                    nativeRect.top + nativeRect.height / 2
                  )
                : null;

            return {
              placement: rail?.getAttribute('data-placement') ?? null,
              railShown: Boolean(railRect),
              launcherShown: Boolean(launcherRect),
              anythingShown: Boolean(shown),
              onLeftHalf: shown ? shown.left < window.innerWidth / 2 : null,
              overlapsSidebar: overlaps(shown, rect(sidebarEl)),
              overlapsColumn: overlaps(shown, rect(column)),
              overlapsNativeAsk: overlaps(shown, nativeRect) || overlaps(rect(toolbar), nativeRect),
              nativeAskHitTargetIsNative:
                hit === nativeAsk || Boolean(nativeAsk && nativeAsk.contains(hit)),
              theme: document.documentElement.getAttribute('data-aside-theme')
            };
          });

          results.push({ label, ...measured, occlusion, nativeOcclusion });
        } finally {
          await page.close();
        }
      }
    }
  }

  return results;
}

/**
 * The library page: Aside's own extension page, reached through the worker's
 * extension id. It must list the sources and questions the earlier scenarios
 * created, show a captured answer read-only, and carry the build id.
 */
async function runLibraryScenario(browser, { questionId = null } = {}) {
  const workerTarget = browser.targets().find((target) => target.type() === 'service_worker');
  if (!workerTarget) {
    throw new Error('Extension service worker target was not found.');
  }
  const extensionId = new URL(workerTarget.url()).hostname;
  const page = await browser.newPage();
  page.__dialogs = [];
  page.on('dialog', (dialog) => {
    page.__dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });

  try {
    await page.goto(`chrome-extension://${extensionId}/library.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('#sources .source', { timeout: 20_000 });
    const sourceCount = await page.evaluate(() => document.querySelectorAll('#sources .source').length);
    const footer = await page.evaluate(() => document.querySelector('#about')?.textContent ?? '');

    // Search finds a word from a captured answer, across every source.
    await page.type('#search', 'uses only the selected passage');
    await page.waitForSelector('#content .q', { timeout: 10_000 });
    // Every keystroke re-renders the results. On a slow runner the last of those
    // renders landed AFTER the View click below and replaced the opened thread
    // with the list again, so wait until the results have stopped changing.
    await page.waitForFunction(
      () => document.querySelector('#search')?.value === 'uses only the selected passage',
      { timeout: 10_000 }
    );
    let previousResults = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      const current = await page.evaluate(() => document.querySelector('#content')?.innerHTML ?? '');
      if (current === previousResults) {
        break;
      }
      previousResults = current;
    }
    const searchHit = await page.evaluate(() => document.querySelector('#content .q small')?.textContent ?? '');

    // Open the first hit: the saved thread renders as text, read-only.
    await page.evaluate(() => {
      const view = Array.from(document.querySelectorAll('#content .q button')).find((b) => b.textContent === 'View');
      view?.click();
    });
    await page.waitForSelector('#content .msg[data-role="assistant"]', { timeout: 10_000 });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('#content details summary')).some((el) =>
          el.textContent?.includes('Exactly what was sent')
        ),
      { timeout: 10_000 }
    );
    const bundle = await page.evaluate(() => ({
      assistantText: document.querySelector('#content .msg[data-role="assistant"]')?.textContent ?? null,
      assistantPartial: document.querySelector('#content .msg[data-role="assistant"]')?.getAttribute('data-partial') ?? null,
      status: document.querySelector('#content .meta')?.textContent ?? null,
      promptShown: Boolean(Array.from(document.querySelectorAll('#content details summary')).find((el) => el.textContent?.includes('Exactly what was sent'))),
      scripts: document.querySelectorAll('#content script').length
    }));

    // The record of the question the non-project scenario asked, read through
    // the extension page's own channel: complete answer, captured through.
    const record = questionId
      ? await page.evaluate(async (id) => {
          const response = await chrome.runtime.sendMessage({ type: 'DOMAIN_QUERY', query: 'bundle', questionId: id });
          const bundle = response?.bundle;
          if (!bundle) {
            return null;
          }
          const last = bundle.messages.filter((m) => m.role === 'assistant').at(-1) ?? null;
          const link = bundle.links.at(-1) ?? null;
          return {
            title: bundle.question.title,
            lifecycle: bundle.question.lifecycle,
            messageCount: bundle.messages.length,
            lastAssistantText: last?.text ?? null,
            lastAssistantPartial: last?.partial ?? null,
            capture: link?.capture ?? null,
            run: link?.run ?? null,
            snapshotPrompt: bundle.snapshots.at(-1)?.prompt ?? null,
            conversationUrl: link?.conversationUrl ?? null
          };
        }, questionId)
      : null;

    const storage = await readExtensionStorage(browser);
    const journal = JSON.parse(storage.local)['aside:migration-journal'] ?? null;

    return { extensionIdKnown: Boolean(extensionId), sourceCount, footer, searchHit, bundle, record, journal, dialogs: page.__dialogs };
  } finally {
    await page.close();
  }
}

async function runFailureScenario(browser) {
  routeMap = {
    '/c/source-failure': buildSourceHtml(),
    '/': buildFalsePositiveComposerHtml()
  };

  const page = await createSourcePage(browser, '/c/source-failure');

  try {
    await openDraft(page);
    await setPanelBranchKind(page, 'persistent');
    await page.type('.aside-panel:not([hidden]) textarea[data-aside-role="question"]', 'Why this assumption?');
    const pageCountBefore = (await browser.pages()).length;
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Local branch creation failed\./);
    const pageCountAfter = (await browser.pages()).length;
    await clickPanelAction(page, 'Copy log');

    return await Promise.all([
      page.evaluate(() => ({
        status:
          document.querySelector('.aside-panel:not([hidden]) .aside-panel-heading p')?.textContent ??
          null,
        errorText:
          document.querySelector('.aside-panel:not([hidden]) .aside-error-copy')?.textContent ??
          null,
        bodyText: document.body.innerText
      })),
      branchFrame.evaluate(() => ({
        branchLocation: window.location.href,
        enterFallbackTriggered: Boolean(window.__enterFallbackTriggered)
      }))
    ]).then(async ([source, branch]) => ({
      ...source,
      ...branch,
      pageCountBefore,
      pageCountAfter
    }));
  } finally {
    await page.close();
  }
}

await fs.rm(profilePath, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless,
  pipe: true,
  userDataDir: profilePath,
  enableExtensions: [extensionPath],
  defaultViewport: { width: 1440, height: 960 },
  args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check']
});

let exitCode = 0;

try {
  await installBrowserInterception(browser);

  const nonProject = await runNonProjectScenario(browser);
  const why = includeNativeWindowSmoke ? await runWhyScenario(browser) : null;
  const newTab = includeNativeWindowSmoke ? await runNewTabScenario(browser) : null;
  const enterOnly = await runEnterOnlyScenario(browser);
  const project = await runProjectScenario(browser);
  const temporaryChatUnconfirmed = await runTemporaryChatUnconfirmedScenario(browser);
  const temporaryChatVerified = await runTemporaryChatVerifiedScenario(browser);
  const temporaryChatBlocked = await runTemporaryChatBlockedScenario(browser);
  const temporaryChatMenuChooser = await runTemporaryChatMenuChooserScenario(browser);
  const claudeIncognitoActive = await runClaudeIncognitoActiveScenario(browser);
  const claudeCurrent = await runClaudeScenario(browser, { variant: 'current' });
  const claudeLegacy = await runClaudeScenario(browser, { variant: 'legacy' });
  const claudeEmbedded = await runClaudeEmbeddedScenario(browser);
  const layoutMatrix = await runLayoutMatrixScenario(browser);
  const crossTab = await runCrossTabScenario(browser);
  const failure = await runFailureScenario(browser);
  const library = await runLibraryScenario(browser, { questionId: nonProject.liveResult.questionId });

  const result = {
    nonProject,
    why,
    newTab,
    enterOnly,
    project,
    temporaryChatUnconfirmed,
    temporaryChatVerified,
    temporaryChatBlocked,
    temporaryChatMenuChooser,
    claudeIncognitoActive,
    layoutMatrix,
    claudeCurrent,
    claudeLegacy,
    claudeEmbedded,
    crossTab,
    failure,
    library
  };

  console.log(JSON.stringify(result, null, 2));

  if (
    library.extensionIdKnown !== true ||
    (library.sourceCount ?? 0) < 1 ||
    !/Aside build /.test(library.footer) ||
    !/matched in (message|title|draft)/.test(library.searchHit) ||
    !library.bundle.assistantText?.includes('This uses only the selected passage.') ||
    library.bundle.promptShown !== true ||
    // The non-project question's own record: answer complete, captured through,
    // the frozen prompt equal to what the branch received, run submitted.
    !library.record ||
    library.record.title !== 'Why this assumption?' ||
    library.record.lastAssistantText !== 'This uses only the selected passage.' ||
    library.record.lastAssistantPartial !== false ||
    library.record.capture !== 'captured-through' ||
    library.record.snapshotPrompt !== nonProject.liveResult.prompt ||
    library.record.conversationUrl !== 'https://chatgpt.com/c/generated-local' ||
    // Captured text is rendered as text nodes only.
    library.bundle.scripts !== 0 ||
    // Migration ran and validated on this fresh profile (nothing legacy to migrate).
    !library.journal || library.journal.validation?.ok !== true ||
    library.dialogs.length !== 0
  ) {
    throw new Error(`Library scenario failed: ${JSON.stringify(library)}`);
  }

  layoutMatrix.forEach((entry) => {
    if (
      // Aside must always offer a way in.
      entry.anythingShown !== true ||
      // The RAIL belongs in left-side whitespace. The compact launcher is the
      // documented fallback when no gutter exists and only has to be in verified
      // free space, which at 768px with the sidebar open is not the left.
      (entry.railShown && entry.onLeftHalf !== true) ||
      entry.overlapsSidebar !== false ||
      entry.overlapsColumn !== false ||
      entry.overlapsNativeAsk !== false ||
      entry.nativeAskHitTargetIsNative !== true ||
      // And, for a popup that mounted after Aside had already placed itself:
      // nothing of Aside's is painted over.
      entry.occlusion?.allReachable !== true ||
      entry.nativeOcclusion?.allReachable !== true ||
      // The rail is either placed in the gutter or replaced by the compact launcher.
      !(entry.placement === 'left-gutter' || entry.launcherShown) ||
      entry.theme !== (entry.label.endsWith('dark') ? 'dark' : 'light')
    ) {
      throw new Error(`Layout matrix failed at ${entry.label}: ${JSON.stringify(entry)}`);
    }
  });

  [claudeCurrent, claudeLegacy].forEach((claude) => {
    if (
      claude.toolbarState.visible !== true ||
      claude.toolbarState.label !== 'Aside branch actions' ||
      // The selection must reach a Claude branch on Claude, never a chatgpt.com URL.
      !claude.branchState.location.startsWith('https://claude.ai/') ||
      !claude.branchState.lastPrompt?.includes('SELECTED PASSAGE') ||
      !claude.branchState.lastPrompt?.includes('convexity assumption') ||
      !claude.branchState.lastPrompt?.includes('fallible excerpt') ||
      !claude.branchState.assistantText?.includes('This answers the selected passage.') ||
      // Claude refuses framing, so the branch must say it runs in a Claude window.
      // Claude refuses framing, so the branch must report a Claude window surface.
      !/Claude window/.test(claude.panelState.status || claude.panelState.surface || '') ||
      claude.panelState.railOverlapsSidebar !== false ||
      !claude.contextPreview.includes('SELECTED PASSAGE') ||
      // Exactly one submit: the fallback chain must not post the question twice.
      claude.branchState.sendClicks !== 1
    ) {
      throw new Error(`Claude ${claude.variant} scenario failed: ${JSON.stringify(claude)}`);
    }
  });

  if (networkEscapes.length) {
    throw new Error(
      `Requests escaped to hosts the harness does not serve: ${JSON.stringify([...new Set(networkEscapes)])}`
    );
  }

  if (
    !crossTab.panelId ||
    crossTab.panelStoredAfterEdit !== true ||

    // Tab B's edit must never be silently lost. Either it reached the store, or
    // the panel still holds it in the box. Which of the two happens depends on
    // how the two tabs interleave, which a browser test should not have to win;
    // the policy that decides it is unit-tested directly in
    // tests/panel-store.spec.ts ("write conflict policy"). What is asserted here
    // is the property that does not depend on timing: the text still exists.
    !(
      crossTab.editVisibleInStore === true ||
      crossTab.tabBWriteState?.textareaValue === 'edited in tab B'
    ) ||
    // Close is presentation only: the record survives, no tombstone, and tab B's
    // own view is not forced shut by tab A's close.
    crossTab.panelKeptAfterClose !== true ||
    crossTab.tombstoneAfterCloseOnly !== false ||
    crossTab.tabBViewSurvivedClose !== true ||
    (crossTab.listRowCount ?? 0) < 1 ||
    // An explicit delete in tab A must leave a tombstone and must not be undone by tab B.
    crossTab.tombstoneWritten !== true ||
    crossTab.panelResurrectedAfterClose !== false ||
    crossTab.lateWriteLanded !== false ||
    crossTab.tabBStillShowsPanel !== false
  ) {
    throw new Error(`Cross-tab panel protocol failed: ${JSON.stringify(crossTab)}`);
  }

  // The live failure this exists for: Aside's toolbar was placed, was visible and
  // was the right size, and the provider's popup was painted over half of it. A
  // rectangle comparison cannot express that; asking the page what a click would
  // actually reach can.
  if (nonProject.askOcclusion?.allReachable !== true) {
    throw new Error(
      `Aside's own controls were covered by provider UI: ${JSON.stringify(nonProject.askOcclusion)}`
    );
  }

  // The direction that actually shipped: Aside's host sits near the maximum
  // z-index, so Aside covering the provider is the likely failure, not the
  // reverse. Nothing asserted this until a live Claude run found it.
  if (nonProject.nativeOcclusion?.allReachable !== true) {
    throw new Error(
      `Aside covered the provider's own controls: ${JSON.stringify(nonProject.nativeOcclusion)}`
    );
  }

  // Claude must ATTEMPT the in-page panel. It opened a separate window for every
  // branch because a capability flag said embedding was impossible — an assumption
  // that, because the same flag gated the attempt, nothing could ever disprove.
  if (claudeEmbedded.framedInPanel !== true || claudeEmbedded.openedSeparateWindow !== false) {
    throw new Error(
      `Claude did not run its branch in the in-page panel: ${JSON.stringify(claudeEmbedded)}`
    );
  }

  if (
    nonProject.askState.visibleActions.join('|') !== 'Ask|Why|New-tab' ||
    // Aside must coexist with the provider's own selection action, not hide it.
    nonProject.askState.nativeAskUsable !== true ||
    nonProject.askState.nativeAskHitTargetIsNative !== true ||
    nonProject.askState.asideOverlapsNativeAsk !== false ||
    nonProject.askState.nativeAskClassList !== '' ||
    nonProject.askState.toolbarIsLabelledAside !== 'Aside branch actions'
  ) {
    throw new Error(
      `Native selection action must stay usable alongside Aside: ${JSON.stringify(nonProject.askState)}`
    );
  }

  if (
    nonProject.darkThemeState.theme !== 'dark' ||
    !isDarkRgb(nonProject.darkThemeState.panelBackground)
  ) {
    throw new Error(`Dark theme did not propagate: ${JSON.stringify(nonProject.darkThemeState)}`);
  }

  if (
    nonProject.liveResult.status !== 'Branch answer is ready in this window.' ||
    nonProject.liveResult.title !== 'Why this assumption?' ||
    // Preview equals submission, byte for byte.
    nonProject.liveResult.contextPreviewMatchesPrompt !== true ||
    nonProject.liveResult.precedingQuestionDefaultOn !== true ||
    nonProject.liveResult.precedingQuestionPresentByDefault !== true ||
    nonProject.liveResult.precedingQuestionGoneWhenUnticked !== true ||
    nonProject.liveResult.branchLocation !== 'https://chatgpt.com/c/generated-local' ||
    !nonProject.liveResult.openBranchVisible ||
    nonProject.liveResult.pageCountBefore !== nonProject.liveResult.pageCountAfter ||
    !nonProject.liveResult.promptContainsSelectedPassage ||
    !nonProject.liveResult.promptContainsLocalSourceAnswer ||
    !nonProject.liveResult.assistantText?.includes('This uses only the selected passage.') ||
    // Captured, and said so: the fixture stops generating immediately, so the
    // answer must settle to a complete message with a "captured through" label.
    nonProject.liveResult.captureState?.assistantPartial !== 'false' ||
    !/Captured through/.test(nonProject.liveResult.captureState?.archiveStatus ?? '')
  ) {
    throw new Error(`Non-project embedded branch scenario failed: ${JSON.stringify(nonProject.liveResult)}`);
  }

  if (
    // The rail belongs in free LEFT-side whitespace: right of the provider sidebar,
    // left of the reading column, overlapping neither.
    nonProject.minimizedState.placement !== 'left-gutter' ||
    nonProject.minimizedState.flexDirection !== 'column' ||
    !nonProject.minimizedState.tabVisible ||
    nonProject.minimizedState.panelHidden !== true ||
    nonProject.minimizedState.overlapsSidebar !== false ||
    nonProject.minimizedState.overlapsReadingColumn !== false ||
    nonProject.minimizedState.tabHitInsideRail !== true ||
    (nonProject.minimizedState.tabBarLeft ?? 0) < (nonProject.minimizedState.sidebarRight ?? 0) ||
    (nonProject.minimizedState.tabBarLeft ?? 0) >= (nonProject.minimizedState.readingColumnLeft ?? 0)
  ) {
    throw new Error(`Vertical minimized rail scenario failed: ${JSON.stringify(nonProject.minimizedState)}`);
  }

  if (
    nonProject.homeRestoreState.location !== 'https://chatgpt.com/' ||
    !nonProject.homeRestoreState.tabVisible ||
    nonProject.homeRestoreState.panelHidden !== true ||
    (nonProject.homeRestoreState.tabWidth ?? 0) < 80 ||
    // Restored panels use the same left-gutter placement, not the old right rail.
    nonProject.homeRestoreState.placement !== 'left-gutter' ||
    nonProject.homeRestoreState.overlapsSidebar !== false ||
    nonProject.homeRestoreState.overlapsReadingColumn !== false
  ) {
    throw new Error(
      `Global minimized restore scenario failed: ${JSON.stringify(nonProject.homeRestoreState)}`
    );
  }

  if (
    includeNativeWindowSmoke &&
    why &&
    (
      why.status !== 'Branch answer is ready in its ChatGPT window.' ||
      why.formVisible !== false ||
      why.branchLocation !== 'https://chatgpt.com/c/generated-why' ||
      !why.openBranchVisible ||
      !why.assistantText?.includes('This uses only the selected passage.') ||
      !why.prompt?.includes('QUESTION\nWhy?') ||
      // The excerpt must be framed as fallible, not as truth to defend.
      !why.prompt?.includes('fallible excerpt')
    )
  ) {
    throw new Error(`Why action scenario failed: ${JSON.stringify(why)}`);
  }

  if (
    includeNativeWindowSmoke &&
    newTab &&
    (
      newTab.sourceLocation !== 'https://chatgpt.com/c/source-new-tab' ||
      // The draft panel stays on the source page, reporting the branch's status.
      newTab.panelVisible !== true ||
      // No window opened merely because New-tab was pressed.
      newTab.noWindowBeforeQuestion !== true ||
      newTab.location !== 'https://chatgpt.com/c/generated-new-window' ||
      newTab.branchPanelVisible !== false ||
      newTab.composerVisible !== true ||
      newTab.composerFocused !== true ||
      !newTab.userPrompt?.includes('SELECTED PASSAGE') ||
      !newTab.userPrompt?.includes('convexity assumption guarantees the relaxation stays tight') ||
      // The actual question was sent, once — no bootstrap message.
      !newTab.userPrompt?.includes('Why this assumption?') ||
      /Ready for your question/.test(newTab.userPrompt ?? '') ||
      !newTab.assistantText?.includes('This answers the question in its own window.')
    )
  ) {
    throw new Error(`New-tab scenario failed: ${JSON.stringify(newTab)}`);
  }

  if (
    project.status !== 'Branch answer is ready in this window.' ||
    project.branchLocation !== 'https://chatgpt.com/g/g-p-demo-project/c/generated-project' ||
    project.privacyNote.containerWarningVisible !== true ||
    project.privacyNote.projectBulletHidden !== true ||
    project.privacyNote.noteOpen !== false
  ) {
    throw new Error(`Project embedded branch scenario failed: ${JSON.stringify(project)}`);
  }

  if (
    enterOnly.status !== 'Branch answer is ready in this window.' ||
    enterOnly.branchLocation !== 'https://chatgpt.com/c/generated-enter-only' ||
    !enterOnly.prompt?.includes('QUESTION')
  ) {
    throw new Error(`Enter-only scenario failed: ${JSON.stringify(enterOnly)}`);
  }

  if (
    // Unverifiable privacy must block BEFORE anything is typed or sent.
    temporaryChatUnconfirmed.status !== 'This branch was not sent.' ||
    !/never confirmed it|did not report/i.test(temporaryChatUnconfirmed.errorText ?? '') ||
    temporaryChatUnconfirmed.composerValue !== '' ||
    temporaryChatUnconfirmed.lastPrompt !== null ||
    temporaryChatUnconfirmed.turnsRendered !== 0 ||
    temporaryChatUnconfirmed.branchLocation.includes('/c/') ||
    // …and the user keeps their question and a way to retry.
    temporaryChatUnconfirmed.questionPreserved !== 'Why this assumption?' ||
    temporaryChatUnconfirmed.formVisible !== true ||
    // The failed state the screenshots objected to: one error, no blank frame,
    // diagnostics behind More, recovery near the question.
    temporaryChatUnconfirmed.failedLayout.frameShellHidden !== true ||
    temporaryChatUnconfirmed.failedLayout.errorCount !== 1 ||
    temporaryChatUnconfirmed.failedLayout.errorTextOccurrences !== 1 ||
    temporaryChatUnconfirmed.failedLayout.visibleHeaderButtons.includes('Copy log') ||
    !temporaryChatUnconfirmed.failedLayout.moreButtons.includes('Copy log') ||
    !temporaryChatUnconfirmed.failedLayout.moreButtons.includes('Copy log + text') ||
    !temporaryChatUnconfirmed.failedLayout.moreButtons.includes('Select log') ||
    temporaryChatUnconfirmed.failedLayout.recoveryVisible !== true ||
    !temporaryChatUnconfirmed.failedLayout.recoveryButtons.includes('Check again') ||
    !temporaryChatUnconfirmed.failedLayout.recoveryButtons.includes('Show branch window') ||
    !temporaryChatUnconfirmed.failedLayout.recoveryButtons.includes('Use ordinary mode…') ||
    temporaryChatUnconfirmed.failedLayout.shellVisibleAfterShow !== true ||
    // Check again re-observes the SAME document and continues there, once.
    temporaryChatUnconfirmed.recheck.docToken !== 'unconfirmed-doc' ||
    temporaryChatUnconfirmed.recheck.submitCount !== 1 ||
    !temporaryChatUnconfirmed.recheck.lastPrompt?.includes('SELECTED PASSAGE') ||
    temporaryChatUnconfirmed.recheck.location.includes('/c/') ||
    temporaryChatUnconfirmed.recheck.status !== 'Branch answer is ready in this window.'
  ) {
    throw new Error(
      `Unverified temporary chat must block the send: ${JSON.stringify(temporaryChatUnconfirmed)}`
    );
  }

  if (
    temporaryChatMenuChooser.awaiting.status !== 'This branch was not sent.' ||
    !/asking for a choice/i.test(temporaryChatMenuChooser.awaiting.errorText ?? '') ||
    !/Make the choice/.test(temporaryChatMenuChooser.awaiting.hint ?? '') ||
    temporaryChatMenuChooser.awaiting.errorCount !== 1 ||
    temporaryChatMenuChooser.awaiting.frameShellHidden !== true ||
    temporaryChatMenuChooser.awaiting.privacyNoteOpen !== false ||
    !temporaryChatMenuChooser.awaiting.recoveryButtons.includes('Check again') ||
    !temporaryChatMenuChooser.awaiting.recoveryButtons.includes('Show branch window') ||
    // A chooser is the provider asking a question; ordinary mode is not an answer to it.
    temporaryChatMenuChooser.awaiting.recoveryButtons.includes('Use ordinary mode…') ||
    // Aside opened the menu once, selected the control once, and chose nothing.
    temporaryChatMenuChooser.frameBefore.menuTriggerClicks !== 1 ||
    temporaryChatMenuChooser.frameBefore.toggleClicks !== 1 ||
    temporaryChatMenuChooser.frameBefore.chooserVisible !== true ||
    temporaryChatMenuChooser.frameBefore.choice !== null ||
    temporaryChatMenuChooser.frameBefore.composerValue !== '' ||
    temporaryChatMenuChooser.frameBefore.lastPrompt !== null ||
    temporaryChatMenuChooser.frameBefore.submitCount !== 0 ||
    // After the owner's choice and Check again: same document, one send, private.
    temporaryChatMenuChooser.after.docToken !== 'menu-doc' ||
    temporaryChatMenuChooser.after.choice !== 'chooser-unpersonalized' ||
    temporaryChatMenuChooser.after.submitCount !== 1 ||
    !temporaryChatMenuChooser.after.lastPrompt?.includes('SELECTED PASSAGE') ||
    temporaryChatMenuChooser.after.location.includes('/c/') ||
    temporaryChatMenuChooser.after.toggleClicks !== 1 ||
    temporaryChatMenuChooser.after.menuTriggerClicks !== 1 ||
    temporaryChatMenuChooser.after.temporaryChatModeActive !== true ||
    temporaryChatMenuChooser.privateTextInLocalStorage !== false ||
    temporaryChatMenuChooser.privateTextInSessionStorage !== true
  ) {
    throw new Error(
      `Temporary chat behind a menu with a chooser failed: ${JSON.stringify(temporaryChatMenuChooser)}`
    );
  }

  if (
    claudeIncognitoActive.openedSeparateWindow !== false ||
    !claudeIncognitoActive.location.startsWith('https://claude.ai/') ||
    claudeIncognitoActive.location.includes('/chat/generated') ||
    claudeIncognitoActive.sendClicks !== 1 ||
    claudeIncognitoActive.incognitoClicks !== 0 ||
    !claudeIncognitoActive.lastPrompt?.includes('SELECTED PASSAGE') ||
    claudeIncognitoActive.privateTextInLocalStorage !== false ||
    claudeIncognitoActive.privateTextInSessionStorage !== true ||
    claudeIncognitoActive.logMentionsMarker !== true
  ) {
    throw new Error(`Claude incognito-active scenario failed: ${JSON.stringify(claudeIncognitoActive)}`);
  }

  if (
    temporaryChatVerified.status !== 'Branch answer is ready in this window.' ||
    temporaryChatVerified.temporaryChatToggleClicks < 1 ||
    temporaryChatVerified.temporaryChatModeActive !== true ||
    temporaryChatVerified.temporaryChatState !== 'true' ||
    temporaryChatVerified.branchLocation.includes('/c/') ||
    !temporaryChatVerified.lastPrompt?.includes('SELECTED PASSAGE') ||
    // A private branch must never reach durable storage.
    temporaryChatVerified.privateTextInLocalStorage !== false ||
    temporaryChatVerified.privateTextInSessionStorage !== true
  ) {
    throw new Error(
      `Verified temporary chat should send normally: ${JSON.stringify(temporaryChatVerified)}`
    );
  }

  if (
    // A temporary chat that cannot be turned on must block, not leak. Previously
    // this path typed the passage into a persistent chat and reported it afterwards.
    temporaryChatBlocked.status !== 'This branch was not sent.' ||
    !/never confirmed it|did not report|could not find/i.test(temporaryChatBlocked.errorText ?? '') ||
    temporaryChatBlocked.composerValue !== '' ||
    temporaryChatBlocked.lastPrompt !== null ||
    temporaryChatBlocked.turnsRendered !== 0 ||
    temporaryChatBlocked.branchLocation.includes('/c/') ||
    temporaryChatBlocked.temporaryChatToggleClicks < 1 ||
    // Ordinary mode is offered, and only as an explicit two-step choice.
    !temporaryChatBlocked.failedLayout.recoveryButtons.includes('Use ordinary mode…') ||
    temporaryChatBlocked.afterFirstClick.confirmVisible !== true ||
    !/ordinary .* chat/i.test(temporaryChatBlocked.afterFirstClick.confirmText) ||
    temporaryChatBlocked.afterFirstClick.status !== 'This branch was not sent.' ||
    temporaryChatBlocked.afterFirstClick.lastPrompt !== null ||
    // Confirmed: the branch is sent as an ordinary, saved chat and says so.
    temporaryChatBlocked.ordinary.selectedKind !== 'branch-kind-persistent' ||
    temporaryChatBlocked.ordinary.location !== 'https://chatgpt.com/c/generated-temp-blocked' ||
    !temporaryChatBlocked.ordinary.lastPrompt?.includes('SELECTED PASSAGE') ||
    temporaryChatBlocked.ordinary.temporaryChatModeActive !== false
  ) {
    throw new Error(
      `Temporary-chat blocked scenario failed: ${JSON.stringify(temporaryChatBlocked)}`
    );
  }

  if (
    !/Local branch creation failed\.|Debug log copied\./.test(failure.status ?? '') ||
    !failure.enterFallbackTriggered ||
    !failure.branchLocation.startsWith('https://chatgpt.com/') ||
    failure.pageCountBefore !== failure.pageCountAfter ||
    failure.bodyText.includes('Branch answer is ready in this window.')
  ) {
    throw new Error(`False-live failure scenario failed: ${JSON.stringify(failure)}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  await Promise.race([browser.close().catch(() => {}), sleep(5_000)]);
  process.exit(exitCode);
}
