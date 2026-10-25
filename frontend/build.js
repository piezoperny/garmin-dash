/**
 * frontend/build.js
 * Deterministic static build script compiling frontend/ into ../dist/ for GitHub Pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const assetsDir = path.join(distDir, 'assets');
const chartsOutDir = path.join(assetsDir, 'charts');

fs.mkdirSync(chartsOutDir, { recursive: true });

// 1. Transform index.html entry script from ./src/main.js -> ./assets/main.js
const indexSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const indexDist = indexSrc.replace('./src/main.js', './assets/main.js');
fs.writeFileSync(path.join(distDir, 'index.html'), indexDist, 'utf8');

// 2. Copy core ES modules
for (const file of ['main.js', 'crypto.js', 'session.js']) {
  fs.copyFileSync(
    path.join(__dirname, 'src', file),
    path.join(assetsDir, file)
  );
}

// 3. Copy chart modules
for (const file of ['chart_engine.js', 'endurance.js', 'physiological.js', 'activities.js']) {
  fs.copyFileSync(
    path.join(__dirname, 'src', 'charts', file),
    path.join(chartsOutDir, file)
  );
}

// 4. Copy stylesheet
fs.copyFileSync(
  path.join(__dirname, 'src', 'styles', 'style.css'),
  path.join(assetsDir, 'style.css')
);

// 5. Copy encrypted payload if present in public/data.enc
const publicEnc = path.join(rootDir, 'public', 'data.enc');
if (fs.existsSync(publicEnc)) {
  fs.copyFileSync(publicEnc, path.join(distDir, 'data.enc'));
}

console.log('Static frontend built successfully to dist/');
