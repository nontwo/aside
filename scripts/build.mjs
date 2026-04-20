import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = resolve(root, 'dist');

async function buildEntry(entry, name, fileName, formats = ['iife']) {
  await build({
    configFile: false,
    root,
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
}

await rm(dist, { recursive: true, force: true });
await buildEntry('src/content/root.ts', 'AsideRootContent', 'assets/root-content.js');
await buildEntry('src/background/index.ts', 'AsideBackground', 'assets/background.js', ['es']);
await copyManifest();
