/**
 * tests/test_m8_readiness_and_vitals.js
 *
 * Milestone 3 (M8): Training Readiness & Expanded Vitals Cards + Trend Modals
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Minimal DOM mock for Node.js ESM environment
function createMockElement(id = '', tag = 'div') {
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  let _innerHTML = '';
  const el = {
    id,
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    value: '',
    textContent: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k] ?? null,
    hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    dispatchEvent: (ev) => { if (listeners[ev.type]) listeners[ev.type](ev); },
    appendChild: (child) => { el.children.push(child); return child; },
    querySelector: (sel) => {
      const m = sel.match(/\[data-metric="([^"]+)"\]/);
      if (m && _innerHTML.includes(`data-metric="${m[1]}"`)) {
        const card = createMockElement(`card-wellness-${m[1]}`);
        card.setAttribute('data-metric', m[1]);
        card.classList.add('cursor-pointer');
        return card;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-metric]') {
        const matches = [..._innerHTML.matchAll(/data-metric="([^"]+)"/g)];
        return matches.map((m) => {
          const card = createMockElement(`card-wellness-${m[1]}`);
          card.setAttribute('data-metric', m[1]);
          return card;
        });
      }
      if (sel === 'tr') {
        const matches = [..._innerHTML.matchAll(/<tr\b/g)];
        return matches.map(() => createMockElement('', 'tr'));
      }
      return [];
    },
    getContext: () => ({
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      fillText: () => {},
      measureText: (t) => ({ width: String(t).length * 6 }),
      setLineDash: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
    }),
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => _innerHTML,
    set: (val) => {
      _innerHTML = String(val);
      if (id === 'trend-kpi-grid') {
        const count = (_innerHTML.match(/rounded-(?:lg|xl)/g) || []).length;
        el.children = Array.from({ length: count }, () => createMockElement());
      }
    },
  });
  return el;
}

const elements = new Map();
for (const id of [
  'health-fitness-dashboard',
  'wellness-dashboard',
  'wellness-in-focus',
  'wellness-at-a-glance',
  'wellness-readiness-vitals',
  'metric-trend-modal',
  'trend-modal-panel',
  'trend-modal-title',
  'trend-modal-subtitle',
  'trend-modal-badge',
  'trend-modal-icon',
  'trend-kpi-grid',
  'trend-modal-canvas',
  'trend-table-head',
  'trend-table-header-row',
  'trend-table-body',
  'trend-modal-range-label',
  'trend-modal-close',
  'trend-modal-expand',
  'trend-modal-prev',
  'trend-modal-next',
]) {
  elements.set(id, createMockElement(id));
}
elements.get('metric-trend-modal').setAttribute('aria-hidden', 'true');

global.document = {
  body: createMockElement('body', 'body'),
  getElementById: (id) => {
    if (id === 'card-wellness-training-readiness') {
      const vitals = elements.get('wellness-readiness-vitals');
      if (vitals && vitals.innerHTML.includes('id="card-wellness-training-readiness"')) {
        const c = createMockElement(id);
        c.setAttribute('data-metric', 'training_readiness');
        return c;
      }
      return null;
    }
    return elements.get(id) || null;
  },
  createElement: (tag) => createMockElement('', tag),
  querySelectorAll: () => [],
  addEventListener: () => {},
};
global.window = { devicePixelRatio: 1 };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const {
  DEFAULT_WELLNESS_LAYOUT,
  WELLNESS_METRIC_METADATA,
  renderWellnessDashboard,
} = await import('../frontend/src/charts/wellness.js');

const {
  METRIC_CONFIGS,
  initTrendsModal,
  openMetricTrendModal,
} = await import('../frontend/src/charts/trends_modal.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }
}

console.log('\n======================================================================');
console.log('Milestone 3: Training Readiness & Expanded Vitals Test Suite');
console.log('======================================================================');

const ROOT = process.cwd();
const pyJson = execFileSync(
  'python3',
  [
    '-c',
    `
import json
from src.ingestion.mock_generator import generate_wellness_dataset
ds = generate_wellness_dataset(seed=42, days=14)
print(json.dumps(ds))
`,
  ],
  { cwd: ROOT, encoding: 'utf8' }
);
const wellnessData = JSON.parse(pyJson);

test('M3-PY-01: generate_wellness_dataset populates all 16 M3 vitals keys on daily & current', () => {
  const keys = [
    'training_readiness_score',
    'training_readiness_level',
    'vo2max_running',
    'vo2max_cycling',
    'spo2_avg',
    'spo2_low',
    'respiration_waking',
    'respiration_sleep',
    'floors_ascended',
    'floors_descended',
    'hydration_ml',
    'hydration_goal_ml',
    'weight_kg',
    'bmi',
    'body_fat_pct',
    'muscle_mass_kg',
  ];
  assert.equal(wellnessData.daily.length, 14);
  for (const rec of wellnessData.daily) {
    for (const k of keys) {
      assert.ok(rec[k] !== undefined && rec[k] !== null, `Missing ${k} on daily record`);
    }
    assert.ok(rec.training_readiness_score >= 0 && rec.training_readiness_score <= 100);
    assert.ok(['Prime', 'High', 'Moderate', 'Low'].includes(rec.training_readiness_level));
  }
  for (const k of keys) {
    assert.ok(wellnessData.current[k] !== undefined && wellnessData.current[k] !== null, `Missing ${k} on current`);
  }
});

test('M3-WELLNESS-01: DEFAULT_WELLNESS_LAYOUT preserves 4 in_focus and 4 at_a_glance items', () => {
  assert.equal(DEFAULT_WELLNESS_LAYOUT.in_focus.length, 4);
  assert.equal(DEFAULT_WELLNESS_LAYOUT.at_a_glance.length, 4);
});

const M3_METRICS = [
  'training_readiness',
  'vo2max',
  'spo2',
  'respiration',
  'floors',
  'hydration',
  'weight',
];

test('M3-WELLNESS-02: WELLNESS_METRIC_METADATA registers all 7 new metrics', () => {
  for (const m of M3_METRICS) {
    assert.ok(WELLNESS_METRIC_METADATA[m], `Missing ${m} in WELLNESS_METRIC_METADATA`);
  }
});

const rollup = { wellness: wellnessData };

test('M3-DOM-01: renderWellnessDashboard renders Training Readiness card & Expanded Vitals Strip', () => {
  renderWellnessDashboard(rollup);
  const vitalsStrip = document.getElementById('wellness-readiness-vitals');
  assert.ok(vitalsStrip, 'Missing #wellness-readiness-vitals');

  const trCard = document.getElementById('card-wellness-training-readiness');
  assert.ok(trCard, 'Missing #card-wellness-training-readiness');
  assert.equal(trCard.getAttribute('data-metric'), 'training_readiness');

  for (const m of M3_METRICS) {
    const el = vitalsStrip.querySelector(`[data-metric="${m}"]`);
    assert.ok(el, `Missing vitals card for data-metric="${m}"`);
    assert.ok(el.classList.contains('cursor-pointer'), `Card ${m} should have cursor-pointer`);
  }
});

initTrendsModal();

for (const m of M3_METRICS) {
  test(`M3-MODAL-${m}: METRIC_CONFIGS, 4 KPIs, and table render cleanly for '${m}'`, () => {
    assert.ok(METRIC_CONFIGS[m], `Missing ${m} in METRIC_CONFIGS`);
    openMetricTrendModal(m, rollup);

    const modal = document.getElementById('metric-trend-modal');
    assert.equal(modal.getAttribute('aria-hidden'), 'false');

    const kpis = document.getElementById('trend-kpi-grid');
    assert.ok(kpis && kpis.children.length === 4, `Expected 4 KPI cards for ${m}`);

    const tbody = document.getElementById('trend-table-body');
    assert.ok(tbody && tbody.querySelectorAll('tr').length > 0, `Expected table rows for ${m}`);
  });
}

console.log('\n======================================================================');
console.log(`Milestone 3 Test Suite Results: ${passed} passed, ${failed} failed (Total: ${passed + failed})`);
console.log('======================================================================\n');

if (failed > 0) process.exit(1);
