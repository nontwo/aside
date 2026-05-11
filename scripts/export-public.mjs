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

async function copyEntry(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(targetDir, relativePath);
  await fs.cp(source, destination, {
    recursive: true,
    filter: (copiedPath) => !skipNames.has(path.basename(copiedPath))
  });
}

await fs.rm(targetDir, { recursive: true, force: true });
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
