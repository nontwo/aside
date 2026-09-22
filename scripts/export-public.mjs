import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const targetDir = path.resolve(process.argv[2] ?? path.join(root, '..', 'aside-public'));

const copyEntries = [
  '.gitignore',
  '.github',
  'LICENSE',
  'README.md',
  'course-submission',
  'docs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'public',
  'scripts',
  'src',
  'tests'
];

const skipNames = new Set(['.DS_Store']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The first thing this script does is rm -rf the target, so a mistyped argument such as
// `npm run export:public -- .` would delete the working tree before anything is copied.
function assertSafeTargetDir(target, repoRoot) {
  const relativeToRoot = path.relative(repoRoot, target);
  const insideRepo = relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));

  if (insideRepo) {
    fail(`Refusing to export into the repository itself (${target}). Pass a path outside ${repoRoot}.`);
  }

  if (path.dirname(target) === target) {
    fail(`Refusing to export to a filesystem root (${target}).`);
  }

  if (path.relative(target, repoRoot) && !path.relative(target, repoRoot).startsWith('..')) {
    fail(`Refusing to export to ${target} because it contains the repository at ${repoRoot}.`);
  }
}

async function assertTargetIsReplaceable(target) {
  let entries;
  try {
    entries = await fs.readdir(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  // A previously exported clone legitimately carries its own .git plus regenerable
  // directories the export never publishes; refusing those would break the documented
  // "export, inspect, push" loop.
  const disposableEntries = new Set([
    '.git',
    '.DS_Store',
    'node_modules',
    'dist',
    'coverage',
    '.local'
  ]);
  const unexpected = entries.filter(
    (entry) => !disposableEntries.has(entry) && !copyEntries.includes(entry)
  );
  if (unexpected.length) {
    fail(
      `Refusing to delete ${target}: it holds files this export does not manage (${unexpected
        .slice(0, 5)
        .join(', ')}). Remove it yourself, or choose an empty directory.`
    );
  }
}

async function copyEntry(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(targetDir, relativePath);
  await fs.cp(source, destination, {
    recursive: true,
    filter: (copiedPath) => !skipNames.has(path.basename(copiedPath))
  });
}

assertSafeTargetDir(targetDir, root);
await assertTargetIsReplaceable(targetDir);

// Keep a .git directory in place so an existing public clone keeps its history.
const preservedGitDir = path.join(targetDir, '.git');
const hasPreservedGitDir = await fs
  .access(preservedGitDir)
  .then(() => true)
  .catch(() => false);

for (const relativePath of copyEntries) {
  await fs.rm(path.join(targetDir, relativePath), { recursive: true, force: true });
}

if (!hasPreservedGitDir) {
  await fs.rm(targetDir, { recursive: true, force: true });
}

await fs.mkdir(targetDir, { recursive: true });

for (const relativePath of copyEntries) {
  await copyEntry(relativePath);
}

const auditResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'audit-public.mjs'), targetDir], {
  stdio: 'inherit'
});

if (auditResult.status !== 0) {
  process.exit(auditResult.status ?? 1);
}

console.log(`\nExported clean Aside repo to ${targetDir}`);
console.log('Next steps:');
console.log(`  cd ${targetDir}`);
console.log('  git init');
console.log('  git add .');
console.log('  git commit -m "Initial Aside open source release"');
