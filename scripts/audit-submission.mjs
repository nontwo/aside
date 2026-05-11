import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const submissionDir = path.resolve(process.argv[2] ?? path.join(root, 'course-submission'));
const forbiddenFileNames = new Set(['.DS_Store']);
const ignoredDirNames = new Set(['node_modules', '.git']);
const forbiddenPatterns = [
  { label: 'personal macOS absolute path', pattern: /\/Users\// },
  { label: 'private environment file reference', pattern: /\.env(?:\.|$)/ },
  { label: 'copied branch debug log', pattern: /ChatGPT Side Branches Debug Log/i },
  { label: 'old reference folder', pattern: /tangent-reference/i },
  { label: 'old reference branding', pattern: /Tangent/ },
  { label: 'real profile debug flag', pattern: /USE_REAL_PROFILE/ },
  { label: 'maintainer debug script', pattern: /inspect-chatgpt|remote-chatgpt-debug/ }
];

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, findings = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(submissionDir, fullPath);

    if (forbiddenFileNames.has(entry.name)) {
      findings.push({ path: relativePath, reason: 'forbidden local artifact' });
      continue;
    }

    if (entry.isDirectory()) {
      if (!ignoredDirNames.has(entry.name)) {
        await walk(fullPath, findings);
      }
      continue;
    }

    let content;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(content)) {
        findings.push({ path: relativePath, reason: label });
      }
    }
  }

  return findings;
}

if (!(await pathExists(submissionDir))) {
  console.error(`Submission folder does not exist: ${submissionDir}`);
  process.exit(1);
}

const findings = await walk(submissionDir);

if (findings.length) {
  console.error(`Submission audit failed for ${submissionDir}`);
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${finding.reason}`);
  }
  process.exit(1);
}

console.log(`Submission audit passed for ${submissionDir}`);
