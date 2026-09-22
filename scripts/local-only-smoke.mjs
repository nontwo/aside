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
  temporaryModeSkipsConversationUrl = false,
  conversationUrlMode = 'always',
  conversationUrlStorageKey = '__asideSubmitCount',
  realComposerId = 'prompt-textarea',
  realSendMode = 'explicit',
  enterOnlySubmit = false,
  sendInShadowRoot = false,
  assistantReplyText = '[[BRANCH_TITLE: local convexity]]\nThis uses only the selected passage.'
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
  const temporaryChatMarkup = includeTemporaryChatToggle
    ? `<button id="temporary-chat-toggle" type="submit" aria-label="开启临时聊天">开启临时聊天</button>`
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
    <script>
      const temporaryChatToggle = document.getElementById('temporary-chat-toggle');
      if (temporaryChatToggle) {
        let temporaryChatModeActive = ${temporaryChatInitiallyActive ? 'true' : 'false'};
        window.__temporaryChatModeActive = temporaryChatModeActive;
        const reflectTemporaryChatState = (active) => {
          temporaryChatToggle.dataset.temporaryChatState = active ? 'active' : 'inactive';
          temporaryChatToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
          temporaryChatToggle.setAttribute('aria-label', active ? '关闭临时聊天' : '开启临时聊天');
          temporaryChatToggle.textContent = active ? '关闭临时聊天' : '开启临时聊天';
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

function resolveRouteBody(pathname) {
  return routeMap[pathname] ?? routeMap['*'] ?? NOT_FOUND_HTML;
}

async function fulfillPausedRequest(session, event) {
  const { requestId } = event;

  let url = null;
  try {
    url = new URL(event.request.url);
  } catch {
    url = null;
  }

  if (!url || url.hostname !== 'chatgpt.com') {
    await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }

  await session
    .send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(resolveRouteBody(url.pathname), 'utf8').toString('base64')
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

async function createSourcePage(browser, pathName) {
  const page = await browser.newPage();
  page.__consoleMessages = [];
  page.on('console', (message) => {
    page.__consoleMessages.push(message.text());
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

async function injectNativeAskButton(page) {
  await page.evaluate(() => {
    const range = getSelection()?.getRangeAt(0);
    if (!range) {
      throw new Error('No selection range was available.');
    }
    const rect = range.getBoundingClientRect();
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Ask ChatGPT');
    button.textContent = 'Ask ChatGPT';
    button.style.position = 'fixed';
    button.style.top = `${Math.max(16, rect.top - 40)}px`;
    button.style.left = `${Math.max(16, rect.right + 16)}px`;
    button.style.zIndex = '2147483646';
    document.body.append(button);
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

async function waitForPanelStatus(page, matcher, timeoutMs = 30_000) {
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

async function setPanelBranchKind(page, label) {
  await page.evaluate((kindLabel) => {
    const panel = document.querySelector('.aside-panel:not([hidden])');
    const button = Array.from(panel?.querySelectorAll('.aside-kind-toggle button') ?? []).find(
      (candidate) => candidate.textContent?.trim() === kindLabel
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Branch kind button not found: ${kindLabel}`);
    }
    button.click();
  }, label);
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
  await page.waitForSelector('.aside-panel:not([hidden]) textarea', { timeout: 10_000 });
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
  await page.type('.aside-panel:not([hidden]) textarea', question);
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
    await injectNativeAskButton(page);
    await selectAssistantText(page);

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
      const toolbarRect = document
        .querySelector('#aside-selection-toolbar')
        ?.getBoundingClientRect();

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
    await page.waitForSelector('.aside-panel:not([hidden]) textarea', { timeout: 10_000 });
    await page.type('.aside-panel:not([hidden]) textarea', 'Why this assumption?');

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
    await waitForPanelTitle(page, 'local convexity');

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
      promptContainsSelectedPassage: Boolean(
        branch.prompt?.includes('convexity assumption guarantees the relaxation stays tight')
      ),
      promptContainsLocalSourceAnswer: Boolean(
        branch.prompt?.includes('The convexity assumption guarantees the relaxation stays tight')
      )
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
    await waitForPanelStatus(page, /native ChatGPT window/i, 30_000);

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
      assistantReplyText: '[[BRANCH_TITLE: local convexity]]\nReady for your question.'
    })
  };

  const page = await createSourcePage(browser, '/c/source-new-tab');

  try {
    await selectAssistantText(page);
    await page.waitForSelector('#aside-selection-toolbar', { timeout: 10_000 });
    const existingPages = await browser.pages();
    await clickSelectionAction(page, '#aside-new-tab-button');
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
        panelVisible: Boolean(document.querySelector('.aside-panel:not([hidden])'))
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
    ]).then(([source, branch]) => ({ ...source, ...branch }));
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

async function runTemporaryChatRecoveryScenario(browser) {
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
    await setPanelBranchKind(page, 'Temporary');
    await page.type('.aside-panel:not([hidden]) textarea', 'Why this assumption?');
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
          null,
        openBranchVisible: Array.from(
          document.querySelectorAll('.aside-panel:not([hidden]) .aside-panel-actions button')
        ).some((button) => button.textContent?.trim() === 'Open branch' && getComputedStyle(button).display !== 'none')
      })),
      branchFrame.evaluate(() => {
        const temporaryChatToggle = document.getElementById('temporary-chat-toggle');
        return {
          branchLocation: window.location.href,
          temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0,
          temporaryChatModeActive: window.__temporaryChatModeActive ?? false,
          temporaryChatState: temporaryChatToggle?.getAttribute('aria-pressed') ?? null,
          temporaryChatLabel: temporaryChatToggle?.getAttribute('aria-label') ?? null,
          temporaryChatText: temporaryChatToggle?.textContent ?? null
        };
      })
    ]).then(([source, branch]) => ({ ...source, ...branch }));
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
    await setPanelBranchKind(page, 'Temporary');
    await page.type('.aside-panel:not([hidden]) textarea', 'Why this assumption?');
    await page.evaluate(() => {
      const button = document.querySelector('.aside-panel:not([hidden]) button[type="submit"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Panel submit button not found');
      }
      button.click();
    });
    const branchFrame = await waitForBranchFrame(page);
    await waitForPanelStatus(page, /Local branch creation failed\./);

    return await Promise.all([
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
        return {
          branchLocation: window.location.href,
          temporaryChatToggleClicks: window.__temporaryChatToggleClicks ?? 0,
          temporaryChatLabel: temporaryChatToggle?.getAttribute('aria-label') ?? null,
          temporaryChatText: temporaryChatToggle?.textContent ?? null
        };
      })
    ]).then(([source, branch]) => ({ ...source, ...branch }));
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
    const { branchFrame } = await openDraftAndSubmit(page, 'Why this assumption?');
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
    ]).then(([source, branch]) => ({ ...source, ...branch }));
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
    await setPanelBranchKind(page, 'Persistent');
    await page.type('.aside-panel:not([hidden]) textarea', 'Why this assumption?');
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
  const temporaryChatRecovery = await runTemporaryChatRecoveryScenario(browser);
  const temporaryChatBlocked = await runTemporaryChatBlockedScenario(browser);
  const failure = await runFailureScenario(browser);

  const result = {
    nonProject,
    why,
    newTab,
    enterOnly,
    project,
    temporaryChatRecovery,
    temporaryChatBlocked,
    failure
  };

  console.log(JSON.stringify(result, null, 2));

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
    nonProject.liveResult.title !== 'local convexity' ||
    nonProject.liveResult.branchLocation !== 'https://chatgpt.com/c/generated-local' ||
    !nonProject.liveResult.openBranchVisible ||
    nonProject.liveResult.pageCountBefore !== nonProject.liveResult.pageCountAfter ||
    !nonProject.liveResult.promptContainsSelectedPassage ||
    !nonProject.liveResult.promptContainsLocalSourceAnswer ||
    !nonProject.liveResult.assistantText?.includes('This uses only the selected passage.')
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
      why.status !== 'Branch continued in a native ChatGPT window.' ||
      why.formVisible !== false ||
      why.branchLocation !== 'https://chatgpt.com/c/generated-why' ||
      !why.openBranchVisible ||
      !why.assistantText?.includes('This uses only the selected passage.') ||
      !why.prompt?.includes('USER QUESTION\nWhy?')
    )
  ) {
    throw new Error(`Why action scenario failed: ${JSON.stringify(why)}`);
  }

  if (
    includeNativeWindowSmoke &&
    newTab &&
    (
      newTab.sourceLocation !== 'https://chatgpt.com/c/source-new-tab' ||
      newTab.panelVisible !== false ||
      newTab.location !== 'https://chatgpt.com/c/generated-new-window' ||
      newTab.branchPanelVisible !== false ||
      newTab.composerVisible !== true ||
      newTab.composerFocused !== true ||
      !newTab.userPrompt?.includes('SELECTED PASSAGE') ||
      !newTab.userPrompt?.includes('convexity assumption guarantees the relaxation stays tight') ||
      !newTab.assistantText?.includes('Ready for your question.')
    )
  ) {
    throw new Error(`New-tab scenario failed: ${JSON.stringify(newTab)}`);
  }

  if (
    project.status !== 'Branch answer is ready in this window.' ||
    project.branchLocation !== 'https://chatgpt.com/g/g-p-demo-project/c/generated-project'
  ) {
    throw new Error(`Project embedded branch scenario failed: ${JSON.stringify(project)}`);
  }

  if (
    enterOnly.status !== 'Branch answer is ready in this window.' ||
    enterOnly.branchLocation !== 'https://chatgpt.com/c/generated-enter-only' ||
    !enterOnly.prompt?.includes('USER QUESTION')
  ) {
    throw new Error(`Enter-only scenario failed: ${JSON.stringify(enterOnly)}`);
  }

  if (
    temporaryChatRecovery.status !== 'Branch answer is ready in this window.' ||
    temporaryChatRecovery.branchLocation.includes('/c/') ||
    temporaryChatRecovery.temporaryChatToggleClicks < 1 ||
    temporaryChatRecovery.temporaryChatModeActive !== true ||
    temporaryChatRecovery.openBranchVisible !== false
  ) {
    throw new Error(
      `Temporary-chat recovery scenario failed: ${JSON.stringify(temporaryChatRecovery)}`
    );
  }

  if (
    temporaryChatBlocked.status !== 'Local branch creation failed.' ||
    !temporaryChatBlocked.errorText?.includes('saved this branch as a normal conversation') ||
    // The leaked conversation has to be surfaced so the user can go and delete it.
    temporaryChatBlocked.branchLocation !== 'https://chatgpt.com/c/generated-temp-blocked' ||
    temporaryChatBlocked.openBranchVisible !== true ||
    temporaryChatBlocked.temporaryChatToggleClicks < 1
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
