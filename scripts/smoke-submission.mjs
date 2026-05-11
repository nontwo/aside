import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = pathToFileURL(resolve(process.cwd(), 'course-submission/index.html')).href;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files']
});

try {
  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#sourceText .sentence', { timeout: 10000 });

  const title = await page.$eval('h1', (node) => node.textContent?.trim());
  if (title !== 'Follow the Sentence, Not the Thread') {
    throw new Error(`Unexpected page title: ${title}`);
  }

  await page.click('#sourceText .sentence:nth-child(2)');
  const methodTrace = await page.$eval('#methodTrace', (node) => node.textContent ?? '');
  const prompt = await page.$eval('#promptOutput', (node) => node.textContent ?? '');
  if (!methodTrace.includes('Anchor: sentence 2')) {
    throw new Error('Method trace did not update after sentence selection.');
  }
  if (!prompt.includes('SELECTED PASSAGE')) {
    throw new Error('Prompt output did not include the selected passage section.');
  }

  await page.click('#askAction');
  await page.click('#whyAction');
  await page.click('#newTabAction');

  const branchCount = await page.$$eval('.branch-card', (cards) => cards.length);
  if (branchCount < 3) {
    throw new Error(`Expected at least 3 branch cards; found ${branchCount}.`);
  }

  const links = await page.$$eval('.deliverable-links a', (anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href'))
  );
  for (const expected of [
    './report/report.html',
    './replication/',
    './data/sample_conversations.jsonl',
    './extension/'
  ]) {
    if (!links.includes(expected)) {
      throw new Error(`Missing deliverable link: ${expected}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        title,
        branchCount,
        methodTrace: methodTrace.slice(0, 120)
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
