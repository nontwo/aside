import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? process.cwd());
const ignoredDirNames = new Set(['.git', 'node_modules', 'dist', 'coverage', '.local']);
const auditScriptRelativePaths = new Set([
  path.join('scripts', 'audit-public.mjs'),
  path.join('scripts', 'audit-submission.mjs')
]);
const forbiddenFileNames = new Set([
  '.DS_Store',
  'inspect-chatgpt.mjs',
  'remote-chatgpt-debug.mjs',
  'rules.json',
  'sidepanel.html'
]);
const forbiddenPathParts = ['tangent-reference'];
const forbiddenPatterns = [
  { label: 'legacy Tangent branding', pattern: /Tangent/ },
  { label: 'legacy Tangent reference folder', pattern: /tangent-reference/ },
  { label: 'personal macOS absolute path', pattern: /\/Users\// },
  { label: 'real-profile maintainer flag', pattern: /USE_REAL_PROFILE/ },
  { label: 'legacy store id', pattern: /dhacmfmpmgedcagknopapipcgcfcpaae/ },
  { label: 'legacy Tangent store url', pattern: /chromewebstore\.google\.com\/detail\/tangent/i }
];

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, results = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath);

    if (forbiddenPathParts.some((segment) => relativePath.split(path.sep).includes(segment))) {
      results.push({
        type: 'path',
        path: relativePath,
        reason: 'forbidden reference material'
      });
      continue;
    }

    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name)) {
        continue;
      }
      await walk(fullPath, results);
      continue;
    }

    if (forbiddenFileNames.has(entry.name)) {
      results.push({
        type: 'path',
        path: relativePath,
        reason: 'forbidden publish artifact'
      });
      continue;
    }

    let content;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    if (auditScriptRelativePaths.has(relativePath)) {
      continue;
    }

    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(content)) {
        results.push({
          type: 'content',
          path: relativePath,
          reason: label
        });
      }
    }
  }

  return results;
}

if (!(await pathExists(root))) {
  console.error(`Audit target does not exist: ${root}`);
  process.exit(1);
}

const findings = await walk(root);

if (findings.length) {
  console.error(`Public audit failed for ${root}`);
  findings.forEach((finding) => {
    console.error(`- ${finding.path}: ${finding.reason}`);
  });
  process.exit(1);
}

console.log(`Public audit passed for ${root}`);
