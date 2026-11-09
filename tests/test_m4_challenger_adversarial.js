/**
 * tests/test_m4_challenger_adversarial.js
 * 
 * Milestone 4 Adversarial Challenger Test Suite:
 * Empirical Stress-Testing of Trend Modal, Responsive Canvas Chart Engine,
 * Window/Fullscreen Resizing, Zero-Record Resilience, and Generator Extreme Spans.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// Lightweight Headless DOM & Canvas Mock Environment with Boundary Checkers
// ============================================================================

class MockClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
    this._syncFromClassName();
  }
  _syncFromClassName() {
    this.set.clear();
    if (this.el._className) {
      this.el._className.split(/\s+/).filter(Boolean).forEach(c => this.set.add(c));
    }
  }
  _syncToClassName() {
    this.el._className = Array.from(this.set).join(' ');
  }
  add(...tokens) {
    tokens.forEach(t => this.set.add(t));
    this._syncToClassName();
  }
  remove(...tokens) {
    tokens.forEach(t => this.set.delete(t));
    this._syncToClassName();
  }
  contains(token) {
    return this.set.has(token);
  }
  toggle(token, force) {
    if (force !== undefined) {
      if (force) this.add(token);
      else this.remove(token);
      return force;
    }
    if (this.contains(token)) {
      this.remove(token);
      return false;
    } else {
      this.add(token);
      return true;
    }
  }
}

class StrictMockCanvasContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '10px sans-serif';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.calls = [];
  }

  _checkNum(val, name, op) {
    if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
      throw new Error(`[Boundary Safety] Invalid ${name}=${val} passed to ${op}`);
    }
  }

  clearRect(x, y, w, h) {
    this._checkNum(x, 'x', 'clearRect');
    this._checkNum(y, 'y', 'clearRect');
    this._checkNum(w, 'w', 'clearRect');
    this._checkNum(h, 'h', 'clearRect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dimensions in clearRect (${w}, ${h})`);
    this.calls.push({ op: 'clearRect', args: [x, y, w, h] });
  }

  beginPath() { this.calls.push({ op: 'beginPath' }); }
  closePath() { this.calls.push({ op: 'closePath' }); }

  moveTo(x, y) {
    this._checkNum(x, 'x', 'moveTo');
    this._checkNum(y, 'y', 'moveTo');
    this.calls.push({ op: 'moveTo', args: [x, y] });
  }

  lineTo(x, y) {
    this._checkNum(x, 'x', 'lineTo');
    this._checkNum(y, 'y', 'lineTo');
    this.calls.push({ op: 'lineTo', args: [x, y] });
  }

  arc(x, y, r, s, e, cc) {
    this._checkNum(x, 'x', 'arc');
    this._checkNum(y, 'y', 'arc');
    this._checkNum(r, 'r', 'arc');
    if (r < 0) throw new Error(`[Boundary Safety] Negative radius in arc: ${r}`);
    this.calls.push({ op: 'arc', args: [x, y, r, s, e, cc] });
  }

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this._checkNum(cp1x, 'cp1x', 'bezierCurveTo');
    this._checkNum(cp1y, 'cp1y', 'bezierCurveTo');
    this._checkNum(cp2x, 'cp2x', 'bezierCurveTo');
    this._checkNum(cp2y, 'cp2y', 'bezierCurveTo');
    this._checkNum(x, 'x', 'bezierCurveTo');
    this._checkNum(y, 'y', 'bezierCurveTo');
    this.calls.push({ op: 'bezierCurveTo', args: [cp1x, cp1y, cp2x, cp2y, x, y] });
  }

  rect(x, y, w, h) {
    this._checkNum(x, 'x', 'rect');
    this._checkNum(y, 'y', 'rect');
    this._checkNum(w, 'w', 'rect');
    this._checkNum(h, 'h', 'rect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dimensions in rect (${w}, ${h})`);
    this.calls.push({ op: 'rect', args: [x, y, w, h] });
  }

  roundRect(x, y, w, h, radii) {
    this._checkNum(x, 'x', 'roundRect');
    this._checkNum(y, 'y', 'roundRect');
    this._checkNum(w, 'w', 'roundRect');
    this._checkNum(h, 'h', 'roundRect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dimensions in roundRect (${w}, ${h})`);
    this.calls.push({ op: 'roundRect', args: [x, y, w, h, radii] });
  }

  fillRect(x, y, w, h) {
    this._checkNum(x, 'x', 'fillRect');
    this._checkNum(y, 'y', 'fillRect');
    this._checkNum(w, 'w', 'fillRect');
    this._checkNum(h, 'h', 'fillRect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dimensions in fillRect (${w}, ${h})`);
    this.calls.push({ op: 'fillRect', args: [x, y, w, h] });
  }

  stroke() { this.calls.push({ op: 'stroke' }); }
  fill() { this.calls.push({ op: 'fill' }); }

  save() { this.calls.push({ op: 'save' }); }
  restore() { this.calls.push({ op: 'restore' }); }

  scale(sx, sy) {
    this._checkNum(sx, 'sx', 'scale');
    this._checkNum(sy, 'sy', 'scale');
    this.calls.push({ op: 'scale', args: [sx, sy] });
  }

  resetTransform() { this.calls.push({ op: 'resetTransform' }); }
  setTransform() { this.calls.push({ op: 'setTransform' }); }
  setLineDash(dash) { this.calls.push({ op: 'setLineDash', args: [dash] }); }

  measureText(txt) {
    return { width: String(txt || '').length * 6.5 };
  }

  fillText(txt, x, y) {
    this._checkNum(x, 'x', 'fillText');
    this._checkNum(y, 'y', 'fillText');
    this.calls.push({ op: 'fillText', args: [String(txt), x, y] });
  }

  createLinearGradient(x0, y0, x1, y1) {
    this._checkNum(x0, 'x0', 'createLinearGradient');
    this._checkNum(y0, 'y0', 'createLinearGradient');
    this._checkNum(x1, 'x1', 'createLinearGradient');
    this._checkNum(y1, 'y1', 'createLinearGradient');
    return {
      addColorStop: (stop, color) => {}
    };
  }
}

class MockElement {
  constructor(tag, id = '', className = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._className = className;
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this._innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.eventListeners = new Map();
    this._mockWidth = 600;
    this._mockHeight = 300;
  }

  get className() { return this._className; }
  set className(v) {
    this._className = v;
    this.classList._syncFromClassName();
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    const tagMatches = html.matchAll(/<([a-zA-Z0-9\-]+)([^>]*)>/g);
    for (const match of tagMatches) {
      const tag = match[1];
      const attrsStr = match[2];
      const child = new MockElement(tag);
      child.parentElement = this;

      const idMatch = attrsStr.match(/id=["']([^"']+)["']/);
      if (idMatch) child.id = idMatch[1];

      const classMatch = attrsStr.match(/class=["']([^"']+)["']/);
      if (classMatch) child.className = classMatch[1];

      const dataTrendRange = attrsStr.match(/data-trend-range=["']([^"']+)["']/);
      if (dataTrendRange) child.setAttribute('data-trend-range', dataTrendRange[1]);

      const dataMetric = attrsStr.match(/data-metric=["']([^"']+)["']/);
      if (dataMetric) child.setAttribute('data-metric', dataMetric[1]);

      this.children.push(child);
    }
  }

  getBoundingClientRect() {
    return {
      width: this._mockWidth,
      height: this._mockHeight,
      top: 0,
      left: 0,
      right: this._mockWidth,
      bottom: this._mockHeight
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    return this.attributes.get(name) || null;
  }
  hasAttribute(name) {
    if (name === 'class') return Boolean(this.className);
    if (name === 'id') return Boolean(this.id);
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.eventListeners.get(type);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  dispatchEvent(event) {
    const list = this.eventListeners.get(event.type) || [];
    for (const h of list) {
      h.call(this, event);
    }
  }

  getContext(type) {
    if (type === '2d') {
      if (!this._ctx) {
        this._ctx = new StrictMockCanvasContext2D(this);
      }
      return this._ctx;
    }
    return null;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(sel) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (sel.startsWith('#') && child.id === sel.slice(1)) results.push(child);
        else if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) results.push(child);
        else if (sel.startsWith('[') && sel.endsWith(']')) {
          const attr = sel.slice(1, -1);
          if (child.hasAttribute(attr)) results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

// Global DOM Mock
const domStore = new Map();
function registerElement(el) {
  domStore.set(el.id, el);
  return el;
}

const windowListeners = new Map();
global.window = {
  devicePixelRatio: 2,
  addEventListener: (evt, fn) => {
    if (!windowListeners.has(evt)) windowListeners.set(evt, []);
    windowListeners.get(evt).push(fn);
  },
  removeEventListener: (evt, fn) => {
    const l = windowListeners.get(evt);
    if (l) {
      const idx = l.indexOf(fn);
      if (idx >= 0) l.splice(idx, 1);
    }
  },
  dispatchEvent: (evt) => {
    const l = windowListeners.get(evt.type) || [];
    for (const fn of l) fn(evt);
  }
};

global.document = {
  body: new MockElement('body'),
  getElementById: (id) => domStore.get(id) || null,
  querySelectorAll: (sel) => {
    const res = [];
    for (const el of domStore.values()) {
      if (sel.startsWith('[') && sel.endsWith(']')) {
        const attr = sel.slice(1, -1);
        if (el.hasAttribute(attr)) res.push(el);
      }
    }
    return res;
  },
  addEventListener: (evt, fn) => {
    if (!windowListeners.has(evt)) windowListeners.set(evt, []);
    windowListeners.get(evt).push(fn);
  }
};

// ============================================================================
// Setup Trends Modal Mock DOM Elements
// ============================================================================

function setupMockDom() {
  domStore.clear();

  const modal = registerElement(new MockElement('div', 'metric-trend-modal', 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 hidden'));
  modal.setAttribute('aria-hidden', 'true');

  const backdrop = registerElement(new MockElement('div', 'trend-modal-backdrop'));
  modal.children.push(backdrop);

  const panel = registerElement(new MockElement('div', 'trend-modal-panel', 'relative w-full max-w-4xl bg-[#111114] border border-[#1f1f24] rounded-2xl max-h-[92vh] flex flex-col shadow-2xl'));
  modal.children.push(panel);

  const expandBtn = registerElement(new MockElement('button', 'btn-expand-trend-modal'));
  const closeBtn = registerElement(new MockElement('button', 'btn-close-trend-modal'));
  panel.children.push(expandBtn, closeBtn);

  const iconEl = registerElement(new MockElement('div', 'trend-metric-icon'));
  const titleEl = registerElement(new MockElement('h2', 'trend-metric-title'));
  const subtitleEl = registerElement(new MockElement('p', 'trend-metric-subtitle'));
  const badgeEl = registerElement(new MockElement('span', 'trend-metric-badge'));
  panel.children.push(iconEl, titleEl, subtitleEl, badgeEl);

  ['1d', '7d', '1m', '1y', 'custom'].forEach(r => {
    const btn = registerElement(new MockElement('button', `trend-range-${r}`, 'px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-400'));
    btn.setAttribute('data-trend-range', r);
    panel.children.push(btn);
  });

  const customCont = registerElement(new MockElement('div', 'trend-custom-date-container', 'hidden'));
  const startIn = registerElement(new MockElement('input', 'trend-input-start-date'));
  const endIn = registerElement(new MockElement('input', 'trend-input-end-date'));
  const applyBtn = registerElement(new MockElement('button', 'trend-btn-apply-custom'));
  const errEl = registerElement(new MockElement('div', 'trend-custom-error', 'hidden'));
  customCont.children.push(startIn, endIn, applyBtn, errEl);
  panel.children.push(customCont);

  const prevBtn = registerElement(new MockElement('button', 'trend-nav-prev'));
  const nextBtn = registerElement(new MockElement('button', 'trend-nav-next'));
  const labelEl = registerElement(new MockElement('span', 'trend-date-label'));
  panel.children.push(prevBtn, nextBtn, labelEl);

  const kpiGrid = registerElement(new MockElement('div', 'trend-kpi-grid'));
  panel.children.push(kpiGrid);

  const chartCont = registerElement(new MockElement('div', 'trend-chart-container', 'h-64 sm:h-72 w-full relative'));
  const canvas = registerElement(new MockElement('canvas', 'metric-trend-chart'));
  canvas.parentElement = chartCont;
  chartCont.children.push(canvas);

  const emptyNotice = registerElement(new MockElement('div', 'trend-chart-empty', 'hidden'));
  chartCont.children.push(emptyNotice);
  panel.children.push(chartCont);

  const countEl = registerElement(new MockElement('span', 'trend-table-count'));
  const theadRow = registerElement(new MockElement('tr', 'trend-table-header-row'));
  const tbody = registerElement(new MockElement('tbody', 'trend-table-body'));
  panel.children.push(countEl, theadRow, tbody);
}

// Generate test rollup
function createMockRollup(dayCount = 365) {
  const daily = [];
  const start = new Date(2026, 9, 26); // Oct 26, 2026
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({
      date: iso,
      steps: 8000 + (i % 50) * 100,
      steps_goal: 10000,
      resting_hr: 46 + (i % 6),
      resting_hr_7d_avg: 48,
      sleep_seconds: 25200 + (i % 3600),
      sleep_deep_seconds: 5400,
      sleep_light_seconds: 14400,
      sleep_rem_seconds: 4500,
      sleep_awake_seconds: 900,
      sleep_score: 82 + (i % 15),
      sleep_quality: 'Optimal',
      stress_level: 22 + (i % 25),
      stress_qualifier: 'Rest',
      body_battery_high: 95,
      body_battery_low: 22,
      body_battery_charged: 73,
      body_battery_drained: 70,
      hrv_last_night_avg: 54 + (i % 8),
      hrv_weekly_avg: 55,
      hrv_status: 'Balanced',
      intensity_minutes_moderate: 25,
      intensity_minutes_vigorous: 20,
      daily_calories: 2350,
      active_calories: 620,
      bmr_calories: 1730
    });
  }

  const threshold_trends = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(start.getFullYear(), start.getMonth() - m, 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    threshold_trends.push({
      date: iso,
      cycling_ftp: 280 + m * 2,
      lthr: 168,
      vo2max: 54.0 + (m * 0.2)
    });
  }

  return {
    wellness: { daily },
    physiological: { threshold_trends }
  };
}

// ============================================================================
// TEST SUITE EXECUTION
// ============================================================================

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    testsFailed++;
  }
}

async function runAdversarialSuite() {
  console.log('\n======================================================================');
  console.log('Milestone 4 Challenger: Adversarial Stress & Boundary Safety Suite');
  console.log('======================================================================\n');

  // Load modules
  const { Chart } = await import('../frontend/src/charts/chart_engine.js');
  const trendsModal = await import('../frontend/src/charts/trends_modal.js');

  const {
    openMetricTrendModal,
    closeMetricTrendModal,
    toggleExpandModal,
    setTimeRange,
    navigateDatePeriod,
    applyCustomDateRange,
    initTrendsModal
  } = trendsModal;

  const mockRollup = createMockRollup(365);

  // --------------------------------------------------------------------------
  // Area 1: Chart Engine Layout Stability & Canvas 2D Boundary Safety
  // Viewports: 320px, 375px, 600px, 800px, 1440px
  // --------------------------------------------------------------------------
  console.log('--- Area 1: Chart Engine Layout & Boundary Safety under Extreme Viewports ---');

  const testViewports = [320, 375, 600, 800, 1440];
  const allMetrics = ['sleep', 'hrv', 'resting_hr', 'steps', 'body_battery', 'stress', 'intensity_minutes', 'calories', 'thresholds'];

  for (const vp of testViewports) {
    await test(`A1-VP-${vp}: All 9 metric charts render with zero boundary violations at ${vp}px viewport`, () => {
      setupMockDom();
      initTrendsModal();

      const canvas = document.getElementById('metric-trend-chart');
      const container = document.getElementById('trend-chart-container');
      container._mockWidth = vp;
      canvas._mockWidth = vp;

      for (const metric of allMetrics) {
        openMetricTrendModal(metric, mockRollup);

        const ctx = canvas.getContext('2d');
        assert(ctx.calls.length > 0, `No drawing calls recorded for ${metric} at ${vp}px`);

        // Check for NaN or non-finite values across all canvas calls
        for (const call of ctx.calls) {
          if (call.args) {
            for (let i = 0; i < call.args.length; i++) {
              const arg = call.args[i];
              if (typeof arg === 'number') {
                assert(!isNaN(arg), `Found NaN argument in ${call.op} for ${metric} at ${vp}px`);
                assert(isFinite(arg), `Found non-finite argument in ${call.op} for ${metric} at ${vp}px`);
              }
            }
          }
        }
      }
    });
  }

  await test('A1-EXTREME-DIMS: Chart engine handles zero, negative, and extreme container heights without crashing', () => {
    setupMockDom();
    initTrendsModal();

    const canvas = document.getElementById('metric-trend-chart');
    const container = document.getElementById('trend-chart-container');

    // Height = 50px (very squished)
    container._mockWidth = 320;
    container._mockHeight = 50;
    canvas._mockWidth = 320;
    canvas._mockHeight = 50;
    openMetricTrendModal('sleep', mockRollup);

    // Height = 1200px (tall screen)
    container._mockHeight = 1200;
    canvas._mockHeight = 1200;
    openMetricTrendModal('hrv', mockRollup);

    // Width = 0 (collapsed container)
    container._mockWidth = 0;
    canvas._mockWidth = 0;
    assert.doesNotThrow(() => {
      openMetricTrendModal('steps', mockRollup);
    }, 'Collapsing width to 0 threw an uncaught error');
  });

  await test('A1-LABEL-COLLISION: 365 daily points in narrow 320px viewport enforces label collision clearance', () => {
    setupMockDom();
    initTrendsModal();

    const canvas = document.getElementById('metric-trend-chart');
    const container = document.getElementById('trend-chart-container');
    container._mockWidth = 320;
    canvas._mockWidth = 320;

    openMetricTrendModal('steps', mockRollup);
    setTimeRange('1y');

    const ctx = canvas.getContext('2d');
    const textCalls = ctx.calls.filter(c => c.op === 'fillText');
    assert(textCalls.length > 0, 'No text labels rendered in 1y view');

    // Verify labels did not crowd or overlap each other
    const xLabels = textCalls.filter(c => c.args[2] > 200); // bottom axis labels
    assert(xLabels.length <= 15, `Too many X labels rendered in 320px viewport: ${xLabels.length}`);
  });

  await test('A1-CORRUPT-DATA: Single-record, identical min/max Y, negative values, and NaN items handled gracefully', () => {
    setupMockDom();
    const canvas = document.getElementById('metric-trend-chart');

    // 1. Single record
    const singleRecordRollup = {
      wellness: {
        daily: [
          {
            date: '2026-10-26',
            steps: 10000,
            resting_hr: 48,
            sleep_seconds: 28800,
            sleep_deep_seconds: 7200,
            sleep_light_seconds: 14400,
            sleep_rem_seconds: 5400,
            sleep_awake_seconds: 1800,
            sleep_score: 85,
            stress_level: 25,
            body_battery_high: 90,
            body_battery_low: 30,
            body_battery_charged: 60,
            body_battery_drained: 60,
            hrv_last_night_avg: 55,
            hrv_weekly_avg: 55,
            intensity_minutes_moderate: 30,
            intensity_minutes_vigorous: 20,
            daily_calories: 2400,
            active_calories: 650,
            bmr_calories: 1750
          }
        ]
      }
    };
    openMetricTrendModal('sleep', singleRecordRollup);

    // 2. Direct chart call with identical Y values
    const c1 = new Chart(canvas, {
      type: 'line',
      data: {
        labels: ['Day 1', 'Day 2', 'Day 3'],
        datasets: [{ label: 'Constant Series', data: [50, 50, 50] }]
      }
    });
    c1.destroy();

    // 3. Direct chart call with null, NaN, and negative values
    const c2 = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['A', 'B', 'C', 'D'],
        datasets: [{ label: 'Mixed Series', data: [10, null, NaN, -5] }]
      }
    });
    c2.destroy();
  });

  await test('A1-TOOLTIP-BOUNDARIES: Tooltip rendered at canvas edges (x=0 and x=width) is clamped inside canvas', () => {
    setupMockDom();
    const canvas = document.getElementById('metric-trend-chart');
    canvas._mockWidth = 400;
    canvas._mockHeight = 250;

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: ['LeftEdge', 'Center', 'RightEdge'],
        datasets: [{ label: 'Edge Test', data: [100, 50, 200] }]
      }
    });

    assert(chart.dataPoints.length === 3, 'Expected 3 plotted data points');

    // Simulate mouse move directly over left point
    const ptLeft = chart.dataPoints[0];
    chart._handleMouseMove({ clientX: ptLeft.x, clientY: ptLeft.y });
    assert(chart.activeTooltip !== null, 'Tooltip should activate on left edge point');

    // Simulate mouse move directly over right point
    const ptRight = chart.dataPoints[2];
    chart._handleMouseMove({ clientX: ptRight.x, clientY: ptRight.y });
    assert(chart.activeTooltip !== null, 'Tooltip should activate on right edge point');

    chart.destroy();
  });

  // Area 2: Canvas Resizing during Fullscreen Expansion & Window Resize
  // --------------------------------------------------------------------------
  console.log('\n--- Area 2: Canvas Resizing during Fullscreen Expansion & Window Resize ---');

  await test('A2-FULLSCREEN-01: Fullscreen expansion toggles classes and triggers responsive re-render', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('sleep', mockRollup);

    const panel = document.getElementById('trend-modal-panel');
    const canvas = document.getElementById('metric-trend-chart');
    const container = document.getElementById('trend-chart-container');

    assert(panel.classList.contains('max-w-4xl'), 'Panel should initially be max-w-4xl');

    // Toggle expand
    toggleExpandModal();
    assert(panel.classList.contains('w-full'), 'Panel should expand to w-full');
    assert(panel.classList.contains('h-full'), 'Panel should expand to h-full');
    assert(panel.classList.contains('rounded-none'), 'Panel should remove rounded corners in fullscreen');
    assert(!panel.classList.contains('max-w-4xl'), 'Panel should not retain max-w-4xl in fullscreen');

    // Simulate fullscreen width expand from 800 to 1440
    container._mockWidth = 1440;
    canvas._mockWidth = 1440;
    window.dispatchEvent(new Event('resize'));

    // Toggle back to normal
    toggleExpandModal();
    assert(panel.classList.contains('max-w-4xl'), 'Panel should restore max-w-4xl');
    assert(!panel.classList.contains('rounded-none'), 'Panel should restore rounded corners');
  });

  await test('A2-STRESS-RAPID-TOGGLE: Rapid 20x fullscreen toggle cycle maintains state and canvas integrity', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('hrv', mockRollup);

    for (let i = 0; i < 20; i++) {
      toggleExpandModal();
    }

    const panel = document.getElementById('trend-modal-panel');
    // After 20 toggles (even number), it should be collapsed
    assert(panel.classList.contains('max-w-4xl'), 'Panel should be collapsed after even number of toggles');
  });

  await test('A2-WINDOW-RESIZE: Window resize event triggers chart redraw without memory leak or exceptions', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('calories', mockRollup);

    const canvas = document.getElementById('metric-trend-chart');
    const ctx = canvas.getContext('2d');
    const initialCallCount = ctx.calls.length;

    window.dispatchEvent(new Event('resize'));
    assert(ctx.calls.length > initialCallCount, 'Canvas was not redrawn on window resize');

    // Close modal, ensure window resize does not error when chart is destroyed
    closeMetricTrendModal();
    assert.doesNotThrow(() => {
      window.dispatchEvent(new Event('resize'));
    }, 'Window resize threw error after modal close and chart destruction');
  });

  await test('A2-FLUID-DRAG-STRESS: 50 sequential rapid resize events mimicking fluid window drag maintain stability', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('steps', mockRollup);

    const canvas = document.getElementById('metric-trend-chart');
    const container = document.getElementById('trend-chart-container');

    for (let w = 320; w <= 820; w += 10) {
      container._mockWidth = w;
      canvas._mockWidth = w;
      window.dispatchEvent(new Event('resize'));
    }

    const ctx = canvas.getContext('2d');
    assert(ctx.calls.length > 50, 'Resize events did not properly execute');
  });

  await test('A2-DPR-SCALING: Canvas handles devicePixelRatio variations (1x, 1.5x, 2x, 3x Retina) cleanly', () => {
    setupMockDom();
    initTrendsModal();

    const dprs = [1, 1.5, 2, 3];
    for (const dpr of dprs) {
      global.window.devicePixelRatio = dpr;
      openMetricTrendModal('resting_hr', mockRollup);

      const canvas = document.getElementById('metric-trend-chart');
      assert.strictEqual(canvas.width, Math.round(canvas._mockWidth * dpr), `Canvas width mismatch at ${dpr}x DPR`);
      assert.strictEqual(canvas.height, Math.round(canvas._mockHeight * dpr), `Canvas height mismatch at ${dpr}x DPR`);
    }
    global.window.devicePixelRatio = 2; // restore default
  });

  // --------------------------------------------------------------------------
  // Area 3: Empty State Handling: 0 Records must Render Cleanly
  // --------------------------------------------------------------------------
  console.log('\n--- Area 3: Empty State Handling & Zero-Record Resilience ---');

  await test('A3-EMPTY-ROLLUP: Complete empty rollup renders #trend-chart-empty, "—" in all KPIs, and 0 exceptions', () => {
    setupMockDom();
    initTrendsModal();

    const emptyRollup = { wellness: { daily: [] }, physiological: { threshold_trends: [] } };
    openMetricTrendModal('sleep', emptyRollup);

    const emptyNotice = document.getElementById('trend-chart-empty');
    assert(!emptyNotice.classList.contains('hidden'), '#trend-chart-empty notice should be visible');

    const kpiGrid = document.getElementById('trend-kpi-grid');
    assert(kpiGrid.innerHTML.includes('—'), 'KPI cards must contain em-dash "—"');
    assert(kpiGrid.innerHTML.includes('No data'), 'KPI cards must state "No data"');

    const tbody = document.getElementById('trend-table-body');
    assert(tbody.innerHTML.includes('No records found'), 'Table must render empty state text');

    const countEl = document.getElementById('trend-table-count');
    assert.strictEqual(countEl.textContent, '0 records');
  });

  await test('A3-EMPTY-ALL-METRICS: All 9 metrics render empty state without throwing exceptions', () => {
    setupMockDom();
    initTrendsModal();
    const emptyRollup = { wellness: null, physiological: null };

    for (const metric of allMetrics) {
      assert.doesNotThrow(() => {
        openMetricTrendModal(metric, emptyRollup);
      }, `Metric ${metric} threw an exception with null rollup`);

      const emptyNotice = document.getElementById('trend-chart-empty');
      assert(!emptyNotice.classList.contains('hidden'), `#trend-chart-empty notice should be visible for ${metric}`);

      const kpiGrid = document.getElementById('trend-kpi-grid');
      assert(kpiGrid.innerHTML.includes('—'), `KPI cards must contain "—" for ${metric}`);
    }
  });

  await test('A3-EMPTY-TIME-RANGES: Switching time ranges (1D, 7D, 1M, 1Y, Custom) with 0 records remains stable', () => {
    setupMockDom();
    initTrendsModal();
    const emptyRollup = { wellness: { daily: [] } };
    openMetricTrendModal('steps', emptyRollup);

    ['1d', '7d', '1m', '1y'].forEach(r => {
      assert.doesNotThrow(() => {
        setTimeRange(r);
      }, `setTimeRange(${r}) threw error on empty dataset`);
      const emptyNotice = document.getElementById('trend-chart-empty');
      assert(!emptyNotice.classList.contains('hidden'));
    });

    // Custom date range with 0 records
    const startIn = document.getElementById('trend-input-start-date');
    const endIn = document.getElementById('trend-input-end-date');
    startIn.value = '2030-01-01';
    endIn.value = '2030-01-10';
    assert.doesNotThrow(() => {
      applyCustomDateRange();
    }, 'applyCustomDateRange threw error on future range');

    const emptyNotice = document.getElementById('trend-chart-empty');
    assert(!emptyNotice.classList.contains('hidden'), '#trend-chart-empty must remain visible for 0-record custom range');
  });

  await test('A3-CUSTOM-DATE-VALIDATION: Catches missing dates, inverted ranges, and supports single-day custom spans', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('sleep', mockRollup);

    const startIn = document.getElementById('trend-input-start-date');
    const endIn = document.getElementById('trend-input-end-date');
    const errEl = document.getElementById('trend-custom-error');

    // 1. Missing end date
    startIn.value = '2026-10-01';
    endIn.value = '';
    applyCustomDateRange();
    assert(!errEl.classList.contains('hidden'), 'Error banner should be visible for missing date');
    assert(errEl.textContent.includes('start and end dates'));

    // 2. Inverted dates (start > end)
    startIn.value = '2026-10-20';
    endIn.value = '2026-10-10';
    applyCustomDateRange();
    assert(!errEl.classList.contains('hidden'), 'Error banner should be visible for inverted dates');
    assert(errEl.textContent.includes('Start date must be before or equal to end date'));

    // 3. Single-day custom span (start == end)
    startIn.value = '2026-10-15';
    endIn.value = '2026-10-15';
    applyCustomDateRange();
    assert(errEl.classList.contains('hidden'), 'Error banner should be hidden for valid range');
    const countEl = document.getElementById('trend-table-count');
    assert.strictEqual(countEl.textContent, '1 records');
  });

  await test('A3-BOUNDARY-PAGINATION: Chronological boundary disables forward button at latest date', () => {
    setupMockDom();
    initTrendsModal();
    openMetricTrendModal('steps', mockRollup);

    const nextBtn = document.getElementById('trend-nav-next');
    // Initially at latest date, next button must be disabled
    assert(nextBtn.classList.contains('pointer-events-none'), 'Next button should be disabled at latest date');
    assert(nextBtn.classList.contains('opacity-30'), 'Next button should have opacity-30 at latest date');

    // Navigate backwards
    navigateDatePeriod(-1);
    assert(!nextBtn.classList.contains('pointer-events-none'), 'Next button should be enabled after navigating back');

    // Navigate forwards back to latest date
    navigateDatePeriod(1);
    assert(nextBtn.classList.contains('pointer-events-none'), 'Next button should be disabled again at latest date');
  });

  // --------------------------------------------------------------------------
  // Area 4: Python Generator Stress: 1, 7, 365, 730 Day Spans
  // --------------------------------------------------------------------------
  console.log('\n--- Area 4: Python Ingestion Generator Extreme Day Spans ---');

  const testSpans = [1, 7, 365, 730];
  for (const span of testSpans) {
    await test(`A4-PY-SPAN-${span}: Python generate_wellness_dataset & compile_dashboard_rollup cleanly support ${span} days`, () => {
      const pyCode = `
import json
from src.ingestion.mock_generator import SyntheticDatasetGenerator, generate_wellness_dataset, compile_dashboard_rollup

span = ${span}
gen = SyntheticDatasetGenerator(seed=42)
acts = gen.generate_activities()

# Test standalone generate_wellness_dataset
w1 = generate_wellness_dataset(days=span)
assert len(w1['daily']) == span, "Standalone span mismatch: %d != %d" % (len(w1['daily']), span)

# Test generate_wellness_dataset with activities
w2 = generate_wellness_dataset(activities=acts, days=span)
assert len(w2['daily']) == span, "With acts span mismatch: %d != %d" % (len(w2['daily']), span)

# Test compile_dashboard_rollup with generated wellness
rollup = compile_dashboard_rollup(wellness=w2)
assert 'wellness' in rollup
assert len(rollup['wellness']['daily']) == span, "Rollup span mismatch: %d != %d" % (len(rollup['wellness']['daily']), span)

# Verify daily fields integrity on boundary records
first_rec = w2['daily'][0]
last_rec = w2['daily'][-1]
for rec in [first_rec, last_rec]:
    assert 'date' in rec
    assert 'steps' in rec
    assert 'resting_hr' in rec
    assert 'sleep_seconds' in rec
    assert 'body_battery_high' in rec
    assert 'hrv_last_night_avg' in rec

print("OK")
`;
      const out = execSync('python3', { input: pyCode, encoding: 'utf-8' });
      assert(out.trim() === 'OK', `Python runner output: ${out}`);
    });
  }

  await test('A4-PY-DETERMINISM: Identical RNG seed guarantees bit-identical daily records', () => {
    const pyCode = `
from src.ingestion.mock_generator import generate_wellness_dataset

w_run1 = generate_wellness_dataset(seed=42, days=30)
w_run2 = generate_wellness_dataset(seed=42, days=30)
assert w_run1 == w_run2, "Seed 42 output is non-deterministic"

w_diff = generate_wellness_dataset(seed=999, days=30)
assert w_run1['daily'][0]['steps'] != w_diff['daily'][0]['steps'] or w_run1['daily'][0]['sleep_score'] != w_diff['daily'][0]['sleep_score']
print("OK")
`;
    const out = execSync('python3', { input: pyCode, encoding: 'utf-8' });
    assert(out.trim() === 'OK', `Python determinism output: ${out}`);
  });

  await test('A4-PY-MONOTONICITY-730D: 730 days of continuous telemetry are strictly monotonic without gaps', () => {
    const pyCode = `
from datetime import datetime, timedelta
from src.ingestion.mock_generator import generate_wellness_dataset

w = generate_wellness_dataset(days=730)
daily = w['daily']
assert len(daily) == 730, f"Expected 730, got {len(daily)}"

for i in range(len(daily) - 1):
    d_curr = datetime.fromisoformat(daily[i]['date'])
    d_next = datetime.fromisoformat(daily[i + 1]['date'])
    diff = (d_next - d_curr).days
    assert diff == 1, f"Gap detected at index {i}: {daily[i]['date']} -> {daily[i+1]['date']}"

print("OK")
`;
    const out = execSync('python3', { input: pyCode, encoding: 'utf-8' });
    assert(out.trim() === 'OK', `Python monotonicity output: ${out}`);
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log(`Milestone 4 Adversarial Results: ${testsPassed} passed, ${testsFailed} failed (Total: ${testsPassed + testsFailed})`);
  console.log('======================================================================\n');

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runAdversarialSuite();
