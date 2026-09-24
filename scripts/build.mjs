import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');

// A non-sensitive identifier for this bundle: short commit, a dirty marker when
// the tree has uncommitted changes, and the build time. Shown in the panel's
// diagnostic log and the library page so an installed build can be matched to
// the PR it came from. Falls back cleanly outside a git checkout.
function computeBuildId() {
  let sha = 'nogit';
  let dirty = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const status = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    dirty = status ? '-dirty' : '';
  } catch {
    // Not a git checkout.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  return `${sha}${dirty}+${stamp}`;
}

const BUILD_ID = process.env.ASIDE_BUILD_ID || computeBuildId();

async function buildEntry(entry, name, fileName, formats = ['iife']) {
  await build({
    configFile: false,
    root,
    define: {
      __ASIDE_BUILD__: JSON.stringify(BUILD_ID)
    },
    build: {
      target: 'es2022',
      outDir: dist,
      emptyOutDir: false,
      lib: {
        entry: resolve(root, entry),
        name,
        formats,
        fileName: () => fileName
      }
    }
  });
}

async function copyManifest() {
  await cp(resolve(root, 'public/manifest.json'), resolve(dist, 'manifest.json'));
  // The library is an extension-owned page: local resources only, no inline
  // script, so it complies with the default extension CSP.
  await cp(resolve(root, 'public/library.html'), resolve(dist, 'library.html'));
  // The toolbar popup: active temporary handoffs only. Same CSP rules.
  await cp(resolve(root, 'public/popup.html'), resolve(dist, 'popup.html'));
}

await rm(dist, { recursive: true, force: true });
await buildEntry('src/content/root.ts', 'AsideRootContent', 'assets/root-content.js');
await buildEntry('src/background/index.ts', 'AsideBackground', 'assets/background.js', ['es']);
await buildEntry('src/ui/library.ts', 'AsideLibrary', 'assets/library.js');
await buildEntry('src/ui/popup.ts', 'AsidePopup', 'assets/popup.js');
await copyManifest();
console.log(`[aside] build id ${BUILD_ID}`);
