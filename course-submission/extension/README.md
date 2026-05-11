# Aside Extension Artifact

This folder preserves the original Aside browser extension for the course submission.

The extension source remains at the repository root. Running `npm run build:submission` copies the current extension build into this folder as:

```text
course-submission/extension/dist
```

## Install for manual inspection

1. Run `npm install`.
2. Run `npm run build:submission`.
3. Open `chrome://extensions/`.
4. Enable Developer Mode.
5. Choose "Load unpacked".
6. Select `course-submission/extension/dist`.
7. Open `https://chatgpt.com/`, select text in an assistant answer, and try Aside's selection actions.

The public course demo does not require this extension to run. The static app in `course-submission/index.html` reproduces the text-processing workflow with synthetic data.
