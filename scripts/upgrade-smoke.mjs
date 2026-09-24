/**
 * Retained-data upgrade check, run locally before handing a candidate over.
 *
 * It does what the Owner does: an unpacked extension loaded from ONE directory
 * holds data written by the previous build; the directory's contents are
 * replaced by the new build and the browser restarts on the same profile. The
 * extension id (derived from the directory) and its storage must carry over,
 * and every saved record must still be there and usable.
 *
 *   OLD_DIST=<previous build dir> node scripts/upgrade-smoke.mjs
 *
 * Nothing here touches a real provider: page requests are served from local
 * fixtures, and any other host fails the run.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const oldDist = process.env.OLD_DIST;
const newDist = path.join(process.cwd(), 'dist');
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headless = process.env.HEADLESS !== 'false';
if (!oldDist) {
  console.error('Set OLD_DIST to the previous build directory.');
  process.exit(2);
}

// A hung browser call must fail the check, not stall it.
const watchdog = setTimeout(() => {
  console.error('UPGRADE CHECK TIMED OUT');
  process.exit(3);
}, 240_000);
watchdog.unref();

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'aside-upgrade-'));
const extensionDir = path.join(work, 'extension');
const profileDir = path.join(work, 'profile');
const escapes = [];

const SOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Upgrade source</title></head><body>
<main>
  <article data-message-author-role="user"><p>Tell me about convexity.</p></article>
  <article data-message-author-role="assistant"><div data-message-content>
    <p>The convexity assumption guarantees the relaxation stays tight and keeps optimization stable.</p>
  </div></article>
</main></body></html>`;
const NATIVE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Native</title></head><body>
<main><textarea id="composer"></textarea><button id="send">Send</button></main>
<script>
  window.__native = { sends: 0, inputs: 0 };
  document.getElementById('composer').addEventListener('input', () => { window.__native.inputs += 1; });
  document.getElementById('send').addEventListener('click', () => { window.__native.sends += 1; });
  window.__fixtureReady = true;
</script></body></html>`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function intercept(browser) {
  const session = await browser.target().createCDPSession();
  session.on('sessionattached', (attached) => {
    void (async () => {
      try {
        attached.on('Fetch.requestPaused', (event) => {
          const url = new URL(event.request.url);
          if (!['chatgpt.com', 'claude.ai'].includes(url.hostname)) {
            if (url.protocol.startsWith('http')) {
              escapes.push(url.origin);
              void attached.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
              return;
            }
            void attached.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
            return;
          }
          const body = url.pathname.startsWith('/c/upgrade-source') ? SOURCE_HTML : NATIVE_HTML;
          void attached
            .send('Fetch.fulfillRequest', {
              requestId: event.requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
              body: Buffer.from(body).toString('base64')
            })
            .catch(() => {});
        });
        await attached.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      } catch {
        // Some targets reject Fetch.enable.
      } finally {
        await attached.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      }
    })();
  });
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    pipe: true,
    userDataDir: profileDir,
    enableExtensions: [extensionDir],
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check']
  });
  await intercept(browser);
  const deadline = Date.now() + 15_000;
  let worker = null;
  while (!worker && Date.now() < deadline) {
    worker = browser.targets().find((target) => target.type() === 'service_worker') ?? null;
    if (!worker) {
      await sleep(200);
    }
  }
  if (!worker) {
    throw new Error('No extension service worker.');
  }
  const extensionId = new URL(worker.url()).hostname;
  return { browser, extensionId, worker: await worker.worker() };
}

async function extensionPage(browser, extensionId, file) {
  const page = await browser.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  // Right after a reload the extension is briefly unavailable; retry for a while.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await page.goto(`chrome-extension://${extensionId}/${file}`, { waitUntil: 'domcontentloaded' });
      return page;
    } catch (error) {
      if (Date.now() > deadline) {
        await page.close();
        throw error;
      }
      await sleep(500);
    }
  }
}

async function dumpDatabase(browser, extensionId) {
  const page = await extensionPage(browser, extensionId, 'library.html');
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
            const tx = db.transaction(names, 'readonly');
            let pending = names.length;
            names.forEach((name) => {
              const all = tx.objectStore(name).getAll();
              all.onsuccess = () => {
                out[name] = all.result;
                pending -= 1;
                if (!pending) {
                  resolve(out);
                }
              };
            });
          };
        })
    );
  } finally {
    await page.close();
  }
}

let exitCode = 0;
try {
  await fs.cp(oldDist, extensionDir, { recursive: true });
  const oldManifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));

  console.log('STEP old-build');
  /* ---------------------------- the previous build ---------------------------- */
  let { browser, extensionId, worker } = await launch();
  const oldBuild = await (async () => {
    const page = await extensionPage(browser, extensionId, 'library.html');
    await page.waitForSelector('#about', { timeout: 15_000 });
    await sleep(500);
    const footer = await page.evaluate(() => document.querySelector('#about')?.textContent ?? '');
    const seeded = await page.evaluate(async () => {
      const send = (message) => chrome.runtime.sendMessage(message);
      const sourceId = 'src_upgrade';
      const create = (id, title) =>
        send({
          type: 'DOMAIN_COMMAND',
          command: {
            type: 'CreateQuestion',
            source: {
              id: sourceId,
              providerId: 'chatgpt',
              scopeKey: 'chatgpt:c:upgrade-source',
              conversationId: 'upgrade-source',
              containerId: null,
              url: 'https://chatgpt.com/c/upgrade-source',
              title: 'Upgrade source',
              kind: 'assistant-answer',
              acquisition: 'selected-fragment',
              messageId: 'assistant:1:u'
            },
            blocks: [],
            anchor: {
              id: `a_${id}`,
              sourceId,
              selectedText: 'convexity assumption',
              exact: 'convexity assumption',
              prefix: 'The ',
              suffix: ' guarantees',
              messageId: 'assistant:1:u',
              turnIndex: 1,
              role: 'assistant',
              contentHash: 'u',
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
            draft: { text: title, excludedBlockIds: [], background: 'kept background' }
          }
        });
      const results = [await create('q_upgrade_1', 'Upgrade question one'), await create('q_upgrade_2', 'Upgrade question two')];
      results.push(
        await send({
          type: 'DOMAIN_COMMAND',
          command: { type: 'SaveNote', note: { id: 'n_upgrade', questionId: 'q_upgrade_1', sourceId, text: 'Upgrade note', messageId: null } }
        })
      );
      const now = Date.now();
      results.push(
        await send({
          type: 'PANEL_UPSERT',
          panelId: 'panel_upgrade',
          scopeKey: 'chatgpt:c:upgrade-source',
          area: 'local',
          baseRev: 0,
          state: {
            panelId: 'panel_upgrade',
            rootConversationId: 'chatgpt:c:upgrade-source',
            rootChatUrl: 'https://chatgpt.com/c/upgrade-source',
            selection: {
              rootConversationId: 'chatgpt:c:upgrade-source',
              rootChatUrl: 'https://chatgpt.com/c/upgrade-source',
              selectedText: 'convexity assumption',
              selectedBlocks: [{ messageId: 'assistant:1:u', role: 'assistant', turnIndex: 1, text: 'The convexity assumption guarantees the relaxation stays tight.', excerpt: 'The convexity' }],
              branchBaseMessageId: 'assistant:1:u',
              rangeQuotes: { exact: 'convexity assumption', prefix: 'The ', suffix: ' guarantees' },
              fallbackScrollY: 0
            },
            focusPreview: 'convexity assumption',
            branchKind: 'persistent',
            entryAction: 'ask',
            surfaceMode: 'embedded',
            creationMode: 'local_persistent',
            title: 'Upgrade legacy panel',
            titleStatus: 'ready',
            minimized: false,
            status: 'live',
            statusLabel: 'Branch answer is ready in this window.',
            initialQuestion: 'Upgrade legacy question',
            branchChatUrl: 'https://chatgpt.com/c/upgrade-branch',
            createdAt: now,
            updatedAt: now
          }
        })
      );
      await chrome.storage.local.set({ 'aside:last-branch-kind:chatgpt': 'persistent' });
      return results.map((result) => result?.outcome?.status ?? result?.status ?? 'failed');
    });
    await page.close();
    const local = await worker.evaluate(async () => chrome.storage.local.get(null));
    return { footer, seeded, localKeys: Object.keys(local).sort(), journal: local['aside:migration-journal'] ?? null };
  })();
  console.log('STEP dump-before');
  const beforeDatabase = await dumpDatabase(browser, extensionId);
  await browser.close();

  console.log('STEP update');
  /* ------------------------------ in-place update ------------------------------ */
  const entries = await fs.readdir(extensionDir);
  await Promise.all(entries.map((entry) => fs.rm(path.join(extensionDir, entry), { recursive: true, force: true })));
  await fs.cp(newDist, extensionDir, { recursive: true });

  console.log('STEP relaunch');
  const relaunched = await launch();
  browser = relaunched.browser;
  worker = relaunched.worker;
  const extensionIdAfter = relaunched.extensionId;
  await sleep(1_000);

  // Which worker is answering? Replacing the files and restarting the browser
  // is not always enough for Chrome to pick up a new service worker for an
  // unpacked extension with the same version: the Owner presses Reload on the
  // extension card, and so does this check when it has to.
  const withTimeout = (promise, ms, label) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms))]);
  const workerBuild = async () => {
    console.log('  workerBuild: opening page');
    const page = await withTimeout(extensionPage(browser, extensionIdAfter, 'library.html'), 40_000, 'open library');
    console.log('  workerBuild: page open');
    try {
      return await withTimeout(
        page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'PANEL_LIST' }))?.buildId ?? null),
        20_000,
        'PANEL_LIST'
      );
    } finally {
      await page.close().catch(() => {});
    }
  };
  const expectedBuild = (await fs.readFile(path.join(extensionDir, 'assets/background.js'), 'utf8')).match(/[0-9a-f]{7}(?:-dirty)?\+\d{4}-\d{2}-\d{2}T\d{4,6}/)?.[0] ?? null;
  console.log('STEP worker-build');
  const workerBuildAfterRestart = await workerBuild();
  let reloadedFromCard = false;
  console.log(`  worker after restart: ${workerBuildAfterRestart}; files: ${expectedBuild}`);
  if (workerBuildAfterRestart !== expectedBuild) {
    reloadedFromCard = true;
    // What the card's Reload button does: load the same unpacked directory
    // again. Same directory, so the same extension id and the same storage.
    const reinstalledId = await browser.installExtension(extensionDir);
    console.log(`  reloaded from the same directory: ${reinstalledId}`);
    await sleep(2_000);
  }
  console.log('STEP after-reload');
  const workerBuildAfterReload = await workerBuild();
  // From here on, storage is read from an extension page: a debugger handle to
  // a service worker does not survive the extension reloading.
  const readLocal = async () => {
    const page = await extensionPage(browser, extensionIdAfter, 'library.html');
    try {
      return await page.evaluate(async () => chrome.storage.local.get(null));
    } finally {
      await page.close();
    }
  };
  const readSessionKeys = async () => {
    const page = await extensionPage(browser, extensionIdAfter, 'library.html');
    try {
      return await page.evaluate(async () =>
        Object.keys(await chrome.storage.session.get(null)).filter((key) => key.startsWith('aside:handoff:'))
      );
    } finally {
      await page.close();
    }
  };
  console.log('STEP read-local');
  const afterLocal = await readLocal();
  console.log('STEP dump-after');
  const afterDatabase = await dumpDatabase(browser, extensionIdAfter);
  const library = await extensionPage(browser, extensionIdAfter, 'library.html');
  await library.waitForSelector('#sources .source', { timeout: 15_000 });
  const footerAfter = await library.evaluate(() => document.querySelector('#about')?.textContent ?? '');
  const listed = await library.evaluate(() => document.querySelector('#sources')?.textContent ?? '');
  await library.close();

  console.log('STEP legacy-view');
  // The legacy view, read-only, and a new handoff that writes nothing durable.
  const source = await browser.newPage();
  await source.goto('https://chatgpt.com/c/upgrade-source', { waitUntil: 'domcontentloaded' });
  await source.waitForSelector('.aside-legacy-panel', { timeout: 15_000 });
  const legacyView = await source.evaluate(() => ({
    readOnly: !document.querySelector('.aside-legacy-panel textarea[data-aside-role="question"]'),
    iframe: Boolean(document.querySelector('#aside-root iframe'))
  }));
  const questionsBefore = afterDatabase.questions.length;
  await source.evaluate(() => {
    const paragraph = document.querySelector('article[data-message-author-role="assistant"] p');
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 4);
    range.setEnd(paragraph.firstChild, 24);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await source.waitForFunction(() => {
    const toolbar = document.querySelector('#aside-selection-toolbar');
    return toolbar instanceof HTMLElement && !toolbar.hidden;
  }, { timeout: 10_000 });
  await source.evaluate(() => document.querySelector('#aside-why-button')?.click());
  const cardShown = await source
    .waitForSelector('.aside-handoff:not([hidden])', { timeout: 10_000 })
    .then(() => true, () => false);
  if (!cardShown) {
    const diagnostics = await source.evaluate(() => ({
      notice: document.querySelector('.aside-notice')?.textContent ?? null,
      cards: document.querySelectorAll('.aside-handoff').length,
      legacyVisible: Boolean(document.querySelector('.aside-legacy-panel:not([hidden])')),
      selection: String(getSelection())
    }));
    throw new Error(`No handoff card after Why: ${JSON.stringify(diagnostics)}`);
  }
  const whyQuestion = await source.evaluate(() => document.querySelector('.aside-handoff textarea[data-aside-role="handoff-question"]')?.value ?? '');
  await sleep(800);
  console.log('STEP dump-handoff');
  const afterHandoffDatabase = await dumpDatabase(browser, extensionIdAfter);
  const sessionKeys = await readSessionKeys();
  await browser.close();

  const newManifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const result = {
    expectedBuild,
    workerBuildAfterRestart,
    reloadedFromCard,
    workerBuildAfterReload,
    oldBuild: oldBuild.footer.match(/Aside build (\S+)/)?.[1] ?? oldBuild.footer,
    newBuild: footerAfter.match(/Aside build (\S+)/)?.[1] ?? footerAfter,
    extensionIdStable: extensionId === extensionIdAfter,
    seeded: oldBuild.seeded,
    questionsKept: ['q_upgrade_1', 'q_upgrade_2'].every((id) => afterDatabase.questions.some((question) => question.id === id)),
    draftBackgroundKept: afterDatabase.drafts.some((draft) => draft.questionId === 'q_upgrade_1' && draft.background === 'kept background'),
    noteKept: afterDatabase.notes.some((note) => note.id === 'n_upgrade'),
    // Every record that existed before is still there, byte for byte. New
    // questions may appear only from the journaled legacy-panel migration,
    // which runs on each worker start for panels written after the cutover.
    existingRecordsUnchanged: ['questions', 'notes', 'drafts', 'anchors', 'sources'].every((store) =>
      beforeDatabase[store].every((record) => afterDatabase[store].some((candidate) => JSON.stringify(candidate) === JSON.stringify(record)))
    ),
    addedQuestions: afterDatabase.questions.map((question) => question.id).filter((id) => !beforeDatabase.questions.some((question) => question.id === id)),
    legacyPanelKept: Boolean(afterLocal['aside:panel:panel_upgrade']),
    journalValid: afterLocal['aside:migration-journal']?.validation?.ok === true,
    journalSuperset: (oldBuild.journal?.migrated ?? []).every((entry) =>
      (afterLocal['aside:migration-journal']?.migrated ?? []).some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))
    ),
    oldLocalKeysKept: oldBuild.localKeys.every((key) => key in afterLocal),
    libraryListsSource: /Upgrade source/.test(listed),
    legacyView,
    whyIsHandoff: whyQuestion.startsWith('Why does this step hold?'),
    noNewDurableQuestion: afterHandoffDatabase.questions.length === questionsBefore,
    handoffInSessionOnly: sessionKeys.length === 1,
    manifest: {
      oldVersion: oldManifest.version,
      newVersion: newManifest.version,
      oldPermissions: oldManifest.permissions,
      newPermissions: newManifest.permissions,
      hostPermissionsSame: JSON.stringify(oldManifest.host_permissions) === JSON.stringify(newManifest.host_permissions)
    },
    escapes
  };
  console.log(JSON.stringify(result, null, 2));
  const ok =
    result.workerBuildAfterReload === result.expectedBuild &&
    result.extensionIdStable &&
    result.seeded.every((status) => status === 'applied') &&
    result.questionsKept &&
    result.draftBackgroundKept &&
    result.noteKept &&
    result.existingRecordsUnchanged &&
    result.addedQuestions.every((id) => id.startsWith('q_legacy_')) &&
    result.legacyPanelKept &&
    result.libraryListsSource &&
    result.journalValid &&
    result.journalSuperset &&
    result.oldLocalKeysKept &&
    result.legacyView.readOnly &&
    !result.legacyView.iframe &&
    result.whyIsHandoff &&
    result.noNewDurableQuestion &&
    result.handoffInSessionOnly &&
    result.manifest.hostPermissionsSame &&
    escapes.length === 0;
  if (!ok) {
    throw new Error('Upgrade check failed');
  }
  console.log('UPGRADE CHECK PASSED');
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
}
