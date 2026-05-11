import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const submissionDir = path.join(root, 'course-submission');
const reportSource = path.join(submissionDir, 'report', 'report.md');
const reportOutput = path.join(submissionDir, 'report', 'report.html');
const extensionTarget = path.join(submissionDir, 'extension', 'dist');

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listItems = [];
  let codeLines = [];
  let inCode = false;

  function flushParagraph() {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) {
      return;
    }
    html.push('<ul>');
    for (const item of listItems) {
      html.push(`<li>${renderInline(item)}</li>`);
    }
    html.push('</ul>');
    listItems = [];
  }

  function flushCode() {
    if (!codeLines.length) {
      return;
    }
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (line.startsWith('# ')) {
      flushParagraph();
      flushList();
      html.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      continue;
    }

    if (line.startsWith('## ')) {
      flushParagraph();
      flushList();
      html.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith('- ')) {
      flushParagraph();
      listItems.push(line.slice(2));
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();
  return html.join('\n');
}

function reportTemplate(body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aside Course Project Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f4ef;
        --ink: #17202a;
        --muted: #687386;
        --line: #d8d4ca;
        --panel: #fffdf8;
        --accent: #1f6f68;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI", Helvetica, Arial, sans-serif;
        line-height: 1.68;
      }
      main {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        margin: 48px auto;
        max-width: 920px;
        padding: clamp(24px, 5vw, 56px);
      }
      a { color: var(--accent); }
      h1 { font-size: clamp(2.2rem, 5vw, 4.4rem); line-height: 0.98; margin-top: 0; }
      h2 { border-top: 1px solid var(--line); margin-top: 36px; padding-top: 28px; }
      p, li { color: #293443; font-size: 1.04rem; }
      code { background: #eee9df; border-radius: 4px; padding: 0.12em 0.3em; }
      pre {
        background: #17202a;
        border-radius: 8px;
        color: #f6f4ef;
        overflow: auto;
        padding: 16px;
      }
      .back {
        color: var(--muted);
        display: inline-block;
        font-weight: 750;
        margin-bottom: 28px;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="../index.html">Back to app</a>
      ${body}
    </main>
  </body>
</html>
`;
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await fs.mkdir(path.dirname(reportOutput), { recursive: true });
const markdown = await fs.readFile(reportSource, 'utf8');
await fs.writeFile(reportOutput, reportTemplate(renderMarkdown(markdown)));

runNodeScript(path.join(root, 'scripts', 'build.mjs'));

await fs.rm(extensionTarget, { recursive: true, force: true });
await fs.cp(path.join(root, 'dist'), extensionTarget, {
  recursive: true,
  filter: (source) => path.basename(source) !== '.DS_Store'
});

console.log(`Built course submission at ${submissionDir}`);
