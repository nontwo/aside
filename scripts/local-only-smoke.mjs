/**
 * Offline browser smoke for Aside's native temporary-chat handoff.
 *
 * Every provider page is a local fixture served through CDP request
 * interception; any request to a host the harness does not serve fails the run.
 * The fixtures record every click, input, key and paste, so the smoke proves
 * what Aside does NOT do in a native page as well as what it does. The Owner's
 * own paste-and-send is simulated in the fixture, explicitly, after Aside is done.
 */
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
let routeMap = {};

let claudeRouteMap = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      <form id="composer-form"><textarea name="prompt-textarea" placeholder="Ask anything" style="width:100%;height:56px"></textarea></form>
    </main>
  </body>
</html>`;
}

/**
 * Unique per run: scratch content carries this, so a persistence assertion
 * cannot be satisfied (or defeated) by another run's leftovers.
 */
const MARK = `scratchmark${process.pid}${Date.now().toString(36)}`;
const WHY_TEXT = 'Why does this step hold? Explain the reasoning and state any necessary assumptions.';
const CARD = '.aside-handoff:not([hidden])';

/**
 * A native destination page: what ChatGPT or Claude shows at a new chat. It
 * records every interaction, so the smoke can prove Aside never clicks the mode
 * control, types, sends or presses Enter there. The Owner's own paste-and-send
 * is simulated through an explicit helper, and only after Aside is done.
 */
function buildNativeChatHtml({ provider = 'chatgpt', title = 'Native chat' } = {}) {
  const isClaude = provider === 'claude';
  const modeButton = isClaude
    ? '<button id="mode" type="button" aria-label="Start incognito chat" aria-pressed="false">👻</button>'
    : '<button id="mode" type="button" aria-label="Temporary chat" aria-pressed="false">Temporary</button>';
  const composer = isClaude
    ? '<div id="composer" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Write your prompt to Claude"></div>'
    : '<textarea id="composer" name="prompt-textarea" placeholder="Ask anything"></textarea>';
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>${LAYOUT_CHROME_CSS}</head>
  <body data-sidebar="open">
    ${SIDEBAR_MARKUP}
    <main>
      <header>${modeButton}</header>
      <div id="turns"></div>
      <form id="composer-form">${composer}<button id="send" type="button" aria-label="Send">Send</button></form>
    </main>
    <script>
      const composer = document.getElementById('composer');
      const read = () => (composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText);
      const write = (value) => { if (composer.tagName === 'TEXTAREA') { composer.value = value; } else { composer.textContent = value; } };
      window.__native = {
        url: location.href,
        referrer: document.referrer,
        modeClicks: 0,
        sendClicks: 0,
        composerInputs: 0,
        keydowns: 0,
        pastes: 0,
        prompts: []
      };
      document.getElementById('mode').addEventListener('click', (event) => {
        window.__native.modeClicks += 1;
        const on = event.currentTarget.getAttribute('aria-pressed') !== 'true';
        event.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      composer.addEventListener('input', () => { window.__native.composerInputs += 1; });
      composer.addEventListener('paste', () => { window.__native.pastes += 1; });
      document.addEventListener('keydown', () => { window.__native.keydowns += 1; }, true);
      document.getElementById('send').addEventListener('click', () => {
        window.__native.sendClicks += 1;
        const prompt = read();
        if (!prompt.trim()) { return; }
        window.__native.prompts.push(prompt);
        write('');
        const turn = document.createElement('article');
        turn.setAttribute('data-message-author-role', 'assistant');
        turn.innerHTML = '<div data-message-content><p>A native answer the Owner reads here.</p></div>';
        document.getElementById('turns').append(turn);
      });
      // The Owner, not Aside: switch the mode on, paste what they copied, send.
      window.__ownerTurnOnMode = () => document.getElementById('mode').click();
      window.__ownerPasteAndSend = (text) => { write(text); document.getElementById('send').click(); };
      window.__fixtureReady = true;
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

/**
 * Provider-host documents that were NOT served by the harness. A request that
 * starts before interception attaches would load the real site; every served
 * fixture marks its document, so an unmarked provider document is an escape.
 */
const unservedProviderPages = [];

function watchForUnservedProviderPages(browser) {
  browser.on('targetchanged', (target) => {
    if (target.type() !== 'page') {
      return;
    }
    let url;
    try {
      url = new URL(target.url());
    } catch {
      return;
    }
    if (!SERVED_HOSTS.has(url.hostname)) {
      return;
    }
    void (async () => {
      try {
        const page = await target.page();
        await sleep(1_500);
        const served = await page.evaluate(() => document.documentElement.hasAttribute('data-aside-fixture'));
        if (!served) {
          unservedProviderPages.push(target.url());
        }
      } catch {
        // Closed before it could be checked.
      }
    })();
  });
}

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

  const servedBody = resolveRouteBody(url.hostname, url.pathname).replace('<html', '<html data-aside-fixture');
  const headers = [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }];

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
  // Aside confirms the page's role with its worker before it listens for
  // selections; wait until it has mounted its host.
  await page.waitForSelector('#aside-root', { timeout: 15_000 });
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
  // Aside confirms the page's role with its worker before it listens for
  // selections; wait until it has mounted its host.
  await page.waitForSelector('#aside-root', { timeout: 15_000 });
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
    { name: '768', width: 768, height: 800 },
    // Browser zoom at 125% on a 1440px window: fewer CSS pixels, denser device pixels.
    { name: '1152-zoom125', width: 1152, height: 720, deviceScaleFactor: 1.25 },
    // A short viewport: the card must shrink above the composer, not cover it.
    // (Shorter still, it steps aside to the rail with a notice instead.)
    { name: '1024-short', width: 1024, height: 480 }
  ];
  const results = [];

  for (const viewport of viewports) {
    for (const sidebar of ['open', 'collapsed']) {
      for (const dark of [false, true]) {
        const label = `${viewport.name}-${sidebar}-${dark ? 'dark' : 'light'}`;
        routeMap = {
          [`/c/layout-${label}`]: buildSourceHtml({ dark, sidebar }),
          '/': buildNativeChatHtml({})
        };

        const page = await createSourcePage(browser, `/c/layout-${label}`);
        try {
          await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
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

          await openCard(page);
          await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, 'Why this assumption?');
          await capture(page, `card-${label}`);
          // The open card must not paint over the provider's composer.
          const composerUnderCard = await page.evaluate(() => {
            const composer = document.querySelector('#composer-form');
            if (!(composer instanceof HTMLElement)) {
              return { applicable: false, reachable: true };
            }
            const rect = composer.getBoundingClientRect();
            const points = [0.1, 0.5, 0.9].map((fraction) => [rect.left + rect.width * fraction, rect.top + rect.height / 2]);
            const covered = points.filter(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('#aside-root')));
            return { applicable: true, reachable: covered.length === 0 };
          });
          await clickCard(page, 'handoff-hide');
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

          results.push({ label, ...measured, occlusion, nativeOcclusion, composerUnderCard });
        } finally {
          await page.close();
        }
      }
    }
  }

  return results;
}


/* ------------------------------------------------------------------ *
 * Extension, worker and clipboard helpers
 * ------------------------------------------------------------------ */

async function serviceWorker(browser) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const target = browser.targets().find((candidate) => candidate.type() === 'service_worker');
    if (target) {
      return target.worker();
    }
    await sleep(200);
  }
  throw new Error('Extension service worker target was not found.');
}

async function extensionIdOf(browser) {
  const target = browser.targets().find((candidate) => candidate.type() === 'service_worker');
  if (!target) {
    throw new Error('Extension service worker target was not found.');
  }
  return new URL(target.url()).hostname;
}

async function openExtensionPage(browser, file) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.on('dialog', (dialog) => {
    page.__dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  await page.goto(`chrome-extension://${await extensionIdOf(browser)}/${file}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  return page;
}

/**
 * Every durable write, observed as it happens rather than inferred from the
 * final state: chrome.storage local/sync change events and every storage-
 * authority message reaching the worker. Persist-then-delete would show here.
 */
async function installPersistenceProbe(browser) {
  const worker = await serviceWorker(browser);
  await worker.evaluate(() => {
    if (self.__asideProbe) {
      return;
    }
    self.__asideProbe = { local: [], sync: [], messages: [] };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' || area === 'sync') {
        self.__asideProbe[area].push(JSON.stringify(changes));
      }
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message && (message.type === 'DOMAIN_COMMAND' || message.type === 'PANEL_UPSERT' || message.type === 'DOMAIN_RESTORE')) {
        self.__asideProbe.messages.push(JSON.stringify(message));
      }
      return false;
    });
  });
}

async function readPersistenceProbe(browser) {
  const worker = await serviceWorker(browser);
  return worker.evaluate(() => self.__asideProbe ?? null);
}

async function workerEval(browser, fn, ...args) {
  const worker = await serviceWorker(browser);
  return worker.evaluate(fn, ...args);
}

async function handoffSessionKeys(browser) {
  return workerEval(browser, async () =>
    Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith('aside:handoff:'))
  );
}

async function tabsSnapshot(browser) {
  return workerEval(browser, async () =>
    (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url, active: tab.active }))
  );
}

/** Every record in the question database, as one string, read from an extension page. */
async function dumpQuestionDatabase(browser) {
  const page = await openExtensionPage(browser, 'library.html');
  try {
    return await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('aside-questions');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const names = Array.from(db.objectStoreNames);
            const out = {};
            let pending = names.length;
            if (!pending) {
              resolve('{}');
              return;
            }
            const tx = db.transaction(names, 'readonly');
            names.forEach((name) => {
              const all = tx.objectStore(name).getAll();
              all.onsuccess = () => {
                out[name] = all.result;
                pending -= 1;
                if (!pending) {
                  resolve(JSON.stringify(out));
                }
              };
              all.onerror = () => reject(all.error);
            });
          };
        })
    );
  } finally {
    await page.close();
  }
}

async function readClipboard(page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function writeClipboard(page, text) {
  await page.bringToFront();
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function waitForPageAt(browser, url, timeoutMs = 20_000) {
  let target;
  try {
    target = await browser.waitForTarget(
      (candidate) => candidate.type() === 'page' && candidate.url() === url,
      { timeout: timeoutMs }
    );
  } catch (error) {
    const pages = browser.targets().filter((candidate) => candidate.type() === 'page').map((candidate) => candidate.url());
    throw new Error(`No page reached ${url}; open pages: ${JSON.stringify(pages)}`, { cause: error });
  }
  const page = await target.page();
  // Interval polling: a tab opened in the background does not run animation frames.
  await page.waitForFunction(() => window.__fixtureReady === true, { timeout: timeoutMs, polling: 100 });
  return page;
}

/* ------------------------------------------------------------------ *
 * Handoff card helpers
 * ------------------------------------------------------------------ */

async function openCard(page, buttonId = '#aside-ask-button') {
  await page.waitForFunction(() => {
    const toolbar = document.querySelector('#aside-selection-toolbar');
    return toolbar instanceof HTMLElement && !toolbar.hidden;
  }, { timeout: 10_000 });
  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Selection action not found: ${selector}`);
    }
    button.click();
  }, buttonId);
  await page.waitForSelector(`${CARD} textarea[data-aside-role="handoff-question"]`, { timeout: 10_000 });
}

async function cardState(page) {
  return page.evaluate((cardSelector) => {
    const card = document.querySelector(cardSelector);
    const role = (name) => card?.querySelector(`[data-aside-role="${name}"]`);
    return {
      sessionId: card?.getAttribute('data-session-id') ?? null,
      count: document.querySelectorAll('.aside-handoff').length,
      label: role('handoff-label')?.textContent ?? null,
      instruction: role('handoff-instruction')?.textContent ?? null,
      question: role('handoff-question')?.value ?? null,
      questionFocused: document.activeElement === role('handoff-question'),
      focus: role('handoff-focus')?.textContent ?? null,
      preview: role('handoff-prompt')?.textContent ?? null,
      summary: role('handoff-context-summary')?.textContent ?? null,
      primary: role('handoff-copy-open')?.textContent ?? null,
      clipboardStatus: role('handoff-clipboard-status')?.textContent ?? null,
      targetStatus: role('handoff-target-status')?.textContent ?? null,
      manualCopyShown: role('handoff-manual-copy') ? !role('handoff-manual-copy').hidden : null,
      hasIframe: Boolean(document.querySelector('#aside-root iframe')),
      target: card?.getAttribute('data-target') ?? null,
      clipboard: card?.getAttribute('data-clipboard') ?? null
    };
  }, CARD);
}

/** A trusted click (real input events), as the Owner's click would be. */
async function clickCard(page, role) {
  await page.bringToFront();
  await page.click(`${CARD} [data-aside-role="${role}"]`);
}

async function notices(page) {
  return page.evaluate(() => document.querySelector('.aside-notice')?.textContent ?? '');
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

const CHATGPT_TEMPORARY_URL = 'https://chatgpt.com/?temporary-chat=true';
const CLAUDE_NEW_URL = 'https://claude.ai/new';

/**
 * Retained data from before this release: durable questions in the question
 * database (with a captured thread, a snapshot and a note) and legacy panel
 * view records in chrome.storage.local — written through the same authority
 * messages the previous build used.
 */
async function seedRetainedData(browser) {
  const page = await openExtensionPage(browser, 'library.html');
  try {
    return await page.evaluate(async () => {
      const send = (message) => chrome.runtime.sendMessage(message);
      const now = Date.now();
      const sourceId = 'src_seed_chatgpt';
      const source = {
        id: sourceId,
        providerId: 'chatgpt',
        scopeKey: 'chatgpt:c:source-retained',
        conversationId: 'source-retained',
        containerId: null,
        url: 'https://chatgpt.com/c/source-retained',
        title: 'Retained convexity chat',
        kind: 'assistant-answer',
        acquisition: 'selected-fragment',
        messageId: 'assistant:1:seed'
      };
      const question = (id, title) => ({
        type: 'CreateQuestion',
        source,
        blocks: [],
        anchor: {
          id: `a_${id}`,
          sourceId,
          selectedText: 'convexity assumption',
          exact: 'convexity assumption',
          prefix: 'The ',
          suffix: ' guarantees',
          messageId: 'assistant:1:seed',
          turnIndex: 1,
          role: 'assistant',
          contentHash: 'seed',
          scrollHint: 0
        },
        question: {
          id,
          sourceId,
          anchorId: `a_${id}`,
          parentQuestionId: null,
          parentMessageId: null,
          title,
          titleSource: 'user',
          retention: 'durable',
          providerMode: 'normal',
          entryAction: 'ask'
        },
        draft: { text: title, excludedBlockIds: [], background: '' }
      });
      const results = [];
      results.push(await send({ type: 'DOMAIN_COMMAND', command: question('q_seed_kept', 'Seeded kept question') }));
      results.push(await send({ type: 'DOMAIN_COMMAND', command: question('q_seed_resolve', 'Seeded question to resolve') }));
      results.push(await send({ type: 'DOMAIN_COMMAND', command: question('q_seed_delete', 'Seeded question to delete') }));
      results.push(
        await send({
          type: 'DOMAIN_COMMAND',
          command: {
            type: 'FreezeSnapshot',
            questionId: 'q_seed_kept',
            snapshot: {
              id: 'snap_seed',
              questionId: 'q_seed_kept',
              prompt: 'Seeded frozen prompt',
              question: 'Seeded kept question',
              blocks: [],
              missing: [],
              compilerVersion: '2.0.0',
              templateVersion: '2.0.0',
              charCount: 20
            },
            link: {
              id: 'link_seed',
              questionId: 'q_seed_kept',
              providerId: 'chatgpt',
              conversationUrl: 'https://chatgpt.com/c/seed-branch',
              attemptId: null,
              snapshotId: 'snap_seed',
              run: 'submitted',
              acknowledgement: 'seed',
              capture: 'link-only',
              capturedThroughMessageId: null,
              lastCaptureAt: null,
              model: null
            }
          }
        })
      );
      results.push(
        await send({
          type: 'DOMAIN_COMMAND',
          command: {
            type: 'AppendOrReviseCapturedMessage',
            questionId: 'q_seed_kept',
            linkId: 'link_seed',
            attemptId: 'seed-attempt',
            message: {
              id: 'msg_seed',
              role: 'assistant',
              text: 'Seeded saved answer about retained convexity.',
              partial: false,
              providerMessageId: null,
              ordinal: 1,
              snapshotId: 'snap_seed',
              attemptId: null
            },
            capture: 'captured-through',
            capturedThroughMessageId: 'msg_seed'
          }
        })
      );
      results.push(
        await send({
          type: 'DOMAIN_COMMAND',
          command: {
            type: 'SaveNote',
            note: { id: 'note_seed', questionId: 'q_seed_kept', sourceId, text: 'Seeded note text', messageId: null }
          }
        })
      );
      const legacyState = (panelId, extra) => ({
        panelId,
        rootConversationId: 'chatgpt:c:source-retained',
        rootChatUrl: 'https://chatgpt.com/c/source-retained',
        selection: {
          rootConversationId: 'chatgpt:c:source-retained',
          rootChatUrl: 'https://chatgpt.com/c/source-retained',
          selectedText: 'convexity assumption guarantees the relaxation stays',
          selectedBlocks: [
            {
              messageId: 'assistant:1:seed',
              role: 'assistant',
              turnIndex: 1,
              text: 'The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.',
              excerpt: 'The convexity assumption'
            }
          ],
          branchBaseMessageId: 'assistant:1:seed',
          rangeQuotes: { exact: 'convexity assumption guarantees the relaxation stays', prefix: 'The ', suffix: ' tight and' },
          fallbackScrollY: 0
        },
        focusPreview: 'convexity assumption guarantees the relaxation stays',
        branchKind: 'persistent',
        entryAction: 'ask',
        surfaceMode: 'embedded',
        creationMode: 'local_persistent',
        title: 'Seeded legacy branch',
        titleStatus: 'ready',
        minimized: false,
        status: 'live',
        statusLabel: 'Branch answer is ready in this window.',
        initialQuestion: 'Seeded legacy question',
        initialPrompt: 'Seeded legacy prompt',
        branchChatUrl: 'https://chatgpt.com/c/seed-legacy-branch',
        archive: {
          messages: [{ role: 'assistant', text: 'Seeded legacy archived answer.', partial: false, providerMessageId: null, ordinal: 1 }],
          capture: 'captured-through'
        },
        createdAt: now,
        updatedAt: now,
        ...extra
      });
      results.push(
        await send({
          type: 'PANEL_UPSERT',
          panelId: 'panel_seed_live',
          scopeKey: 'chatgpt:c:source-retained',
          area: 'local',
          baseRev: 0,
          state: legacyState('panel_seed_live', {})
        })
      );
      return results.map((result) => {
        const status = result?.outcome?.status ?? result?.status ?? (result?.ok ? 'ok' : 'failed');
        const reason = result?.outcome?.reason ?? result?.reason;
        return reason && status !== 'applied' ? `${status}: ${reason}` : status;
      });
    });
  } finally {
    await page.close();
  }
}

/** Native selection, occlusion both ways, dark theme, rail and restore — around a handoff card. */
async function runCoexistenceScenario(browser) {
  routeMap = { '/c/source-local': buildSourceHtml({ dark: true }), '/': buildNativeChatHtml({}) };
  const page = await createSourcePage(browser, '/c/source-local');
  try {
    await selectAssistantText(page);
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return toolbar instanceof HTMLElement && !toolbar.hidden;
    }, { timeout: 10_000 });
    await injectNativeAskButton(page, { placement: 'above', variant: 'bare', shape: 'nested' });
    await sleep(500);
    const askOcclusion = await readAsideOcclusion(page);
    const nativeOcclusion = await readNativePopupOcclusion(page);
    const askState = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#aside-selection-toolbar button')).filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(button).display !== 'none';
      });
      const nativeAsk = document.querySelector('button[aria-label="Ask ChatGPT"]');
      const nativeRect = nativeAsk?.getBoundingClientRect();
      const toolbarEl = document.querySelector('#aside-selection-toolbar');
      const toolbarRect = toolbarEl instanceof HTMLElement && !toolbarEl.hidden ? toolbarEl.getBoundingClientRect() : null;
      const hit = nativeRect ? document.elementFromPoint(nativeRect.left + nativeRect.width / 2, nativeRect.top + nativeRect.height / 2) : null;
      return {
        visibleActions: buttons.map((button) => button.textContent?.trim() ?? ''),
        toolbarIsLabelledAside: toolbarEl?.getAttribute('aria-label') ?? null,
        nativeAskHitTargetIsNative: hit === nativeAsk || Boolean(nativeAsk?.contains(hit)),
        asideOverlapsNativeAsk: Boolean(
          nativeRect && toolbarRect &&
            nativeRect.left < toolbarRect.right && nativeRect.right > toolbarRect.left &&
            nativeRect.top < toolbarRect.bottom && nativeRect.bottom > toolbarRect.top
        )
      };
    });

    await openCard(page);
    const context = await page.evaluate((cardSelector) => {
      const card = document.querySelector(cardSelector);
      const rows = Array.from(card?.querySelectorAll('.aside-context-block') ?? []);
      return {
        rolesIncluded: rows.filter((row) => row.querySelector('input')?.checked).map((row) => row.getAttribute('data-plan-role')),
        precedingInPreview: (card?.querySelector('[data-aside-role="handoff-prompt"]')?.textContent ?? '').includes('Tell me about convexity.')
      };
    }, CARD);
    await page.evaluate((cardSelector) => {
      const row = document.querySelector(`${cardSelector} .aside-context-block[data-plan-role="preceding-question"] input`);
      row?.click();
    }, CARD);
    const precedingGoneWhenUnticked = !(await cardState(page)).preview.includes('Tell me about convexity.');
    await page.evaluate((cardSelector) => {
      document.querySelector(`${cardSelector} .aside-context-block[data-plan-role="preceding-question"] input`)?.click();
    }, CARD);

    const darkThemeState = await page.evaluate((cardSelector) => ({
      theme: document.documentElement.dataset.asideTheme ?? null,
      panelBackground: getComputedStyle(document.querySelector(cardSelector)).backgroundColor
    }), CARD);

    // Escape and right-click OUTSIDE Aside belong to the provider.
    await page.evaluate(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    const cardSurvivesOutsideEscape = (await cardState(page)).sessionId !== null;
    const contextMenuPrevented = await page.evaluate(() => {
      const target = document.querySelector('article[data-message-author-role="assistant"] p');
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target?.dispatchEvent(event);
      return event.defaultPrevented;
    });

    // Hide: the card goes to the rail in free left space; the scratch is kept.
    await clickCard(page, 'handoff-hide');
    await page.waitForFunction(() => Boolean(document.querySelector('#aside-tabbar:not([hidden]) .aside-tab-handoff')), { timeout: 10_000 });
    const minimizedState = await page.evaluate(() => {
      const tabBar = document.querySelector('#aside-tabbar');
      const tab = document.querySelector('.aside-tab-handoff');
      const tabBarRect = tabBar?.getBoundingClientRect();
      const tabRect = tab?.getBoundingClientRect();
      const sidebarRect = document.querySelector('nav[aria-label]')?.getBoundingClientRect();
      const columnRect = document.querySelector('main article, main #turns')?.getBoundingClientRect();
      const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        placement: tabBar?.getAttribute('data-placement'),
        tabBarLeft: tabBarRect ? Math.round(tabBarRect.left) : null,
        sidebarRight: sidebarRect ? Math.round(sidebarRect.right) : null,
        readingColumnLeft: columnRect ? Math.round(columnRect.left) : null,
        overlapsSidebar: overlaps(tabBarRect, sidebarRect),
        overlapsReadingColumn: overlaps(tabBarRect, columnRect),
        tabHitInsideRail: Boolean(tabBarRect && tabRect && tabRect.left >= tabBarRect.left - 1 && tabRect.right <= tabBarRect.right + 1),
        flexDirection: tabBar ? getComputedStyle(tabBar).flexDirection : null,
        badge: tab?.querySelector('small')?.textContent ?? null,
        cardHidden: document.querySelector('.aside-handoff') instanceof HTMLElement ? document.querySelector('.aside-handoff').hidden : null
      };
    });
    const sessionsWhileHidden = (await handoffSessionKeys(browser)).length;

    // A reload and a navigation in the SAME tab: the session comes back (session
    // storage, not disk), and on another conversation it stays in the rail.
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#aside-root', { timeout: 15_000 });
    await page.waitForFunction(() => Boolean(document.querySelector('#aside-tabbar:not([hidden]) .aside-tab-handoff')), { timeout: 10_000 });
    const homeRestoreState = await page.evaluate(() => {
      const tabBar = document.querySelector('#aside-tabbar');
      const sidebarRect = document.querySelector('nav[aria-label]')?.getBoundingClientRect();
      const tabBarRect = tabBar?.getBoundingClientRect();
      const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        location: window.location.href,
        placement: tabBar?.getAttribute('data-placement'),
        handoffTab: Boolean(document.querySelector('.aside-tab-handoff')),
        cardHidden: document.querySelector('.aside-handoff') instanceof HTMLElement ? document.querySelector('.aside-handoff').hidden : null,
        overlapsSidebar: overlaps(tabBarRect, sidebarRect)
      };
    });
    // Clean up through the Owner's own path: open it from the rail and End it.
    await page.evaluate(() => document.querySelector('.aside-tab-handoff button')?.click());
    await page.waitForSelector(`${CARD}`, { timeout: 10_000 });
    const jumpOnOtherConversation = await (async () => {
      await clickCard(page, 'handoff-jump');
      return (await cardState(page)).targetStatus;
    })();
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });

    return {
      askState,
      askOcclusion,
      nativeOcclusion,
      context,
      precedingGoneWhenUnticked,
      darkThemeState,
      cardSurvivesOutsideEscape,
      contextMenuPrevented,
      minimizedState,
      sessionsWhileHidden,
      homeRestoreState,
      jumpOnOtherConversation,
      sessionsAfterEnd: (await handoffSessionKeys(browser)).length
    };
  } finally {
    await page.close();
  }
}

/**
 * The whole ChatGPT lifecycle with a unique marker in the scratch content:
 * select -> Ask -> inspect -> Copy & open -> the Owner confirms the mode, pastes
 * and sends -> a follow-up in the native chat -> Return -> a second, independent
 * question -> Hide -> End -> the native tab closed by hand. Persistence is
 * observed throughout, not only at the end.
 */
async function runChatGPTHandoffScenario(browser) {
  routeMap = { '/c/source-handoff': buildSourceHtml(), '/': buildNativeChatHtml({ provider: 'chatgpt' }) };
  await installPersistenceProbe(browser);
  const page = await createSourcePage(browser, '/c/source-handoff');
  const sentinel = `owner clipboard sentinel ${MARK}-x`;
  const result = { steps: {} };
  try {
    await writeClipboard(page, sentinel);
    const pagesBefore = (await browser.pages()).length;

    // 1. Selection alone: a local draft, nothing else.
    await selectAssistantText(page);
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return toolbar instanceof HTMLElement && !toolbar.hidden;
    }, { timeout: 10_000 });
    result.steps.afterSelection = {
      clipboard: await readClipboard(page),
      pages: (await browser.pages()).length - pagesBefore,
      sessions: (await handoffSessionKeys(browser)).length
    };

    // 2. Ask: the card; still nothing copied, opened or saved.
    await openCard(page);
    result.steps.afterAsk = {
      card: await cardState(page),
      clipboard: await readClipboard(page),
      pages: (await browser.pages()).length - pagesBefore,
      sessions: (await handoffSessionKeys(browser)).length
    };

    // 3. The question and some background, both carrying the marker.
    await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, `Why does it stay tight? ${MARK}`);
    await page.evaluate((cardSelector) => {
      const details = document.querySelector(`${cardSelector} details.aside-context`);
      if (details) {
        details.open = true;
      }
    }, CARD);
    await page.type(`${CARD} textarea[data-aside-role="handoff-background"]`, `Background ${MARK}`);
    await sleep(600);
    const beforeCopy = await cardState(page);
    result.steps.sessionHoldsMarker = (await workerEval(browser, async () => JSON.stringify(await chrome.storage.session.get(null)))).includes(MARK);

    // 4. Copy & open, as a real click.
    await clickCard(page, 'handoff-copy-open');
    const target = await waitForPageAt(browser, CHATGPT_TEMPORARY_URL);
    await page.bringToFront();
    await page.waitForFunction((cardSelector) => document.querySelector(cardSelector)?.getAttribute('data-target') === 'open', { timeout: 10_000 }, CARD);
    const copied = await readClipboard(page);
    const afterOpen = await cardState(page);
    const tabs = await tabsSnapshot(browser);
    const sourceTab = tabs.find((tab) => tab.url === 'https://chatgpt.com/c/source-handoff');
    const targetTab = tabs.find((tab) => tab.url === CHATGPT_TEMPORARY_URL);
    result.steps.copyAndOpen = {
      previewEqualsClipboard: copied === beforeCopy.preview,
      clipboardHasMarker: copied.includes(MARK),
      clipboardHasTex: copied.includes('SELECTED PASSAGE'),
      card: afterOpen,
      sourceUrl: page.url(),
      targetInOwnWindow: Boolean(sourceTab && targetTab && sourceTab.windowId !== targetTab.windowId),
      native: await target.evaluate(() => ({ ...window.__native, asideHost: Boolean(document.getElementById('aside-root')) }))
    };

    // 5. The Owner: turn the mode on, paste, send; then a follow-up there.
    await target.bringToFront();
    await target.evaluate(() => window.__ownerTurnOnMode());
    await target.evaluate((text) => window.__ownerPasteAndSend(text), copied);
    await target.evaluate(() => window.__ownerPasteAndSend('And if it were not convex?'));
    // Selecting in the native page shows nothing of Aside's.
    await target.evaluate(() => {
      const paragraph = document.querySelector('#turns p');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await sleep(500);
    result.steps.owner = await target.evaluate(() => ({
      prompts: window.__native.prompts,
      modeClicks: window.__native.modeClicks,
      sendClicks: window.__native.sendClicks,
      composerInputs: window.__native.composerInputs,
      keydowns: window.__native.keydowns,
      asideToolbar: Boolean(document.getElementById('aside-selection-toolbar')),
      asideHost: Boolean(document.getElementById('aside-root'))
    }));
    result.steps.owner.firstPromptIsCopied = result.steps.owner.prompts[0] === copied;
    result.steps.owner.clipboardAfterFollowUp = await readClipboard(target);

    // 6. Return to the source from the toolbar popup.
    const popup = await openExtensionPage(browser, 'popup.html');
    await popup.waitForSelector('.session', { timeout: 10_000 });
    result.steps.popup = await popup.evaluate(() => ({
      sessions: document.querySelectorAll('.session').length,
      text: document.querySelector('.session')?.textContent ?? ''
    }));
    await popup.click('.session [data-aside-role="popup-return"]');
    await popup.waitForFunction(() => /Back at|passage/.test(document.querySelector('.session .status')?.textContent ?? ''), { timeout: 10_000 });
    result.steps.returned = {
      popupStatus: await popup.evaluate(() => document.querySelector('.session .status')?.textContent ?? ''),
      sourceActive: (await tabsSnapshot(browser)).find((tab) => tab.url === 'https://chatgpt.com/c/source-handoff')?.active ?? false,
      // Drawn once the scroll settles, and cleared a couple of seconds later.
      highlight: await page
        .waitForSelector('#aside-highlight-overlay', { timeout: 4_000 })
        .then(() => true, () => false)
    };
    await popup.close();

    // 7. Continue focuses the SAME native tab; nothing new opens.
    const pagesBeforeContinue = (await browser.pages()).length;
    await clickCard(page, 'handoff-copy-open');
    await sleep(600);
    result.steps.continue = {
      newPages: (await browser.pages()).length - pagesBeforeContinue,
      targetActive: (await tabsSnapshot(browser)).find((tab) => tab.url === CHATGPT_TEMPORARY_URL)?.active ?? false,
      clipboardUnchanged: (await readClipboard(page)) === copied
    };

    // 8. A second, independent question: its own session, its own native tab.
    const firstSession = afterOpen.sessionId;
    await page.bringToFront();
    await selectAssistantText(page);
    await openCard(page, '#aside-why-button');
    const whyCard = await cardState(page);
    await clickCard(page, 'handoff-copy-open');
    await page.waitForFunction(
      (cardSelector) => document.querySelector(cardSelector)?.getAttribute('data-target') === 'open',
      { timeout: 15_000 },
      CARD
    );
    const allTargets = (await tabsSnapshot(browser)).filter((tab) => tab.url === CHATGPT_TEMPORARY_URL);
    result.steps.second = {
      whyQuestion: whyCard.question,
      distinctSession: whyCard.sessionId !== firstSession,
      targets: allTargets.length,
      sessions: (await handoffSessionKeys(browser)).length
    };

    // 9. Hide keeps it; the explicit clipboard clearing says what it does.
    await clickCard(page, 'handoff-hide');
    await page.waitForFunction(() => document.querySelectorAll('.aside-tab-handoff').length >= 1, { timeout: 10_000 });
    result.steps.hidden = {
      sessions: (await handoffSessionKeys(browser)).length,
      railEntries: await page.evaluate(() => document.querySelectorAll('.aside-tab-handoff').length)
    };

    // 10. End the first session from its card: the owned native tab closes.
    await page.evaluate((sessionId) => {
      document.querySelector(`.aside-tab-handoff[data-session-id="${sessionId}"] button`)?.click();
    }, firstSession);
    await page.waitForFunction((sessionId) => document.querySelector(`.aside-handoff[data-session-id="${sessionId}"]`)?.hidden === false, { timeout: 10_000 }, firstSession);
    await page.evaluate((cardSelector) => {
      const more = document.querySelector(`${cardSelector} details.aside-panel-more`);
      if (more) {
        more.open = true;
      }
    }, CARD);
    await clickCard(page, 'handoff-clear-clipboard');
    result.steps.clipboardCleared = (await readClipboard(page)) === '';
    await clickCard(page, 'handoff-end');
    result.steps.endWarning = await page.evaluate((cardSelector) => document.querySelector(`${cardSelector} .aside-handoff-end-confirm p`)?.textContent ?? '', CARD);
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction((sessionId) => !document.querySelector(`.aside-handoff[data-session-id="${sessionId}"]`), { timeout: 10_000 }, firstSession);
    await sleep(500);
    result.steps.afterEnd = {
      sessions: (await handoffSessionKeys(browser)).length,
      targets: (await tabsSnapshot(browser)).filter((tab) => tab.url === CHATGPT_TEMPORARY_URL).length,
      notice: await notices(page)
    };

    // 11. The Owner closes the second native tab by hand: that scratch ends too.
    const secondTarget = (await browser.pages()).find((candidate) => candidate.url() === CHATGPT_TEMPORARY_URL);
    const secondFound = Boolean(secondTarget);
    const sessionsBeforeClose = (await handoffSessionKeys(browser)).length;
    await secondTarget?.close();
    const disposed = await page
      .waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 })
      .then(() => true, () => false);
    result.steps.afterTargetClose = {
      secondFound,
      sessionsBeforeClose,
      disposed,
      cards: await page.evaluate(() => Array.from(document.querySelectorAll('.aside-handoff')).map((card) => ({ id: card.getAttribute('data-session-id'), hidden: card.hidden }))),
      tabs: await tabsSnapshot(browser),
      sessions: (await handoffSessionKeys(browser)).length,
      notice: await notices(page),
      railEntries: await page.evaluate(() => document.querySelectorAll('.aside-tab-handoff').length)
    };

    // 12. Nothing durable, at any point.
    const probe = await readPersistenceProbe(browser);
    const storage = await readExtensionStorage(browser);
    const database = await dumpQuestionDatabase(browser);
    result.persistence = {
      probeAlive: Boolean(probe),
      localWritesWithMarker: (probe?.local ?? []).filter((entry) => entry.includes(MARK)).length,
      syncWritesWithMarker: (probe?.sync ?? []).filter((entry) => entry.includes(MARK)).length,
      authorityMessagesWithMarker: (probe?.messages ?? []).filter((entry) => entry.includes(MARK)).length,
      localHasMarker: storage.local.includes(MARK),
      sessionHasMarkerAfterEnd: storage.session.includes(MARK),
      databaseHasMarker: database.includes(MARK),
      consoleHasMarker: page.__consoleMessages.some((line) => line.includes(MARK))
    };
    return result;
  } finally {
    const pages = await browser.pages();
    await Promise.all(pages.filter((candidate) => candidate.url().startsWith('https://chatgpt.com/?')).map((candidate) => candidate.close().catch(() => {})));
    await page.close();
  }
}

/** Closing the source leaves the native chat alone; the popup still reaches the session. */
async function runSourceCloseScenario(browser) {
  routeMap = { '/c/source-close': buildSourceHtml(), '/': buildNativeChatHtml({}) };
  const page = await createSourcePage(browser, '/c/source-close');
  await selectAssistantText(page);
  await openCard(page);
  await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, 'Source close question');
  await clickCard(page, 'handoff-copy-open');
  const target = await waitForPageAt(browser, CHATGPT_TEMPORARY_URL);
  await page.close();
  await sleep(500);
  const popup = await openExtensionPage(browser, 'popup.html');
  try {
    await popup.waitForSelector('.session', { timeout: 10_000 });
    const listed = await popup.evaluate(() => ({
      text: document.querySelector('.session')?.textContent ?? '',
      returnDisabled: document.querySelector('.session [data-aside-role="popup-return"]')?.disabled ?? null
    }));
    const targetOpenAfterSourceClose = !target.isClosed();
    await popup.click('.session [data-aside-role="popup-end"]');
    await popup.click('.session [data-aside-role="popup-end-confirm"]');
    await popup.waitForFunction(() => /Cleared from Aside|still open/.test(document.querySelector('.session')?.textContent ?? ''), { timeout: 10_000 });
    await sleep(500);
    return {
      listed,
      targetOpenAfterSourceClose,
      popupAfterEnd: await popup.evaluate(() => document.querySelector('.session')?.textContent ?? ''),
      targetClosedByEnd: target.isClosed(),
      sessions: (await handoffSessionKeys(browser)).length
    };
  } finally {
    await popup.close();
    if (!target.isClosed()) {
      await target.close();
    }
  }
}

/** New-tab: same card and same contract, a tab beside the source instead of a window. */
async function runNewTabScenario(browser) {
  routeMap = { '/c/source-new-tab': buildSourceHtml(), '/': buildNativeChatHtml({}) };
  const page = await createSourcePage(browser, '/c/source-new-tab');
  try {
    const pagesBefore = (await browser.pages()).length;
    await selectAssistantText(page);
    await openCard(page, '#aside-new-tab-button');
    const card = await cardState(page);
    const noTabBeforeQuestion = (await browser.pages()).length === pagesBefore;
    await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, 'New tab question');
    await clickCard(page, 'handoff-copy-open');
    const target = await waitForPageAt(browser, CHATGPT_TEMPORARY_URL);
    const tabs = await tabsSnapshot(browser);
    const source = tabs.find((tab) => tab.url === 'https://chatgpt.com/c/source-new-tab');
    const opened = tabs.find((tab) => tab.url === CHATGPT_TEMPORARY_URL);
    const native = await target.evaluate(() => ({ ...window.__native }));
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    await sleep(400);
    return {
      card,
      noTabBeforeQuestion,
      sameWindow: Boolean(source && opened && source.windowId === opened.windowId),
      native,
      targetClosedByEnd: target.isClosed()
    };
  } finally {
    await page.close();
  }
}

/** Why never inherits an old ordinary-mode preference, and writes nothing durable. */
async function runWhyPreferenceScenario(browser) {
  routeMap = { '/c/source-why': buildSourceHtml(), '/': buildNativeChatHtml({}) };
  await workerEval(browser, async () => {
    await chrome.storage.local.set({ 'aside:last-branch-kind:chatgpt': 'persistent', 'side-branches:last-branch-kind': 'persistent' });
  });
  await installPersistenceProbe(browser);
  const messagesBefore = (await readPersistenceProbe(browser))?.messages.length ?? 0;
  const page = await createSourcePage(browser, '/c/source-why');
  try {
    await selectAssistantText(page);
    await openCard(page, '#aside-why-button');
    const card = await cardState(page);
    const session = await workerEval(browser, async () => JSON.stringify(await chrome.storage.session.get(null)));
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    const probe = await readPersistenceProbe(browser);
    return {
      card,
      temporaryIntended: session.includes('"policy":"temporary-intended"'),
      entryWhy: session.includes('"entry":"why"'),
      newAuthorityMessages: (probe?.messages.length ?? 0) - messagesBefore
    };
  } finally {
    await page.close();
  }
}

/** Claude: the plain new-chat page, the Owner starts Incognito there. */
async function runClaudeScenario(browser, { variant = 'current' } = {}) {
  routeMap = {};
  claudeRouteMap = {
    [`/chat/source-claude-${variant}`]: buildClaudeSourceHtml({ variant }),
    '/new': buildNativeChatHtml({ provider: 'claude' }),
    '*': buildNativeChatHtml({ provider: 'claude' })
  };
  const page = await createClaudePage(browser, `/chat/source-claude-${variant}`);
  try {
    await selectClaudeAssistantText(page);
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('#aside-selection-toolbar');
      return toolbar instanceof HTMLElement && !toolbar.hidden;
    }, { timeout: 10_000 });
    const toolbarLabel = await page.evaluate(() => document.querySelector('#aside-selection-toolbar')?.getAttribute('aria-label') ?? null);
    await openCard(page);
    await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, 'Why this assumption?');
    await sleep(300);
    const card = await cardState(page);
    await capture(page, `handoff-claude-${variant}`);
    await clickCard(page, 'handoff-copy-open');
    const target = await waitForPageAt(browser, CLAUDE_NEW_URL);
    await page.bringToFront();
    const copied = await readClipboard(page);
    const native = await target.evaluate(() => ({ ...window.__native, asideHost: Boolean(document.getElementById('aside-root')) }));
    await clickCard(page, 'handoff-hide');
    await page.waitForFunction(() => Boolean(document.querySelector('#aside-tabbar:not([hidden]) .aside-tab-handoff')), { timeout: 10_000 });
    const railOverlapsSidebar = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label]')?.getBoundingClientRect();
      const rail = document.querySelector('#aside-tabbar')?.getBoundingClientRect();
      return Boolean(nav && rail && rail.left < nav.right && rail.right > nav.left);
    });
    await page.evaluate(() => document.querySelector('.aside-tab-handoff button')?.click());
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    await sleep(400);
    return {
      variant,
      toolbarLabel,
      card,
      previewEqualsClipboard: copied === card.preview,
      native,
      railOverlapsSidebar,
      targetClosedByEnd: target.isClosed()
    };
  } finally {
    await page.close();
  }
}

/** The same tab moving to another provider must never receive this provider's scratch. */
async function runCrossProviderTabScenario(browser) {
  routeMap = { '/c/source-cross': buildSourceHtml(), '/': buildNativeChatHtml({}) };
  claudeRouteMap = { '*': buildClaudeSourceHtml({ variant: 'current' }) };
  const page = await createSourcePage(browser, '/c/source-cross');
  try {
    await selectAssistantText(page);
    await openCard(page);
    await page.type(`${CARD} textarea[data-aside-role="handoff-question"]`, `Cross provider ${MARK}`);
    await sleep(600);
    await page.goto('https://claude.ai/chat/elsewhere', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#aside-root', { timeout: 15_000 });
    await sleep(1_000);
    const onClaude = await page.evaluate((mark) => ({
      cards: document.querySelectorAll('.aside-handoff').length,
      railEntries: document.querySelectorAll('.aside-tab-handoff').length,
      markerInDom: document.documentElement.innerHTML.includes(mark)
    }), MARK);
    await page.goto('https://chatgpt.com/c/source-cross', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#aside-root', { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll('.aside-handoff').length === 1, { timeout: 10_000 });
    const backOnChatGPT = await page.evaluate(() => document.querySelectorAll('.aside-handoff').length);
    await page.evaluate(() => document.querySelector('.aside-tab-handoff button')?.click());
    await page.waitForSelector(CARD, { timeout: 10_000 }).catch(() => {});
    if (await page.$(CARD)) {
      await clickCard(page, 'handoff-end');
      await clickCard(page, 'handoff-end-confirm');
      await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    }
    return { onClaude, backOnChatGPT, sessions: (await handoffSessionKeys(browser)).length };
  } finally {
    await page.close();
  }
}

/** Retired automation cannot be asked for by any client, and stale builds are refused. */
async function runRetiredEndpointsScenario(browser) {
  const page = await openExtensionPage(browser, 'popup.html');
  try {
    return await page.evaluate(async () => {
      const send = (message) => chrome.runtime.sendMessage(message).catch((error) => ({ error: String(error) }));
      const attempt = { providerId: 'chatgpt', panelId: 'p', attemptId: 'a' };
      return {
        createWindow: await send({ type: 'CREATE_BRANCH_WINDOW', ...attempt, prompt: 'x', launchUrl: 'https://chatgpt.com/', branchKind: 'temporary' }),
        recheck: await send({ type: 'RECHECK_BRANCH_IN_TAB', ...attempt }),
        automationEvent: await send({ type: 'BRANCH_AUTOMATION_EVENT', ...attempt, event: { kind: 'live' } }),
        runInTab: await send({ type: 'RUN_BRANCH_PROMPT_IN_TAB', ...attempt, prompt: 'x', launchUrl: 'https://chatgpt.com/', branchKind: 'temporary' }),
        staleOpen: await send({ type: 'HANDOFF_OPEN', buildId: 'an-older-build', sessionId: 'x', kind: 'window' }),
        badUrl: await send({ type: 'OPEN_PROVIDER_URL', url: 'https://example.com/phish' })
      };
    });
  } finally {
    await page.close();
  }
}

/** Many sessions opened and ended leave nothing behind in the page or in session storage. */
async function runManySessionsScenario(browser) {
  routeMap = { '/c/source-many': buildSourceHtml(), '/': buildNativeChatHtml({}) };
  const page = await createSourcePage(browser, '/c/source-many');
  try {
    await selectAssistantText(page);
    await openCard(page);
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    const baselineNodes = await page.evaluate(() => document.getElementById('aside-root')?.querySelectorAll('*').length ?? 0);
    for (let index = 0; index < 8; index += 1) {
      await selectAssistantText(page);
      await openCard(page);
      await clickCard(page, 'handoff-end');
      await clickCard(page, 'handoff-end-confirm');
      await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    }
    await sleep(300);
    return {
      baselineNodes,
      finalNodes: await page.evaluate(() => document.getElementById('aside-root')?.querySelectorAll('*').length ?? 0),
      cards: await page.evaluate(() => document.querySelectorAll('.aside-handoff').length),
      sessions: (await handoffSessionKeys(browser)).length
    };
  } finally {
    await page.close();
  }
}

/**
 * Saved data from before this release stays usable: the library, the legacy
 * view on its source page (read-only, no frame, explicit navigation only), the
 * question list, cross-tab view state, explicit delete, and the explicit local
 * note from a new handoff.
 */
async function runRetainedDataScenario(browser, seedOutcome) {
  routeMap = {
    '/c/source-retained': buildSourceHtml(),
    '/c/seed-legacy-branch': buildNativeChatHtml({ title: 'Saved legacy branch' }),
    '/': buildNativeChatHtml({})
  };
  const library = await openExtensionPage(browser, 'library.html');
  const result = { seedOutcome };
  try {
    await library.waitForSelector('#sources .source', { timeout: 20_000 });
    result.footer = await library.evaluate(() => document.querySelector('#about')?.textContent ?? '');
    // A phrase that exists only in the seeded captured answer.
    await library.type('#search', 'Seeded saved answer');
    await library.waitForSelector('#content .q', { timeout: 10_000 });
    let previous = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      const current = await library.evaluate(() => document.querySelector('#content')?.innerHTML ?? '');
      if (current === previous) {
        break;
      }
      previous = current;
    }
    result.searchHit = await library.evaluate(() => document.querySelector('#content .q small')?.textContent ?? '');
    await library.evaluate(() => {
      Array.from(document.querySelectorAll('#content .q button')).find((button) => button.textContent === 'View')?.click();
    });
    await library.waitForSelector('#content .msg[data-role="assistant"]', { timeout: 10_000 }).catch(() => null);
    result.bundle = await library.evaluate(() => ({
      content: (document.querySelector('#content')?.textContent ?? '').slice(0, 400),
      assistantText: document.querySelector('#content .msg[data-role="assistant"]')?.textContent ?? null,
      notes: document.querySelector('#content')?.textContent?.includes('Seeded note text') ?? false,
      scripts: document.querySelectorAll('#content script').length
    }));
    result.lifecycle = await library.evaluate(async () => {
      const send = (message) => chrome.runtime.sendMessage(message);
      const bundle = (await send({ type: 'DOMAIN_QUERY', query: 'bundle', questionId: 'q_seed_resolve' })).bundle;
      const resolved = await send({ type: 'DOMAIN_COMMAND', command: { type: 'ResolveQuestion', questionId: 'q_seed_resolve', baseRev: bundle.question.rev } });
      const deleted = await send({ type: 'DOMAIN_COMMAND', command: { type: 'DeleteQuestion', questionId: 'q_seed_delete', descendants: 'reparent' } });
      // A deleted question stays deleted: nothing can attach to it or recreate it.
      const recreate = await send({
        type: 'DOMAIN_COMMAND',
        command: { type: 'SaveNote', note: { id: 'n_after_delete', questionId: 'q_seed_delete', sourceId: 'src_seed_chatgpt', text: 'x', messageId: null } }
      });
      const backup = await send({ type: 'DOMAIN_BACKUP' });
      const markdown = await send({ type: 'DOMAIN_EXPORT_MARKDOWN', sourceId: 'src_seed_chatgpt' });
      return {
        resolved: resolved.outcome?.status,
        deleted: deleted.outcome?.status,
        noteOnDeleted: recreate.outcome?.status,
        backupHasKept: (backup.backup?.data?.questions ?? []).some((question) => question.id === 'q_seed_kept'),
        backupHasDeleted: (backup.backup?.data?.questions ?? []).some((question) => question.id === 'q_seed_delete'),
        backupTombstoned: (backup.backup?.data?.tombstones ?? []).some((tombstone) => tombstone.id === 'q_seed_delete'),
        markdownHasAnswer: JSON.stringify(markdown).includes('Seeded saved answer')
      };
    });
  } finally {
    await library.close();
  }

  // The legacy view on its source page.
  const page = await createSourcePage(browser, '/c/source-retained');
  try {
    await page.waitForSelector('.aside-legacy-panel', { timeout: 15_000 });
    result.legacyView = await page.evaluate(() => {
      const panel = document.querySelector('.aside-legacy-panel');
      return {
        visible: panel instanceof HTMLElement && !panel.hidden,
        questionBox: Boolean(panel?.querySelector('textarea[data-aside-role="question"]')),
        startButton: Array.from(panel?.querySelectorAll('button') ?? []).some((button) => /Start branch|Try again/.test(button.textContent ?? '')),
        iframe: Boolean(document.querySelector('#aside-root iframe')),
        archive: panel?.querySelector('.aside-archive')?.textContent ?? '',
        openConversation: Boolean(panel?.querySelector('[data-aside-role="legacy-open-conversation"]')),
        askHandoff: Boolean(panel?.querySelector('[data-aside-role="legacy-ask-handoff"]'))
      };
    });
    result.openButton = await page.evaluate(() => {
      const button = document.querySelector('.aside-legacy-panel [data-aside-role="legacy-open-conversation"]');
      const rect = button?.getBoundingClientRect();
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      return {
        display: button ? getComputedStyle(button).display : null,
        width: rect ? Math.round(rect.width) : null,
        hitIsButton: hit === button
      };
    });
    await page.click('.aside-legacy-panel [data-aside-role="legacy-open-conversation"]');
    try {
      const saved = await waitForPageAt(browser, 'https://chatgpt.com/c/seed-legacy-branch');
      result.savedLink = await saved.evaluate(() => ({ ...window.__native, asideHost: Boolean(document.getElementById('aside-root')) }));
      await saved.close();
    } catch (error) {
      const opened = (await browser.pages()).find((candidate) => candidate.url() === 'https://chatgpt.com/c/seed-legacy-branch');
      result.savedLink = {
        openedPage: opened
          ? await opened.evaluate(() => ({ title: document.title, ready: window.__fixtureReady ?? null, html: document.documentElement.outerHTML.slice(0, 300) })).catch((e) => String(e))
          : null,
        error: String(error),
        notice: await notices(page),
        log: (page.__consoleMessages ?? []).slice(-6)
      };
    }
    await page.bringToFront();
    const recordBefore = JSON.parse((await readExtensionStorage(browser)).local)['aside:panel:panel_seed_live'];
    await page.click('.aside-legacy-panel [data-aside-role="legacy-ask-handoff"]');
    await page.waitForSelector(`${CARD}`, { timeout: 10_000 });
    result.handoffFromLegacy = await cardState(page);
    // An explicit local note from the new handoff.
    await clickCard(page, 'handoff-save-note-open');
    await page.type(`${CARD} textarea[data-aside-role="handoff-note-text"]`, 'Note saved on purpose');
    await clickCard(page, 'handoff-note-save');
    await page.waitForFunction(() => /Saved to Aside/.test(document.querySelector('.aside-notice')?.textContent ?? ''), { timeout: 10_000 });
    await clickCard(page, 'handoff-end');
    await clickCard(page, 'handoff-end-confirm');
    await page.waitForFunction(() => !document.querySelector('.aside-handoff'), { timeout: 10_000 });
    const recordAfter = JSON.parse((await readExtensionStorage(browser)).local)['aside:panel:panel_seed_live'];
    // Everything but this tab's own view state must be exactly as stored.
    const withoutView = (record) => {
      const { minimized, closedView, updatedAt, ...rest } = record?.state ?? {};
      return JSON.stringify(rest);
    };
    result.legacyRecordUnchanged = Boolean(recordBefore) && withoutView(recordBefore) === withoutView(recordAfter);
  } finally {
    await page.close();
  }

  // Cross-tab: closing the legacy view in tab A does not close it in tab B.
  const tabA = await createSourcePage(browser, '/c/source-retained');
  const tabB = await createSourcePage(browser, '/c/source-retained');
  try {
    await tabA.waitForSelector('.aside-legacy-panel', { timeout: 15_000 });
    await tabB.waitForSelector('.aside-legacy-panel', { timeout: 15_000 });
    await tabA.evaluate(() => {
      Array.from(document.querySelectorAll('.aside-legacy-panel .aside-panel-actions button')).find((button) => button.textContent === 'Close')?.click();
    });
    await sleep(800);
    result.crossTab = {
      closedInA: await tabA.evaluate(() => !document.querySelector('.aside-legacy-panel')),
      stillInB: await tabB.evaluate(() => Boolean(document.querySelector('.aside-legacy-panel'))),
      recordKept: Boolean(JSON.parse((await readExtensionStorage(browser)).local)['aside:panel:panel_seed_live'])
    };
  } finally {
    await tabA.close();
    await tabB.close();
  }

  const database = await dumpQuestionDatabase(browser);
  result.database = {
    kept: database.includes('q_seed_kept'),
    note: database.includes('Note saved on purpose'),
    handoffNoteMode: database.includes('native-handoff'),
    tombstone: database.includes('"q_seed_delete"') && database.includes('tombstones'),
    savedAnswer: database.includes('Seeded saved answer about retained convexity.')
  };
  const storage = await readExtensionStorage(browser);
  result.journal = JSON.parse(storage.local)['aside:migration-journal'] ?? null;
  return result;
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

function check(condition, label, detail) {
  if (!condition) {
    throw new Error(`${label}: ${JSON.stringify(detail)}`);
  }
}

try {
  await installBrowserInterception(browser);
  watchForUnservedProviderPages(browser);
  const context = browser.defaultBrowserContext();
  for (const origin of ['https://chatgpt.com', 'https://claude.ai']) {
    await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  }
  await serviceWorker(browser);

  // Saved data from before this release, present for the whole run.
  const seedOutcome = await seedRetainedData(browser);
  console.log('SEED', JSON.stringify(seedOutcome));

  const coexistence = await runCoexistenceScenario(browser);
  const chatgpt = await runChatGPTHandoffScenario(browser);
  const sourceClose = await runSourceCloseScenario(browser);
  const newTab = await runNewTabScenario(browser);
  const whyPreference = await runWhyPreferenceScenario(browser);
  const claudeCurrent = await runClaudeScenario(browser, { variant: 'current' });
  const claudeLegacy = await runClaudeScenario(browser, { variant: 'legacy' });
  const crossProvider = await runCrossProviderTabScenario(browser);
  const retired = await runRetiredEndpointsScenario(browser);
  const many = await runManySessionsScenario(browser);
  const layoutMatrix = await runLayoutMatrixScenario(browser);
  const retained = await runRetainedDataScenario(browser, seedOutcome);

  const result = { coexistence, chatgpt, sourceClose, newTab, whyPreference, claudeCurrent, claudeLegacy, crossProvider, retired, many, layoutMatrix, retained };
  console.log(JSON.stringify(result, null, 2));

  /* ---------------------------- coexistence ---------------------------- */
  check(coexistence.askOcclusion.allReachable === true, "Aside's own controls were covered by provider UI", coexistence.askOcclusion);
  check(coexistence.nativeOcclusion.allReachable === true, "Aside covered the provider's own controls", coexistence.nativeOcclusion);
  check(
    coexistence.askState.visibleActions.join('|') === 'Ask|Why|New-tab' &&
      coexistence.askState.toolbarIsLabelledAside === 'Aside branch actions' &&
      coexistence.askState.nativeAskHitTargetIsNative === true &&
      coexistence.askState.asideOverlapsNativeAsk === false,
    'Native selection action must stay usable alongside Aside',
    coexistence.askState
  );
  check(
    coexistence.context.rolesIncluded.includes('focus') &&
      coexistence.context.rolesIncluded.includes('preceding-question') &&
      coexistence.context.precedingInPreview === true &&
      coexistence.precedingGoneWhenUnticked === true,
    'Context: the preceding question is in by default and leaves when unticked',
    coexistence.context
  );
  check(
    coexistence.darkThemeState.theme === 'dark' && isDarkRgb(coexistence.darkThemeState.panelBackground),
    'Dark theme did not propagate to the card',
    coexistence.darkThemeState
  );
  check(coexistence.cardSurvivesOutsideEscape === true && coexistence.contextMenuPrevented === false, 'Escape/right-click outside Aside must stay native', coexistence);
  const rail = coexistence.minimizedState;
  check(
    rail.placement === 'left-gutter' &&
      rail.flexDirection === 'column' &&
      rail.overlapsSidebar === false &&
      rail.overlapsReadingColumn === false &&
      rail.tabHitInsideRail === true &&
      rail.badge === 'temporary' &&
      rail.cardHidden === true &&
      (rail.tabBarLeft ?? 0) >= (rail.sidebarRight ?? 0) &&
      (rail.tabBarLeft ?? 0) < (rail.readingColumnLeft ?? 0) &&
      coexistence.sessionsWhileHidden === 1,
    'Hidden handoff must sit in the left-gutter rail and keep its session',
    { rail, sessions: coexistence.sessionsWhileHidden }
  );
  check(
    coexistence.homeRestoreState.handoffTab === true &&
      coexistence.homeRestoreState.cardHidden === true &&
      coexistence.homeRestoreState.overlapsSidebar === false &&
      /different conversation/.test(coexistence.jumpOnOtherConversation ?? '') &&
      coexistence.sessionsAfterEnd === 0,
    'A reload/navigation in the source tab must bring the session back to the rail, and End must clear it',
    { home: coexistence.homeRestoreState, jump: coexistence.jumpOnOtherConversation, after: coexistence.sessionsAfterEnd }
  );

  /* --------------------------- ChatGPT lifecycle --------------------------- */
  const steps = chatgpt.steps;
  check(
    steps.afterSelection.clipboard.startsWith('owner clipboard sentinel') && steps.afterSelection.pages === 0 && steps.afterSelection.sessions === 0,
    'Selection alone must not copy, open or store anything',
    steps.afterSelection
  );
  check(
    steps.afterAsk.card.label === 'Temporary handoff · Not saved in Aside' &&
      /Confirm the temporary mode in the native page before pasting/.test(steps.afterAsk.card.instruction ?? '') &&
      steps.afterAsk.card.question === '' &&
      steps.afterAsk.card.questionFocused === true &&
      steps.afterAsk.card.primary === 'Copy & open temporary chat' &&
      steps.afterAsk.card.hasIframe === false &&
      steps.afterAsk.clipboard.startsWith('owner clipboard sentinel') &&
      steps.afterAsk.pages === 0 &&
      steps.afterAsk.sessions === 1 &&
      steps.sessionHoldsMarker === true,
    'Ask must open a card and nothing else',
    { afterAsk: steps.afterAsk, sessionHoldsMarker: steps.sessionHoldsMarker }
  );
  const open = steps.copyAndOpen;
  check(
    open.previewEqualsClipboard === true &&
      open.clipboardHasMarker === true &&
      open.clipboardHasTex === true &&
      open.card.primary === 'Continue in ChatGPT' &&
      /Copied: this exact prompt is on the clipboard\. Nothing has been sent\./.test(open.card.clipboardStatus ?? '') &&
      /ChatGPT opened in a new window/.test(open.card.targetStatus ?? '') &&
      open.sourceUrl === 'https://chatgpt.com/c/source-handoff' &&
      open.targetInOwnWindow === true,
    'Copy & open must copy exactly the preview and open a top-level window without moving the source',
    open
  );
  check(
    open.native.url === CHATGPT_TEMPORARY_URL &&
      !open.native.url.includes(MARK) &&
      open.native.referrer === '' &&
      open.native.asideHost === false &&
      open.native.modeClicks === 0 &&
      open.native.sendClicks === 0 &&
      open.native.composerInputs === 0 &&
      open.native.keydowns === 0 &&
      open.native.pastes === 0 &&
      open.native.prompts.length === 0,
    'The native page must receive nothing: no content in the URL or referrer, no clicks, typing, paste or send, no Aside UI',
    open.native
  );
  check(
    steps.owner.firstPromptIsCopied === true &&
      steps.owner.prompts.length === 2 &&
      steps.owner.prompts[1] === 'And if it were not convex?' &&
      steps.owner.composerInputs === 0 &&
      steps.owner.keydowns === 0 &&
      steps.owner.asideToolbar === false &&
      steps.owner.asideHost === false &&
      steps.owner.clipboardAfterFollowUp === open.card.preview,
    "The Owner's paste and follow-up stay native; Aside does not re-copy or appear in the native page",
    steps.owner
  );
  check(
    steps.popup.sessions === 1 &&
      /temporary handoff/.test(steps.popup.text) &&
      /Back at the passage/.test(steps.returned.popupStatus) &&
      steps.returned.sourceActive === true &&
      steps.returned.highlight === true,
    'Return to source from the toolbar popup must focus the source and find the passage',
    { popup: steps.popup, returned: steps.returned }
  );
  check(
    steps.continue.newPages === 0 && steps.continue.targetActive === true && steps.continue.clipboardUnchanged === true,
    'Continue must focus the same native tab without copying again',
    steps.continue
  );
  check(
    steps.second.whyQuestion === WHY_TEXT && steps.second.distinctSession === true && steps.second.targets === 2 && steps.second.sessions === 2,
    'A second question must get its own session and its own native tab',
    steps.second
  );
  check(steps.hidden.sessions === 2 && steps.hidden.railEntries >= 1, 'Hide must keep the session', steps.hidden);
  check(steps.clipboardCleared === true, 'Explicit Clear clipboard must replace the clipboard', steps.clipboardCleared);
  check(
    /cannot be reopened after it is closed/.test(steps.endWarning) &&
      steps.afterEnd.sessions === 1 &&
      steps.afterEnd.targets === 1 &&
      /Cleared from Aside/.test(steps.afterEnd.notice),
    'End must warn, clear the session and close only its own native tab',
    { warning: steps.endWarning, afterEnd: steps.afterEnd }
  );
  check(
    steps.afterTargetClose.disposed === true &&
      steps.afterTargetClose.sessions === 0 &&
      /was closed/.test(steps.afterTargetClose.notice) &&
      steps.afterTargetClose.railEntries === 0,
    'Closing the native tab by hand must end its scratch in the source page',
    steps.afterTargetClose
  );
  const persistence = chatgpt.persistence;
  check(
    persistence.probeAlive === true &&
      persistence.localWritesWithMarker === 0 &&
      persistence.syncWritesWithMarker === 0 &&
      persistence.authorityMessagesWithMarker === 0 &&
      persistence.localHasMarker === false &&
      persistence.sessionHasMarkerAfterEnd === false &&
      persistence.databaseHasMarker === false &&
      persistence.consoleHasMarker === false,
    'Scratch content must never reach durable storage, the question database or logs',
    persistence
  );

  /* ----------------------------- other paths ----------------------------- */
  check(
    sourceClose.targetOpenAfterSourceClose === true &&
      /source tab was closed/.test(sourceClose.listed.text) &&
      sourceClose.listed.returnDisabled === true &&
      sourceClose.targetClosedByEnd === true &&
      sourceClose.sessions === 0,
    'Closing the source must leave the native tab and keep End reachable from the toolbar',
    sourceClose
  );
  check(
    newTab.noTabBeforeQuestion === true &&
      newTab.card.question === '' &&
      newTab.card.primary === 'Copy & open temporary chat in a new tab' &&
      newTab.sameWindow === true &&
      newTab.native.sendClicks === 0 &&
      newTab.native.composerInputs === 0 &&
      newTab.targetClosedByEnd === true,
    'New-tab must prepare first, then open a tab beside the source, with nothing sent',
    newTab
  );
  check(
    whyPreference.card.question === WHY_TEXT &&
      whyPreference.card.label === 'Temporary handoff · Not saved in Aside' &&
      whyPreference.card.primary === 'Copy & open temporary chat' &&
      whyPreference.temporaryIntended === true &&
      whyPreference.entryWhy === true &&
      whyPreference.newAuthorityMessages === 0,
    'Why must stay a temporary handoff whatever an old preference said, and write nothing durable',
    whyPreference
  );
  [claudeCurrent, claudeLegacy].forEach((claude) => {
    check(
      claude.toolbarLabel === 'Aside branch actions' &&
        claude.card.label === 'Temporary handoff · Not saved in Aside' &&
        /SELECTED PASSAGE/.test(claude.card.preview ?? '') &&
        claude.previewEqualsClipboard === true &&
        claude.native.url === CLAUDE_NEW_URL &&
        claude.native.referrer === '' &&
        claude.native.asideHost === false &&
        claude.native.modeClicks === 0 &&
        claude.native.sendClicks === 0 &&
        claude.native.composerInputs === 0 &&
        claude.railOverlapsSidebar === false &&
        claude.targetClosedByEnd === true,
      `Claude ${claude.variant} handoff failed`,
      claude
    );
  });
  check(
    crossProvider.onClaude.cards === 0 &&
      crossProvider.onClaude.railEntries === 0 &&
      crossProvider.onClaude.markerInDom === false &&
      crossProvider.backOnChatGPT === 1 &&
      crossProvider.sessions === 0,
    "A tab that moves to another provider must not receive the first provider's scratch",
    crossProvider
  );
  check(
    retired.createWindow?.code === 'retired' &&
      retired.recheck?.code === 'retired' &&
      retired.automationEvent?.code === 'retired' &&
      retired.runInTab?.code === 'retired' &&
      retired.staleOpen?.code === 'stale-client' &&
      retired.badUrl?.ok === false,
    'Retired automation and stale clients must be refused',
    retired
  );
  check(
    many.cards === 0 && many.sessions === 0 && many.finalNodes <= many.baselineNodes + 2,
    'Opening and ending many sessions must not leave nodes or session entries behind',
    many
  );
  layoutMatrix.forEach((entry) => {
    check(
      entry.anythingShown === true &&
        (!entry.railShown || entry.onLeftHalf === true) &&
        entry.overlapsSidebar === false &&
        entry.overlapsColumn === false &&
        entry.overlapsNativeAsk === false &&
        entry.nativeAskHitTargetIsNative === true &&
        entry.occlusion?.allReachable === true &&
        entry.nativeOcclusion?.allReachable === true &&
        entry.composerUnderCard?.applicable === true &&
        entry.composerUnderCard?.reachable === true &&
        (entry.placement === 'left-gutter' || entry.launcherShown) &&
        entry.theme === (entry.label.includes('dark') ? 'dark' : 'light'),
      `Layout matrix failed at ${entry.label}`,
      entry
    );
  });

  /* ------------------------------ saved data ------------------------------ */
  check(
    retained.seedOutcome.every((status) => status === 'applied' || status === 'ok') &&
      /Aside build /.test(retained.footer) &&
      /matched in (message|title|draft|note)/.test(retained.searchHit) &&
      retained.bundle.assistantText === 'Seeded saved answer about retained convexity.' &&
      retained.bundle.notes === true &&
      retained.bundle.scripts === 0,
    'Saved records must stay searchable and readable in the library',
    retained
  );
  check(
    retained.lifecycle.resolved === 'applied' &&
      retained.lifecycle.deleted === 'applied' &&
      retained.lifecycle.noteOnDeleted === 'rejected' &&
      retained.lifecycle.backupHasKept === true &&
      retained.lifecycle.backupHasDeleted === false &&
      retained.lifecycle.backupTombstoned === true &&
      retained.lifecycle.markdownHasAnswer === true,
    'Resolve, delete (tombstoned), backup and export must keep working on saved records',
    retained.lifecycle
  );
  check(
    retained.legacyView.visible === true &&
      retained.legacyView.questionBox === false &&
      retained.legacyView.startButton === false &&
      retained.legacyView.iframe === false &&
      /Seeded legacy archived answer/.test(retained.legacyView.archive) &&
      retained.legacyView.openConversation === true &&
      retained.legacyView.askHandoff === true,
    'A legacy view must be read-only: no send form, no frame',
    retained.legacyView
  );
  check(
    retained.savedLink.url === 'https://chatgpt.com/c/seed-legacy-branch' &&
      retained.savedLink.sendClicks === 0 &&
      retained.savedLink.composerInputs === 0 &&
      retained.savedLink.asideHost === true,
    'Opening a saved conversation must be plain navigation',
    retained.savedLink
  );
  check(
    retained.handoffFromLegacy.question === 'Seeded legacy question' &&
      retained.handoffFromLegacy.label === 'Temporary handoff · Not saved in Aside' &&
      retained.legacyRecordUnchanged === true,
    'Asking from a legacy view must start a handoff and leave the record untouched',
    { card: retained.handoffFromLegacy, unchanged: retained.legacyRecordUnchanged }
  );
  check(
    retained.crossTab.closedInA === true && retained.crossTab.stillInB === true && retained.crossTab.recordKept === true,
    'Closing a view in one tab must not close it in another or delete the record',
    retained.crossTab
  );
  check(
    retained.database.kept === true &&
      retained.database.note === true &&
      retained.database.handoffNoteMode === true &&
      retained.database.tombstone === true &&
      retained.database.savedAnswer === true &&
      retained.journal?.validation?.ok === true,
    'The question database must keep saved data, the explicit note and the migration state',
    { database: retained.database, journal: retained.journal }
  );

  if (networkEscapes.length) {
    throw new Error(`Requests escaped to hosts the harness does not serve: ${JSON.stringify([...new Set(networkEscapes)])}`);
  }
  if (unservedProviderPages.length) {
    throw new Error(`A provider page loaded without the harness serving it: ${JSON.stringify(unservedProviderPages)}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(error);
  // What the pages themselves reported, for diagnosing a failed step.
  for (const openPage of await browser.pages().catch(() => [])) {
    if (openPage.__consoleMessages?.length) {
      console.error(`CONSOLE[${openPage.url()}]`, JSON.stringify(openPage.__consoleMessages.slice(-20)));
    }
  }
} finally {
  await Promise.race([browser.close().catch(() => {}), sleep(5_000)]);
  process.exit(exitCode);
}
