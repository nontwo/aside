import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const sourceDir = path.join(root, 'course-submission');
const packageDir = path.resolve(process.argv[2] ?? '/tmp/aside-course-submission');

const packageRelativeToRoot = path.relative(root, packageDir);
if (
  packageRelativeToRoot === '' ||
  (!packageRelativeToRoot.startsWith('..') && !path.isAbsolute(packageRelativeToRoot)) ||
  !path.relative(packageDir, root).startsWith('..') ||
  path.dirname(packageDir) === packageDir
) {
  // This path is deleted before it is written, so never let it resolve onto the repo.
  console.error(`Refusing to package into ${packageDir}. Choose a path outside ${root}.`);
  process.exit(1);
}

function run(scriptName) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', scriptName)], {
    cwd: root,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await fs.rm(packageDir, { recursive: true, force: true });

run('build-submission.mjs');
run('audit-submission.mjs');

await fs.mkdir(path.dirname(packageDir), { recursive: true });
await fs.cp(sourceDir, packageDir, {
  recursive: true,
  filter: (source) => path.basename(source) !== '.DS_Store'
});

console.log(`Submission package folder created at ${packageDir}`);
console.log('Pass a path argument if you want the package somewhere else.');
