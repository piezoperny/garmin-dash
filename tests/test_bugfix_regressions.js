import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Minimal DOM & Canvas mock
function makeMockCtx() {
  const texts = [];
  return {
    texts,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    scale() {},
    resetTransform() {},
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    arc() {},
    rect() {},
    roundRect() {},
    clip() {},
    fill() {},
    stroke() {},
    setLineDash() {},
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(t) { return { width: String(t || '').length * 6 }; },
    fillText(text, x, y) { texts.push({ text: String(text), x, y }); }
  };
}

const ctx = makeMockCtx();
const mockCanvas = {
  width: 600,
  height: 300,
  clientWidth: 600,
  clientHeight: 300,
  style: {},
  parentElement: { getBoundingClientRect: () => ({ width: 600, height: 300 }) },
  getBoundingClientRect: () => ({ width: 600, height: 300 }),
  getContext: () => ctx,
  addEventListener() {},
  removeEventListener() {}
};

globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { style: {} }
};

const { Chart } = await import(path.join(rootDir, 'frontend/src/charts/chart_engine.js'));

// 1. Test non-zero RHR Y-axis scaling & integer ticks
ctx.texts.length = 0;
new Chart(mockCanvas, {
  type: 'line',
  data: {
    labels: ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'],
    datasets: [{ label: 'Daily RHR (bpm)', data: [48, 51, 51, 51, 55, 48, 48], borderColor: '#f43f5e' }]
  },
  options: {
    scales: {
      y: { beginAtZero: false, min: 45, max: 58, integerTicks: true }
    }
  }
});
const tickStrings = ctx.texts.map(t => t.text);
assert.ok(!tickStrings.includes('0.0') && !tickStrings.includes('0'), `RHR Y-axis must not start at 0: ${tickStrings.join(', ')}`);
assert.ok(tickStrings.includes('45') && tickStrings.includes('58'), `RHR Y-axis should include tight bounds 45..58: ${tickStrings.join(', ')}`);
console.log('✓ JS-REG-01: RHR non-zero Y-axis & integer ticks verified');

// 2. Test gap-aware line chart (nulls do not plot 0)
ctx.texts.length = 0;
const gapChart = new Chart(mockCanvas, {
  type: 'line',
  data: {
    labels: ['2026-11-20', '2026-11-21', '2026-11-22'],
    datasets: [{ label: 'HRV', data: [103, null, 98], borderColor: '#10b981' }]
  },
  options: { scales: { y: { beginAtZero: false, integerTicks: true } } }
});
assert.equal(gapChart.dataPoints.length, 2, 'Null point must not generate a plotted dataPoint');
assert.deepEqual(gapChart.dataPoints.map(p => p.val), [103, 98]);
console.log('✓ JS-REG-02: Gap-aware line chart skips null points cleanly');

// 3. Test dist/index.html layout contracts (centered activity modal, scrollable customize modal, pagination bar)
const distHtml = fs.readFileSync(path.join(rootDir, 'dist/index.html'), 'utf-8');
assert.ok(distHtml.includes('id="customize-modal"') && distHtml.includes('max-h-[90vh]'), 'Customize modal must be viewport-safe (max-h-[90vh])');
assert.ok(distHtml.includes('id="activity-drawer" class="fixed inset-0 z-50 flex items-center justify-center'), 'Activity detail must be centered modal, not right-aligned drawer');
assert.ok(!distHtml.includes('id="activity-drawer" class="fixed inset-0 z-50 flex items-center justify-end'), 'Right-aligned drawer class must be removed');
assert.ok(distHtml.includes('id="activity-pagination-bar"') && distHtml.includes('id="activity-page-prev"') && distHtml.includes('id="activity-page-next"') && distHtml.includes('id="activity-page-size"'), 'Pagination controls must exist in dist/index.html');
console.log('✓ JS-REG-03: dist/index.html modal centering, viewport clamping, & pagination bar verified');

console.log('\nALL JS BUGFIX REGRESSION TESTS PASSED.');
