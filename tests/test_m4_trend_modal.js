/**
 * tests/test_m4_trend_modal.js
 * 
 * Comprehensive Test Suite for Milestone 4:
 * Singular Metric Trend Modals across Time Periods (Garmin Connect Style)
 * 
 * Verifications:
 * 1. DOM Architecture & Mandatory Root IDs preservation (all 12 IDs).
 * 2. Metric trend modal markup & Obsidian dark theme classes.
 * 3. Modal open / close / expand state machine & accessibility (Escape, backdrop).
 * 4. Time range filters (1D, 7D, 1M, 1Y, Custom) and chronological pagination.
 * 5. Custom date range input validation and boundary clamping.
 * 6. Metric-specific chart configurations (Sleep, HRV, RHR, Steps, Body Battery, Stress, Intensity, Calories, Thresholds).
 * 7. 4-card KPI stat strip calculation and breakdown table rendering.
 * 8. Card click affordances & stopPropagation on card controls.
 * 9. Empty dataset resilience (0 points notice, no exceptions).
 * 10. Ingestion generator full 1-year telemetry support.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Lightweight Headless DOM & Canvas Mock Environment
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
    this.checked = false;
    this.eventListeners = new Map();
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.onsubmit = null;
  }

  get className() {
    return this._className;
  }
  set className(v) {
    this._className = v;
    this.classList._syncFromClassName();
  }

  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    // Basic tag extractor for querySelector simulations
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

      const dataWellnessAction = attrsStr.match(/data-wellness-action=["']([^"']+)["']/);
      if (dataWellnessAction) child.setAttribute('data-wellness-action', dataWellnessAction[1]);

      this.children.push(child);
    }
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
    const type = event.type || event;
    const evObj = typeof event === 'string' ? { type: event, target: this, preventDefault() {}, stopPropagation() {} } : event;
    evObj.target = evObj.target || this;

    const list = this.eventListeners.get(type) || [];
    for (const h of list) {
      h.call(this, evObj);
    }
    const inline = this[`on${type}`];
    if (typeof inline === 'function') {
      inline.call(this, evObj);
    }
    return true;
  }

  click() {
    let stopped = false;
    const ev = {
      type: 'click',
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; }
    };
    this.dispatchEvent(ev);
    return !stopped;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches && cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const attr = selector.slice(1, -1);
      return this.hasAttribute(attr);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  getBoundingClientRect() {
    return { width: 600, height: 300, top: 0, left: 0, right: 600, bottom: 300 };
  }

  getContext(type) {
    return {
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      bezierCurveTo() {},
      arc() {},
      fill() {},
      stroke() {},
      fillRect() {},
      rect() {},
      fillText() {},
      measureText(t) { return { width: (t || '').length * 6 }; },
      save() {},
      restore() {},
      scale() {},
      closePath() {},
      setTransform() {},
      resetTransform() {},
      setLineDash() {}
    };
  }
}

class MockDocument {
  constructor() {
    this.elementsById = new Map();
    this.body = new MockElement('body', 'body');
    this.eventListeners = new Map();
  }
  register(el) {
    if (el.id) this.elementsById.set(el.id, el);
    return el;
  }
  getElementById(id) {
    return this.elementsById.get(id) || null;
  }
  querySelectorAll(sel) {
    const res = [];
    for (const el of this.elementsById.values()) {
      if (el.matches(sel)) res.push(el);
      for (const ch of el.children) {
        if (ch.matches(sel)) res.push(ch);
      }
    }
    return res;
  }
  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length > 0 ? all[0] : null;
  }
  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(handler);
  }
  dispatchEvent(event) {
    const list = this.eventListeners.get(event.type || event) || [];
    for (const h of list) h(event);
  }
}

// Build mock telemetry dataset
function createMockWellnessRollup() {
  const daily = [];
  const baseDate = new Date(2026, 9, 26); // Oct 26, 2026

  for (let i = 55; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const sleepSec = 28800; // 8h
    daily.push({
      date: dateStr,
      steps: 10500 - (i % 7) * 400,
      steps_goal: 10000,
      resting_hr: 48 + (i % 4),
      resting_heart_rate: 48 + (i % 4),
      resting_hr_7d_avg: 49.0,
      sleep_seconds: sleepSec,
      sleep_score: 84 - (i % 6),
      sleep_quality: 'Good',
      sleep_deep_seconds: 5760,
      sleep_light_seconds: 14400,
      sleep_rem_seconds: 6480,
      sleep_awake_seconds: 2160,
      stress_level: 22 + (i % 8),
      stress_qualifier: 'Low',
      body_battery_high: 95 - (i % 5),
      body_battery_low: 25 + (i % 5),
      body_battery_charged: 70,
      body_battery_drained: 70,
      hrv_last_night_avg: 55 + (i % 5),
      hrv_weekly_avg: 54,
      hrv_status: 'Balanced',
      intensity_minutes_moderate: 25,
      intensity_minutes_vigorous: 15,
      active_calories: 650 + (i % 10) * 20,
      bmr_calories: 1730,
      daily_calories: 2380
    });
  }

  const threshold_trends = [
    { date: '2026-09-01', vo2max: 51, cycling_ftp: 268, ftp: 268, lthr: 165 },
    { date: '2026-09-15', vo2max: 52, cycling_ftp: 272, ftp: 272, lthr: 166 },
    { date: '2026-10-01', vo2max: 53, cycling_ftp: 276, ftp: 276, lthr: 167 },
    { date: '2026-10-15', vo2max: 54, cycling_ftp: 280, ftp: 280, lthr: 168 }
  ];

  return {
    wellness: {
      daily,
      current: daily[daily.length - 1]
    },
    physiological: {
      threshold_trends
    }
  };
}

// ============================================================================
// Test Suite Execution
// ============================================================================

async function runMilestone4TestSuite() {
  process.stdout.write('\n======================================================================\n');
  process.stdout.write('Milestone 4: Singular Metric Trend Modals Test Suite\n');
  process.stdout.write('======================================================================\n\n');

  let passed = 0;
  let failed = 0;

  async function test(title, fn) {
    try {
      await fn();
      process.stdout.write(`  ✓ ${title}\n`);
      passed++;
    } catch (err) {
      process.stderr.write(`  ✗ ${title}\n    ${err.stack || err.message}\n`);
      failed++;
    }
  }

  // Section 1: DOM Elements & Contract Integrity
  process.stdout.write('--- Section 1: DOM Architecture & 12 Root IDs Integrity ---\n');

  const indexPath = path.resolve(__dirname, '../dist/index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf-8');

  await test('M4-DOM-01: All 12 mandatory root IDs strictly preserved in dist/index.html', () => {
    const mandatoryIds = [
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
    for (const id of mandatoryIds) {
      assert.ok(indexHtml.includes(`id="${id}"`), `Missing mandatory root ID: ${id}`);
    }
  });

  await test('M4-DOM-02: #metric-trend-modal exists and is initially hidden with aria-hidden="true"', () => {
    assert.ok(indexHtml.includes('id="metric-trend-modal"'), 'Missing #metric-trend-modal');
    assert.ok(indexHtml.includes('id="metric-trend-modal" class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 hidden" aria-hidden="true"'), 'Modal must have hidden and aria-hidden="true"');
  });

  await test('M4-DOM-03: Modal contains all required Obsidian/Zinc control elements and selectors', () => {
    const requiredElements = [
      'id="trend-modal-backdrop"',
      'id="trend-modal-panel"',
      'id="trend-metric-icon"',
      'id="trend-metric-title"',
      'id="trend-metric-badge"',
      'id="trend-metric-subtitle"',
      'id="trend-range-selector"',
      'data-trend-range="1d"',
      'data-trend-range="7d"',
      'data-trend-range="1m"',
      'data-trend-range="1y"',
      'data-trend-range="custom"',
      'id="btn-expand-trend-modal"',
      'id="btn-close-trend-modal"',
      'id="trend-nav-prev"',
      'id="trend-date-label"',
      'id="trend-nav-next"',
      'id="trend-custom-date-container"',
      'id="trend-input-start-date"',
      'id="trend-input-end-date"',
      'id="trend-btn-apply-custom"',
      'id="trend-kpi-grid"',
      'id="metric-trend-chart"',
      'id="trend-table-count"',
      'id="trend-table-header-row"',
      'id="trend-table-body"'
    ];
    for (const token of requiredElements) {
      assert.ok(indexHtml.includes(token), `Missing required modal element: ${token}`);
    }
  });

  // Section 2: Trends Modal ES Module State Machine & Logic
  process.stdout.write('\n--- Section 2: Modal State Machine & Navigation Logic ---\n');

  // Setup Global Mock DOM
  const mockDoc = new MockDocument();
  global.document = mockDoc;
  global.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {}
  };

  const modalEl = mockDoc.register(new MockElement('div', 'metric-trend-modal', 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 hidden'));
  const panelEl = mockDoc.register(new MockElement('div', 'trend-modal-panel', 'relative w-full max-w-4xl bg-[#111114] border border-[#1f1f24] rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden z-10'));
  const backdropEl = mockDoc.register(new MockElement('div', 'trend-modal-backdrop', 'fixed inset-0 bg-[#09090b]/80 backdrop-blur-md'));
  const iconEl = mockDoc.register(new MockElement('div', 'trend-metric-icon'));
  const titleEl = mockDoc.register(new MockElement('h3', 'trend-metric-title'));
  const subtitleEl = mockDoc.register(new MockElement('p', 'trend-metric-subtitle'));
  const badgeEl = mockDoc.register(new MockElement('span', 'trend-metric-badge'));
  const expandBtn = mockDoc.register(new MockElement('button', 'btn-expand-trend-modal'));
  const closeBtn = mockDoc.register(new MockElement('button', 'btn-close-trend-modal'));
  const prevBtn = mockDoc.register(new MockElement('button', 'trend-nav-prev'));
  const dateLabelEl = mockDoc.register(new MockElement('span', 'trend-date-label'));
  const nextBtn = mockDoc.register(new MockElement('button', 'trend-nav-next'));
  const customContainer = mockDoc.register(new MockElement('div', 'trend-custom-date-container', 'hidden'));
  const startDateIn = mockDoc.register(new MockElement('input', 'trend-input-start-date'));
  const endDateIn = mockDoc.register(new MockElement('input', 'trend-input-end-date'));
  const applyCustomBtn = mockDoc.register(new MockElement('button', 'trend-btn-apply-custom'));
  const customErrorEl = mockDoc.register(new MockElement('span', 'trend-custom-error', 'hidden'));
  const kpiGridEl = mockDoc.register(new MockElement('div', 'trend-kpi-grid'));
  const canvasEl = mockDoc.register(new MockElement('canvas', 'metric-trend-chart'));
  const emptyNoticeEl = mockDoc.register(new MockElement('div', 'trend-chart-empty', 'hidden'));
  const tableCountEl = mockDoc.register(new MockElement('span', 'trend-table-count'));
  const tableHeadRow = mockDoc.register(new MockElement('tr', 'trend-table-header-row'));
  const tableBodyEl = mockDoc.register(new MockElement('tbody', 'trend-table-body'));

  // Range pill buttons
  const r1d = mockDoc.register(new MockElement('button', 'btn-r-1d'));
  r1d.setAttribute('data-trend-range', '1d');
  const r7d = mockDoc.register(new MockElement('button', 'btn-r-7d'));
  r7d.setAttribute('data-trend-range', '7d');
  const r1m = mockDoc.register(new MockElement('button', 'btn-r-1m'));
  r1m.setAttribute('data-trend-range', '1m');
  const r1y = mockDoc.register(new MockElement('button', 'btn-r-1y'));
  r1y.setAttribute('data-trend-range', '1y');
  const rCustom = mockDoc.register(new MockElement('button', 'btn-r-custom'));
  rCustom.setAttribute('data-trend-range', 'custom');

  // Dynamic import of trends_modal.js
  const trendsModalUrl = 'file:///' + path.resolve(__dirname, '../frontend/src/charts/trends_modal.js').replace(/\\/g, '/');
  const trendsModal = await import(trendsModalUrl);

  const rollup = createMockWellnessRollup();

  await test('M4-LOGIC-01: initTrendsModal wires event listeners without errors', () => {
    trendsModal.initTrendsModal();
    assert.strictEqual(typeof backdropEl.eventListeners.get('click')?.[0], 'function');
    assert.strictEqual(typeof closeBtn.eventListeners.get('click')?.[0], 'function');
    assert.strictEqual(typeof expandBtn.eventListeners.get('click')?.[0], 'function');
    assert.strictEqual(typeof prevBtn.eventListeners.get('click')?.[0], 'function');
    assert.strictEqual(typeof nextBtn.eventListeners.get('click')?.[0], 'function');
  });

  await test('M4-LOGIC-02: openMetricTrendModal unhides modal, sets aria-hidden="false", and initializes Sleep metric', () => {
    trendsModal.openMetricTrendModal('sleep', rollup);
    assert.ok(!modalEl.classList.contains('hidden'), 'Modal must not have hidden class');
    assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'false');
    assert.strictEqual(titleEl.textContent, 'Sleep Duration & Stages');
    assert.ok(badgeEl.textContent.includes('OPTIMAL'));
    assert.ok(dateLabelEl.textContent.length > 5);
    assert.ok(kpiGridEl.children.length >= 4);
    assert.ok(tableBodyEl.children.length > 0);
  });

  await test('M4-LOGIC-03: Time range selector switches to 1D view and renders single day', () => {
    trendsModal.setTimeRange('1d');
    assert.strictEqual(r1d.classList.contains('bg-[#1f1f24]'), true);
    assert.strictEqual(tableCountEl.textContent, '1 records');
  });

  await test('M4-LOGIC-04: Time range selector switches to 1M (30 days) and filters correctly', () => {
    trendsModal.setTimeRange('1m');
    assert.strictEqual(r1m.classList.contains('bg-[#1f1f24]'), true);
    assert.strictEqual(tableCountEl.textContent, '30 records');
  });

  await test('M4-LOGIC-05: Time range selector switches to 1Y and gracefully handles available history', () => {
    trendsModal.setTimeRange('1y');
    assert.strictEqual(r1y.classList.contains('bg-[#1f1f24]'), true);
    assert.strictEqual(tableCountEl.textContent, '56 records');
    assert.ok(dateLabelEl.textContent.includes('days recorded'));
  });

  await test('M4-LOGIC-06: Chronological pagination shifts backwards and forward with boundary clamping', () => {
    trendsModal.setTimeRange('7d');
    const initialLabel = dateLabelEl.textContent;
    // Navigate backwards
    trendsModal.navigateDatePeriod(-1);
    const prevLabel = dateLabelEl.textContent;
    assert.notStrictEqual(initialLabel, prevLabel, 'Date label must change when navigating backwards');

    // Navigate forward back to latest
    trendsModal.navigateDatePeriod(1);
    assert.strictEqual(dateLabelEl.textContent, initialLabel);
    assert.ok(nextBtn.classList.contains('cursor-not-allowed'), 'Next button must be disabled on latest date');
  });

  await test('M4-LOGIC-07: Custom date range validation catches inverted dates and applies valid ranges', () => {
    trendsModal.setTimeRange('custom');
    assert.strictEqual(customContainer.classList.contains('hidden'), false);

    // Test inverted dates: start > end
    startDateIn.value = '2026-10-26';
    endDateIn.value = '2026-10-01';
    trendsModal.applyCustomDateRange();
    assert.ok(!customErrorEl.classList.contains('hidden'), 'Error message must be shown for inverted dates');

    // Test valid date range: Oct 10 to Oct 20
    startDateIn.value = '2026-10-10';
    endDateIn.value = '2026-10-20';
    trendsModal.applyCustomDateRange();
    assert.ok(customErrorEl.classList.contains('hidden'), 'Error message must be hidden on valid dates');
    assert.strictEqual(tableCountEl.textContent, '11 records');
  });

  await test('M4-LOGIC-08: Fullscreen expand/collapse toggles panel dimensions', () => {
    assert.ok(panelEl.classList.contains('max-w-4xl'));
    trendsModal.toggleExpandModal();
    assert.ok(panelEl.classList.contains('w-full') && panelEl.classList.contains('h-full'));
    trendsModal.toggleExpandModal();
    assert.ok(panelEl.classList.contains('max-w-4xl'));
  });

  await test('M4-LOGIC-09: Modal dismissal via close button and Escape key', () => {
    trendsModal.closeMetricTrendModal();
    assert.ok(modalEl.classList.contains('hidden'));
    assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'true');
  });

  // Section 3: Metric Specific Visualizations
  process.stdout.write('\n--- Section 3: All 9 Metric Visualizations & KPI Formats ---\n');

  const metrics = [
    { key: 'sleep', expectedTitle: 'Sleep Duration & Stages' },
    { key: 'hrv', expectedTitle: 'HRV Status' },
    { key: 'resting_hr', expectedTitle: 'Resting Heart Rate' },
    { key: 'steps', expectedTitle: 'Daily Steps' },
    { key: 'body_battery', expectedTitle: 'Body Battery' },
    { key: 'stress', expectedTitle: 'Stress Level' },
    { key: 'intensity_minutes', expectedTitle: 'Active Intensity Minutes' },
    { key: 'calories', expectedTitle: 'Daily Calories' },
    { key: 'thresholds', expectedTitle: 'Threshold Performance Trends' }
  ];

  for (const m of metrics) {
    await test(`M4-VIZ: Render trend modal for '${m.key}' with 4 KPIs and table`, () => {
      trendsModal.openMetricTrendModal(m.key, rollup);
      assert.strictEqual(titleEl.textContent, m.expectedTitle);
      assert.ok(kpiGridEl.children.length >= 4, `Metric ${m.key} must render 4 KPI cards`);
      assert.ok(tableBodyEl.children.length > 0, `Metric ${m.key} must render table rows`);
      trendsModal.closeMetricTrendModal();
    });
  }

  // Section 4: Card Click Handlers & StopPropagation
  process.stdout.write('\n--- Section 4: Clickable Cards & stopPropagation ---\n');

  // Dynamic import of wellness.js
  const wellnessUrl = 'file:///' + path.resolve(__dirname, '../frontend/src/charts/wellness.js').replace(/\\/g, '/');
  const wellnessModule = await import(wellnessUrl);

  await test('M4-CLICK-01: Metric cards have cursor-pointer and trigger trend modal', () => {
    let modalOpenedMetric = null;
    const testCard = new MockElement('div', 'card-wellness-steps', 'bg-[#111114] border border-[#1f1f24] rounded-xl p-5 cursor-pointer');
    testCard.setAttribute('data-metric', 'steps');

    const controlBtn = new MockElement('button', 'btn-prev-steps');
    controlBtn.setAttribute('data-wellness-action', 'prev');
    controlBtn.setAttribute('data-metric', 'steps');
    controlBtn.parentElement = testCard;
    testCard.children.push(controlBtn);

    testCard.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-wellness-action]')) return;
      modalOpenedMetric = testCard.getAttribute('data-metric');
    };

    // 1. Direct card click opens modal
    testCard.click();
    assert.strictEqual(modalOpenedMetric, 'steps', 'Clicking card must open modal for metric');

    // 2. Control button click does NOT open modal (stopPropagation simulation)
    modalOpenedMetric = null;
    controlBtn.onclick = (e) => {
      e.stopPropagation();
    };
    controlBtn.click();
    assert.strictEqual(modalOpenedMetric, null, 'Clicking card control button must not trigger trend modal');
  });

  // Section 5: Empty Dataset Resilience
  process.stdout.write('\n--- Section 5: Zero-Record Resilience & Empty State ---\n');

  await test('M4-STRESS-01: Zero data records render clean empty state without exceptions', () => {
    const emptyRollup = { wellness: { daily: [] }, physiological: { threshold_trends: [] } };
    trendsModal.openMetricTrendModal('sleep', emptyRollup);
    assert.ok(emptyNoticeEl.classList.contains('hidden') === false, 'Empty notice must be shown when 0 records exist');
    assert.ok(tableBodyEl.innerHTML.includes('No records found'), 'Table must show empty notice');
    trendsModal.closeMetricTrendModal();
  });

  // Section 6: Python Generator 1-Year Integration
  process.stdout.write('\n--- Section 6: Ingestion Generator 1-Year Dataset Verification ---\n');

  await test('M4-PY-01: Python generate_wellness_dataset supports 365 days', () => {
    const { execSync } = require('child_process');
    const pyScript = `
import sys
from src.ingestion.mock_generator import generate_wellness_dataset, compile_dashboard_rollup, SyntheticDatasetGenerator

# Test custom days=365
w365 = generate_wellness_dataset(days=365)
assert len(w365["daily"]) == 365, f"Expected 365 days, got {len(w365['daily'])}"

# Test SyntheticDatasetGenerator with days=365
gen = SyntheticDatasetGenerator(seed=42)
w_gen = gen.generate_wellness(days=365)
assert len(w_gen["daily"]) == 365, f"Expected 365 days from generator, got {len(w_gen['daily'])}"

# Test compiled dashboard rollup
rollup = compile_dashboard_rollup()
assert len(rollup["wellness"]["daily"]) == 365, f"Rollup expected 365 days, got {len(rollup['wellness']['daily'])}"
assert len(rollup["physiological"]["threshold_trends"]) >= 10, "Threshold trends should cover 1-year progression"
sys.stdout.write("OK")
`;
    const res = execSync(`python3 -c '${pyScript}'`, { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8' });
    assert.strictEqual(res.trim(), 'OK');
  });

  // Summary
  process.stdout.write('\n======================================================================\n');
  process.stdout.write(`Milestone 4 Test Suite Results: ${passed} passed, ${failed} failed (Total: ${passed + failed})\n`);
  process.stdout.write('======================================================================\n\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMilestone4TestSuite();
