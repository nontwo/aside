# Follow the Sentence, Not the Thread: Aside

## Abstract

Aside is an app project for reading and interrogating long AI-generated answers. The app addresses a common problem in AI-assisted work: when a user wants to ask a follow-up about one small passage inside a long response, the next prompt often inherits too much surrounding conversation and loses the local focus. Aside treats the selected passage as text data. It anchors the passage inside the source answer, extracts a local context window, scores salient terms, and generates a branch prompt that contains only the selected passage and the enclosing source answer. The public demo, titled "Follow the Sentence, Not the Thread," shows these steps through an interactive branch simulator, while the preserved browser extension applies the same idea directly on ChatGPT.

## Motivation

Long AI conversations are useful but difficult to navigate. A single answer may contain definitions, comparisons, caveats, citations, examples, and action items. When the user wants to ask "why this sentence?" or "explain this part," a normal follow-up prompt can be ambiguous. The model may rely on the entire conversation history instead of the passage the user intended.

Aside reframes the problem as one of local text selection and context construction. The user marks a passage, the system identifies its source answer, and the app builds a focused prompt around that local evidence. This makes follow-up questions more reproducible because the branch input is visible and bounded.

## Data

The demo uses a small synthetic dataset of long assistant-style answers. The examples cover software documentation, public meeting summaries, and scientific abstracts. They were written for demonstration and do not contain private chat logs, copied course material, or personal data. Each record contains:

- `id`: stable sample identifier
- `title`: display label
- `topic`: broad text domain
- `user_question`: original prompt context
- `assistant_answer`: long answer used for selection and analysis

The preserved extension can operate on real ChatGPT pages, but the course replication package uses only the synthetic data for privacy and reproducibility.

## Methods

The app demonstrates four text-as-data operations.

First, it segments the source answer into sentences. Sentence segmentation gives the interface a stable unit for click selection and context-window construction.

Second, it anchors the selected passage inside the enclosing answer. In the demo, users can click a sentence or drag across text. In the extension, the same idea is implemented with stored selected text, nearby range quotes, and the touched assistant answer block.

Third, it builds a local context window around the selected sentence. The demo uses one sentence before and after the selected anchor. This keeps the branch prompt compact while retaining enough surrounding text to disambiguate references.

Fourth, it scores terms from the selected passage. The demo tokenizes text, removes common stopwords, and ranks terms by frequency. This is intentionally simple, but it makes the selected passage legible as data: the reader can see what vocabulary is driving the local branch.

## App Design

The public site is a static browser app. It does not require a server, database, API key, or user account. The user chooses a synthetic sample answer, selects a passage, and sees:

- the selected passage
- token, sentence, and context-window counts
- high-signal terms
- the local context window
- the generated branch prompt
- a method trace that explains the anchor, window bounds, term signal, and prompt sections
- simulated Ask, Why, and New-tab branch cards that show how multiple local branches can be staged from the same source answer

The preserved extension implements the applied workflow on ChatGPT. It adds selection actions such as Ask, Why, and New-tab, then builds a local-only first prompt from the selected passage and the touched source answer. The extension is included as an artifact so the course submission contains both a public demonstration and the original working project.

## AI Assistance

AI assistance was used throughout development as a programming partner. It helped inspect the assignment requirements, design the submission structure, write the static demo, generate documentation drafts, and build audit scripts. Human judgment was used to choose the project framing, decide what data could be safely included, and keep the submission independent of private user conversations.

## Limitations

The demo intentionally uses simple sentence splitting and term frequency scoring. This makes the method transparent, but it is not a complete natural language processing pipeline. A production version could add stronger sentence boundary detection, embedding-based passage matching, semantic search, and model evaluation.

The extension depends on ChatGPT page structure, which can change. The submission therefore separates the reproducible static demo from the browser extension artifact. The static app demonstrates the text-as-data logic without requiring live ChatGPT access.

## Replication

The project can be reproduced with Node.js. From the repository root:

```bash
npm install
npm test
npx tsc --noEmit
npm run build
npm run build:submission
npm run audit:submission
```

The public app is in `course-submission/index.html`. The report is in `course-submission/report/report.html`. The synthetic data is in `course-submission/data/sample_conversations.jsonl`. The preserved extension artifact is in `course-submission/extension/`.

## Conclusion

Aside contributes an app-level workflow for making long AI answers more navigable and more auditable. Its central idea is small but practical: treat the selected passage as the primary text data object, preserve its local source context, and make the resulting branch prompt visible. That workflow supports more focused follow-up questions while reducing accidental dependence on unrelated conversation history.
