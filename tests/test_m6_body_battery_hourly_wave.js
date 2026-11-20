import assert from 'node:assert';
import { Chart } from '../frontend/src/charts/chart_engine.js';
import * as trendsModal from '../frontend/src/charts/trends_modal.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err.message);
    failed++;
  }
}

function createMockCtx({ withGradient = true, withBezier = true, withClip = true } = {}) {
  const calls = [];
  let _fillStyle = '#000';
  let _strokeStyle = '#000';
  let _lineWidth = 1;
  let _textAlign = 'left';
  let _textBaseline = 'alphabetic';
  let _font = '10px sans-serif';
  let _globalAlpha = 1;

  const ctx = {
    calls,
    get fillStyle() { return _fillStyle; },
    set fillStyle(v) { _fillStyle = v; },
    get strokeStyle() { return _strokeStyle; },
    set strokeStyle(v) { _strokeStyle = v; },
    get lineWidth() { return _lineWidth; },
    set lineWidth(v) { _lineWidth = v; },
    get textAlign() { return _textAlign; },
    set textAlign(v) { _textAlign = v; },
    get textBaseline() { return _textBaseline; },
    set textBaseline(v) { _textBaseline = v; },
    get font() { return _font; },
    set font(v) { _font = v; },
    get globalAlpha() { return _globalAlpha; },
    set globalAlpha(v) { _globalAlpha = v; },
    save() { calls.push({ op: 'save' }); },
    restore() { calls.push({ op: 'restore' }); },
    scale() {},
    clearRect() {},
    beginPath() { calls.push({ op: 'beginPath' }); },
    closePath() { calls.push({ op: 'closePath' }); },
    moveTo(x, y) { calls.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { calls.push({ op: 'lineTo', x, y }); },
    rect(x, y, w, h) { calls.push({ op: 'rect', x, y, w, h }); },
    arc(x, y, r) { calls.push({ op: 'arc', x, y, r }); },
    fill() { calls.push({ op: 'fill', fillStyle: _fillStyle }); },
    stroke() { calls.push({ op: 'stroke', strokeStyle: _strokeStyle, lineWidth: _lineWidth }); },
    fillText(text, x, y) {
      calls.push({ op: 'fillText', text, x, y, textAlign: _textAlign, textBaseline: _textBaseline });
    },
    measureText(text) { return { width: String(text || '').length * 6 }; },
    setLineDash() {}
  };

  if (withGradient) {
    ctx.createLinearGradient = (x0, y0, x1, y1) => {
      const stops = [];
      const grad = {
        __isGradient: true,
        stops,
        addColorStop(offset, color) { stops.push({ offset, color }); }
      };
      calls.push({ op: 'createLinearGradient', x0, y0, x1, y1, stops });
      return grad;
    };
  }
  if (withBezier) {
    ctx.bezierCurveTo = (cp1x, cp1y, cp2x, cp2y, x, y) => {
      calls.push({ op: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
    };
  }
  if (withClip) {
    ctx.clip = () => { calls.push({ op: 'clip' }); };
  }
  return ctx;
}

function createMockCanvas(width = 640, height = 320, ctxOpts = {}) {
  const ctx = createMockCtx(ctxOpts);
  return {
    width,
    height,
    style: {},
    clientWidth: width,
    clientHeight: height,
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
    addEventListener() {},
    removeEventListener() {}
  };
}

function setupModalDOM() {
  const elements = new Map();
  const makeEl = (id, tag = 'div') => {
    const listeners = {};
    const el = {
      id,
      tagName: tag.toUpperCase(),
      textContent: '',
      innerHTML: '',
      value: '',
      className: '',
      disabled: false,
      style: {},
      dataset: {},
      classList: {
        _set: new Set(['hidden']),
        add(...cls) { cls.forEach(c => this._set.add(c)); },
        remove(...cls) { cls.forEach(c => this._set.delete(c)); },
        toggle(c, force) {
          if (force === undefined) {
            if (this._set.has(c)) this._set.delete(c);
            else this._set.add(c);
          } else if (force) {
            this._set.add(c);
          } else {
            this._set.delete(c);
          }
        },
        contains(c) { return this._set.has(c); }
      },
      attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
      getContext: null
    };
    elements.set(id, el);
    return el;
  };

  [
    'metric-trend-modal', 'trend-modal-backdrop', 'trend-modal-panel',
    'trend-metric-title', 'trend-metric-subtitle', 'trend-date-range-label',
    'trend-time-range-group', 'trend-prev-btn', 'trend-next-btn',
    'trend-custom-range-panel', 'trend-custom-start', 'trend-custom-end',
    'trend-custom-apply', 'trend-custom-error', 'trend-expand-btn',
    'trend-close-btn', 'trend-kpi-grid', 'metric-trend-chart',
    'trend-table-head', 'trend-table-body', 'trend-table-count'
  ].forEach(id => makeEl(id));

  const canvas = createMockCanvas(640, 280);
  const canvasEl = elements.get('metric-trend-chart');
  Object.assign(canvasEl, canvas);

  globalThis.document = {
    body: { style: {} },
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {}
  };
  return { elements, canvasEl };
}

test('M6-BB-01: chart_engine rangeBar renders backgroundCurve before pillars & caps', () => {
  const canvas = createMockCanvas(600, 300);
  const ctx = canvas.getContext('2d');
  new Chart(canvas, {
    type: 'rangeBar',
    data: {
      labels: ['Mon', 'Tue'],
      datasets: [{
        label: 'Body Battery',
        data: [90, 85],
        highData: [90, 85],
        lowData: [20, 25],
        backgroundCurve: {
          enabled: true,
          daySamples: [
            [{ frac: 0.0, value: 30 }, { frac: 0.3, value: 90 }, { frac: 0.9, value: 20 }],
            [{ frac: 0.0, value: 25 }, { frac: 0.3, value: 85 }, { frac: 0.9, value: 25 }]
          ]
        },
        legendItems: [
          { label: 'Daily High', color: '#38bdf8', shape: 'dot' },
          { label: 'Daily Low', color: '#c4b5fd', fillColor: '#0b0714', strokeColor: '#c4b5fd', shape: 'ring' },
          { label: 'Hourly Trend', color: '#a855f7', strokeColor: '#a855f7', shape: 'line' }
        ]
      }]
    },
    options: { scales: { y: { min: 0, max: 100 } } }
  });

  const bezierIdx = ctx.calls.findIndex(c => c.op === 'bezierCurveTo');
  const firstCapIdx = ctx.calls.findIndex(c => c.op === 'fill' && c.fillStyle === '#38bdf8');
  assert.ok(bezierIdx !== -1, 'Expected bezierCurveTo calls for backgroundCurve');
  assert.ok(firstCapIdx !== -1, 'Expected #38bdf8 High cap fill');
  assert.ok(bezierIdx < firstCapIdx, 'backgroundCurve must render BEFORE foreground High/Low caps');

  const legendTexts = ctx.calls
    .filter(c => c.op === 'fillText' && c.textBaseline === 'middle' && c.textAlign === 'left')
    .map(c => c.text);
  assert.deepStrictEqual(legendTexts, ['Daily High', 'Daily Low', 'Hourly Trend']);
});

test('M6-BB-02: chart_engine backgroundCurve guards missing createLinearGradient, bezierCurveTo, and clip', () => {
  const canvas = createMockCanvas(600, 300, { withGradient: false, withBezier: false, withClip: false });
  const ctx = canvas.getContext('2d');
  new Chart(canvas, {
    type: 'rangeBar',
    data: {
      labels: ['Mon', 'Tue'],
      datasets: [{
        label: 'Body Battery',
        data: [80, 75],
        highData: [80, 75],
        lowData: [30, 25],
        backgroundCurve: {
          enabled: true,
          fallbackColor: '#a855f7',
          daySamples: [
            [{ frac: 0.0, value: 30 }, { frac: 0.5, value: 80 }],
            [{ frac: 0.0, value: 25 }, { frac: 0.5, value: 75 }]
          ]
        }
      }]
    },
    options: { scales: { y: { min: 0, max: 100 } } }
  });

  const waveStroke = ctx.calls.find(c => c.op === 'stroke' && c.strokeStyle === '#a855f7' && c.lineWidth === 2.2);
  assert.ok(waveStroke, 'Expected fallbackColor #a855f7 stroke when createLinearGradient is absent');
  const lineToCalls = ctx.calls.filter(c => c.op === 'lineTo');
  assert.ok(lineToCalls.length >= 4, 'Expected lineTo fallback when bezierCurveTo is absent');
});

test('M6-BB-03: trends_modal 7D body_battery extracts intraday samples & synthesizes 6-pt diurnal fallback', () => {
  const { elements, canvasEl } = setupModalDOM();
  const ctx = canvasEl.getContext('2d');
  const rollup = {
    wellness: {
      daily: [
        { date: '2026-11-10', body_battery_high: 88, body_battery_low: 22, body_battery_at_wake: 85 },
        {
          date: '2026-11-11',
          body_battery_high: 92,
          body_battery_low: 28,
          intraday_body_battery: Array.from({ length: 48 }, (_, i) => ({
            time: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
            value: i === 14 ? 92 : (i === 44 ? 28 : 55)
          }))
        }
      ]
    }
  };

  trendsModal.openMetricTrendModal('body_battery', rollup);
  assert.strictEqual(elements.get('trend-metric-title').textContent, 'Body Battery');

  const hasBezier = ctx.calls.some(c => c.op === 'bezierCurveTo');
  assert.ok(hasBezier, 'Expected continuous hourly wave bezierCurveTo in multi-day body_battery');

  const legendTexts = ctx.calls
    .filter(c => c.op === 'fillText' && c.textBaseline === 'middle' && c.textAlign === 'left')
    .map(c => c.text);
  assert.deepStrictEqual(legendTexts, ['Daily High', 'Daily Low', 'Hourly Trend']);
});

test('M6-BB-04: trends_modal 1D mode preserves single-day intraday line curve', () => {
  const { elements, canvasEl } = setupModalDOM();
  const ctx = canvasEl.getContext('2d');
  const rollup = {
    wellness: {
      daily: [
        {
          date: '2026-11-11',
          body_battery_high: 90,
          body_battery_low: 25,
          intraday_body_battery: [
            { time: '00:00', value: 40 },
            { time: '07:00', value: 90 },
            { time: '22:00', value: 25 }
          ]
        }
      ]
    }
  };

  trendsModal.openMetricTrendModal('body_battery', rollup);
  trendsModal.setTimeRange('1d');
  assert.strictEqual(elements.get('trend-metric-title').textContent, 'Body Battery');
  assert.ok(ctx.calls.length > 0, 'Expected 1D intraday line chart to render');
});

console.log(`\nM6 Body Battery Hourly Wave Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
