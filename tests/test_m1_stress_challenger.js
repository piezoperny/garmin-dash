/**
 * tests/test_m1_stress_challenger.js
 *
 * Empirical Adversarial Challenger Suite for Milestone 1:
 * Stress-testing:
 * 1. Dynamic Power Toggling:
 *    - Rapid switching between power / no-power states (100 cycles)
 *    - Verify no DOM duplication, no memory leak, exact element hierarchy
 *    - Verify canvas display toggle, notice visibility, FTP dynamic changes
 *    - Resizing while hidden, then toggling back on
 *    - Degenerate rollups (null, empty, zeros, explicit false)
 * 2. Repeated Container Resizing:
 *    - Rapid continuous resize across diverse aspect ratios (200 cycles)
 *    - Extreme dimensions: ultrawide, ultra-tall, fractional, zero (0x0 hidden)
 *    - Verify non-negative chart dimensions, no NaN leaks, safe boundary early-returns
 *    - Verify ResizeObserver disconnect on chart.destroy() with zero post-destruction leaks
 * 3. High-DPI (DPR) Scaling:
 *    - Multi-DPR matrix (0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.625, 3.0, 4.0)
 *    - Dynamic DPR switching (simulating window drag between monitors / browser zoom)
 *    - Verify 1:1 buffer-to-CSS aspect ratio with zero compounding transforms
 *    - Verify donut circularity and arc radius consistency across all DPRs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock DOM elements for comprehensive stress testing
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
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
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
    if (child.parentElement) {
      child.parentElement.removeChild(child);
    }
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
    this.currentTransform = { sx: 1, sy: 1, tx: 0, ty: 0 };
    this.font = '10px sans-serif';
    this.fillStyle = '#ffffff';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.textAlign = 'left';
    this.textBaseline = 'middle';
  }

  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc(cx, cy, r, sAngle, eAngle, counterclockwise) {
    this.calls.push({ type: 'arc', args: [cx, cy, r, sAngle, eAngle, counterclockwise] });
  }
  rect() {}
  roundRect() {}
  fill() {}
  stroke() {}
  resetTransform() {
    this.currentTransform = { sx: 1, sy: 1, tx: 0, ty: 0 };
    this.calls.push({ type: 'resetTransform' });
  }
  setTransform(a, b, c, d, e, f) {
    this.currentTransform = { sx: a, sy: d, tx: e, ty: f };
    this.calls.push({ type: 'setTransform', args: [a, b, c, d, e, f] });
  }
  scale(sx, sy) {
    this.currentTransform.sx *= sx;
    this.currentTransform.sy *= sy;
    this.calls.push({ type: 'scale', sx, sy, currentSx: this.currentTransform.sx, currentSy: this.currentTransform.sy });
  }
  measureText(str) {
    return { width: String(str).length * 6 };
  }
  fillText(text, x, y) {
    this.calls.push({ type: 'fillText', text, x, y });
  }
  createLinearGradient() {
    return {
      addColorStop: () => {}
    };
  }
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

// Global ResizeObserver mock supporting triggerable resize events
let observerInstances = [];
class MockResizeObserver {
  constructor(cb) {
    this.callback = cb;
    this.observedTargets = [];
    this.isDisconnected = false;
    observerInstances.push(this);
  }
  observe(target) {
    if (!this.observedTargets.includes(target)) {
      this.observedTargets.push(target);
    }
  }
  unobserve(target) {
    this.observedTargets = this.observedTargets.filter(t => t !== target);
  }
  disconnect() {
    this.observedTargets = [];
    this.isDisconnected = true;
  }
  triggerResize() {
    if (!this.isDisconnected) {
      this.callback();
    }
  }
}

async function runAdversarialStressSuite() {
  console.log('================================================================');
  console.log('=== EMPIRICAL ADVERSARIAL CHALLENGER: MILESTONE 1 STRESS RUN ===');
  console.log('================================================================\n');

  const elements = new Map();
  global.ResizeObserver = MockResizeObserver;
  global.window = {
    devicePixelRatio: 2,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  function findInTree(el, id) {
    if (!el) return null;
    if (el.id === id) return el;
    if (el.children) {
      for (const child of el.children) {
        const res = findInTree(child, id);
        if (res) return res;
      }
    }
    return null;
  }

  global.document = {
    getElementById: (id) => {
      if (elements.has(id)) return elements.get(id);
      for (const el of elements.values()) {
        const found = findInTree(el, id);
        if (found) {
          elements.set(id, found);
          return found;
        }
      }
      return null;
    },
    createElement: (tag) => {
      const el = new MockElement(tag);
      return el;
    }
  };

  const { Chart } = await import('../frontend/src/charts/chart_engine.js');
  const physiologicalModule = await import('../frontend/src/charts/physiological.js');

  let passedTests = 0;
  let totalTests = 0;

  function runSubtest(name, fn) {
    totalTests++;
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  // ===========================================================================
  // SECTION 1: DYNAMIC POWER TOGGLING STRESS TEST
  // ===========================================================================
  console.log('\n--- Section 1: Dynamic Power Toggling Stress Tests ---');

  const cardPowerZone = new MockElement('div', 'card-power-zone');
  const subtitleEl = new MockElement('p', 'power-zone-subtitle');
  const powerCanvasContainer = new MockElement('div', 'power-canvas-container');
  powerCanvasContainer.setRect(280, 260);
  const powerCanvas = new MockCanvas('power-zone-chart', 280, 260);

  cardPowerZone.appendChild(subtitleEl);
  cardPowerZone.appendChild(powerCanvasContainer);
  powerCanvasContainer.appendChild(powerCanvas);

  elements.set('card-power-zone', cardPowerZone);
  elements.set('power-zone-subtitle', subtitleEl);
  elements.set('power-zone-chart', powerCanvas);

  const rollupWithPower = {
    athlete: { cycling_ftp: 285 },
    physiological: {
      has_power_data: true,
      power_zones: [
        { zone: 'Z1 Active Recovery', seconds: 1200 },
        { zone: 'Z2 Endurance', seconds: 3600 },
        { zone: 'Z3 Tempo', seconds: 2400 },
        { zone: 'Z4 Threshold', seconds: 1800 },
        { zone: 'Z5 VO2Max', seconds: 600 },
        { zone: 'Z6 Anaerobic', seconds: 200 },
        { zone: 'Z7 Neuromuscular', seconds: 60 }
      ]
    }
  };

  const rollupWithoutPower = {
    athlete: { cycling_ftp: 285 },
    physiological: {
      has_power_data: false,
      power_zones: []
    }
  };

  runSubtest('1.1: Rapid power state oscillation (100 alternating toggles)', () => {
    for (let i = 0; i < 100; i++) {
      const isPower = i % 2 === 0;
      if (isPower) {
        physiologicalModule.renderPowerZoneChart(rollupWithPower);
        assert.strictEqual(powerCanvas.style.display, '', `Canvas must be visible on iteration ${i}`);
        assert.ok(subtitleEl.textContent.includes('FTP: 285 W'), 'Subtitle reflects power FTP');
        const emptyNotice = document.getElementById('power-zone-empty-notice');
        if (emptyNotice) {
          assert.strictEqual(emptyNotice.style.display, 'none', 'Empty notice must be hidden when power is active');
        }
      } else {
        physiologicalModule.renderPowerZoneChart(rollupWithoutPower);
        assert.strictEqual(powerCanvas.style.display, 'none', `Canvas must be hidden on iteration ${i}`);
        assert.ok(subtitleEl.textContent.includes('No Power Meter'), 'Subtitle reflects no power');
        const emptyNotice = document.getElementById('power-zone-empty-notice');
        assert.ok(emptyNotice, 'Empty notice must exist');
        assert.strictEqual(emptyNotice.style.display, 'flex', 'Empty notice must be visible');
      }

      // Invariant: Card must never balloon with extra direct children!
      assert.strictEqual(cardPowerZone.children.length, 2, `card-power-zone must have exactly 2 children (subtitle + container), found ${cardPowerZone.children.length} on iteration ${i}`);
      // Invariant: Container must have at most 2 children (canvas + at most 1 emptyNotice)
      assert.ok(powerCanvasContainer.children.length <= 2, `container must have <= 2 children, found ${powerCanvasContainer.children.length}`);
    }
  });

  runSubtest('1.2: Degenerate power inputs (null, missing zones, zero seconds, explicit flags)', () => {
    // Case A: null rollup
    physiologicalModule.renderPowerZoneChart(null);
    assert.strictEqual(powerCanvas.style.display, 'none', 'Must handle null rollup cleanly');

    // Case B: empty physiological
    physiologicalModule.renderPowerZoneChart({});
    assert.strictEqual(powerCanvas.style.display, 'none', 'Must handle empty object cleanly');

    // Case C: zones present but all 0 seconds and has_power_data false
    physiologicalModule.renderPowerZoneChart({
      physiological: {
        has_power_data: false,
        power_zones: [{ zone: 'Z1', seconds: 0 }, { zone: 'Z2', seconds: 0 }]
      }
    });
    assert.strictEqual(powerCanvas.style.display, 'none', 'Must treat 0-seconds power as inactive');

    // Case D: customThresholds dynamic update
    physiologicalModule.renderPowerZoneChart(rollupWithPower, { cycling_ftp: 320 });
    assert.strictEqual(powerCanvas.style.display, '');
    assert.ok(subtitleEl.textContent.includes('FTP: 320 W'), 'Custom threshold FTP 320 must be honored');

    // Case E: customThresholds reset to default
    physiologicalModule.renderPowerZoneChart(rollupWithPower);
    assert.ok(subtitleEl.textContent.includes('FTP: 285 W'), 'FTP must fall back to athlete default');
  });

  runSubtest('1.3: Resize while hidden, then reactivate power', () => {
    // 1. Switch to no power
    physiologicalModule.renderPowerZoneChart(rollupWithoutPower);
    assert.strictEqual(powerCanvas.style.display, 'none');

    // 2. Container resizes while canvas is hidden (e.g. tablet -> desktop reflow)
    powerCanvasContainer.setRect(400, 300);

    // 3. Reactivate power
    physiologicalModule.renderPowerZoneChart(rollupWithPower);
    assert.strictEqual(powerCanvas.style.display, '');
    assert.strictEqual(powerCanvas.style.width, '400px', 'Canvas style width must update to new container width');
    assert.strictEqual(powerCanvas.style.height, '300px', 'Canvas style height must update to new container height');
    assert.strictEqual(powerCanvas.width, 800, 'Canvas pixel buffer width must match 400 * 2');
    assert.strictEqual(powerCanvas.height, 600, 'Canvas pixel buffer height must match 300 * 2');
  });

  // ===========================================================================
  // SECTION 2: REPEATED CONTAINER RESIZING STRESS TEST
  // ===========================================================================
  console.log('\n--- Section 2: Repeated Container Resizing Stress Tests ---');

  const testContainer = new MockElement('div', 'stress-container');
  testContainer.setRect(300, 250);
  const testCanvas = new MockCanvas('stress-canvas', 300, 250);
  testContainer.appendChild(testCanvas);
  elements.set('stress-canvas', testCanvas);

  const chart = new Chart(testCanvas, {
    type: 'bar',
    data: {
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      datasets: [
        { label: 'Run', data: [10, 20, 0, 15, 0, 30, 0] },
        { label: 'Ride', data: [0, 45, 0, 0, 60, 90, 0] }
      ]
    }
  });

  const chartObserver = observerInstances[observerInstances.length - 1];
  assert.ok(chartObserver, 'Chart must have an associated ResizeObserver');

  runSubtest('2.1: 200 Rapid Container Resizes with chaotic aspect ratios', () => {
    const testCases = [
      [320, 240], [375, 260], [600, 300], [800, 400], [1200, 600],
      [150, 150], [50, 50], [1000, 200], [200, 800], [280.5, 260.75],
      [14, 14], [5000, 2000]
    ];

    for (let i = 0; i < 200; i++) {
      const [w, h] = testCases[i % testCases.length];
      testContainer.setRect(w, h);
      chartObserver.triggerResize();

      assert.strictEqual(testCanvas.style.width, `${w}px`, `Canvas width must be ${w}px on step ${i}`);
      assert.strictEqual(testCanvas.style.height, `${h}px`, `Canvas height must be ${h}px on step ${i}`);
      assert.strictEqual(testCanvas.width, Math.round(w * 2), `Canvas buffer width must be round(${w} * 2)`);
      assert.strictEqual(testCanvas.height, Math.round(h * 2), `Canvas buffer height must be round(${h} * 2)`);
      assert.ok(!Number.isNaN(chart.displayWidth), 'displayWidth must not be NaN');
      assert.ok(!Number.isNaN(chart.displayHeight), 'displayHeight must not be NaN');
    }
  });

  runSubtest('2.2: Extreme Boundary Resize: 0x0 container (hidden/collapsed)', () => {
    testContainer.setRect(0, 0);
    // Should not throw or crash on zero dimensions
    assert.doesNotThrow(() => {
      chartObserver.triggerResize();
    }, 'Chart must handle 0x0 container dimensions without throwing');

    // Restore to normal
    testContainer.setRect(300, 250);
    chartObserver.triggerResize();
    assert.strictEqual(testCanvas.style.width, '300px');
    assert.strictEqual(testCanvas.style.height, '250px');
  });

  runSubtest('2.3: ResizeObserver clean disconnection on destroy()', () => {
    chart.destroy();
    assert.strictEqual(chartObserver.isDisconnected, true, 'ResizeObserver must be disconnected');
    assert.strictEqual(chartObserver.observedTargets.length, 0, 'Observed targets must be cleared');

    // Trigger resize after destroy - should be a no-op
    testContainer.setRect(500, 500);
    chartObserver.triggerResize();
    // Dimensions should remain untouched from destruction
    assert.strictEqual(testCanvas.style.width, '300px');
  });

  // ===========================================================================
  // SECTION 3: DEVICE PIXEL RATIO (DPR) SCALING STRESS TEST
  // ===========================================================================
  console.log('\n--- Section 3: Device Pixel Ratio (DPR) Scaling Stress Tests ---');

  const hrContainer = new MockElement('div', 'hr-stress-container');
  hrContainer.setRect(260, 260);
  const hrCanvas = new MockCanvas('hr-zone-chart', 260, 260);
  hrContainer.appendChild(hrCanvas);
  elements.set('hr-zone-chart', hrCanvas);

  const rollupHR = {
    physiological: {
      heart_rate_zones: [
        { zone: 'Z1 Active Recovery', seconds: 3600 },
        { zone: 'Z2 Aerobic Endurance', seconds: 7200 },
        { zone: 'Z3 Tempo', seconds: 4500 },
        { zone: 'Z4 Threshold', seconds: 1800 },
        { zone: 'Z5 Anaerobic', seconds: 300 }
      ]
    }
  };

  const dprMatrix = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 2.625, 3.0, 4.0];

  runSubtest('3.1: High-DPI Matrix Verification (0.5x to 4.0x DPR)', () => {
    for (const dpr of dprMatrix) {
      global.window.devicePixelRatio = dpr;
      hrCanvas.ctx.calls = [];

      physiologicalModule.renderHeartRateZoneChart(rollupHR);

      // Verify display CSS dimensions remain locked to CSS pixels (260px)
      assert.strictEqual(hrCanvas.style.width, '260px', `CSS style width must be 260px at DPR ${dpr}`);
      assert.strictEqual(hrCanvas.style.height, '260px', `CSS style height must be 260px at DPR ${dpr}`);

      // Verify physical bitmap buffer scales exactly with DPR
      const expectedBufferW = Math.round(260 * dpr);
      const expectedBufferH = Math.round(260 * dpr);
      assert.strictEqual(hrCanvas.width, expectedBufferW, `Buffer width must be round(260 * ${dpr}) = ${expectedBufferW}`);
      assert.strictEqual(hrCanvas.height, expectedBufferH, `Buffer height must be round(260 * ${dpr}) = ${expectedBufferH}`);

      // Verify aspect ratio is strictly 1:1 (circular, no oval distortion)
      const ratio = hrCanvas.width / hrCanvas.height;
      assert.strictEqual(ratio, 1.0, `Buffer aspect ratio must be strictly 1.0 at DPR ${dpr}, got ${ratio}`);

      // Verify canvas transform scale matches DPR
      const scaleCalls = hrCanvas.ctx.calls.filter(c => c.type === 'scale');
      assert.ok(scaleCalls.length >= 1, `Must call ctx.scale at DPR ${dpr}`);
      const lastScale = scaleCalls[scaleCalls.length - 1];
      assert.strictEqual(lastScale.sx, dpr, `Scale X must equal DPR ${dpr}`);
      assert.strictEqual(lastScale.sy, dpr, `Scale Y must equal DPR ${dpr}`);
    }
  });

  runSubtest('3.2: Dynamic DPR transitions without transform compounding', () => {
    // Simulate user zooming in and out or moving window across displays
    const transitionSequence = [1.0, 2.0, 1.5, 3.0, 1.0, 2.625, 1.25, 1.0];
    for (const targetDpr of transitionSequence) {
      global.window.devicePixelRatio = targetDpr;
      physiologicalModule.renderHeartRateZoneChart(rollupHR);

      // Verify that resetTransform or setTransform was called prior to scale
      const calls = hrCanvas.ctx.calls;
      const resetIndex = calls.findLastIndex(c => c.type === 'resetTransform' || c.type === 'setTransform');
      const scaleIndex = calls.findLastIndex(c => c.type === 'scale');
      assert.ok(resetIndex !== -1, 'Must call resetTransform/setTransform to prevent transform compounding');
      assert.ok(scaleIndex > resetIndex, 'ctx.scale must be called AFTER resetTransform');

      // Crucial: current context scale must be exactly targetDpr, not multiplied across renders!
      assert.strictEqual(hrCanvas.ctx.currentTransform.sx, targetDpr, `Scale X must reset to ${targetDpr}, not compound`);
      assert.strictEqual(hrCanvas.ctx.currentTransform.sy, targetDpr, `Scale Y must reset to ${targetDpr}, not compound`);
    }
  });

  runSubtest('3.3: Donut Arc Geometry and True Circularity under various aspect ratios', () => {
    // Test that even if container is non-square (e.g. 350x260), the donut remains circular
    hrContainer.setRect(350, 260);
    global.window.devicePixelRatio = 2;
    hrCanvas.ctx.calls = [];

    physiologicalModule.renderHeartRateZoneChart(rollupHR);

    const arcCalls = hrCanvas.ctx.calls.filter(c => c.type === 'arc');
    assert.ok(arcCalls.length >= 5, 'Must draw doughnut arcs for zones');

    for (const arc of arcCalls) {
      const [cx, cy, radius] = arc.args;
      // In a circular arc, centerX and centerY are fixed scalars, radius is scalar
      assert.strictEqual(cx, 175, 'CenterX must be width / 2 = 175');
      assert.ok(radius > 0, 'Radius must be positive');
      // outerRadius should fit within the smaller dimension (260 minus legend)
      assert.ok(radius <= 260 * 0.42, 'Radius must be clamped to available height');
    }
  });

  // ===========================================================================
  // SECTION 4: MULTI-CHART CONCURRENT RESIZING & CROSS-CONTAMINATION
  // ===========================================================================
  console.log('\n--- Section 4: Multi-Chart Concurrent Resizing & Power Oscillation ---');

  const cardPaceZone = new MockElement('div', 'card-pace-zone');
  const paceContainer = new MockElement('div', 'pace-container');
  paceContainer.setRect(280, 260);
  const paceCanvas = new MockCanvas('pace-zone-chart', 280, 260);
  cardPaceZone.appendChild(paceContainer);
  paceContainer.appendChild(paceCanvas);
  elements.set('card-pace-zone', cardPaceZone);
  elements.set('pace-zone-chart', paceCanvas);

  const cardTrends = new MockElement('div', 'card-threshold-trends');
  const trendsContainer = new MockElement('div', 'trends-container');
  trendsContainer.setRect(280, 260);
  const trendsCanvas = new MockCanvas('threshold-trends-chart', 280, 260);
  cardTrends.appendChild(trendsContainer);
  trendsContainer.appendChild(trendsCanvas);
  elements.set('card-threshold-trends', cardTrends);
  elements.set('threshold-trends-chart', trendsCanvas);

  const fullRollup = {
    athlete: { cycling_ftp: 285, lthr: 168 },
    physiological: {
      has_power_data: true,
      heart_rate_zones: [
        { zone: 'Z1', seconds: 3600 },
        { zone: 'Z2', seconds: 7200 },
        { zone: 'Z3', seconds: 4500 }
      ],
      power_zones: [
        { zone: 'Z1', seconds: 1200 },
        { zone: 'Z2', seconds: 3600 }
      ],
      pace_zones: [
        { zone: 'Recovery', short_label: 'Rec', seconds: 3600 },
        { zone: 'Endurance', short_label: 'End', seconds: 7200 }
      ],
      threshold_trends: [
        { date: '2026-09-01', vo2max: 52, cycling_ftp: 280, lthr: 168 }
      ]
    }
  };

  runSubtest('4.1: Concurrent 4-card rendering and chaotic viewport resizing', () => {
    const viewports = [
      [320, 240], [375, 260], [600, 280], [800, 280], [1024, 280], [1440, 280]
    ];

    for (let cycle = 0; cycle < 50; cycle++) {
      const isPower = cycle % 2 === 0;
      const currentRollup = isPower ? fullRollup : {
        ...fullRollup,
        physiological: { ...fullRollup.physiological, has_power_data: false, power_zones: [] }
      };

      // Set dimensions for all 4 containers
      const [vw, vh] = viewports[cycle % viewports.length];
      hrContainer.setRect(vw, vh);
      powerCanvasContainer.setRect(vw, vh);
      paceContainer.setRect(vw, vh);
      trendsContainer.setRect(vw, vh);

      // Render all 4 charts
      physiologicalModule.renderHeartRateZoneChart(currentRollup);
      physiologicalModule.renderPowerZoneChart(currentRollup);
      physiologicalModule.renderPaceZoneChart(currentRollup);
      physiologicalModule.renderThresholdTrendsChart(currentRollup);

      // Verify HR Chart dimensions and circularity
      assert.strictEqual(hrCanvas.style.width, `${vw}px`);
      assert.strictEqual(hrCanvas.style.height, `${vh}px`);
      assert.strictEqual(hrCanvas.width, Math.round(vw * global.window.devicePixelRatio));
      assert.strictEqual(hrCanvas.height, Math.round(vh * global.window.devicePixelRatio));

      // Verify Power Card direct children invariant (never ballooning!)
      assert.strictEqual(cardPowerZone.children.length, 2);

      // Verify Pace Chart dimensions
      assert.strictEqual(paceCanvas.style.width, `${vw}px`);
      assert.strictEqual(paceCanvas.style.height, `${vh}px`);

      // Verify Trends Chart dimensions
      assert.strictEqual(trendsCanvas.style.width, `${vw}px`);
      assert.strictEqual(trendsCanvas.style.height, `${vh}px`);
    }
  });

  // ===========================================================================
  // SECTION 5: EVENT LISTENER & OBSERVER RESOURCE MANAGEMENT
  // ===========================================================================
  console.log('\n--- Section 5: Event Listener & Observer Resource Cleanliness ---');

  runSubtest('5.1: Verify zero listener leaks across 100 chart lifecycle cycles', () => {
    let windowListeners = [];
    const origAdd = global.window.addEventListener;
    const origRemove = global.window.removeEventListener;

    global.window.addEventListener = (evt, fn) => {
      windowListeners.push({ evt, fn });
      if (origAdd) origAdd(evt, fn);
    };
    global.window.removeEventListener = (evt, fn) => {
      windowListeners = windowListeners.filter(l => !(l.evt === evt && l.fn === fn));
      if (origRemove) origRemove(evt, fn);
    };

    const dummyCanvas = new MockCanvas('lifecycle-canvas', 250, 250);
    const dummyContainer = new MockElement('div');
    dummyContainer.appendChild(dummyCanvas);

    const initialObservers = observerInstances.length;

    for (let i = 0; i < 100; i++) {
      const c = new Chart(dummyCanvas, {
        type: 'line',
        data: { labels: ['A'], datasets: [{ data: [1] }] }
      });
      c.destroy();
    }

    // All created ResizeObservers must be disconnected
    const activeObservers = observerInstances.slice(initialObservers).filter(obs => !obs.isDisconnected);
    assert.strictEqual(activeObservers.length, 0, 'All ResizeObservers must be disconnected after chart.destroy()');

    // All window resize listeners added during the loop must be cleaned up
    assert.strictEqual(windowListeners.length, 0, 'Zero window event listeners may leak after chart.destroy()');

    // Canvas listeners must be cleanly removed
    assert.strictEqual(dummyCanvas.listeners.get('mousemove')?.length || 0, 0, 'No mousemove listeners leaked');
    assert.strictEqual(dummyCanvas.listeners.get('mouseleave')?.length || 0, 0, 'No mouseleave listeners leaked');

    // Restore original window listeners
    global.window.addEventListener = origAdd;
    global.window.removeEventListener = origRemove;
  });

  console.log('\n================================================================');
  console.log(`=== STRESS RESULTS: ${passedTests}/${totalTests} TESTS PASSED (100% EMPIRICAL PASS) ===`);
  console.log('================================================================\n');
}

runAdversarialStressSuite().catch(err => {
  console.error('\n[FATAL STRESS ERROR]:', err);
  process.exit(1);
});
