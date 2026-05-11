const STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'but',
  'by',
  'can',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'over',
  'so',
  'that',
  'the',
  'their',
  'this',
  'to',
  'use',
  'with',
  'within',
  'without',
  'you',
  'your'
]);

const FALLBACK_DATA = [
  {
    id: 'editor-frameworks',
    title: 'Rich-text editor framework comparison',
    topic: 'Software documentation and product positioning',
    user_question: 'Which editor framework fits a research annotation tool?',
    expected_focus: 'schema control, collaboration features, and development speed',
    sample_followups: {
      ask: 'A focused branch would compare implementation speed against long-term schema control.',
      why: 'This matters because editor choice changes what kinds of annotations the project can represent later.',
      new_tab: 'The selected passage can be staged in a separate window so the main comparison remains readable.'
    },
    assistant_answer:
      'A team choosing a rich-text editor has to balance flexibility, implementation speed, and collaboration needs. A low-level editor engine gives developers more control over document structure, custom nodes, and rendering behavior. That control is valuable for research annotation because the data model can represent overlapping notes, quote anchors, and review states. The tradeoff is that the team must build more product behavior itself. A batteries-included editor kit usually ships with comments, suggestions, slash commands, and import or export tools. That makes the first version faster to launch, but the app may inherit assumptions about document layout or collaboration workflows. In this case, the strongest choice depends on whether the project values full control over annotation data or quick delivery of a polished writing surface. If the goal is a semester prototype, a higher-level React editor kit is probably the pragmatic choice. If the goal is a long-running research platform, the lower-level engine may be safer because it keeps the schema and analysis pipeline under the team ownership.'
  },
  {
    id: 'public-meeting',
    title: 'Public meeting summary',
    topic: 'Civic text analysis and agenda tracking',
    user_question: 'What issues dominated the public comments?',
    expected_focus: 'housing, transit reliability, and everyday infrastructure',
    sample_followups: {
      ask: 'A focused branch would connect the chosen comment to the larger theme of predictability.',
      why: 'This matters because repeated local complaints reveal shared policy expectations.',
      new_tab: 'A separate branch can preserve the public comment source while testing alternative summaries.'
    },
    assistant_answer:
      'The public comments focused on three recurring concerns. First, residents repeatedly described housing affordability as a pressure that shapes daily life, especially for renters and younger families. Speakers connected rising rents to school enrollment, commute length, and whether long-term residents can remain in the neighborhood. Second, several comments raised worries about transit reliability. The complaints were not only about delays, but also about the difficulty of planning childcare, medical appointments, and hourly work schedules around inconsistent service. Third, participants discussed public space maintenance. These comments mentioned lighting, sidewalk repairs, trash pickup, and tree care as small but visible signals of whether city agencies are paying attention. The comments did not all point to the same policy solution. However, the language shows a shared demand for predictability: predictable housing costs, predictable transportation, and predictable maintenance of everyday infrastructure.'
  },
  {
    id: 'scientific-abstract',
    title: 'Scientific abstract explanation',
    topic: 'Research-paper reading support',
    user_question: 'What should a non-specialist take from this abstract?',
    expected_focus: 'classification performance, class-level errors, and human review',
    sample_followups: {
      ask: 'A focused branch would unpack why aggregate accuracy can hide important classification failures.',
      why: 'This matters because rare categories are often the cases researchers care about most.',
      new_tab: 'The branch can isolate one methodological warning without disturbing the abstract summary.'
    },
    assistant_answer:
      'The study evaluates whether short text passages can be classified into policy-relevant categories using a combination of embeddings and supervised learning. The authors begin by creating a labeled sample of documents, where each passage is assigned to one or more substantive themes. They then compare several representations of the text, including sparse term features and dense sentence embeddings. The main result is that embeddings improve recall for categories with varied vocabulary, while simpler term features remain competitive for categories with stable keywords. The practical implication is that text classification systems should not be judged only by aggregate accuracy. A method that performs well overall can still miss rare but important categories. For applied work, the authors recommend reporting class-level performance, inspecting errors manually, and using human review for high-stakes cases.'
  }
];

const ACTION_LABELS = {
  ask: 'Ask',
  why: 'Why',
  new_tab: 'New-tab'
};

let samples = [];
let activeSample = null;
let selectedSentenceIndex = 0;
let selectedText = '';
let branchKind = 'persistent';
let branchCounter = 0;
let branches = [];
let lastAnalysis = null;

const els = {
  datasetSelect: document.querySelector('#datasetSelect'),
  sourceTitle: document.querySelector('#sourceTitle'),
  sourceMeta: document.querySelector('#sourceMeta'),
  sourceText: document.querySelector('#sourceText'),
  resetSelection: document.querySelector('#resetSelection'),
  selectedPassage: document.querySelector('#selectedPassage'),
  selectionBadge: document.querySelector('#selectionBadge'),
  tokenCount: document.querySelector('#tokenCount'),
  sentenceCount: document.querySelector('#sentenceCount'),
  contextCount: document.querySelector('#contextCount'),
  keywordList: document.querySelector('#keywordList'),
  contextWindow: document.querySelector('#contextWindow'),
  methodTrace: document.querySelector('#methodTrace'),
  persistentKind: document.querySelector('#persistentKind'),
  temporaryKind: document.querySelector('#temporaryKind'),
  questionInput: document.querySelector('#questionInput'),
  askAction: document.querySelector('#askAction'),
  whyAction: document.querySelector('#whyAction'),
  newTabAction: document.querySelector('#newTabAction'),
  promptOutput: document.querySelector('#promptOutput'),
  branchCards: document.querySelector('#branchCards'),
  branchCount: document.querySelector('#branchCount'),
  branchSummary: document.querySelector('#branchSummary')
};

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

function tokenize(text) {
  return text
    .toLowerCase()
    .match(/[a-z][a-z-]{2,}/g)
    ?.filter((token) => !STOPWORDS.has(token)) ?? [];
}

function topTerms(text, limit = 8) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function contextFor(sentences, index, radius = 1) {
  const start = Math.max(0, index - radius);
  const end = Math.min(sentences.length, index + radius + 1);
  return {
    sentences: sentences.slice(start, end),
    start,
    end
  };
}

function getQuestion(action) {
  if (action === 'why') {
    return 'Why?';
  }
  return els.questionInput.value.trim() || 'Why does this passage matter?';
}

function modeLine(action) {
  if (action === 'new_tab') {
    return 'New-tab opens the local context in a separate ChatGPT window before the user asks a follow-up.';
  }
  if (branchKind === 'temporary') {
    return 'Temporary branch mode allows an ephemeral follow-up session.';
  }
  return 'Persistent branch mode requires a saved conversation URL.';
}

function buildPrompt(action = 'ask') {
  return [
    'Before your answer, output exactly one line in this format:',
    '[[BRANCH_TITLE: concise lower-case title]]',
    'Use at most 7 words for the title.',
    'Use only this local context; if needed context is missing, say so briefly.',
    '',
    'SELECTED PASSAGE',
    selectedText,
    '',
    'LOCAL SOURCE ANSWER 1',
    activeSample.assistant_answer,
    '',
    'BRANCH MODE',
    modeLine(action),
    '',
    'USER QUESTION',
    getQuestion(action)
  ].join('\n');
}

function analysisSnapshot() {
  const sentences = splitSentences(activeSample.assistant_answer);
  const context = contextFor(sentences, selectedSentenceIndex);
  const terms = topTerms(selectedText);
  const tokens = tokenize(selectedText);

  return {
    sentences,
    context,
    terms,
    tokens,
    promptSections: ['title contract', 'selected passage', 'local source answer', 'branch mode', 'user question']
  };
}

function updateKindButtons() {
  els.persistentKind.classList.toggle('active', branchKind === 'persistent');
  els.temporaryKind.classList.toggle('active', branchKind === 'temporary');
}

function selectSentence(index) {
  const sentences = splitSentences(activeSample.assistant_answer);
  selectedSentenceIndex = Math.max(0, Math.min(index, sentences.length - 1));
  selectedText = sentences[selectedSentenceIndex] ?? '';
  updateAnalysis();
}

function selectCustomText(text) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length < 8) {
    return;
  }

  const sentences = splitSentences(activeSample.assistant_answer);
  const lower = trimmed.toLowerCase();
  const matchedIndex = sentences.findIndex((sentence) =>
    sentence.toLowerCase().includes(lower.slice(0, Math.min(40, lower.length)))
  );

  selectedSentenceIndex = matchedIndex >= 0 ? matchedIndex : selectedSentenceIndex;
  selectedText = trimmed;
  updateAnalysis();
}

function renderSource() {
  const sentences = splitSentences(activeSample.assistant_answer);
  els.sourceTitle.textContent = activeSample.title;
  els.sourceMeta.textContent = `${activeSample.topic} | ${sentences.length} sentences`;
  els.sourceText.innerHTML = '';

  sentences.forEach((sentence, index) => {
    const span = document.createElement('span');
    span.className = 'sentence';
    span.dataset.index = String(index);
    span.textContent = sentence;
    span.addEventListener('click', () => selectSentence(index));
    els.sourceText.append(span, ' ');
  });
}

function renderTerms(terms) {
  els.keywordList.innerHTML = '';
  if (!terms.length) {
    const empty = document.createElement('span');
    empty.textContent = 'no terms yet';
    els.keywordList.append(empty);
    return;
  }

  for (const [term, count] of terms) {
    const chip = document.createElement('span');
    chip.textContent = `${term} ${count}`;
    els.keywordList.append(chip);
  }
}

function renderMethodTrace(analysis) {
  const topTermText = analysis.terms.map(([term]) => term).slice(0, 5).join(', ') || 'none';
  const items = [
    `Anchor: sentence ${selectedSentenceIndex + 1} of ${analysis.sentences.length}`,
    `Window: sentences ${analysis.context.start + 1}-${analysis.context.end}`,
    `Signal: ${analysis.tokens.length} filtered tokens; top terms are ${topTermText}`,
    `Prompt: ${analysis.promptSections.join(' -> ')}`
  ];

  els.methodTrace.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    els.methodTrace.append(li);
  }
}

function updateAnalysis(action = 'ask') {
  lastAnalysis = analysisSnapshot();

  document.querySelectorAll('.sentence').forEach((sentence) => {
    sentence.classList.toggle(
      'active',
      Number(sentence.dataset.index) === selectedSentenceIndex
    );
  });

  els.selectionBadge.textContent = selectedText ? 'anchored' : 'none';
  els.selectedPassage.textContent = selectedText || 'No passage selected.';
  els.tokenCount.textContent = String(lastAnalysis.tokens.length);
  els.sentenceCount.textContent = String(lastAnalysis.sentences.length);
  els.contextCount.textContent = String(lastAnalysis.context.sentences.length);
  els.contextWindow.textContent = lastAnalysis.context.sentences.join(' ');
  renderTerms(lastAnalysis.terms);
  renderMethodTrace(lastAnalysis);
  els.promptOutput.textContent = buildPrompt(action);
}

function summarizePrompt(prompt) {
  const lines = prompt.split('\n').filter(Boolean);
  return `${lines.length} non-empty lines; selected passage and one local source answer included.`;
}

function simulateResponse(action, analysis) {
  const fallback = activeSample.sample_followups?.[action];
  const terms = analysis.terms.map(([term]) => term).slice(0, 3).join(', ');
  if (fallback) {
    return fallback;
  }

  if (action === 'why') {
    return `This passage matters because it concentrates the local argument around ${terms || 'the selected wording'}.`;
  }
  if (action === 'new_tab') {
    return `The branch is staged with the selected passage and local context, leaving the main text undisturbed.`;
  }
  return `The branch would answer "${getQuestion(action)}" using only the selected passage and its source answer.`;
}

function createBranch(action) {
  updateAnalysis(action);
  branchCounter += 1;
  const prompt = buildPrompt(action);
  const branch = {
    id: branchCounter,
    action,
    kind: action === 'new_tab' ? 'native window' : branchKind,
    question: getQuestion(action),
    selected: selectedText,
    promptSummary: summarizePrompt(prompt),
    response: simulateResponse(action, lastAnalysis),
    focus: activeSample.expected_focus ?? 'local source context',
    terms: lastAnalysis.terms.map(([term]) => term).slice(0, 4)
  };

  branches = [branch, ...branches].slice(0, 6);
  renderBranches();
}

function renderBranches() {
  els.branchCards.innerHTML = '';
  els.branchCount.textContent = String(branches.length);
  els.branchSummary.textContent = branches.length
    ? `${branches.length} simulated branch${branches.length === 1 ? '' : 'es'} staged from local text.`
    : 'No branch has been staged yet.';

  if (!branches.length) {
    return;
  }

  for (const branch of branches) {
    const card = document.createElement('article');
    card.className = 'branch-card';

    const header = document.createElement('header');
    const titleWrap = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = `Branch ${branch.id}: ${ACTION_LABELS[branch.action]}`;
    const meta = document.createElement('div');
    meta.className = 'branch-meta';

    const actionBadge = document.createElement('span');
    actionBadge.className = 'branch-action-label';
    actionBadge.textContent = branch.action === 'new_tab' ? 'side window' : branch.action;

    const kindBadge = document.createElement('span');
    kindBadge.className = 'branch-kind';
    kindBadge.textContent = branch.kind;

    meta.append(actionBadge, kindBadge);
    titleWrap.append(title, meta);
    header.append(titleWrap);

    const selected = document.createElement('p');
    selected.textContent = `Selected: ${branch.selected}`;

    const prompt = document.createElement('p');
    prompt.textContent = `Prompt package: ${branch.promptSummary}`;

    const response = document.createElement('p');
    response.textContent = `Simulated response: ${branch.response}`;

    const focus = document.createElement('p');
    focus.textContent = `Expected focus: ${branch.focus}`;

    const timeline = document.createElement('div');
    timeline.className = 'timeline';
    ['anchored', 'prompted', 'ready'].forEach((step) => {
      const item = document.createElement('span');
      item.className = 'active';
      item.textContent = step;
      timeline.append(item);
    });

    card.append(header, selected, prompt, response, focus, timeline);
    els.branchCards.append(card);
  }
}

function resetBranches() {
  branches = [];
  branchCounter = 0;
  renderBranches();
}

function loadSample(id) {
  activeSample = samples.find((sample) => sample.id === id) ?? samples[0];
  resetBranches();
  renderSource();
  selectSentence(0);
}

async function loadSamples() {
  try {
    const response = await fetch('./data/sample_conversations.jsonl', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`sample data request failed: ${response.status}`);
    }

    const text = await response.text();
    samples = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    samples = FALLBACK_DATA;
  }
}

function bindEvents() {
  els.datasetSelect.addEventListener('change', () => loadSample(els.datasetSelect.value));
  els.resetSelection.addEventListener('click', () => selectSentence(0));
  els.persistentKind.addEventListener('click', () => {
    branchKind = 'persistent';
    updateKindButtons();
    updateAnalysis();
  });
  els.temporaryKind.addEventListener('click', () => {
    branchKind = 'temporary';
    updateKindButtons();
    updateAnalysis();
  });
  els.questionInput.addEventListener('input', () => updateAnalysis());
  els.askAction.addEventListener('click', () => createBranch('ask'));
  els.whyAction.addEventListener('click', () => {
    els.questionInput.value = 'Why?';
    createBranch('why');
  });
  els.newTabAction.addEventListener('click', () => createBranch('new_tab'));
  els.sourceText.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !els.sourceText.contains(selection.anchorNode)) {
      return;
    }
    selectCustomText(selection.toString());
  });
}

async function init() {
  await loadSamples();
  samples.forEach((sample) => {
    const option = document.createElement('option');
    option.value = sample.id;
    option.textContent = sample.title;
    els.datasetSelect.append(option);
  });
  updateKindButtons();
  bindEvents();
  loadSample(samples[0].id);
}

init();
