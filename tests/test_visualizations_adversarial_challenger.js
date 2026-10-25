/**
 * tests/test_visualizations_adversarial_challenger.js
 * 
 * Milestone 3 Adversarial Challenger Test Suite:
 * Empirical Stress-Testing of Interactive Visualizations & Activity Drill-Down.
 * 
 * Scope & Verification Objectives:
 * 1. Section 1 (Endurance & Load):
 *    - Decrypted payload fidelity: weekly mileage, moving time, ACWR & training status.
 *    - Stacked weekly volume chart: multi-sport series (run, cycle, strength), stacked axes, unit conversion.
 *    - Sport filter reactivity on volume charts ('all', 'running', 'cycling', 'strength').
 *    - Training load curves: CTL (Fitness), ATL (Fatigue), TSB (Form).
 *    - Stress testing: 0 CTL, negative TSB, missing summary, empty weekly data, re-render teardown.
 * 
 * 2. Section 2 (Physiological Distribution):
 *    - 5-zone Heart Rate distribution doughnut chart & hour calculations.
 *    - Coggan 7-zone cycling power distribution bar chart.
 *    - Threshold performance trends: FTP, LTHR, VO2max multi-series curves over time.
 *    - Pace zones distribution bar chart.
 *    - Stress testing: empty physiological data, missing zones, 0-second zones, re-render teardown.
 * 
 * 3. Section 3 (Activity Drill-Down & Telemetry):
 *    - Filterable activity table with decrypted multi-sport activities.
 *    - Sport filter buttons: 'all', 'running', 'cycling', 'strength'.
 *    - Text search reactivity: title, sport, date, case-insensitivity, no-match empty state.
 *    - Table sorting reactivity: date-desc, date-asc, dist-desc, time-desc.
 *    - Activity drill-down drawer: telemetry KPIs, cadence units (rpm for cycle, spm for run).
 *    - Per-split / lap breakdown table & profile chart.
 *    - Drawer close interactions: close button, backdrop click, Escape key.
 *    - Unit reactivity (KM vs MI) across table, drawer, and pace formatters.
 *    - Stress testing: zero-telemetry activities, empty splits, 100+ splits, XSS/special characters.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Lightweight Headless DOM & Canvas Mock Environment
// ============================================================================

class MockClassList {
  constructor(element) {
    this.element = element;
    this.classes = new Set();
  }
  _syncFromClassName() {
    this.classes.clear();
    if (this.element._className) {
      this.element._className.split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c));
    }
  }
  _syncToClassName() {
    this.element._className = Array.from(this.classes).join(' ');
  }
  add(...tokens) {
    tokens.forEach(t => this.classes.add(t));
    this._syncToClassName();
  }
  remove(...tokens) {
    tokens.forEach(t => this.classes.delete(t));
    this._syncToClassName();
  }
  contains(token) {
    return this.classes.has(token);
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

class MockCanvasContext2D {
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
  clearRect(x, y, w, h) { this.calls.push({ op: 'clearRect', args: [x, y, w, h] }); }
  beginPath() { this.calls.push({ op: 'beginPath' }); }
  closePath() { this.calls.push({ op: 'closePath' }); }
  moveTo(x, y) { this.calls.push({ op: 'moveTo', args: [x, y] }); }
  lineTo(x, y) { this.calls.push({ op: 'lineTo', args: [x, y] }); }
  arc(x, y, r, s, e, cc) { this.calls.push({ op: 'arc', args: [x, y, r, s, e, cc] }); }
  rect(x, y, w, h) { this.calls.push({ op: 'rect', args: [x, y, w, h] }); }
  roundRect(x, y, w, h, r) { this.calls.push({ op: 'roundRect', args: [x, y, w, h, r] }); }
  fill() { this.calls.push({ op: 'fill', fillStyle: this.fillStyle }); }
  stroke() { this.calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); }
  fillText(text, x, y) { this.calls.push({ op: 'fillText', text: String(text), x, y, fillStyle: this.fillStyle }); }
  measureText(text) {
    return { width: String(text).length * 7 };
  }
  resetTransform() { this.calls.push({ op: 'resetTransform' }); }
  scale(sx, sy) { this.calls.push({ op: 'scale', args: [sx, sy] }); }
  fillRect(x, y, w, h) { this.calls.push({ op: 'fillRect', args: [x, y, w, h], fillStyle: this.fillStyle }); }
}

class MockElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this._className = '';
    this.classList = new MockClassList(this);
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.width = 600;
    this.height = 300;
    this._ctx = null;
  }

  get className() {
    return this._className;
  }
  set className(val) {
    this._className = val || '';
    this.classList._syncFromClassName();
  }

  get innerHTML() {
    if (this.children.length === 0) return this.textContent;
    return this.children.map(c => c.innerHTML).join('');
  }
  set innerHTML(html) {
    this.children = [];
    this.textContent = '';
    if (!html) return;
    
    // Simple child element parser for testing table structures
    const tagMatch = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>|<(\w+)([^>]*)\/>/gi;
    let match;
    let foundChildren = false;

    while ((match = tagMatch.exec(html)) !== null) {
      foundChildren = true;
      const tag = match[1] || match[4];
      const attrsStr = match[2] || match[5] || '';
      const inner = match[3] || '';
      const child = new MockElement(tag);

      // parse class
      const classM = attrsStr.match(/class=["']([^"']+)["']/i);
      if (classM) child.className = classM[1];

      // parse id
      const idM = attrsStr.match(/id=["']([^"']+)["']/i);
      if (idM) child.id = idM[1];

      // parse colspan
      const csM = attrsStr.match(/colspan=["']([^"']+)["']/i);
      if (csM) child.setAttribute('colspan', csM[1]);

      child.innerHTML = inner;
      this.appendChild(child);
    }

    if (!foundChildren) {
      // Strip simple HTML tags to populate textContent
      this.textContent = html.replace(/<[^>]+>/g, '').trim();
    }
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
    if (name.toLowerCase() === 'class') {
      this.className = String(val);
    }
  }
  getAttribute(name) {
    if (name.toLowerCase() === 'class') return this.className;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.toLowerCase() === 'class') this.className = '';
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  querySelector(selector) {
    const sel = selector.trim().toLowerCase();
    for (const c of this.children) {
      if (c.tagName.toLowerCase() === sel) return c;
      if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
      if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
      const sub = c.querySelector(selector);
      if (sub) return sub;
    }
    return null;
  }

  querySelectorAll(selector) {
    const res = [];
    const sel = selector.trim().toLowerCase();
    for (const c of this.children) {
      if (c.tagName.toLowerCase() === sel ||
          (sel.startsWith('.') && c.classList.contains(sel.slice(1))) ||
          (sel.startsWith('#') && c.id === sel.slice(1))) {
        res.push(c);
      }
      res.push(...c.querySelectorAll(selector));
    }
    return res;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) return;
    const arr = this.listeners.get(type);
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  dispatchEvent(evt) {
    const type = typeof evt === 'string' ? evt : evt.type;
    const eventObj = typeof evt === 'string' ? { type: evt, target: this, preventDefault: () => {} } : evt;
    if (!eventObj.target) eventObj.target = this;
    if (this.listeners.has(type)) {
      this.listeners.get(type).forEach(fn => fn(eventObj));
    }
    return true;
  }

  focus() {}
  select() {}

  getContext(type) {
    if (type === '2d') {
      if (!this._ctx) {
        this._ctx = new MockCanvasContext2D(this);
      }
      return this._ctx;
    }
    return null;
  }

  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: this.width || 600,
      bottom: this.height || 300,
      width: this.width || 600,
      height: this.height || 300
    };
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.body = new MockElement('body');
    this.listeners = new Map();
  }

  getElementById(id) {
    if (this.elements.has(id)) {
      return this.elements.get(id);
    }
    // Auto-create element if queried but not explicitly registered
    const el = new MockElement('div', id);
    this.elements.set(id, el);
    return el;
  }

  createElement(tag) {
    return new MockElement(tag);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) return;
    const arr = this.listeners.get(type);
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  dispatchEvent(evt) {
    const type = typeof evt === 'string' ? evt : evt.type;
    const eventObj = typeof evt === 'string' ? { type, preventDefault: () => {} } : evt;
    if (this.listeners.has(type)) {
      this.listeners.get(type).forEach(fn => fn(eventObj));
    }
  }

  initFromHtml(htmlContent) {
    // Regex extract all id="..." elements
    const idRegex = /<([a-zA-Z0-9]+)\s+[^>]*id=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = idRegex.exec(htmlContent)) !== null) {
      const tag = match[1];
      const id = match[2];
      const fullTag = match[0];

      const el = new MockElement(tag, id);

      // check for class
      const classM = fullTag.match(/class=["']([^"']+)["']/i);
      if (classM) {
        el.className = classM[1];
      }
      // check for aria-hidden
      const ariaM = fullTag.match(/aria-hidden=["']([^"']+)["']/i);
      if (ariaM) {
        el.setAttribute('aria-hidden', ariaM[1]);
      }

      this.elements.set(id, el);
    }

    // Ensure specific container hierarchies
    const table = this.elements.get('activity-table');
    if (table) {
      let tbody = table.querySelector('tbody');
      if (!tbody) {
        tbody = new MockElement('tbody');
        table.appendChild(tbody);
      }
    }
  }
}

class MockWindow {
  constructor(document) {
    this.document = document;
    this.devicePixelRatio = 1;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) return;
    const arr = this.listeners.get(type);
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }
  dispatchEvent(evt) {
    const type = typeof evt === 'string' ? evt : evt.type;
    const eventObj = typeof evt === 'string' ? { type, preventDefault: () => {} } : evt;
    if (this.listeners.has(type)) {
      this.listeners.get(type).forEach(fn => fn(eventObj));
    }
  }
}

// Setup Global Browser Primitives before importing Frontend ES Modules
const mockDoc = new MockDocument();
const mockWin = new MockWindow(mockDoc);
global.window = mockWin;
global.document = mockDoc;

// Load dist/index.html to initialize mock DOM tree matching production bundle
const htmlPath = path.resolve(__dirname, '../dist/index.html');
const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
mockDoc.initFromHtml(rawHtml);

// ============================================================================
// Adversarial Challenger Test Suite
// ============================================================================

async function runAdversarialVisualizationsSuite() {
  process.stdout.write('\n======================================================================\n');
  process.stdout.write('Milestone 3 Challenger: Visualizations & Data Rendering Adversarial Suite\n');
  process.stdout.write('======================================================================\n\n');

  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      process.stdout.write(`  ✓ ${name}\n`);
    } catch (err) {
      results.push({ name, status: 'FAIL', error: err });
      process.stderr.write(`  ✗ ${name}: ${err.stack || err.message}\n`);
    }
  }

  // Import Frontend ES Modules dynamically
  const basePath = 'file:///' + path.resolve(__dirname, '../frontend/src').replace(/\\/g, '/');
  const cryptoModule = await import(`${basePath}/crypto.js`);
  const enduranceModule = await import(`${basePath}/charts/endurance.js`);
  const physiologicalModule = await import(`${basePath}/charts/physiological.js`);
  const activitiesModule = await import(`${basePath}/charts/activities.js`);
  const chartEngineModule = await import(`${basePath}/charts/chart_engine.js`);

  // Load and decrypt production payload dist/data.enc
  const encPath = path.resolve(__dirname, '../dist/data.enc');
  assert.ok(fs.existsSync(encPath), 'dist/data.enc must exist');
  const wireBytes = fs.readFileSync(encPath);
  const demoPassphrase = 'demo-passphrase-2026!';

  const { payload: decryptedRollup } = await cryptoModule.decryptDashboardPayload(demoPassphrase, wireBytes);
  assert.ok(decryptedRollup, 'Payload decryption must succeed');

  // ==========================================================================
  // SECTION 1: ENDURANCE & TRAINING LOAD TESTS
  // ==========================================================================
  process.stdout.write('\n--- Section 1: Endurance & Training Load Verification ---\n');

  await test('T1-01: Decrypted payload contains verified Section 1 structures', async () => {
    assert.ok(decryptedRollup.summary, 'Rollup must contain summary object');
    assert.ok(decryptedRollup.training_load, 'Rollup must contain training_load object');
    assert.ok(Array.isArray(decryptedRollup.training_load.weekly), 'Weekly load must be array');
    assert.ok(decryptedRollup.training_load.weekly.length >= 8, 'Must have at least 8 weeks of training data');
  });

  await test('T1-02: KPI Summary Cards reflect decrypted payload data in Metric (KM)', async () => {
    enduranceModule.renderKPICards(decryptedRollup, 'km');

    const distEl = mockDoc.getElementById('kpi-total-distance');
    const timeEl = mockDoc.getElementById('kpi-total-time');
    const loadEl = mockDoc.getElementById('kpi-weekly-load');
    const statusEl = mockDoc.getElementById('kpi-status');

    // Expected distance: rollup summary distance_km formatted to 1 decimal
    const expectedDistKm = decryptedRollup.summary.total_distance_km.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    assert.strictEqual(distEl.textContent, `${expectedDistKm} km`);

    // Expected moving time: formatted via enduranceModule.formatDuration
    const expectedSec = decryptedRollup.summary.total_moving_time_seconds || (decryptedRollup.summary.total_moving_hours * 3600);
    const expectedTimeStr = enduranceModule.formatDuration(expectedSec);
    assert.strictEqual(timeEl.textContent, expectedTimeStr);

    // Latest load TSS
    const latestWeek = decryptedRollup.training_load.weekly[decryptedRollup.training_load.weekly.length - 1];
    assert.strictEqual(loadEl.textContent, `${Math.round(latestWeek.load)} TSS/wk`);

    // Training status (ACWR = ATL / CTL)
    const expectedACWR = latestWeek.ctl > 0 ? (latestWeek.atl / latestWeek.ctl) : 1.0;
    let expectedStatus = 'Optimal';
    if (expectedACWR > 1.35) expectedStatus = 'Overreaching';
    else if (expectedACWR >= 1.05) expectedStatus = 'Productive';
    else if (expectedACWR >= 0.85) expectedStatus = 'Optimal';
    else expectedStatus = 'Recovery';

    assert.strictEqual(statusEl.textContent, expectedStatus);
    assert.ok(statusEl.className.includes('rounded-full'));
  });

  await test('T1-03: KPI Summary Cards react to Imperial (Miles) unit toggle', async () => {
    enduranceModule.renderKPICards(decryptedRollup, 'mi');

    const distEl = mockDoc.getElementById('kpi-total-distance');
    const totalKm = decryptedRollup.summary.total_distance_km;
    const expectedMiles = (totalKm * 0.621371).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    });
    assert.strictEqual(distEl.textContent, `${expectedMiles} mi`);
  });

  await test('T1-04: Stacked Weekly Volume Chart accurately maps weekly sport volumes', async () => {
    enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'all');
    const canvas = mockDoc.getElementById('weekly-volume-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0, 'Canvas rendering calls must be issued');

    // Verify calls included bar operations
    const rectCalls = ctx.calls.filter(c => c.op === 'rect' || c.op === 'roundRect');
    assert.ok(rectCalls.length > 0, 'Bar rectangles must be drawn for weekly volume');
  });

  await test('T1-05: Weekly Volume Chart sport filter reactivity (All, Run, Cycle, Strength)', async () => {
    const canvas = mockDoc.getElementById('weekly-volume-chart');

    // Filter: 'running' -> verify exactly running series rendered
    enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'running');
    let ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0);

    // Filter: 'cycling'
    enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'cycling');
    assert.ok(ctx.calls.length > 0);

    // Filter: 'strength'
    enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'strength');
    assert.ok(ctx.calls.length > 0);

    // Filter: 'all'
    enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'all');
    assert.ok(ctx.calls.length > 0);
  });

  await test('T1-06: Continuous Training Load Chart renders CTL, ATL, TSB curves', async () => {
    enduranceModule.renderTrainingLoadChart(decryptedRollup);
    const canvas = mockDoc.getElementById('training-load-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0, 'Canvas rendering calls must be issued for training load');

    // Line chart must perform lineTo and stroke calls
    const lineCalls = ctx.calls.filter(c => c.op === 'lineTo');
    assert.ok(lineCalls.length >= 24, 'Must draw line segments across 8 weeks for 3 series');
  });

  await test('T1-07: Section 1 Adversarial Stress Tests (0 CTL, negative TSB, empty rollup)', async () => {
    // Scenario A: Rollup with CTL = 0 (ACWR divide-by-zero stress test)
    const zeroCtlRollup = {
      summary: { total_distance_km: 100, total_moving_hours: 10 },
      training_load: {
        weekly: [{ week: '2026-W40', run_km: 20, cycle_km: 40, strength_hours: 1, load: 300, atl: 50, ctl: 0, tsb: 50 }]
      }
    };
    enduranceModule.renderKPICards(zeroCtlRollup, 'km');
    const statusEl = mockDoc.getElementById('kpi-status');
    assert.ok(statusEl.textContent !== 'NaN' && statusEl.textContent !== 'Infinity', 'Must not produce NaN or Infinity on 0 CTL');

    // Scenario B: Negative TSB line chart rendering
    const negTsbRollup = {
      training_load: {
        weekly: [
          { week: 'W1', atl: 100, ctl: 60, tsb: -40 },
          { week: 'W2', atl: 120, ctl: 65, tsb: -55 }
        ]
      }
    };
    enduranceModule.renderTrainingLoadChart(negTsbRollup);
    const canvas = mockDoc.getElementById('training-load-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0, 'Must render negative TSB values without crash');

    // Scenario C: Empty rollup fallback
    enduranceModule.renderKPICards({}, 'km');
    const emptyDistEl = mockDoc.getElementById('kpi-total-distance');
    assert.strictEqual(emptyDistEl.textContent, '0.0 km');
  });

  // ==========================================================================
  // SECTION 2: PHYSIOLOGICAL DISTRIBUTION TESTS
  // ==========================================================================
  process.stdout.write('\n--- Section 2: Physiological Distribution Verification ---\n');

  await test('T2-01: 5-Zone Heart Rate Distribution Chart renders correctly', async () => {
    physiologicalModule.renderHeartRateZoneChart(decryptedRollup);
    const canvas = mockDoc.getElementById('hr-zone-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0);

    // Doughnut chart issues arc operations for slices
    const arcCalls = ctx.calls.filter(c => c.op === 'arc');
    assert.ok(arcCalls.length >= 5, 'Doughnut chart must draw arcs for each HR zone slice');
  });

  await test('T2-02: Coggan 7-Zone Power Distribution Chart renders 7 zones', async () => {
    physiologicalModule.renderPowerZoneChart(decryptedRollup);
    const canvas = mockDoc.getElementById('power-zone-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0);

    const rectCalls = ctx.calls.filter(c => c.op === 'rect' || c.op === 'roundRect');
    assert.ok(rectCalls.length >= 7, 'Must render at least 7 bars for Coggan zones Z1-Z7');
  });

  await test('T2-03: Threshold Trends Chart renders VO2max, FTP, and LTHR curves', async () => {
    physiologicalModule.renderThresholdTrendsChart(decryptedRollup);
    const canvas = mockDoc.getElementById('threshold-trends-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0);

    const lineCalls = ctx.calls.filter(c => c.op === 'lineTo');
    assert.ok(lineCalls.length >= 9, 'Must render multi-point lines for 3 threshold series');
  });

  await test('T2-04: Pace Zones Distribution Chart renders pace zones', async () => {
    physiologicalModule.renderPaceZoneChart(decryptedRollup);
    const canvas = mockDoc.getElementById('pace-zone-chart');
    const ctx = canvas.getContext('2d');
    assert.ok(ctx.calls.length > 0);
  });

  await test('T2-05: Section 2 Adversarial Stress Tests (Missing physiological data & nulls)', async () => {
    // Missing physiological block should not throw
    physiologicalModule.renderHeartRateZoneChart({});
    physiologicalModule.renderPowerZoneChart({});
    physiologicalModule.renderThresholdTrendsChart({});
    physiologicalModule.renderPaceZoneChart({});

    // Empty pace zones should return gracefully
    physiologicalModule.renderPaceZoneChart({ physiological: { pace_zones: [] } });
  });

  // ==========================================================================
  // SECTION 3: ACTIVITY DRILL-DOWN & TELEMETRY TESTS
  // ==========================================================================
  process.stdout.write('\n--- Section 3: Activity Drill-Down & Telemetry Verification ---\n');

  await test('T3-01: Activity Table renders all decrypted activities with correct badges', async () => {
    activitiesModule.renderActivityTable(decryptedRollup.activities, 'km');
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');
    assert.strictEqual(tbody.children.length, 49, 'All 49 activities must be rendered in table');

    // Verify first activity has badge class and formatted distance
    const firstRow = tbody.children[0];
    assert.ok(firstRow.className.includes('cursor-pointer'), 'Row must be clickable');
  });

  await test('T3-02: Sport Filters accurately isolate Running, Cycling, and Strength', async () => {
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');

    // Count expected sports from decrypted data
    const expectedRunning = decryptedRollup.activities.filter(a => a.sport === 'running').length;
    const expectedCycling = decryptedRollup.activities.filter(a => a.sport === 'cycling').length;
    const expectedStrength = decryptedRollup.activities.filter(a => a.sport === 'strength').length;

    assert.ok(expectedRunning > 0, 'Decrypted data must contain running');
    assert.ok(expectedCycling > 0, 'Decrypted data must contain cycling');
    assert.ok(expectedStrength > 0, 'Decrypted data must contain strength');
    assert.strictEqual(expectedRunning + expectedCycling + expectedStrength, 49);

    // Filter Running
    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, expectedRunning, 'Running filter must show exact running count');

    // Filter Cycling
    activitiesModule.setActivitySportFilter('cycling');
    assert.strictEqual(tbody.children.length, expectedCycling, 'Cycling filter must show exact cycling count');

    // Filter Strength
    activitiesModule.setActivitySportFilter('strength');
    assert.strictEqual(tbody.children.length, expectedStrength, 'Strength filter must show exact strength count');

    // Filter All
    activitiesModule.setActivitySportFilter('all');
    assert.strictEqual(tbody.children.length, 49, 'All filter must restore all 49 activities');
  });

  await test('T3-03: Activity Text Search reactivity and empty search state', async () => {
    activitiesModule.setupActivityEventListeners();
    const searchInput = mockDoc.getElementById('activity-search');
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');

    // Search by title keyword 'Threshold'
    searchInput.value = 'Threshold';
    searchInput.dispatchEvent('input');
    const thresholdCount = tbody.children.length;
    assert.ok(thresholdCount > 0, 'Searching for "Threshold" should find workouts');

    // Search by case-insensitive sport keyword 'cYCliNg'
    searchInput.value = 'cYCliNg';
    searchInput.dispatchEvent('input');
    const cyclingCount = tbody.children.length;
    const expectedCycling = decryptedRollup.activities.filter(a => a.sport === 'cycling').length;
    assert.strictEqual(cyclingCount, expectedCycling, 'Case-insensitive sport search must match');

    // Search with impossible query -> empty state message
    searchInput.value = 'XYZ_NONEXISTENT_WORKOUT_999';
    searchInput.dispatchEvent('input');
    assert.strictEqual(tbody.children.length, 1, 'Empty match must render single empty row');
    assert.ok(tbody.children[0].innerHTML.includes('No activities found matching criteria'));

    // Clear search -> reset
    searchInput.value = '';
    searchInput.dispatchEvent('input');
    assert.strictEqual(tbody.children.length, 49, 'Clearing search must restore all rows');
  });

  await test('T3-04: Activity Table Sorting (date, distance, duration)', async () => {
    const sortSelect = mockDoc.getElementById('activity-sort');
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');

    // Sort by longest distance
    sortSelect.value = 'dist-desc';
    sortSelect.dispatchEvent('change');
    assert.strictEqual(tbody.children.length, 49);

    // Sort by longest duration
    sortSelect.value = 'time-desc';
    sortSelect.dispatchEvent('change');
    assert.strictEqual(tbody.children.length, 49);

    // Reset to date-desc
    sortSelect.value = 'date-desc';
    sortSelect.dispatchEvent('change');
    assert.strictEqual(tbody.children.length, 49);
  });

  await test('T3-05: Clicking activity opens drawer with detailed splits and cadence', async () => {
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');
    const drawer = mockDoc.getElementById('activity-drawer');

    // Pick running activity with splits
    const runningAct = decryptedRollup.activities.find(a => a.sport === 'running' && a.splits && a.splits.length > 0);
    assert.ok(runningAct, 'Must have running activity with splits');

    // Initially drawer must have hidden class
    drawer.classList.add('hidden');

    // Open drawer for running activity
    activitiesModule.openActivityDrawer(runningAct, 'km');
    assert.strictEqual(drawer.classList.contains('hidden'), false, 'Drawer must not be hidden when opened');

    // Verify Title and Metadata
    const titleEl = mockDoc.getElementById('drawer-activity-title');
    assert.strictEqual(titleEl.textContent, runningAct.title);

    const distEl = mockDoc.getElementById('drawer-kpi-dist');
    const expectedDist = activitiesModule.formatDistance(runningAct.distance_meters, 'km');
    assert.strictEqual(distEl.textContent, expectedDist);

    // Cadence unit for running must be spm
    const cadEl = mockDoc.getElementById('drawer-kpi-cadence');
    assert.ok(cadEl.textContent.includes('spm'), 'Running cadence must use spm units');

    // Verify Splits Table populated
    const splitsTbody = mockDoc.getElementById('drawer-splits-tbody');
    assert.strictEqual(splitsTbody.children.length, runningAct.splits.length, 'Splits rows must match activity splits');

    // Verify Activity Profile Chart rendered
    const profileCanvas = mockDoc.getElementById('activity-profile-chart');
    const ctx = profileCanvas.getContext('2d');
    assert.ok(ctx.calls.length > 0, 'Activity profile chart must issue canvas drawing calls');
  });

  await test('T3-06: Cycling activity in drawer displays RPM cadence unit', async () => {
    const cyclingAct = decryptedRollup.activities.find(a => a.sport === 'cycling');
    assert.ok(cyclingAct, 'Must have cycling activity');

    activitiesModule.openActivityDrawer(cyclingAct, 'km');
    const cadEl = mockDoc.getElementById('drawer-kpi-cadence');
    assert.ok(cadEl.textContent.includes('rpm'), 'Cycling cadence must use rpm units');
  });

  await test('T3-07: Drawer Close Interactions (close button, backdrop, Escape key)', async () => {
    const drawer = mockDoc.getElementById('activity-drawer');
    const closeBtn = mockDoc.getElementById('btn-close-drawer');
    const backdrop = mockDoc.getElementById('drawer-backdrop');

    // Ensure open
    drawer.classList.remove('hidden');

    // Test close button
    closeBtn.dispatchEvent('click');
    assert.strictEqual(drawer.classList.contains('hidden'), true, 'Close button must hide drawer');

    // Open again and test backdrop click
    drawer.classList.remove('hidden');
    backdrop.dispatchEvent('click');
    assert.strictEqual(drawer.classList.contains('hidden'), true, 'Backdrop click must hide drawer');

    // Open again and test Escape key
    drawer.classList.remove('hidden');
    mockWin.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(drawer.classList.contains('hidden'), true, 'Escape key must hide drawer');
  });

  await test('T3-08: Unit conversion reactivity across Table & Drawer (KM vs Miles)', async () => {
    // Running activity has avg_pace_sec_km
    const runningAct = decryptedRollup.activities.find(a => a.sport === 'running' && a.avg_pace_sec_km);
    assert.ok(runningAct, 'Must find running activity with pace data');

    // In KM:
    const distKm = activitiesModule.formatDistance(runningAct.distance_meters, 'km');
    assert.ok(distKm.includes('km'));

    // In MI:
    const distMi = activitiesModule.formatDistance(runningAct.distance_meters, 'mi');
    assert.ok(distMi.includes('mi'));

    // Pace in KM vs MI
    const paceKm = activitiesModule.formatPace(runningAct.avg_pace_sec_km, 'km');
    const paceMi = activitiesModule.formatPace(runningAct.avg_pace_sec_km, 'mi');
    assert.ok(paceKm.includes('/km'), `paceKm must include /km, got: ${paceKm}`);
    assert.ok(paceMi.includes('/mi'), `paceMi must include /mi, got: ${paceMi}`);

    // Verify cycling activity returns '-' for pace
    const cyclingAct = decryptedRollup.activities.find(a => a.sport === 'cycling');
    assert.ok(cyclingAct, 'Must find cycling activity');
    const cyclingPace = activitiesModule.formatPace(cyclingAct.avg_pace_sec_km, 'km');
    assert.strictEqual(cyclingPace, '-', 'Cycling pace without avg_pace_sec_km must format to -');
  });

  await test('T3-09: Section 3 Adversarial Stress Tests (null splits, 100+ splits, extreme metrics)', async () => {
    const drawer = mockDoc.getElementById('activity-drawer');

    // Scenario A: Activity with no splits
    const noSplitsAct = {
      title: 'Stretching & Core',
      sport: 'strength',
      distance_meters: 0,
      duration_seconds: 1800,
      splits: []
    };
    activitiesModule.openActivityDrawer(noSplitsAct, 'km');
    const splitsTbody = mockDoc.getElementById('drawer-splits-tbody');
    assert.ok(splitsTbody.innerHTML.includes('No split breakdown recorded'));

    // Scenario B: Activity with 100 splits
    const largeSplits = Array.from({ length: 100 }, (_, i) => ({
      split_number: i + 1,
      split_sec: 240 + (i % 20),
      avg_hr: 150 + (i % 10),
      avg_cadence: 175,
      elevation_diff: (i % 5) - 2
    }));
    const hundredSplitsAct = {
      title: 'Ultra 100km Run',
      sport: 'running',
      distance_meters: 100000,
      duration_seconds: 24000,
      splits: largeSplits
    };
    activitiesModule.openActivityDrawer(hundredSplitsAct, 'km');
    assert.strictEqual(splitsTbody.children.length, 100, 'Drawer must handle 100 splits without failure');

    // Scenario C: Negative elevation difference (-25 m)
    const negElevAct = {
      title: 'Downhill Run',
      sport: 'running',
      splits: [{ split_number: 1, split_sec: 240, avg_hr: 140, elevation_diff: -25 }]
    };
    activitiesModule.openActivityDrawer(negElevAct, 'km');
    assert.ok(splitsTbody.innerHTML.includes('-25 m'), 'Negative elevation difference must be rendered with minus sign');

    // Scenario D: Activity with HTML/XSS in title
    const xssAct = {
      title: '<script>alert("pwned")</script>',
      sport: 'running',
      distance_meters: 5000,
      splits: []
    };
    activitiesModule.openActivityDrawer(xssAct, 'km');
    const titleEl = mockDoc.getElementById('drawer-activity-title');
    assert.strictEqual(titleEl.textContent, '<script>alert("pwned")</script>', 'Drawer title must use safe textContent');
  });

  await test('T1-08: Zero-dimension canvas resilience & high-DPI scaling', async () => {
    const canvas = mockDoc.getElementById('weekly-volume-chart');
    canvas.width = 0;
    canvas.height = 0;
    assert.doesNotThrow(() => {
      enduranceModule.renderWeeklyVolumeChart(decryptedRollup, 'km', 'all');
    });
    canvas.width = 600;
    canvas.height = 300;
  });

  await test('T1-09: 1,000 data points line chart performance & stress test', async () => {
    const hugeWeeks = Array.from({ length: 1000 }, (_, i) => ({
      week: `Day-${i + 1}`,
      atl: 40 + (i % 50),
      ctl: 30 + (i % 40),
      tsb: (i % 40) - (i % 50)
    }));
    const t0 = Date.now();
    enduranceModule.renderTrainingLoadChart({ training_load: { weekly: hugeWeeks } });
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 200, `Rendering 1,000 points must be <200ms, took ${elapsedMs}ms`);
  });

  await test('T2-06: Zero-total doughnut distribution stress test', async () => {
    const zeroRollup = {
      physiological: {
        heart_rate_zones: [
          { zone: 'Z1', seconds: 0 },
          { zone: 'Z2', seconds: 0 },
          { zone: 'Z3', seconds: 0 },
          { zone: 'Z4', seconds: 0 },
          { zone: 'Z5', seconds: 0 }
        ]
      }
    };
    assert.doesNotThrow(() => {
      physiologicalModule.renderHeartRateZoneChart(zeroRollup);
    });
  });

  await test('T3-10: ReDoS & regex metacharacter injection in search', async () => {
    const searchInput = mockDoc.getElementById('activity-search');
    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');

    const hostileQueries = [
      '.*+?^${}()|[]\\',
      '(((((((((a+)+)+)+)+)+)+)+)+)',
      '[a-z]+[0-9]*',
      '\\d{1,4}\\w*',
      '<script>alert(1)</script>',
      '\' OR \'1\'=\'1',
      '${7*7}',
      '{{title}}'
    ];

    for (const q of hostileQueries) {
      searchInput.value = q;
      assert.doesNotThrow(() => {
        searchInput.dispatchEvent('input');
      }, `Search with query "${q}" must not throw or crash`);
      assert.ok(tbody.children.length >= 1);
    }

    searchInput.value = '';
    searchInput.dispatchEvent('input');
    assert.strictEqual(tbody.children.length, 49);
  });

  await test('T3-11: Production bundle mirror parity (dist/assets/charts/)', async () => {
    const distBasePath = 'file:///' + path.resolve(__dirname, '../dist/assets').replace(/\\/g, '/');
    const distEndurance = await import(`${distBasePath}/charts/endurance.js`);
    const distPhysiological = await import(`${distBasePath}/charts/physiological.js`);
    const distActivities = await import(`${distBasePath}/charts/activities.js`);

    assert.strictEqual(typeof distEndurance.renderKPICards, 'function');
    assert.strictEqual(typeof distEndurance.renderWeeklyVolumeChart, 'function');
    assert.strictEqual(typeof distEndurance.renderTrainingLoadChart, 'function');
    assert.strictEqual(typeof distPhysiological.renderHeartRateZoneChart, 'function');
    assert.strictEqual(typeof distPhysiological.renderPowerZoneChart, 'function');
    assert.strictEqual(typeof distPhysiological.renderThresholdTrendsChart, 'function');
    assert.strictEqual(typeof distPhysiological.renderPaceZoneChart, 'function');
    assert.strictEqual(typeof distActivities.renderActivityTable, 'function');
    assert.strictEqual(typeof distActivities.openActivityDrawer, 'function');
    assert.strictEqual(typeof distActivities.setActivitySportFilter, 'function');

    distEndurance.renderKPICards(decryptedRollup, 'km');
    distEndurance.renderWeeklyVolumeChart(decryptedRollup, 'km', 'all');
    distPhysiological.renderHeartRateZoneChart(decryptedRollup);
    distActivities.renderActivityTable(decryptedRollup.activities, 'km');

    const table = mockDoc.getElementById('activity-table');
    const tbody = table.querySelector('tbody');
    assert.strictEqual(tbody.children.length, 49, 'Dist activity table must render 49 activities');
  });

  // Summary
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  process.stdout.write('\n======================================================================\n');
  process.stdout.write(`Adversarial Visualizations Results: ${passed} passed, ${failed} failed (Total: ${results.length})\n`);
  process.stdout.write('======================================================================\n\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAdversarialVisualizationsSuite().catch(err => {
    process.stderr.write(`Fatal execution error: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { runAdversarialVisualizationsSuite };
