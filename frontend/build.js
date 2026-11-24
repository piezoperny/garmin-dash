/**
 * frontend/build.js
 * Deterministic static build script compiling frontend/ into ../dist/ for GitHub Pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const assetsDir = path.join(distDir, 'assets');
const chartsOutDir = path.join(assetsDir, 'charts');

fs.mkdirSync(chartsOutDir, { recursive: true });

// Load optional esbuild for ESM minification (fallback to copy in isolated builds)
let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

async function copyOrMinifyJs(srcPath, destPath) {
  if (!esbuild) {
    fs.copyFileSync(srcPath, destPath);
    return;
  }
  const source = fs.readFileSync(srcPath, 'utf8');
  const result = await esbuild.transform(source, {
    loader: 'js',
    format: 'esm',
    minify: true,
    target: 'es2020'
  });
  fs.writeFileSync(destPath, result.code, 'utf8');
}

// 1. Transform index.html entry script and stylesheet links to assets/
const indexSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const indexDist = indexSrc
  .replace('./src/main.js', './assets/main.js')
  .replace('./src/styles/style.css', './assets/style.css')
  .replace('../public/icon.svg', './icon.svg');
fs.writeFileSync(path.join(distDir, 'index.html'), indexDist, 'utf8');

// 2. Compile stylesheet via Tailwind CLI when available (fallback to copy in isolated builds)
const styleSrc = path.join(__dirname, 'src', 'styles', 'style.css');
const styleOut = path.join(assetsDir, 'style.css');
const tailwindBin = path.join(__dirname, 'node_modules', '.bin', 'tailwindcss');
if (fs.existsSync(tailwindBin)) {
  execFileSync(
    tailwindBin,
    ['-i', styleSrc, '-o', styleOut, '--minify'],
    { cwd: __dirname, stdio: 'pipe' }
  );
} else {
  fs.copyFileSync(styleSrc, styleOut);
}

// 3. Minify (or copy) core ES modules
const coreModules = ['main.js', 'crypto.js', 'crypto_worker.js', 'shard_cache.js', 'session.js'];
for (const file of coreModules) {
  const srcPath = path.join(__dirname, 'src', file);
  if (fs.existsSync(srcPath)) {
    await copyOrMinifyJs(srcPath, path.join(assetsDir, file));
  }
}

// 4. Minify (or copy) chart modules
const chartsSrcDir = path.join(__dirname, 'src', 'charts');
for (const file of fs.readdirSync(chartsSrcDir).filter((f) => f.endsWith('.js'))) {
  await copyOrMinifyJs(
    path.join(chartsSrcDir, file),
    path.join(chartsOutDir, file)
  );
}

// 5. Copy icon, encrypted payload, and sharded streams if present in public/
const publicIcon = path.join(rootDir, 'public', 'icon.svg');
if (fs.existsSync(publicIcon)) {
  fs.copyFileSync(publicIcon, path.join(distDir, 'icon.svg'));
}
const publicEnc = path.join(rootDir, 'public', 'data.enc');
if (fs.existsSync(publicEnc)) {
  fs.copyFileSync(publicEnc, path.join(distDir, 'data.enc'));
}
const publicStreamsDir = path.join(rootDir, 'public', 'streams');
if (fs.existsSync(publicStreamsDir)) {
  const distStreamsDir = path.join(distDir, 'streams');
  fs.mkdirSync(distStreamsDir, { recursive: true });
  for (const file of fs.readdirSync(publicStreamsDir)) {
    if (file.endsWith('.enc') || file.endsWith('.pack')) {
      fs.copyFileSync(path.join(publicStreamsDir, file), path.join(distStreamsDir, file));
    }
  }
}

console.log('Static frontend built successfully to dist/');
