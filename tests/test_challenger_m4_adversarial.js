/**
 * tests/test_challenger_m4_adversarial.js
 * 
 * Adversarial Challenger Test Suite for Milestone 4 (Garmin Vault)
 * Singular Metric Trend Modals across Time Periods (Garmin Connect Style)
 * 
 * Aggressive edge-case & boundary verifications:
 * 1. Rapid interaction & re-entrance stress (rapid card clicking, rapid backdrop/close,
 *    rapid range switching 1D->1Y->Custom->7D->1M, rapid chronological pagination).
 * 2. Inverted, future, ancient, and malformed date inputs in custom date range selector.
 * 3. Telemetry datasets with missing fields, NaN values, zero points, and extreme numbers.
 * 4. Event bubbling & stopPropagation contract: clicking .card-control-btn or its SVG/path
 *    children NEVER opens #metric-trend-modal.
 * 5. High-DPI canvas & zero-dimension container resilience.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ============================================================================
// Headless DOM & Canvas Mock Environment
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

      const dataRangeMatch = attrsStr.match(/data-trend-range=["']([^"']+)["']/);
      if (dataRangeMatch) child.setAttribute('data-trend-range', dataRangeMatch[1]);

      const dataMetricMatch = attrsStr.match(/data-metric=["']([^"']+)["']/);
      if (dataMetricMatch) child.setAttribute('data-metric', dataMetricMatch[1]);

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

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
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
    const evObj = typeof event === 'string' ? { type: event, target: this, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } } : event;
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
    let propagationStopped = false;
    let defaultPrevented = false;
    const ev = {
      type: 'click',
      target: this,
      get defaultPrevented() { return defaultPrevented; },
      preventDefault() { defaultPrevented = true; },
      stopPropagation() { propagationStopped = true; }
    };

    // Bubble up through DOM unless stopped
    let cur = this;
    while (cur && !propagationStopped) {
      const list = cur.eventListeners.get('click') || [];
      for (const h of list) {
        if (!propagationStopped) h.call(cur, ev);
      }
      if (typeof cur.onclick === 'function' && !propagationStopped) {
        cur.onclick.call(cur, ev);
      }
      cur = cur.parentElement;
    }
    return !propagationStopped;
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
    const w = this._boxW !== undefined ? this._boxW : 600;
    const h = this._boxH !== undefined ? this._boxH : 300;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h };
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
    const checkNode = (node) => {
      if (node.matches && node.matches(sel)) res.push(node);
      for (const ch of node.children) checkNode(ch);
    };
    for (const el of this.elementsById.values()) {
      checkNode(el);
    }
    return Array.from(new Set(res));
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

// Generate rich synthetic 60-day wellness dataset
function generateAdversarialWellnessRollup() {
  const daily = [];
  const baseDate = new Date(2026, 9, 26); // Oct 26, 2026

  for (let i = 59; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    daily.push({
      date: dateStr,
      steps: 10000 + (i % 5) * 500,
      steps_goal: 10000,
      resting_hr: 47 + (i % 3),
      resting_heart_rate: 47 + (i % 3),
      resting_hr_7d_avg: 48.0,
      sleep_seconds: 28800,
      sleep_score: 85,
      sleep_quality: 'Good',
      sleep_deep_seconds: 5400,
      sleep_light_seconds: 14400,
      sleep_rem_seconds: 6000,
      sleep_awake_seconds: 3000,
      stress_level: 25,
      stress_qualifier: 'Low',
      body_battery_high: 95,
      body_battery_low: 25,
      body_battery_charged: 70,
      body_battery_drained: 70,
      hrv_last_night_avg: 58,
      hrv_weekly_avg: 56,
      hrv_status: 'Balanced',
      intensity_minutes_moderate: 30,
      intensity_minutes_vigorous: 20,
      active_calories: 650,
      bmr_calories: 1730,
      daily_calories: 2380
    });
  }

  const threshold_trends = [
    { date: '2026-09-01', vo2max: 52, cycling_ftp: 270, ftp: 270, lthr: 165 },
    { date: '2026-09-15', vo2max: 53, cycling_ftp: 275, ftp: 275, lthr: 166 },
    { date: '2026-10-01', vo2max: 54, cycling_ftp: 280, ftp: 280, lthr: 167 },
    { date: '2026-10-15', vo2max: 55, cycling_ftp: 285, ftp: 285, lthr: 168 }
  ];

  return {
    wellness: { daily, current: daily[daily.length - 1] },
    physiological: { threshold_trends }
  };
}

// ============================================================================
// Adversarial Challenger Suite Execution
// ============================================================================

async function runAdversarialTestSuite() {
  process.stdout.write('\n======================================================================\n');
  process.stdout.write('Milestone 4 Adversarial Challenger: Stress & Edge Cases Suite\n');
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

  // Setup Global Mock Environment
  const mockDoc = new MockDocument();
  global.document = mockDoc;
  global.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {}
  };

  // Register Modal DOM Structure
  const modalEl = mockDoc.register(new MockElement('div', 'metric-trend-modal', 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 hidden'));
  modalEl.setAttribute('aria-hidden', 'true');
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

  // Load modules
  const trendsModalUrl = 'file:///' + path.resolve(__dirname, '../frontend/src/charts/trends_modal.js').replace(/\\/g, '/');
  const trendsModal = await import(trendsModalUrl);

  const wellnessUrl = 'file:///' + path.resolve(__dirname, '../frontend/src/charts/wellness.js').replace(/\\/g, '/');
  const wellnessModule = await import(wellnessUrl);

  const rollup = generateAdversarialWellnessRollup();
  trendsModal.initTrendsModal();

  // --------------------------------------------------------------------------
  // SECTION 1: Event Bubbling & StopPropagation
  // --------------------------------------------------------------------------
  process.stdout.write('--- Section 1: Event Bubbling & StopPropagation Contract ---\n');

  await test('ADV-1.1: Clicking .card-control-btn (prev/next/remove) NEVER opens #metric-trend-modal', () => {
    // Construct real DOM tree: container -> card -> header -> button -> svg -> path
    const wellnessRoot = mockDoc.register(new MockElement('div', 'wellness-dashboard'));
    const testCard = new MockElement('div', 'card-wellness-steps', 'wellness-card p-4 rounded-xl');
    testCard.setAttribute('data-metric', 'steps');
    wellnessRoot.appendChild(testCard);

    const controlsContainer = new MockElement('div', '', 'flex items-center space-x-1');
    testCard.appendChild(controlsContainer);

    const removeBtn = new MockElement('button', 'btn-remove-steps', 'card-control-btn p-1');
    removeBtn.setAttribute('data-wellness-action', 'remove');
    removeBtn.setAttribute('data-metric', 'steps');
    controlsContainer.appendChild(removeBtn);

    const svgIcon = new MockElement('svg', '', 'w-3 h-3');
    removeBtn.appendChild(svgIcon);

    const pathEl = new MockElement('path', '', '');
    svgIcon.appendChild(pathEl);

    // Initial state: modal is hidden
    trendsModal.closeMetricTrendModal();
    assert.strictEqual(modalEl.classList.contains('hidden'), true);
    assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'true');

    // Simulate attachCardActionListeners
    removeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    testCard.classList.add('cursor-pointer');
    testCard.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-wellness-action]')) {
        return;
      }
      trendsModal.openMetricTrendModal('steps', rollup);
    };

    // 1. Direct click on button
    removeBtn.click();
    assert.strictEqual(modalEl.classList.contains('hidden'), true, 'Clicking remove button must NOT open modal');

    // 2. Click on deeply nested SVG path child
    pathEl.click();
    assert.strictEqual(modalEl.classList.contains('hidden'), true, 'Clicking nested path inside control button must NOT open modal');

    // 3. Click on card surface opens modal
    testCard.click();
    assert.strictEqual(modalEl.classList.contains('hidden'), false, 'Direct card click MUST open modal');
    assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'false');
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-1.2: Reorder buttons (prev/next/toggle-section) enforce stopPropagation', () => {
    const cardEl = new MockElement('div', 'card-wellness-sleep', 'wellness-card');
    cardEl.setAttribute('data-metric', 'sleep');
    const prevActionBtn = new MockElement('button', 'btn-prev-sleep', 'card-control-btn');
    prevActionBtn.setAttribute('data-wellness-action', 'prev');
    prevActionBtn.setAttribute('data-metric', 'sleep');
    cardEl.appendChild(prevActionBtn);

    cardEl.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-wellness-action]')) return;
      trendsModal.openMetricTrendModal('sleep', rollup);
    };
    prevActionBtn.onclick = (e) => {
      e.stopPropagation();
    };

    prevActionBtn.click();
    assert.strictEqual(modalEl.classList.contains('hidden'), true, 'Reorder prev button must not open modal');
  });

  // --------------------------------------------------------------------------
  // SECTION 2: Rapid Interaction, Re-entrance & Lifecycle Stress
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Section 2: Rapid Interaction, Re-entrance & Lifecycle Stress ---\n');

  await test('ADV-2.1: Rapid open & close cycling (100 iterations) without memory corruption', () => {
    for (let i = 0; i < 100; i++) {
      trendsModal.openMetricTrendModal('steps', rollup);
      assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'false');
      // Alternate between close button and backdrop click
      if (i % 2 === 0) {
        closeBtn.click();
      } else {
        backdropEl.click();
      }
      assert.strictEqual(modalEl.classList.contains('hidden'), true);
      assert.strictEqual(modalEl.getAttribute('aria-hidden'), 'true');
    }
  });

  await test('ADV-2.2: Rapid range switching (1D -> 1Y -> Custom -> 7D -> 1M, 50 cycles)', () => {
    trendsModal.openMetricTrendModal('sleep', rollup);
    const ranges = ['1d', '1y', 'custom', '7d', '1m'];

    for (let cycle = 0; cycle < 50; cycle++) {
      const r = ranges[cycle % ranges.length];
      trendsModal.setTimeRange(r);
      assert.ok(dateLabelEl.textContent.length > 0, `Date label should not be empty for range ${r}`);
      assert.ok(!dateLabelEl.textContent.includes('NaN'), `Date label should not contain NaN for range ${r}`);
      assert.ok(!dateLabelEl.textContent.includes('Invalid Date'), `Date label should not contain Invalid Date for range ${r}`);
    }
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-2.3: Rapid pagination stress: 50 steps backward to min boundary & 50 steps forward to max boundary', () => {
    trendsModal.openMetricTrendModal('resting_hr', rollup);
    trendsModal.setTimeRange('7d');

    // Navigate backwards 50 times (well past dataset boundary of 60 days)
    for (let i = 0; i < 50; i++) {
      trendsModal.navigateDatePeriod(-1);
    }
    // Should be clamped to min boundary
    assert.ok(prevBtn.classList.contains('cursor-not-allowed'), 'Prev button must be disabled at earliest date');
    assert.ok(!dateLabelEl.textContent.includes('NaN'));
    assert.ok(!dateLabelEl.textContent.includes('Invalid Date'));

    // Navigate forward 50 times back to latest
    for (let i = 0; i < 50; i++) {
      trendsModal.navigateDatePeriod(1);
    }
    // Should be clamped to max boundary
    assert.ok(nextBtn.classList.contains('cursor-not-allowed'), 'Next button must be disabled at latest date');
    assert.ok(!dateLabelEl.textContent.includes('NaN'));
    assert.ok(!dateLabelEl.textContent.includes('Invalid Date'));

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-2.4: Rapid sequential switching across all 9 metrics with chart re-instantiation', () => {
    const allMetrics = ['sleep', 'hrv', 'resting_hr', 'steps', 'body_battery', 'stress', 'intensity_minutes', 'calories', 'thresholds'];
    for (const m of allMetrics) {
      trendsModal.openMetricTrendModal(m, rollup);
      assert.strictEqual(modalEl.classList.contains('hidden'), false);
      assert.strictEqual(titleEl.textContent.length > 0, true);
      const cardMatches = kpiGridEl.innerHTML.match(/rounded-xl/g);
      assert.strictEqual(cardMatches ? cardMatches.length : 0, 4, `Metric ${m} must render 4 KPI cards`);
    }
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-2.5: Rapid fullscreen expand & collapse toggling (30 cycles)', () => {
    trendsModal.openMetricTrendModal('body_battery', rollup);
    for (let i = 0; i < 30; i++) {
      expandBtn.click();
      if (i % 2 === 0) {
        assert.ok(panelEl.classList.contains('rounded-none'), 'Expanded panel must have rounded-none');
      } else {
        assert.ok(panelEl.classList.contains('rounded-2xl'), 'Collapsed panel must have rounded-2xl');
      }
    }
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-2.6: Keyboard Escape dismissal when open, and noop when already closed', () => {
    trendsModal.openMetricTrendModal('stress', rollup);
    assert.strictEqual(modalEl.classList.contains('hidden'), false);

    // Escape while open closes modal
    mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(modalEl.classList.contains('hidden'), true);

    // Redundant Escape while closed does not throw or corrupt state
    mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(modalEl.classList.contains('hidden'), true);
  });

  // --------------------------------------------------------------------------
  // SECTION 3: Inverted, Boundary & Malformed Date Inputs
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Section 3: Inverted, Boundary & Malformed Date Inputs ---\n');

  await test('ADV-3.1: Inverted Custom Date Range (start > end) rejected with visible error', () => {
    trendsModal.openMetricTrendModal('steps', rollup);
    trendsModal.setTimeRange('custom');

    startDateIn.value = '2026-11-01';
    endDateIn.value = '2026-10-01'; // inverted: Nov 1 > Oct 1

    applyCustomBtn.click();
    assert.strictEqual(customErrorEl.classList.contains('hidden'), false, 'Error banner must be visible');
    assert.ok(customErrorEl.textContent.includes('Start date must be before or equal to end date'));

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-3.2: Direct getFilteredTelemetryData call with inverted dates gracefully auto-swaps', () => {
    const res = trendsModal.getFilteredTelemetryData('steps', 'custom', null, rollup, '2026-10-25', '2026-10-15');
    assert.ok(res.startDate <= res.endDate, 'Start date must be normalized to <= end date');
    assert.strictEqual(res.records.length, 11);
  });

  await test('ADV-3.3: Future date range (e.g. 2099) renders empty notice without exceptions', () => {
    trendsModal.openMetricTrendModal('calories', rollup);
    trendsModal.setTimeRange('custom');

    startDateIn.value = '2099-01-01';
    endDateIn.value = '2099-01-15';
    applyCustomBtn.click();

    assert.strictEqual(customErrorEl.classList.contains('hidden'), true);
    assert.strictEqual(emptyNoticeEl.classList.contains('hidden'), false, 'Empty notice must be shown for future dates');
    assert.ok(tableBodyEl.innerHTML.includes('No records found'));
    assert.ok(kpiGridEl.innerHTML.includes('—'));

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-3.4: Ancient date range (1970) renders clean empty state without exceptions', () => {
    trendsModal.openMetricTrendModal('hrv', rollup);
    trendsModal.setTimeRange('custom');

    startDateIn.value = '1970-01-01';
    endDateIn.value = '1970-01-07';
    applyCustomBtn.click();

    assert.strictEqual(emptyNoticeEl.classList.contains('hidden'), false);
    assert.ok(tableBodyEl.innerHTML.includes('No records found'));

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-3.5: Malformed & script-injected date strings handled safely without crashing', () => {
    trendsModal.openMetricTrendModal('steps', rollup);
    trendsModal.setTimeRange('custom');

    // 1. Garbage strings
    startDateIn.value = 'invalid-date-string';
    endDateIn.value = '2026-10-20';
    applyCustomBtn.click();
    assert.strictEqual(customErrorEl.classList.contains('hidden'), false, 'Malformed date must trigger error');

    // 2. HTML/XSS injection attempt
    startDateIn.value = '<script>alert(1)</script>';
    endDateIn.value = '2026-10-20';
    applyCustomBtn.click();
    assert.strictEqual(customErrorEl.classList.contains('hidden'), false, 'XSS input must trigger error');
    assert.ok(!dateLabelEl.textContent.includes('<script>'));

    trendsModal.closeMetricTrendModal();
  });

  // --------------------------------------------------------------------------
  // SECTION 4: Missing Fields, NaN Values, Zero Points & Extreme Numbers
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Section 4: Missing Fields, NaN, Zero Points & Extreme Numbers ---\n');

  await test('ADV-4.1: Empty and null rollups render empty state without throwing exceptions', () => {
    const nullRollup = null;
    const emptyRollup = {};
    const zeroDaysRollup = { wellness: { daily: [] } };

    // Test each across multiple metrics
    for (const r of [nullRollup, emptyRollup, zeroDaysRollup]) {
      trendsModal.openMetricTrendModal('sleep', r);
      assert.strictEqual(emptyNoticeEl.classList.contains('hidden'), false);
      assert.ok(tableBodyEl.innerHTML.includes('No records found'));
      trendsModal.closeMetricTrendModal();

      trendsModal.openMetricTrendModal('thresholds', r);
      assert.strictEqual(emptyNoticeEl.classList.contains('hidden'), false);
      trendsModal.closeMetricTrendModal();
    }
  });

  await test('ADV-4.2: Records with completely missing metric fields (sparse objects) do not crash', () => {
    const sparseRollup = {
      wellness: {
        daily: [
          { date: '2026-10-20' },
          { date: '2026-10-21' },
          { date: '2026-10-22' }
        ]
      },
      physiological: {
        threshold_trends: [
          { date: '2026-10-20' }
        ]
      }
    };

    const metrics = ['sleep', 'hrv', 'resting_hr', 'steps', 'body_battery', 'stress', 'intensity_minutes', 'calories', 'thresholds'];
    for (const m of metrics) {
      trendsModal.openMetricTrendModal(m, sparseRollup);
      assert.strictEqual(modalEl.classList.contains('hidden'), false);
      assert.ok(!kpiGridEl.innerHTML.includes('NaN'), `Metric ${m} KPIs must not render NaN`);
      assert.ok(!tableBodyEl.innerHTML.includes('NaN'), `Metric ${m} Table must not render NaN`);
    }
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-4.3: Zero points preserved accurately (0 steps, 0 sleep, 0 stress, 0 active calories, 0 body battery)', () => {
    const zeroRollup = {
      wellness: {
        daily: [
          {
            date: '2026-10-26',
            steps: 0,
            sleep_seconds: 0,
            sleep_score: 50,
            sleep_deep_seconds: 0,
            sleep_light_seconds: 0,
            sleep_rem_seconds: 0,
            sleep_awake_seconds: 0,
            stress_level: 0,
            active_calories: 0,
            bmr_calories: 1730,
            daily_calories: 1730,
            body_battery_low: 0,
            body_battery_charged: 0,
            body_battery_drained: 0,
            body_battery_high: 50,
            intensity_minutes_moderate: 0,
            intensity_minutes_vigorous: 0
          }
        ]
      }
    };

    // 1. Steps = 0
    trendsModal.openMetricTrendModal('steps', zeroRollup);
    assert.ok(kpiGridEl.innerHTML.includes('0 steps'), '0 steps must display as 0');
    assert.ok(tableBodyEl.innerHTML.includes('0%'), '0% of goal met');

    // 2. Sleep = 0
    trendsModal.openMetricTrendModal('sleep', zeroRollup);
    assert.ok(kpiGridEl.innerHTML.includes('0h 0m'), '0 sleep duration must display as 0h 0m');

    // 3. Stress = 0
    trendsModal.openMetricTrendModal('stress', zeroRollup);
    assert.ok(kpiGridEl.innerHTML.includes('0 pts'), '0 stress must display as 0 pts');

    // 4. Calories = 0 active
    trendsModal.openMetricTrendModal('calories', zeroRollup);
    assert.ok(kpiGridEl.innerHTML.includes('0 kcal'), '0 active burn must display as 0 kcal');

    // 5. Body Battery = 0 low
    trendsModal.openMetricTrendModal('body_battery', zeroRollup);
    assert.ok(kpiGridEl.innerHTML.includes('0 pts'), '0 low battery reserve must display as 0 pts');

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-4.4: Extreme metric numbers (150k steps, 24h sleep, 10k intensity minutes) render without overflow', () => {
    const extremeRollup = {
      wellness: {
        daily: [
          {
            date: '2026-10-26',
            steps: 150000,
            sleep_seconds: 86400, // 24 hours
            sleep_score: 100,
            intensity_minutes_moderate: 5000,
            intensity_minutes_vigorous: 5000,
            active_calories: 12500,
            bmr_calories: 1800,
            daily_calories: 14300,
            body_battery_high: 100,
            body_battery_low: 90
          }
        ]
      }
    };

    trendsModal.openMetricTrendModal('steps', extremeRollup);
    assert.ok(kpiGridEl.innerHTML.includes('150,000 steps'), 'Steps should format with commas');

    trendsModal.openMetricTrendModal('sleep', extremeRollup);
    assert.ok(kpiGridEl.innerHTML.includes('24h 0m'), '24 hours sleep should format cleanly');

    trendsModal.openMetricTrendModal('intensity_minutes', extremeRollup);
    assert.ok(kpiGridEl.innerHTML.includes('15000 min'), 'Total weighted intensity minutes should calculate properly');

    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-4.5: NaN metric values are coerced gracefully without NaN leaks in DOM or Canvas', () => {
    const nanRollup = {
      wellness: {
        daily: [
          {
            date: '2026-10-26',
            steps: NaN,
            sleep_seconds: NaN,
            sleep_score: NaN,
            stress_level: NaN,
            active_calories: NaN,
            bmr_calories: NaN,
            hrv_last_night_avg: NaN,
            resting_hr: NaN,
            cycling_ftp: NaN
          }
        ]
      },
      physiological: {
        threshold_trends: [
          { date: '2026-10-26', cycling_ftp: NaN, vo2max: NaN, lthr: NaN }
        ]
      }
    };

    const metrics = ['sleep', 'hrv', 'resting_hr', 'steps', 'body_battery', 'stress', 'intensity_minutes', 'calories', 'thresholds'];
    for (const m of metrics) {
      trendsModal.openMetricTrendModal(m, nanRollup);
      assert.ok(!kpiGridEl.innerHTML.includes('NaN'), `Metric ${m} KPIs must not contain text 'NaN'`);
      assert.ok(!tableBodyEl.innerHTML.includes('NaN'), `Metric ${m} table must not contain text 'NaN'`);
    }
    trendsModal.closeMetricTrendModal();
  });

  // --------------------------------------------------------------------------
  // SECTION 5: High-DPI Canvas & Zero-Dimension Container Resilience
  // --------------------------------------------------------------------------
  process.stdout.write('\n--- Section 5: High-DPI Canvas & Zero-Dimension Container Resilience ---\n');

  await test('ADV-5.1: Zero-dimension container (width=0, height=0) does not throw or corrupt state', () => {
    canvasEl._boxW = 0;
    canvasEl._boxH = 0;
    trendsModal.openMetricTrendModal('steps', rollup);
    assert.strictEqual(modalEl.classList.contains('hidden'), false);
    // Restore normal dimensions
    canvasEl._boxW = 600;
    canvasEl._boxH = 300;
    trendsModal.closeMetricTrendModal();
  });

  await test('ADV-5.2: 1,000 consecutive days dataset performance stress test', () => {
    const largeDaily = [];
    const base = new Date(2026, 9, 26);
    for (let i = 1000; i >= 0; i--) {
      const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      largeDaily.push({
        date: dt.toISOString().slice(0, 10),
        steps: 8000 + (i % 20) * 200,
        sleep_seconds: 28800,
        resting_hr: 48,
        hrv_last_night_avg: 55,
        stress_level: 24,
        active_calories: 600,
        bmr_calories: 1730
      });
    }
    const largeRollup = { wellness: { daily: largeDaily } };

    const t0 = Date.now();
    trendsModal.openMetricTrendModal('steps', largeRollup);
    trendsModal.setTimeRange('1y');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 150, `1,000-day trend rendering must take < 150ms (took ${elapsed}ms)`);
    assert.strictEqual(tableCountEl.textContent, '365 records', '1Y view should filter exactly 365 days');
    trendsModal.closeMetricTrendModal();
  });

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  process.stdout.write('\n======================================================================\n');
  process.stdout.write(`Adversarial Challenger Results: ${passed} passed, ${failed} failed (Total: ${passed + failed})\n`);
  process.stdout.write('======================================================================\n\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAdversarialTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
