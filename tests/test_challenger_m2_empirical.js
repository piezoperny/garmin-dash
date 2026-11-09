/**
 * tests/test_challenger_m2_empirical.js
 *
 * Challenger M2-1 Empirical Adversarial Test Suite for:
 * 1. #kpi-weekly-load recency calculation across edge cases, time boundaries, and sport filters.
 * 2. Activity Table badge taxonomy for corrupt/missing sports.
 * 3. Endurance Volume Chart sport data isolation & color distinctiveness.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  querySelector(selector) {
    if (selector === 'tbody') {
      return this.children.find(c => c.tagName === 'TBODY') || null;
    }
    return null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  getContext() {
    return {
      clearRect: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      arc: () => {},
      fillText: () => {},
      measureText: () => ({ width: 40 }),
      save: () => {},
      restore: () => {},
      setLineDash: () => {}
    };
  }
  getBoundingClientRect() {
    return { width: 500, height: 350, top: 0, left: 0, right: 500, bottom: 350 };
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
  }
  getElementById(id) {
    return this.elements.get(id) || null;
  }
  createElement(tag) {
    return new MockElement('', tag);
  }
  registerElement(el) {
    this.elements.set(el.id, el);
    return el;
  }
}

const mockDoc = new MockDocument();
global.document = mockDoc;
global.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {}
};

async function runEmpiricalSuite() {
  console.log('\n======================================================================');
  console.log('Challenger M2-1: Empirical Adversarial Verification of Milestone 2');
  console.log('======================================================================\n');

  // Register DOM elements
  const kpiTotalDist = mockDoc.registerElement(new MockElement('kpi-total-distance'));
  const kpiTotalTime = mockDoc.registerElement(new MockElement('kpi-total-time'));
  const kpiWeeklyLoad = mockDoc.registerElement(new MockElement('kpi-weekly-load'));
  const kpiStatus = mockDoc.registerElement(new MockElement('kpi-status'));
  const weeklyVolumeCanvas = mockDoc.registerElement(new MockElement('weekly-volume-chart', 'canvas'));
  const activityTable = mockDoc.registerElement(new MockElement('activity-table', 'table'));
  const tbody = new MockElement('activities-table-body', 'tbody');
  activityTable.appendChild(tbody);
  mockDoc.registerElement(tbody);

  const basePath = 'file:///' + path.resolve(__dirname, '../frontend/src').replace(/\\/g, '/');
  const enduranceModule = await import(`${basePath}/charts/endurance.js`);
  const activitiesModule = await import(`${basePath}/charts/activities.js`);

  let passCount = 0;
  function pass(msg) {
    passCount++;
    console.log(`  ✓ [PASS ${passCount}] ${msg}`);
  }

  // -------------------------------------------------------------------------
  // TEST SECTION 1: #kpi-weekly-load Edge Cases & Time Boundaries
  // -------------------------------------------------------------------------
  console.log('--- Section 1: #kpi-weekly-load Calculation & Recency Stress Tests ---');

  // Case 1.1: User scenario: Hikes exist 45+ days ago, latest week has 0 hikes
  const userScenarioRollup = {
    activities: [
      { id: 'h1', sport: 'hiking', date: '2026-09-01T08:00:00Z', tss: 120 },
      { id: 'h2', sport: 'hiking', date: '2026-09-08T08:00:00Z', tss: 130 },
      { id: 'r1', sport: 'running', date: '2026-10-20T07:00:00Z', tss: 70 },
      { id: 'c1', sport: 'cycling', date: '2026-10-21T07:00:00Z', tss: 90 },
      { id: 's1', sport: 'strength', date: '2026-10-22T07:00:00Z', tss: 40 },
    ],
    training_load: {
      weekly: [
        { week: '2026-W35', week_start: '2026-08-24', load: 120 },
        { week: '2026-W36', week_start: '2026-08-31', load: 130 },
        { week: '2026-W43', week_start: '2026-10-19', load: 200 }
      ]
    }
  };

  enduranceModule.renderKPICards(userScenarioRollup, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '0 TSS/wk', 'Hiking load must be 0 TSS/wk when no hikes in recent week');
  pass('User scenario: 0 TSS/wk for hiking despite historical hikes from 1.5 months ago');

  enduranceModule.renderKPICards(userScenarioRollup, 'km', 'all');
  assert.strictEqual(kpiWeeklyLoad.textContent, '200 TSS/wk', 'All-sport weekly load must show latest week total');
  pass('All-sports filter correctly reports latest week total load (200 TSS/wk)');

  enduranceModule.renderKPICards(userScenarioRollup, 'km', 'running');
  assert.strictEqual(kpiWeeklyLoad.textContent, '70 TSS/wk', 'Running filter must show recent week running TSS (70)');
  pass('Running filter isolates recent week running TSS (70 TSS/wk)');

  enduranceModule.renderKPICards(userScenarioRollup, 'km', 'cycling');
  assert.strictEqual(kpiWeeklyLoad.textContent, '90 TSS/wk', 'Cycling filter must show recent week cycling TSS (90)');
  pass('Cycling filter isolates recent week cycling TSS (90 TSS/wk)');

  enduranceModule.renderKPICards(userScenarioRollup, 'km', 'strength');
  assert.strictEqual(kpiWeeklyLoad.textContent, '40 TSS/wk', 'Strength filter must show recent week strength TSS (40)');
  pass('Strength filter isolates recent week strength TSS (40 TSS/wk)');

  // Case 1.2: Boundary Testing for Week Window [latestWeekStart, latestWeekEnd)
  const weekStart = new Date('2026-10-19T00:00:00.000Z').getTime();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  const boundaryRollup = {
    activities: [
      // 1 ms before week start -> EXCLUDED
      { id: 'b0', sport: 'hiking', date: new Date(weekStart - 1).toISOString(), tss: 100 },
      // Exactly on week start -> INCLUDED
      { id: 'b1', sport: 'hiking', date: new Date(weekStart).toISOString(), tss: 50 },
      // Mid week -> INCLUDED
      { id: 'b2', sport: 'hiking', date: new Date(weekStart + 3 * 86400000).toISOString(), tss: 30 },
      // 1 ms before week end -> INCLUDED
      { id: 'b3', sport: 'hiking', date: new Date(weekEnd - 1).toISOString(), tss: 20 },
      // Exactly on week end -> EXCLUDED (belongs to subsequent week)
      { id: 'b4', sport: 'hiking', date: new Date(weekEnd).toISOString(), tss: 200 }
    ],
    training_load: {
      weekly: [
        { week: '2026-W43', week_start: '2026-10-19', load: 100 }
      ]
    }
  };

  enduranceModule.renderKPICards(boundaryRollup, 'km', 'hiking');
  // Expected included: b1 (50) + b2 (30) + b3 (20) = 100 TSS/wk
  assert.strictEqual(kpiWeeklyLoad.textContent, '100 TSS/wk', 'Exact boundary window must include [start, end) and exclude outside');
  pass('Time windowing adheres strictly to half-open interval [weekStart, weekEnd)');

  // Case 1.3: Empty dataset, null rollup, undefined rollup
  enduranceModule.renderKPICards(null, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '0 TSS/wk', 'Null rollup must yield 0 TSS/wk without crashing');
  pass('Null rollup resilience: 0 TSS/wk');

  enduranceModule.renderKPICards({}, 'km', 'all');
  assert.strictEqual(kpiWeeklyLoad.textContent, '0 TSS/wk', 'Empty rollup must yield 0 TSS/wk');
  pass('Empty rollup resilience: 0 TSS/wk');

  enduranceModule.renderKPICards({ activities: [], training_load: { weekly: [] } }, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '0 TSS/wk', 'Zero activities must yield 0 TSS/wk');
  pass('Zero activities resilience: 0 TSS/wk');

  // Case 1.4: Missing week_start fallback to (latestActTime - 7 days)
  const legacyWeeklyRollup = {
    activities: [
      { id: 'l1', sport: 'hiking', date: '2026-10-01T10:00:00Z', tss: 80 },
      { id: 'l2', sport: 'hiking', date: '2026-10-20T10:00:00Z', tss: 45 },
      { id: 'l3', sport: 'hiking', date: '2026-10-22T10:00:00Z', tss: 55 }
    ],
    training_load: {
      weekly: [
        // No week_start property!
        { week: '2026-W43', load: 100 }
      ]
    }
  };
  enduranceModule.renderKPICards(legacyWeeklyRollup, 'km', 'hiking');
  // latestActTime is 2026-10-22. cutoff is 2026-10-15.
  // l2 and l3 are >= cutoff: 45 + 55 = 100. l1 is excluded.
  assert.strictEqual(kpiWeeklyLoad.textContent, '100 TSS/wk');
  pass('Fallback to latestActTime - 7 days when week_start is omitted');

  // Case 1.5: Sport filter aliases & case-insensitivity
  const aliasRollup = {
    activities: [
      { id: 'a1', sport: 'hiking', date: '2026-10-20T10:00:00Z', tss: 50 },
      { id: 'a2', sport: 'running', date: '2026-10-20T10:00:00Z', tss: 60 },
      { id: 'a3', sport: 'cycling', date: '2026-10-20T10:00:00Z', tss: 70 },
      { id: 'a4', sport: 'walking', date: '2026-10-20T10:00:00Z', tss: 30 },
      { id: 'a5', sport: 'strength', date: '2026-10-20T10:00:00Z', tss: 40 }
    ],
    training_load: {
      weekly: [{ week: '2026-W43', week_start: '2026-10-19', load: 250 }]
    }
  };

  const aliases = [
    ['HIKING', '50 TSS/wk'],
    ['hiking', '50 TSS/wk'],
    ['hike', '50 TSS/wk'],
    ['HIKE', '50 TSS/wk'],
    ['RUNNING', '60 TSS/wk'],
    ['running', '60 TSS/wk'],
    ['run', '60 TSS/wk'],
    ['CYCLING', '70 TSS/wk'],
    ['cycling', '70 TSS/wk'],
    ['cycle', '70 TSS/wk'],
    ['WALKING', '30 TSS/wk'],
    ['walking', '30 TSS/wk'],
    ['walk', '30 TSS/wk'],
    ['STRENGTH', '40 TSS/wk'],
    ['weights', '40 TSS/wk'],
    ['WEIGHTS', '40 TSS/wk'],
  ];

  for (const [filter, expected] of aliases) {
    enduranceModule.renderKPICards(aliasRollup, 'km', filter);
    assert.strictEqual(kpiWeeklyLoad.textContent, expected, `Filter ${filter} should yield ${expected}`);
  }
  pass('Sport filter aliases and casing (hike/hiking, run/running, cycle/cycling, weights/strength) work seamlessly');

  // Case 1.6: Decimal TSS rounding
  const decimalRollup = {
    activities: [
      { id: 'd1', sport: 'hiking', date: '2026-10-20T10:00:00Z', tss: 42.4 },
    ],
    training_load: { weekly: [{ week: '2026-W43', week_start: '2026-10-19', load: 42.4 }] }
  };
  enduranceModule.renderKPICards(decimalRollup, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '42 TSS/wk', '42.4 rounds down to 42');

  decimalRollup.activities[0].tss = 42.6;
  enduranceModule.renderKPICards(decimalRollup, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '43 TSS/wk', '42.6 rounds up to 43');
  pass('TSS rounding handles floating point fractional TSS accurately');

  // -------------------------------------------------------------------------
  // TEST SECTION 2: Activity Table Sport Badge Taxonomy & Fallback
  // -------------------------------------------------------------------------
  console.log('\n--- Section 2: Activity Table Sport Badge Taxonomy & Fallback ---');

  const corruptActivities = [
    { id: 'c1', sport: null, title: 'Null Sport' },
    { id: 'c2', sport: '', title: 'Empty Sport' },
    { id: 'c3', sport: undefined, title: 'Undefined Sport' },
    { id: 'c4', sport: 'badminton', title: 'Dynamic Sport Badminton' },
    { id: 'c5', sport: 'hiking', title: 'True Hiking' },
  ];

  activitiesModule.renderActivityTable(corruptActivities, 'km');
  const rows = tbody.children;
  assert.strictEqual(rows.length, 5);

  assert.ok(rows[0].innerHTML.includes('badge-other'), 'Null sport must use badge-other');
  assert.ok(rows[0].innerHTML.includes('OTHER'), 'Null sport must label OTHER');
  assert.ok(!rows[0].innerHTML.includes('badge-hiking'), 'Null sport must NEVER use badge-hiking');

  assert.ok(rows[1].innerHTML.includes('badge-other'), 'Empty sport must use badge-other');
  assert.ok(rows[1].innerHTML.includes('OTHER'), 'Empty sport must label OTHER');

  assert.ok(rows[2].innerHTML.includes('badge-other'), 'Undefined sport must use badge-other');
  assert.ok(rows[2].innerHTML.includes('OTHER'), 'Undefined sport must label OTHER');

  assert.ok(rows[3].innerHTML.includes('badge-other'), 'Dynamic sport badminton must use badge-other');
  assert.ok(rows[3].innerHTML.includes('BADMINTON'), 'Dynamic sport badminton must label BADMINTON');
  assert.ok(!rows[3].innerHTML.includes('badge-hiking'), 'Dynamic sport badminton must NOT label HIKING');

  assert.ok(rows[4].innerHTML.includes('badge-hiking'), 'True hike must use badge-hiking');
  assert.ok(rows[4].innerHTML.includes('HIKING'), 'True hike must label HIKING');

  pass('Activity table properly isolates missing/null/dynamic sports into badge-other (never badge-hiking)');

  // -------------------------------------------------------------------------
  // TEST SECTION 3: Visual Differentiation & Chart Colors
  // -------------------------------------------------------------------------
  console.log('\n--- Section 3: Visual Differentiation & Palette Distance ---');

  const enduranceCode = fs.readFileSync(path.resolve(__dirname, '../frontend/src/charts/endurance.js'), 'utf-8');

  // Verify colors in source
  assert.ok(enduranceCode.includes("backgroundColor: '#10b981'"), 'Walking must be #10b981 (Emerald)');
  assert.ok(enduranceCode.includes("backgroundColor: '#06b6d4'"), 'Hiking must be #06b6d4 (Cyan)');
  assert.ok(!enduranceCode.includes('#14b8a6'), 'Old conflicting Teal #14b8a6 must be completely removed');

  // Color distance calculation (Euclidean RGB distance)
  function hexToRgb(hex) {
    const num = parseInt(hex.replace('#', ''), 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const walkingRgb = hexToRgb('#10b981');
  const hikingRgb = hexToRgb('#06b6d4');
  const dist = Math.hypot(walkingRgb[0] - hikingRgb[0], walkingRgb[1] - hikingRgb[1], walkingRgb[2] - hikingRgb[2]);
  assert.ok(dist > 80, `RGB distance between Walking and Hiking must be > 80, got ${dist.toFixed(1)}`);
  pass(`Walking (#10b981) and Hiking (#06b6d4) have high visual contrast (Euclidean RGB dist = ${dist.toFixed(1)})`);

  console.log('\n======================================================================');
  console.log(`Challenger M2-1 Verification PASSED: ${passCount}/${passCount} tests succeeded!`);
  console.log('======================================================================\n');
}

runEmpiricalSuite().catch(err => {
  console.error('\n❌ Challenger M2-1 Verification FAILED:\n', err);
  process.exit(1);
});
