/**
 * tests/test_m3_body_battery_rangebar.js
 *
 * Milestone M3 Comprehensive Test Suite:
 * Garmin-Style Body Battery Range Chart (High/Low Pillars + Caps)
 *
 * Covers all 21 tests across 8 sections:
 *  1. Chart engine rangeBar rendering, 0-100 gridlines, 7D/1M/1Y scaling, low > high / low === high safety
 *  2. Vertical pillar hitbox hover & dynamic multi-line tooltip + edge clamping
 *  3. Custom 2-item legend rendering (● Daily High, ◉ Daily Low) with single dataset
 *  4. Per-bar color arrays (barColors & backgroundColor array) for stacked & non-stacked bars
 *  5. trends_modal.js Body Battery 7D/1M/1Y/Custom rangeBar, 1D intraday curve, 1D fallback + cap labels, hover integration
 *  6. Zero-value preservation (0 pts, +0 pts, -0 pts) & missing/NaN/empty resilience
 *  7. Minimal MockCtx fallback compatibility (no roundRect, createLinearGradient, clip, setLineDash)
 *  8. Iteration 2 regression suite (HH:MM intraday + 3/4-elem tuples, TZ-safe ISO dates, inverted low>high labels/tooltips, 0/100 cap label non-overlap)
 */

const assert = require('assert');
const path = require('path');

class RecordingMockCtx {
  constructor(canvas, { omitOptional = false } = {}) {
    this.canvas = canvas;
    this.font = '10px sans-serif';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this.calls = [];
    this.gradients = [];

    if (!omitOptional) {
      this.roundRect = (x, y, w, h, r) => {
        this._checkNum(x, 'x', 'roundRect');
        this._checkNum(y, 'y', 'roundRect');
        this._checkNum(w, 'w', 'roundRect');
        this._checkNum(h, 'h', 'roundRect');
        if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dims in roundRect (${w}, ${h})`);
        this.calls.push({ op: 'roundRect', args: [x, y, w, h, r], fillStyle: this.fillStyle });
      };
      this.createLinearGradient = (x0, y0, x1, y1) => {
        this._checkNum(x0, 'x0', 'createLinearGradient');
        this._checkNum(y0, 'y0', 'createLinearGradient');
        this._checkNum(x1, 'x1', 'createLinearGradient');
        this._checkNum(y1, 'y1', 'createLinearGradient');
        const grad = { __isGradient: true, x0, y0, x1, y1, stops: [] };
        grad.addColorStop = (offset, color) => {
          grad.stops.push({ offset, color });
        };
        this.gradients.push(grad);
        this.calls.push({ op: 'createLinearGradient', args: [x0, y0, x1, y1], grad });
        return grad;
      };
      this.clip = () => {
        this.calls.push({ op: 'clip' });
      };
      this.setLineDash = (dash) => {
        this.calls.push({ op: 'setLineDash', args: [dash] });
      };
    }
  }

  _checkNum(val, name, op) {
    if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
      throw new Error(`[Boundary Safety] Invalid ${name}=${val} in ${op}`);
    }
  }

  clearRect(x, y, w, h) {
    this._checkNum(x, 'x', 'clearRect');
    this._checkNum(y, 'y', 'clearRect');
    this._checkNum(w, 'w', 'clearRect');
    this._checkNum(h, 'h', 'clearRect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dims in clearRect (${w}, ${h})`);
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
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this._checkNum(cp1x, 'cp1x', 'bezierCurveTo');
    this._checkNum(cp1y, 'cp1y', 'bezierCurveTo');
    this._checkNum(cp2x, 'cp2x', 'bezierCurveTo');
    this._checkNum(cp2y, 'cp2y', 'bezierCurveTo');
    this._checkNum(x, 'x', 'bezierCurveTo');
    this._checkNum(y, 'y', 'bezierCurveTo');
    this.calls.push({ op: 'bezierCurveTo', args: [cp1x, cp1y, cp2x, cp2y, x, y] });
  }
  arc(x, y, r, s, e, cc) {
    this._checkNum(x, 'x', 'arc');
    this._checkNum(y, 'y', 'arc');
    this._checkNum(r, 'r', 'arc');
    if (r < 0) throw new Error(`[Boundary Safety] Negative radius in arc: ${r}`);
    this.calls.push({ op: 'arc', args: [x, y, r, s, e, cc] });
  }
  rect(x, y, w, h) {
    this._checkNum(x, 'x', 'rect');
    this._checkNum(y, 'y', 'rect');
    this._checkNum(w, 'w', 'rect');
    this._checkNum(h, 'h', 'rect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dims in rect (${w}, ${h})`);
    this.calls.push({ op: 'rect', args: [x, y, w, h] });
  }
  fillRect(x, y, w, h) {
    this._checkNum(x, 'x', 'fillRect');
    this._checkNum(y, 'y', 'fillRect');
    this._checkNum(w, 'w', 'fillRect');
    this._checkNum(h, 'h', 'fillRect');
    if (w < 0 || h < 0) throw new Error(`[Boundary Safety] Negative dims in fillRect (${w}, ${h})`);
    this.calls.push({ op: 'fillRect', args: [x, y, w, h], fillStyle: this.fillStyle });
  }
  fill() {
    this.calls.push({ op: 'fill', fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
  }
  stroke() {
    this.calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha });
  }
  save() { this.calls.push({ op: 'save' }); }
  restore() { this.calls.push({ op: 'restore' }); }
  scale(sx, sy) {
    this._checkNum(sx, 'sx', 'scale');
    this._checkNum(sy, 'sy', 'scale');
    this.calls.push({ op: 'scale', args: [sx, sy] });
  }
  resetTransform() { this.calls.push({ op: 'resetTransform' }); }
  setTransform() { this.calls.push({ op: 'setTransform' }); }
  measureText(txt) {
    return { width: String(txt || '').length * 6 };
  }
  fillText(txt, x, y) {
    this._checkNum(x, 'x', 'fillText');
    this._checkNum(y, 'y', 'fillText');
    this.calls.push({
      op: 'fillText',
      args: [String(txt), x, y],
      text: String(txt),
      x,
      y,
      width: String(txt || '').length * 6,
      fillStyle: this.fillStyle,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      font: this.font
    });
  }
}

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
  add(...tokens) { tokens.forEach(t => this.set.add(t)); this._syncToClassName(); }
  remove(...tokens) { tokens.forEach(t => this.set.delete(t)); this._syncToClassName(); }
  contains(token) { return this.set.has(token); }
}

class MockElement {
  constructor(tag, id = '', className = '', { width = 600, height = 300, omitOptionalCtx = false } = {}) {
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
    this._boxW = width;
    this._boxH = height;
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this._ctx = new RecordingMockCtx(this, { omitOptional: omitOptionalCtx });
  }
  get className() { return this._className; }
  set className(v) { this._className = v; this.classList._syncFromClassName(); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    const tagMatches = html.matchAll(/<([a-zA-Z0-9\-]+)([^>]*)>/g);
    for (const match of tagMatches) {
      const child = new MockElement(match[1]);
      child.parentElement = this;
      const attrsStr = match[2];
      const idM = attrsStr.match(/id=["']([^"']+)["']/);
      if (idM) child.id = idM[1];
      const clsM = attrsStr.match(/class=["']([^"']+)["']/);
      if (clsM) child.className = clsM[1];
      this.children.push(child);
    }
  }
  setAttribute(n, v) { this.attributes.set(n, String(v)); if (n === 'class') this.className = String(v); if (n === 'id') this.id = String(v); }
  getAttribute(n) { if (n === 'class') return this.className; if (n === 'id') return this.id; return this.attributes.get(n) || null; }
  hasAttribute(n) { if (n === 'class') return Boolean(this.className); if (n === 'id') return Boolean(this.id); return this.attributes.has(n); }
  addEventListener(type, h) { if (!this.eventListeners.has(type)) this.eventListeners.set(type, []); this.eventListeners.get(type).push(h); }
  removeEventListener(type, h) { const l = this.eventListeners.get(type); if (l) { const i = l.indexOf(h); if (i >= 0) l.splice(i, 1); } }
  dispatchEvent(evt) {
    const type = typeof evt === 'string' ? evt : evt.type;
    const ev = typeof evt === 'string' ? { type, target: this, preventDefault() {} } : evt;
    ev.target = ev.target || this;
    for (const h of this.eventListeners.get(type) || []) h.call(this, ev);
  }
  matches(sel) {
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('[') && sel.endsWith(']')) return this.hasAttribute(sel.slice(1, -1));
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }
  getBoundingClientRect() {
    return { width: this._boxW, height: this._boxH, top: 0, left: 0, right: this._boxW, bottom: this._boxH };
  }
  getContext() {
    return this._ctx;
  }
  resetCtx(omitOptionalCtx = false) {
    this._ctx = new RecordingMockCtx(this, { omitOptional: omitOptionalCtx });
    return this._ctx;
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
    }
    return res;
  }
  addEventListener(type, h) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(h);
  }
}

function setupModalDOM(omitOptionalCtx = false) {
  const doc = new MockDocument();
  const ids = [
    'metric-trend-modal', 'trend-modal-backdrop', 'trend-modal-panel',
    'trend-metric-icon', 'trend-metric-title', 'trend-metric-subtitle',
    'trend-metric-badge', 'trend-date-label', 'trend-nav-prev', 'trend-nav-next',
    'trend-custom-date-container', 'trend-input-start-date', 'trend-input-end-date',
    'trend-btn-apply-custom', 'trend-custom-error', 'trend-kpi-grid',
    'trend-chart-empty', 'trend-table-count', 'trend-table-header-row',
    'trend-table-body', 'btn-close-trend-modal', 'btn-expand-trend-modal'
  ];
  for (const id of ids) {
    doc.register(new MockElement('div', id));
  }
  const canvas = doc.register(new MockElement('canvas', 'metric-trend-chart', '', { width: 600, height: 300, omitOptionalCtx }));
  for (const r of ['1d', '7d', '1m', '1y', 'custom']) {
    const btn = new MockElement('button', `range-${r}`);
    btn.setAttribute('data-trend-range', r);
    doc.register(btn);
  }
  global.document = doc;
  global.window = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {}
  };
  return { doc, canvas };
}

function makeDailyRecords(count, { includeIntradayLatest = false } = {}) {
  const records = [];
  const base = new Date(Date.UTC(2026, 10, 12)); // 2026-11-12 (Thu, Nov 12)
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(base.getTime() - i * 86400000);
    const date = dt.toISOString().slice(0, 10);
    const high = 82 + (i % 15);
    const low = 18 + (i % 14);
    const rec = {
      date,
      body_battery: low + 10,
      body_battery_high: high,
      body_battery_low: low,
      body_battery_charged: Math.max(10, high - low),
      body_battery_drained: Math.max(10, high - low - 2),
      stress_level: 25
    };
    if (includeIntradayLatest && i === 0) {
      rec.intraday_body_battery = [
        [Date.UTC(2026, 10, 12, 0, 0), 32],
        [Date.UTC(2026, 10, 12, 6, 0), 92],
        [Date.UTC(2026, 10, 12, 12, 0), 68],
        [Date.UTC(2026, 10, 12, 18, 0), 44],
        [Date.UTC(2026, 10, 12, 23, 59), 24]
      ];
    }
    records.push(rec);
  }
  return records;
}

async function runTests() {
  setupModalDOM(false);
  const { Chart } = await import('../frontend/src/charts/chart_engine.js');
  const trendsModal = await import('../frontend/src/charts/trends_modal.js');

  let passed = 0;
  function test(name, fn) {
    fn();
    passed++;
    console.log(`[PASS] ${name}`);
  }

  // ==========================================================================
  // Section 1: Chart Engine rangeBar Rendering & Geometry
  // ==========================================================================
  test('M3-RB-01: 7D rangeBar renders 7 pillars, #38bdf8 High caps, #0b0714/#c4b5fd Low ring caps', () => {
    const canvas = new MockElement('canvas', 'rb-01', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const labels = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
    const highs = [95, 88, 92, 85, 90, 96, 94];
    const lows = [22, 18, 25, 15, 20, 28, 21];

    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels,
        datasets: [{
          label: 'Body Battery',
          highData: highs,
          lowData: lows,
          chargedData: [73, 70, 67, 70, 70, 68, 73],
          drainedData: [71, 69, 65, 72, 66, 65, 70]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    const pillarCalls = ctx.calls.filter(c => (c.op === 'roundRect' || c.op === 'rect') && c.args[2] >= 10 && c.args[2] <= 14 && c.args[3] > 20);
    assert.strictEqual(pillarCalls.length, 7, `Expected 7 pillar calls with width 10-14, got ${pillarCalls.length}`);
    assert.ok(ctx.gradients.length >= 7, 'Expected linear gradient per pillar');

    const highCapFills = ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#38bdf8');
    assert.strictEqual(highCapFills.length, 8, 'Expected 7 High cap fills + 1 Daily High legend dot in #38bdf8');

    const lowCapFills = ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714');
    assert.strictEqual(lowCapFills.length, 8, 'Expected 7 Low cap fills + 1 Daily Low legend ring in #0b0714');

    const lowCapStrokes = ctx.calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2);
    assert.strictEqual(lowCapStrokes.length, 7, 'Expected 7 Low cap ring strokes in #c4b5fd with lineWidth 2');

    chart.destroy();
  });

  test('M3-RB-02: rangeBar Y-axis 0-100 renders 5 horizontal gridlines (0, 25, 50, 75, 100)', () => {
    const canvas = new MockElement('canvas', 'rb-02', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-12'],
        datasets: [{ label: 'Body Battery', highData: [95], lowData: [22] }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    const yTicks = ctx.calls.filter(c => c.op === 'fillText' && c.textAlign === 'right').map(c => c.text);
    assert.deepStrictEqual(yTicks, ['100', '75', '50', '25', '0'], `Unexpected Y ticks: ${JSON.stringify(yTicks)}`);

    // Count 5 horizontal gridlines spanning plot width
    let gridLines = 0;
    for (let i = 0; i < ctx.calls.length - 1; i++) {
      if (ctx.calls[i].op === 'moveTo' && ctx.calls[i + 1].op === 'lineTo') {
        const [x1, y1] = ctx.calls[i].args;
        const [x2, y2] = ctx.calls[i + 1].args;
        if (Math.abs(y1 - y2) < 0.01 && x2 - x1 > 400) gridLines++;
      }
    }
    assert.strictEqual(gridLines, 5, `Expected 5 horizontal gridlines, got ${gridLines}`);
    chart.destroy();
  });

  test('M3-RB-03: Responsive pillar scaling across 7D, 1M (30d), 1Y (365d) & no X-axis collision', () => {
    const widths = {};
    for (const [tag, count] of [['7d', 7], ['1m', 30], ['1y', 365]]) {
      const recs = makeDailyRecords(count);
      const canvas = new MockElement('canvas', `rb-03-${tag}`, '', { width: 600, height: 300 });
      const ctx = canvas.getContext('2d');
      const chart = new Chart(canvas, {
        type: 'rangeBar',
        data: {
          labels: recs.map(r => r.date),
          datasets: [{
            label: 'Body Battery',
            highData: recs.map(r => r.body_battery_high),
            lowData: recs.map(r => r.body_battery_low)
          }]
        },
        options: { scales: { y: { min: 0, max: 100 } } }
      });

      assert.strictEqual(chart.dataPoints.length, count);
      widths[tag] = chart.dataPoints[0].w;
      assert.ok(widths[tag] >= 2 && widths[tag] <= 14, `Pillar width out of bounds for ${tag}: ${widths[tag]}`);

      // Verify X-axis labels do not collide
      const xLabels = ctx.calls.filter(c => c.op === 'fillText' && c.textBaseline === 'top' && c.textAlign === 'center');
      let prevRight = -Infinity;
      for (const lbl of xLabels) {
        const left = lbl.x - lbl.width / 2;
        const right = lbl.x + lbl.width / 2;
        assert.ok(left >= prevRight + 3.5, `X label collision in ${tag}: ${lbl.text}`);
        prevRight = right;
      }
      chart.destroy();
    }
    assert.ok(widths['7d'] >= widths['1m'] && widths['1m'] >= widths['1y'] && widths['1y'] >= 2,
      `Expected monotonic pillar width shrink: ${JSON.stringify(widths)}`);
  });

  test('M3-RB-04: Defensive geometry for low > high and low === high (no negative heights, caps still render)', () => {
    const canvas = new MockElement('canvas', 'rb-04', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-11', '2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [40, 50],
          lowData: [80, 50]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    assert.strictEqual(chart.dataPoints.length, 2);
    const highCaps = ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#38bdf8');
    const lowCaps = ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714');
    assert.strictEqual(highCaps.length, 3, 'Both High caps + 1 legend dot must render even when low === high');
    assert.strictEqual(lowCaps.length, 3, 'Both Low caps + 1 legend ring must render even when low === high');
    chart.destroy();
  });

  // ==========================================================================
  // Section 2: Vertical Pillar Hitbox & Multi-Line Tooltip
  // ==========================================================================
  test('M3-RB-05: Vertical pillar hitbox hits High cap, midpoint, Low cap, and misses far away', () => {
    const canvas = new MockElement('canvas', 'rb-05', '', { width: 600, height: 300 });
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-10', '2026-11-11', '2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [80, 95, 70],
          lowData: [30, 15, 25],
          chargedData: [50, 80, 45],
          drainedData: [45, 75, 48]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    const pt = chart.dataPoints[1];
    assert.ok(pt.yBottom - pt.yTop > 120, 'Expected tall pillar > 120px');

    chart._handleMouseMove({ clientX: pt.x, clientY: pt.yTop });
    assert.strictEqual(chart.activeTooltip?.label, pt.label, 'Should hit High cap');

    chart._handleMouseMove({ clientX: pt.x, clientY: (pt.yTop + pt.yBottom) / 2 });
    assert.strictEqual(chart.activeTooltip?.label, pt.label, 'Should hit vertical pillar midpoint');

    chart._handleMouseMove({ clientX: pt.x, clientY: pt.yBottom });
    assert.strictEqual(chart.activeTooltip?.label, pt.label, 'Should hit Low cap');

    chart._handleMouseMove({ clientX: 595, clientY: 5 });
    assert.strictEqual(chart.activeTooltip, null, 'Should miss far corner');

    chart._handleMouseMove({ clientX: pt.x, clientY: pt.yTop });
    assert.strictEqual(chart.activeTooltip?.label, pt.label);
    chart._handleMouseLeave();
    assert.strictEqual(chart.activeTooltip, null, 'Should clear tooltip on mouseleave');
    chart.destroy();
  });

  test('M3-RB-06: Multi-line tooltip content, dynamic boxH > 42, no duplicate title, and edge clamping', () => {
    const canvas = new MockElement('canvas', 'rb-06', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-06', '2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [95, 90],
          lowData: [22, 18],
          chargedData: [72, 72],
          drainedData: [71, 68]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    // Hover right-edge day (2026-11-12 -> Thu, Nov 12)
    const ptRight = chart.dataPoints[1];
    ctx.calls = [];
    chart._handleMouseMove({ clientX: ptRight.x, clientY: (ptRight.yTop + ptRight.yBottom) / 2 });

    const texts = ctx.calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.includes('Thu, Nov 12'), `Expected weekday header "Thu, Nov 12" in ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('Daily High: 90 pts'), 'Expected Daily High tooltip line');
    assert.ok(texts.includes('Daily Low: 18 pts'), 'Expected Daily Low tooltip line');
    assert.ok(texts.includes('Charged: +72 pts | Drained: -68 pts'), 'Expected Charged/Drained tooltip line');

    const tooltipRect = ctx.calls.find(c => (c.op === 'roundRect' || c.op === 'rect') && c.args[3] > 42);
    assert.ok(tooltipRect, 'Expected dynamically sized multi-line tooltip box (h > 42)');
    const [bx, by, boxW, boxH] = tooltipRect.args;
    assert.ok(bx >= 8 && bx + boxW <= 600 - 8, `Tooltip X clipped: bx=${bx}, boxW=${boxW}`);
    assert.ok(by >= 8 && by + boxH <= 300 - 8, `Tooltip Y clipped: by=${by}, boxH=${boxH}`);

    // Also verify duplicate title line is stripped if tooltipLines[0] matches tooltipTitle
    const ptLeft = chart.dataPoints[0];
    ptLeft.tooltipTitle = 'Fri, Nov 6';
    ptLeft.tooltipLines = ['Fri, Nov 6', 'Daily High: 95 pts'];
    ctx.calls = [];
    chart._handleMouseMove({ clientX: ptLeft.x, clientY: ptLeft.yTop });
    const dupCount = ctx.calls.filter(c => c.op === 'fillText' && c.text === 'Fri, Nov 6').length;
    assert.strictEqual(dupCount, 1, `Title must not duplicate when tooltipLines[0] matches tooltipTitle, got ${dupCount}`);
    chart.destroy();
  });

  // ==========================================================================
  // Section 3: Custom 2-Item Legend (datasets.length === 1)
  // ==========================================================================
  test('M3-RB-07: Single-dataset rangeBar renders 2-item legend (Daily High dot, Daily Low ring) without clipping at 320px', () => {
    const canvas = new MockElement('canvas', 'rb-07', '', { width: 320, height: 240 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-12'],
        datasets: [{ label: 'Body Battery', highData: [95], lowData: [22] }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    const legendLabels = ctx.calls.filter(c => c.op === 'fillText' && c.textBaseline === 'middle' && c.textAlign === 'left');
    const legendNames = legendLabels.map(l => l.text);
    assert.deepStrictEqual(legendNames, ['Daily High', 'Daily Low']);
    for (const l of legendLabels) {
      assert.ok(l.x >= 0 && l.x + l.width <= 321, `Legend label clipped at 320px: ${l.text}`);
    }
    // Clicking legend with dsIndex: null should not throw
    chart._handleMouseDown({ button: 0, clientX: 80, clientY: 12 });
    chart._handleMouseUp({ target: canvas, clientX: 80, clientY: 12 });
    chart.destroy();
  });

  // ==========================================================================
  // Section 4: Per-Bar Color Array Support
  // ==========================================================================
  test('M3-RB-08: Non-stacked bar supports backgroundColor array and barColors precedence', () => {
    const canvas = new MockElement('canvas', 'rb-08', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const colors = ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e'];
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'],
        datasets: [{ label: 'Stress', data: [18, 42, 65, 88], backgroundColor: colors }]
      }
    });

    const barFills = ctx.calls.filter(c => c.op === 'fill' && colors.includes(c.fillStyle)).map(c => c.fillStyle);
    assert.deepStrictEqual(barFills, colors);
    assert.deepStrictEqual(chart.dataPoints.map(p => p.color), colors);

    // barColors takes precedence over backgroundColor string
    ctx.calls = [];
    const overrideColors = ['#a855f7', '#38bdf8', '#10b981', '#f43f5e'];
    const chart2 = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['A', 'B', 'C', 'D'],
        datasets: [{ label: 'Stress', data: [10, 20, 30, 40], backgroundColor: '#ffffff', barColors: overrideColors }]
      }
    });
    const barFills2 = ctx.calls.filter(c => c.op === 'fill' && overrideColors.includes(c.fillStyle)).map(c => c.fillStyle);
    assert.deepStrictEqual(barFills2, overrideColors);
    chart.destroy();
    chart2.destroy();
  });

  test('M3-RB-09: Stacked bar backward compatibility + per-bar barColors array', () => {
    const canvas = new MockElement('canvas', 'rb-09', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const perBar = ['#38bdf8', '#f43f5e'];
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['2026-11-11', '2026-11-12'],
        datasets: [
          { label: 'Zone A', data: [20, 30], barColors: perBar },
          { label: 'Zone B', data: [10, 15], backgroundColor: '#a855f7' }
        ]
      },
      options: { scales: { x: { stacked: true }, y: { stacked: true } } }
    });

    const fills = ctx.calls.filter(c => c.op === 'fill').map(c => c.fillStyle);
    assert.ok(fills.includes('#38bdf8') && fills.includes('#f43f5e') && fills.includes('#a855f7'));
    assert.strictEqual(chart.dataPoints.length, 4);
    chart.destroy();
  });

  // ==========================================================================
  // Section 5: trends_modal.js Body Battery Integration (7D/1M/1Y/Custom & 1D)
  // ==========================================================================
  test('M3-RB-10: trends_modal body_battery renders rangeBar across 7D, 1M, 1Y, Custom with 4 KPIs & 2-item legend', () => {
    const { doc, canvas } = setupModalDOM(false);
    const rollup365 = { wellness: { daily: makeDailyRecords(365, { includeIntradayLatest: true }) } };

    trendsModal.openMetricTrendModal('body_battery', rollup365);
    assert.strictEqual(doc.getElementById('trend-metric-title').textContent, 'Body Battery');
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '7 records');
    assert.strictEqual(doc.getElementById('trend-kpi-grid').innerHTML.match(/rounded-xl/g).length, 4);

    let ctx = canvas.getContext('2d');
    assert.strictEqual(ctx.calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2).length, 7);
    assert.strictEqual(ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714').length, 8);
    const legend7d = ctx.calls.filter(c => c.op === 'fillText' && c.textBaseline === 'middle' && c.textAlign === 'left').map(c => c.text);
    assert.deepStrictEqual(legend7d, ['Daily High', 'Daily Low', 'Hourly Trend']);

    canvas.resetCtx(false);
    trendsModal.setTimeRange('1m');
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '30 records');
    assert.strictEqual(canvas.getContext('2d').calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2).length, 30);

    canvas.resetCtx(false);
    trendsModal.setTimeRange('1y');
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '365 records');
    assert.strictEqual(canvas.getContext('2d').calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2).length, 365);

    doc.getElementById('trend-input-start-date').value = '2026-11-01';
    doc.getElementById('trend-input-end-date').value = '2026-11-10';
    canvas.resetCtx(false);
    trendsModal.applyCustomDateRange();
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '10 records');
    assert.strictEqual(canvas.getContext('2d').calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2).length, 10);
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-11: trends_modal 1D intraday curve renders when intraday_body_battery has > 1 valid points (filters < 0 & supports objects)', () => {
    const { doc, canvas } = setupModalDOM(false);
    const daily = makeDailyRecords(7);
    daily[daily.length - 1].intraday_body_battery = [
      { timestamp: Date.UTC(2026, 10, 12, 23, 59) / 1000, value: 24 }, // out-of-order + epoch seconds
      [Date.UTC(2026, 10, 12, 0, 0), 32],
      [Date.UTC(2026, 10, 12, 3, 0), -1], // Garmin sentinel -> filtered out
      [Date.UTC(2026, 10, 12, 6, 0), 92],
      { ts: Date.UTC(2026, 10, 12, 12, 0), level: 68 },
      [Date.UTC(2026, 10, 12, 18, 0), 44]
    ];

    trendsModal.openMetricTrendModal('body_battery', { wellness: { daily } });
    canvas.resetCtx(false);
    trendsModal.setTimeRange('1d');

    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '1 records');
    const ctx = canvas.getContext('2d');
    const curveCalls = ctx.calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(curveCalls.length >= 4, 'Expected smooth intraday line curve');
    const lowRingFills = ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714');
    assert.strictEqual(lowRingFills.length, 0, 'Intraday 1D mode must render line curve, not rangeBar pillars');

    const xLabels = ctx.calls.filter(c => c.op === 'fillText' && c.textBaseline === 'top' && c.textAlign === 'center').map(c => c.text);
    assert.ok(xLabels.includes('00:00') && xLabels.includes('23:59'), `Expected 00:00..23:59 time labels, got ${JSON.stringify(xLabels)}`);
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-12: trends_modal 1D fallback renders single rangeBar with value labels above/below caps', () => {
    const { doc, canvas } = setupModalDOM(false);
    const daily = makeDailyRecords(7);
    daily[daily.length - 1] = {
      date: '2026-11-12',
      body_battery_high: 95,
      body_battery_low: 22,
      body_battery_charged: 72,
      body_battery_drained: 71,
      intraday_body_battery: [[Date.UTC(2026, 10, 12, 8, 0), 80]] // <= 1 point -> fallback
    };

    trendsModal.openMetricTrendModal('body_battery', { wellness: { daily } });
    canvas.resetCtx(false);
    trendsModal.setTimeRange('1d');

    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '1 records');
    const ctx = canvas.getContext('2d');
    assert.strictEqual(ctx.calls.filter(c => c.op === 'stroke' && c.strokeStyle === '#c4b5fd' && c.lineWidth === 2).length, 1);
    assert.strictEqual(ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#38bdf8').length, 2);
    assert.strictEqual(ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714').length, 2);
    const texts = ctx.calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.includes('95'), `Expected High cap value label '95' in ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('22'), `Expected Low cap value label '22' in ${JSON.stringify(texts)}`);
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-13: Hover tooltip integration via trends_modal rangeBar renders Thu, Nov 12 & High/Low/Charged/Drained', () => {
    const { canvas } = setupModalDOM(false);
    const daily = [{
      date: '2026-11-12',
      body_battery_high: 95,
      body_battery_low: 22,
      body_battery_charged: 72,
      body_battery_drained: 71
    }];

    trendsModal.openMetricTrendModal('body_battery', { wellness: { daily } });
    const ctx = canvas.getContext('2d');
    ctx.calls = [];

    // Trigger mousemove near center of plot area (x = 314, y = 150) where single bar sits
    canvas.dispatchEvent({ type: 'mousemove', clientX: 314, clientY: 150 });
    const texts = ctx.calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.includes('Thu, Nov 12'), `Expected 'Thu, Nov 12', got ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('Daily High: 95 pts'));
    assert.ok(texts.includes('Daily Low: 22 pts'));
    assert.ok(texts.includes('Charged: +72 pts | Drained: -71 pts'));
    trendsModal.closeMetricTrendModal();
  });

  // ==========================================================================
  // Section 6: Zero-Value & Missing/Corrupt Data Resilience
  // ==========================================================================
  test('M3-RB-14: Zero-value preservation (0 pts, +0 pts, -0 pts) in KPIs, table, and 1D/7D rangeBar', () => {
    const { doc } = setupModalDOM(false);
    const zeroRollup = {
      wellness: {
        daily: [{
          date: '2026-11-12',
          body_battery: 0,
          body_battery_high: 0,
          body_battery_low: 0,
          body_battery_charged: 0,
          body_battery_drained: 0
        }]
      }
    };

    trendsModal.openMetricTrendModal('body_battery', zeroRollup);
    trendsModal.setTimeRange('1d');
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '1 records');

    const kpiHtml = doc.getElementById('trend-kpi-grid').innerHTML;
    assert.ok(kpiHtml.includes('0 pts'), 'KPI grid must preserve 0 pts');
    assert.ok(kpiHtml.includes('+0 pts'), 'KPI grid must preserve +0 pts');
    assert.ok(kpiHtml.includes('-0 pts'), 'KPI grid must preserve -0 pts');
    assert.ok(!kpiHtml.includes('90 pts') && !kpiHtml.includes('25 pts'), 'Zero must never fall back to defaults');

    const tableHtml = doc.getElementById('trend-table-body').innerHTML;
    assert.ok(!tableHtml.includes('NaN'), 'No NaN in table');
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-15: Missing/NaN fields and empty rollup resilience', () => {
    const { doc, canvas } = setupModalDOM(false);
    const corruptRollup = {
      wellness: {
        daily: [
          { date: '2026-11-11' },
          { date: '2026-11-12', body_battery_high: NaN, body_battery_low: NaN, body_battery_charged: NaN, body_battery_drained: NaN }
        ]
      }
    };

    trendsModal.openMetricTrendModal('body_battery', corruptRollup);
    assert.ok(!doc.getElementById('trend-kpi-grid').innerHTML.includes('NaN'));
    assert.ok(!doc.getElementById('trend-table-body').innerHTML.includes('NaN'));
    const texts = canvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(!texts.some(t => t.includes('NaN')), 'No NaN in canvas text');

    trendsModal.openMetricTrendModal('body_battery', { wellness: { daily: [] } });
    assert.ok(!doc.getElementById('trend-chart-empty').classList.contains('hidden'), 'Empty notice must be shown');
    trendsModal.closeMetricTrendModal();
  });

  // ==========================================================================
  // Section 7: Minimal MockCtx Fallback Compatibility
  // ==========================================================================
  test('M3-RB-16: Minimal MockCtx (no roundRect, createLinearGradient, clip, setLineDash) renders rangeBar & tooltip cleanly', () => {
    const { canvas } = setupModalDOM(true);
    const minimalCtx = canvas.getContext('2d');
    assert.strictEqual(minimalCtx.roundRect, undefined);
    assert.strictEqual(minimalCtx.createLinearGradient, undefined);
    assert.strictEqual(minimalCtx.clip, undefined);

    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-11', '2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [95, 88],
          lowData: [22, 18],
          chargedData: [72, 70],
          drainedData: [71, 68],
          showCapLabels: true
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    const rectCalls = minimalCtx.calls.filter(c => c.op === 'rect');
    assert.ok(rectCalls.length >= 2, 'Should fall back to ctx.rect when roundRect is absent');
    const solidFills = minimalCtx.calls.filter(c => c.op === 'fill' && typeof c.fillStyle === 'string');
    assert.ok(solidFills.length > 0, 'Should fall back to solid fillStyle when createLinearGradient is absent');

    // Trigger tooltip rendering under minimal MockCtx
    const pt = chart.dataPoints[0];
    chart._handleMouseMove({ clientX: pt.x, clientY: pt.yTop });
    assert.strictEqual(chart.activeTooltip?.label, pt.label);
    chart.destroy();

    // Also test full trends_modal flows under minimal MockCtx
    const rollup = { wellness: { daily: makeDailyRecords(7, { includeIntradayLatest: true }) } };
    trendsModal.openMetricTrendModal('body_battery', rollup);
    trendsModal.setTimeRange('1d');
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-17: Existing Chart types (line, bar, doughnut) remain unaffected under Minimal MockCtx', () => {
    const canvas = new MockElement('canvas', 'rb-17', '', { width: 600, height: 300, omitOptionalCtx: true });
    const c1 = new Chart(canvas, {
      type: 'line',
      data: { labels: ['2026-11-11', '2026-11-12'], datasets: [{ label: 'HRV', data: [55, 62], fill: true }] }
    });
    const c2 = new Chart(canvas, {
      type: 'bar',
      data: { labels: ['2026-11-11', '2026-11-12'], datasets: [{ label: 'Steps', data: [8000, 12000], backgroundColor: '#10b981' }] }
    });
    const c3 = new Chart(canvas, {
      type: 'doughnut',
      data: { labels: ['Z1', 'Z2', 'Z3'], datasets: [{ data: [30, 50, 20] }] }
    });
    assert.ok(c1.dataPoints.length === 2 && c2.dataPoints.length === 2 && c3.doughnutSlices.length === 3);
    c1.destroy();
    c2.destroy();
    c3.destroy();
  });

  // ==========================================================================
  // Section 8: Iteration 2 Regression Suite
  // ==========================================================================
  test('M3-RB-18: trends_modal 1D intraday supports {time: "HH:MM", value} objects & 3/4-elem Garmin tuples', () => {
    const { doc, canvas } = setupModalDOM(false);
    const daily = makeDailyRecords(5);
    daily[daily.length - 1].intraday_body_battery = [
      { time: '00:00', value: 42 },
      { time: '06:00', value: 94 },
      { time: '12:30:15', value: 66 },
      { time: '18:00', value: 40 },
      { time: '23:00', value: 28 },
      { time: '25:00', value: 50 }, // invalid hour -> ignored
      { time: '12:60', value: 50 }  // invalid minute -> ignored
    ];

    trendsModal.openMetricTrendModal('body_battery', { wellness: { daily } });
    canvas.resetCtx(false);
    trendsModal.setTimeRange('1d');

    let ctx = canvas.getContext('2d');
    let curveCalls = ctx.calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(curveCalls.length >= 4, `Expected intraday curve for HH:MM objects, got ${curveCalls.length}`);
    assert.strictEqual(ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714').length, 0);
    const xLabels = ctx.calls.filter(c => c.op === 'fillText' && c.textBaseline === 'top' && c.textAlign === 'center').map(c => c.text);
    assert.ok(xLabels.includes('00:00') && xLabels.includes('23:00'), `Expected 00:00 and 23:00 labels, got ${JSON.stringify(xLabels)}`);

    // Also verify 3/4-element Garmin tuples [epoch_ms, status, level, ...] & Sentinel filtering
    daily[daily.length - 1].intraday_body_battery = [
      [Date.UTC(2026, 10, 12, 0, 0), 'MEASURED', 35],
      [Date.UTC(2026, 10, 12, 4, 0), 'CHARGED', -1], // sentinel -> ignored
      [Date.UTC(2026, 10, 12, 8, 0), 'CHARGED', null, 88],
      [Date.UTC(2026, 10, 12, 16, 0), 'DRAINED', 52]
    ];
    canvas.resetCtx(false);
    trendsModal.setTimeRange('1d');
    ctx = canvas.getContext('2d');
    curveCalls = ctx.calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(curveCalls.length >= 2, 'Expected intraday curve for 3/4-elem Garmin tuples');
    assert.strictEqual(ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === '#0b0714').length, 0);
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '1 records');
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-19: Timezone-safe ISO YYYY-MM-DD filtering includes latest day in 1D/7D/1Y/Custom', () => {
    const { doc } = setupModalDOM(false);
    const daily = makeDailyRecords(365);
    const rollup = { wellness: { daily } };

    // Verify direct getFilteredTelemetryData anchored on latest ISO string
    const res1d = trendsModal.getFilteredTelemetryData('body_battery', '1d', '2026-11-12', rollup);
    assert.strictEqual(res1d.records.length, 1);
    assert.strictEqual(res1d.records[0].date, '2026-11-12');

    const res7d = trendsModal.getFilteredTelemetryData('body_battery', '7d', '2026-11-12', rollup);
    assert.strictEqual(res7d.records.length, 7);
    assert.strictEqual(res7d.records[6].date, '2026-11-12');

    const res1y = trendsModal.getFilteredTelemetryData('body_battery', '1y', '2026-11-12', rollup);
    assert.strictEqual(res1y.records.length, 365);
    assert.strictEqual(res1y.records[364].date, '2026-11-12');

    trendsModal.openMetricTrendModal('body_battery', rollup);
    trendsModal.setTimeRange('1d');
    assert.strictEqual(doc.getElementById('trend-table-count').textContent, '1 records');
    assert.strictEqual(doc.getElementById('trend-date-label').textContent, 'Nov 12, 2026');
    trendsModal.closeMetricTrendModal();
  });

  test('M3-RB-20: Inverted low > high in Chart rangeBar keeps cap labels, tooltips, and dataPoints consistent', () => {
    const canvas = new MockElement('canvas', 'rb-20', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [40],
          lowData: [80],
          chargedData: [40],
          drainedData: [35],
          showCapLabels: true
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    assert.strictEqual(chart.dataPoints[0].highVal, 80, 'Normalized highVal must be 80');
    assert.strictEqual(chart.dataPoints[0].lowVal, 40, 'Normalized lowVal must be 40');

    const hiText = ctx.calls.find(c => c.op === 'fillText' && c.text === '80' && c.fillStyle === '#38bdf8');
    const loText = ctx.calls.find(c => c.op === 'fillText' && c.text === '40' && c.fillStyle === '#c4b5fd');
    assert.ok(hiText, 'Top cap label "80" must use High color #38bdf8');
    assert.ok(loText, 'Bottom cap label "40" must use Low color #c4b5fd');
    assert.ok(hiText.y < loText.y, 'High label "80" must be positioned above Low label "40"');

    ctx.calls = [];
    const pt = chart.dataPoints[0];
    chart._handleMouseMove({ clientX: pt.x, clientY: (pt.yTop + pt.yBottom) / 2 });
    const tipTexts = ctx.calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(tipTexts.includes('Daily High: 80 pts'), `Expected Daily High: 80 pts in ${JSON.stringify(tipTexts)}`);
    assert.ok(tipTexts.includes('Daily Low: 40 pts'), `Expected Daily Low: 40 pts in ${JSON.stringify(tipTexts)}`);
    chart.destroy();
  });

  test('M3-RB-21: showCapLabels avoids overlapping cap circles at high=100 / low=0 and preserves normal above/below placement', () => {
    const getTextBox = (call) => {
      const h = 10;
      const w = call.width || String(call.text).length * 6;
      const x0 = call.textAlign === 'center' ? call.x - w / 2 : (call.textAlign === 'right' ? call.x - w : call.x);
      const x1 = x0 + w;
      const y0 = call.textBaseline === 'bottom' ? call.y - h : (call.textBaseline === 'middle' ? call.y - h / 2 : call.y);
      const y1 = y0 + h;
      return { x0, x1, y0, y1 };
    };
    const overlapsCircle = (box, cx, cy, r) => {
      const nearX = Math.max(box.x0, Math.min(cx, box.x1));
      const nearY = Math.max(box.y0, Math.min(cy, box.y1));
      return ((nearX - cx) ** 2 + (nearY - cy) ** 2) < (r * r);
    };

    // 1. Extreme boundary: high=100, low=0, plus equal extremes 100/100 and 0/0, plus normal 88/24
    const canvas = new MockElement('canvas', 'rb-21', '', { width: 600, height: 300 });
    const ctx = canvas.getContext('2d');
    const chart = new Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'],
        datasets: [{
          label: 'Body Battery',
          highData: [100, 100, 0, 88],
          lowData: [0, 100, 0, 24],
          showCapLabels: true
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });

    // Collect arc circles (last 2 legend/cap check: cap circles have fillStyle '#38bdf8' or '#0b0714' and x inside plot area)
    const capArcs = ctx.calls.filter((c, idx) => {
      if (c.op !== 'arc') return false;
      const next = ctx.calls[idx + 1];
      return next && next.op === 'fill' && (next.fillStyle === '#38bdf8' || next.fillStyle === '#0b0714') && c.args[1] >= 30;
    });
    assert.strictEqual(capArcs.length, 8, `Expected 8 cap arcs across 4 bars, got ${capArcs.length}`);

    const capLabels = ctx.calls.filter(c =>
      c.op === 'fillText' && (c.fillStyle === '#38bdf8' || c.fillStyle === '#c4b5fd') && /^\d+$/.test(c.text)
    );
    assert.strictEqual(capLabels.length, 8, `Expected 8 cap value labels, got ${capLabels.length}`);

    for (const lbl of capLabels) {
      const box = getTextBox(lbl);
      for (const arc of capArcs) {
        const [cx, cy, r] = arc.args;
        assert.ok(!overlapsCircle(box, cx, cy, r), `Cap label "${lbl.text}" (${JSON.stringify(box)}) overlaps cap circle (${cx}, ${cy}, r=${r})`);
      }
    }

    // Verify normal bar (88/24) still renders '88' above High cap and '24' below Low cap
    const ptNormal = chart.dataPoints[3];
    const lbl88 = capLabels.find(c => c.text === '88');
    const lbl24 = capLabels.find(c => c.text === '24');
    assert.ok(lbl88 && lbl88.textBaseline === 'bottom' && lbl88.y < ptNormal.yTop, 'Normal high label 88 must draw above High cap');
    assert.ok(lbl24 && lbl24.textBaseline === 'top' && lbl24.y > ptNormal.yBottom, 'Normal low label 24 must draw below Low cap');
    chart.destroy();
  });

  console.log(`\nALL ${passed} M3 BODY BATTERY RANGEBAR TESTS PASSED.`);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
