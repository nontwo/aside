# Replication Package

This folder documents how to reproduce the Aside course project from the repository.

## Requirements

- Node.js 20 or newer
- npm
- A Chromium browser if you want to manually load the preserved extension

No server, database, API key, or private data file is required.

## Reproduce the static app and report

From the repository root:

```bash
npm install
npm run build:submission
npm run audit:submission
npm run smoke:submission
```

Then open:

```text
course-submission/index.html
```

The app loads synthetic sample data from:

```text
course-submission/data/sample_conversations.jsonl
```

If the page is opened directly from the filesystem and the browser blocks local data loading, the app falls back to the same synthetic examples bundled in JavaScript.

## Reproduce the extension artifact

From the repository root:

```bash
npm install
npm test
npx tsc --noEmit
npm run build
npm run build:submission
```

The extension build is copied into:

```text
course-submission/extension/dist
```

To inspect it manually, open `chrome://extensions/`, enable Developer Mode, and load the `course-submission/extension/dist` folder as an unpacked extension.

## Verify the project

Run the full local check:

```bash
npm test
npx tsc --noEmit
npm run build
npm run audit:public
npm run build:submission
npm run audit:submission
npm run smoke:submission
```

## Data statement

The sample data is synthetic and was written for this project. It does not contain private ChatGPT logs, personal information, or course discussion transcripts.

## Expected outputs

- A public static app at the GitHub Pages URL for this repository
- `course-submission/report/report.html`
- `course-submission/data/sample_conversations.jsonl`
- `course-submission/extension/dist`
- `course-submission/SUBMISSION_CHECKLIST.md`
