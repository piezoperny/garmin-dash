/**
 * tests/test_m1_aspect_ratio.js
 *
 * Verification suite for Milestone 1:
 * 1. Aspect Ratio Fix in Card 2:
 *    - Power zone empty notice mounts inside canvas.parentElement or cardEl without increasing card height.
 * 2. Canvas Bitmap Aspect Ratio Synchronization:
 *    - Chart._setupCanvasDPI sets canvas.style.width and canvas.style.height matching measured pixels.
 * 3. Chart Container ResizeObserver:
 *    - Instantiated on container, triggers render on resize, cleaned up on destroy().
 * 4. Donut Chart Circular Geometry:
 *    - Heart rate zone chart canvas has 1:1 buffer-to-CSS scaling ensuring true circular arc rendering.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock DOM elements
class MockStyle {
  constructor() {
    this.width = '';
    this.height = '';
    this.display = '';
  }
}

class MockElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.style = new MockStyle();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this._rect = { width: 250, height: 260 };
  }

  setRect(width, height) {
    this._rect = { width, height };
  }

  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      width: this._rect.width,
      height: this._rect.height,
      right: this._rect.width,
      bottom: this._rect.height
    };
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child.parentNode = null;
    }
    return child;
  }
}

class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
  }
  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc(...args) { this.calls.push({ type: 'arc', args }); }
  rect() {}
  roundRect() {}
  fill() {}
  stroke() {}
  resetTransform() {}
  scale(sx, sy) { this.calls.push({ type: 'scale', sx, sy }); }
  measureText(str) { return { width: String(str).length * 6 }; }
  fillText(...args) { this.calls.push({ type: 'fillText', args }); }
}

class MockCanvas extends MockElement {
  constructor(id, width = 250, height = 260) {
    super('canvas', id);
    this.width = width;
    this.height = height;
    this.ctx = new MockContext2D(this);
    this.listeners = new Map();
  }

  getContext(type) {
    if (type === '2d') return this.ctx;
    return null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    if (!this.listeners.has(type)) return;
    const list = this.listeners.get(type);
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }
}

// Global ResizeObserver mock
let observedElements = [];
let disconnected = false;
class MockResizeObserver {
  constructor(cb) {
    this.callback = cb;
    disconnected = false;
  }
  observe(el) {
    observedElements.push(el);
  }
  unobserve(el) {
    observedElements = observedElements.filter(e => e !== el);
  }
  disconnect() {
    observedElements = [];
    disconnected = true;
  }
}

async function runM1Verification() {
  console.log('=== Running Milestone 1 Aspect Ratio & DPI Sync Verification ===\n');

  // Setup DOM environment
  const elements = new Map();
  global.ResizeObserver = MockResizeObserver;
  global.window = {
    devicePixelRatio: 2,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  global.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => new MockElement(tag)
  };

  const { Chart } = await import('../frontend/src/charts/chart_engine.js');
  const physiologicalModule = await import('../frontend/src/charts/physiological.js');

  // 1. Verify Chart DPI and style synchronization
  console.log('Test 1: Verify Chart._setupCanvasDPI synchronizes canvas.style.width and height');
  const container = new MockElement('div', 'container-1');
  container.setRect(280, 260);
  const canvas = new MockCanvas('test-canvas');
  container.appendChild(canvas);
  elements.set('test-canvas', canvas);

  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels: ['A'], datasets: [{ data: [10] }] }
  });

  assert.strictEqual(canvas.style.width, '280px', 'canvas.style.width must match container width');
  assert.strictEqual(canvas.style.height, '260px', 'canvas.style.height must match container height');
  assert.strictEqual(canvas.width, 560, 'canvas.width must equal width * dpr (280 * 2 = 560)');
  assert.strictEqual(canvas.height, 520, 'canvas.height must equal height * dpr (260 * 2 = 520)');
  console.log('  ✓ Chart._setupCanvasDPI sets style.width and style.height matching container');

  // 2. Verify ResizeObserver
  console.log('Test 2: Verify ResizeObserver attachment and cleanup');
  assert.ok(observedElements.includes(container), 'ResizeObserver must observe canvas.parentElement');
  chart.destroy();
  assert.ok(disconnected, 'ResizeObserver must be disconnected on chart.destroy()');
  console.log('  ✓ ResizeObserver attaches to container and disconnects on destroy()');

  // 3. Verify Power Zone empty state does NOT balloon card height
  console.log('Test 3: Verify Power Zone empty notice is contained without ballooning card height');
  const cardPowerZone = new MockElement('div', 'card-power-zone');
  const powerCanvasContainer = new MockElement('div', 'power-canvas-container');
  powerCanvasContainer.setRect(280, 260);
  const powerCanvas = new MockCanvas('power-zone-chart');
  powerCanvasContainer.appendChild(powerCanvas);
  cardPowerZone.appendChild(powerCanvasContainer);

  elements.set('card-power-zone', cardPowerZone);
  elements.set('power-zone-chart', powerCanvas);

  const rollupWithoutPower = {
    physiological: {
      has_power_data: false,
      power_zones: []
    }
  };

  physiologicalModule.renderPowerZoneChart(rollupWithoutPower);

  const emptyNotice = elements.get('power-zone-empty-notice') || powerCanvasContainer.children.find(c => c.id === 'power-zone-empty-notice');
  assert.ok(emptyNotice, 'power-zone-empty-notice must be created');
  assert.strictEqual(powerCanvas.style.display, 'none', 'Canvas must be hidden when hasRealPower is false');
  
  // Crucial check: cardPowerZone must NOT have emptyNotice as a direct sibling of powerCanvasContainer
  assert.strictEqual(cardPowerZone.children.length, 1, 'card-power-zone must contain only the container (no sibling empty notice bloating height)');
  assert.ok(powerCanvasContainer.children.includes(emptyNotice), 'empty notice must be placed inside canvas.parentElement');
  console.log('  ✓ Power Zone empty notice mounted inside canvas.parentElement without bloating card height');

  // 4. Verify Donut Chart Geometry (Circular arc and 1:1 aspect ratio)
  console.log('Test 4: Verify Donut Chart circular geometry');
  const hrContainer = new MockElement('div', 'hr-container');
  hrContainer.setRect(260, 260);
  const hrCanvas = new MockCanvas('hr-zone-chart');
  hrContainer.appendChild(hrCanvas);
  elements.set('hr-zone-chart', hrCanvas);

  const rollupWithHR = {
    physiological: {
      heart_rate_zones: [
        { zone: 'Z1', seconds: 3600 },
        { zone: 'Z2', seconds: 7200 },
        { zone: 'Z3', seconds: 5400 },
        { zone: 'Z4', seconds: 1800 },
        { zone: 'Z5', seconds: 600 }
      ]
    }
  };

  physiologicalModule.renderHeartRateZoneChart(rollupWithHR);
  assert.strictEqual(hrCanvas.style.width, '260px');
  assert.strictEqual(hrCanvas.style.height, '260px');
  assert.strictEqual(hrCanvas.width, 520);
  assert.strictEqual(hrCanvas.height, 520);

  // Check arc calls
  const arcCalls = hrCanvas.ctx.calls.filter(c => c.type === 'arc');
  assert.ok(arcCalls.length >= 5, 'Doughnut chart must draw circular arcs for each zone');
  for (const arc of arcCalls) {
    // args: [centerX, centerY, radius, startAngle, endAngle, counterclockwise]
    const [centerX, centerY, radius] = arc.args;
    assert.strictEqual(centerX, 130, 'Circle center X must be displayWidth / 2 = 130');
    assert.ok(radius > 0, 'Radius must be positive');
  }
  console.log('  ✓ Donut chart maintains 1:1 circular geometry');

  // 5. Verify index.html contains all 12 root IDs and container constraints
  console.log('Test 5: Verify index.html root IDs and layout classes');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const required12IDs = [
    'passphrase-modal',
    'dashboard-main',
    'weekly-volume-chart',
    'training-load-chart',
    'hr-zone-chart',
    'power-zone-chart',
    'pace-zone-chart',
    'threshold-trends-chart',
    'activities-table-body',
    'activity-drawer',
    'dashboard-content',
    'activity-table'
  ];
  for (const id of required12IDs) {
    assert.ok(indexHtml.includes(`id="${id}"`), `Missing required root ID: ${id}`);
  }
  assert.ok(indexHtml.includes('card-hr-zone'), 'card-hr-zone must be present');
  assert.ok(indexHtml.includes('max-h-[280px]'), 'max-h-[280px] constraint must be present');
  assert.ok(!indexHtml.includes('Section 1:'), 'No Section 1: prefix in index.html');
  assert.ok(!indexHtml.includes('Section 2:'), 'No Section 2: prefix in index.html');
  assert.ok(!indexHtml.includes('Section 3:'), 'No Section 3: prefix in index.html');
  console.log('  ✓ index.html conforms to all 12 root IDs, styling, and prefix constraints');

  console.log('\n=== All Milestone 1 Verification Checks PASSED! ===');
}

runM1Verification().catch(err => {
  console.error(err);
  process.exit(1);
});
