# Submission Checklist

Project title: Follow the Sentence, Not the Thread: Aside

Public URL:

```text
https://nontwo.github.io/aside/
```

Submission folder:

```text
course-submission/
```

Required materials:

- Web app: `course-submission/index.html`
- Report: `course-submission/report/report.html`
- Report source: `course-submission/report/report.md`
- Replication package: `course-submission/replication/README.md`
- Synthetic data: `course-submission/data/sample_conversations.jsonl`
- Extension artifact: `course-submission/extension/dist`
- Extension artifact notes: `course-submission/extension/README.md`

Before submission:

```bash
npm test
npx tsc --noEmit
npm run build
npm run audit:public
npm run build:submission
npm run audit:submission
npm run smoke:submission
```

Privacy check:

- Synthetic data only
- No private ChatGPT logs
- No local machine paths
- No `.DS_Store` files
- No API keys or environment files
