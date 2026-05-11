# Aside

Aside is a Chromium extension for asking focused follow-up questions from long ChatGPT answers without losing your place in the main conversation.

It keeps the reading flow centered on the selected passage:
- select text inside a ChatGPT assistant answer
- open an in-page branch with `Ask` or `Why`
- keep reading while branches run in parallel
- restore minimized branches later and jump back to the original selected text

## What Aside does

- Opens an embedded branch workspace beside the main conversation instead of forcing you to scroll the original chat.
- Sends only local context for the first branch prompt:
  - the selected passage
  - the touched assistant answer block(s)
  - your branch question
- Supports both:
  - `persistent` branches that must resolve to a real ChatGPT conversation URL
  - `temporary` branches that may stay ephemeral
- Supports `New-tab`, which opens a second ChatGPT window for a separate branch flow.
- Preserves minimized branches so you can keep multiple questions running without interrupting each other.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Open `chrome://extensions/`, enable Developer Mode, and load the `dist/` directory as an unpacked extension.

4. Reload `chatgpt.com`, select assistant text, and try `Ask`, `Why`, or `New-tab`.

## Course submission package

The Text as Data course submission lives in [`course-submission/`](./course-submission/). It includes a static public demo, synthetic sample data, a report, replication notes, and a preserved extension artifact.

Folder structure:
- root source files are the Chromium extension and shared build/test tooling
- `course-submission/` is the canonical course website and replication package
- generated exports or zip-ready packages should live outside the repo, such as `/tmp/aside-course-submission`

```bash
npm run build:submission
npm run audit:submission
npm run smoke:submission
npm run package:submission
```

The GitHub Pages workflow publishes `course-submission/` as the public project site.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
npm run smoke:local
```

`npm run smoke:local` uses a fake `chatgpt.com` harness to verify the selection toolbar, branch creation flow, and embedded/native branch behaviors without relying on live production markup.

For the current native-window scenarios, there is also an opt-in smoke variant:

```bash
INCLUDE_NATIVE_WINDOW_SMOKE=true npm run smoke:local
```

## Safe open-source release workflow

This workspace is intentionally kept separate from the final public GitHub export.

Before publishing:

```bash
npm run audit:public
npm run export:public -- ../aside-public
```

The audit checks for obvious release blockers such as:
- old reference/provenance markers
- personal machine paths
- `.DS_Store`
- maintainer-only debug artifacts

The export script creates a clean staged repo tree in a separate directory so you can inspect it before running `git init` and pushing it publicly.

## Privacy note

Aside’s branch debug logs can include selected text, the generated first prompt, root and branch URLs, and branch status details. Review logs before sharing them in issues or public discussions.

## License

MIT. See [LICENSE](./LICENSE).
