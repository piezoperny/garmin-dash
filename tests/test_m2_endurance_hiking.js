/**
 * tests/test_m2_endurance_hiking.js
 *
 * Milestone 2 Frontend Verification Suite:
 * - Endurance weekly load KPI sport filter recency calculation.
 * - Distinct colors for Walking (#10b981) and Hiking (#06b6d4).
 * - Activity table badge fallback for unmapped/missing sport to 'OTHER' and 'badge-other'.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Mock DOM
class MockElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this._innerHTML = '';
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = new Map();
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(val) {
    this._innerHTML = val || '';
    if (!val) {
      this.children = [];
    }
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
    return { width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300 };
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

async function runM2FrontendSuite() {
  console.log('\n=== Running Milestone 2 Frontend Endurance & Taxonomy Test Suite ===\n');

  // Register DOM elements for endurance & activities
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

  // Test 1: Fallback sport badge in activities.js
  console.log('Testing activity table sport badge fallback...');
  const sampleActivities = [
    { id: 'act_001', sport: 'hiking', title: 'Mountain Hike', distance_meters: 10000, duration_seconds: 7200 },
    { id: 'act_002', sport: 'running', title: 'Tempo Run', distance_meters: 8000, duration_seconds: 2400 },
    { id: 'act_003', sport: 'cycling', title: 'Road Ride', distance_meters: 30000, duration_seconds: 3600 },
    { id: 'act_004', sport: 'strength', title: 'Gym Workout', distance_meters: 0, duration_seconds: 2700 },
    { id: 'act_005', sport: 'walking', title: 'Evening Walk', distance_meters: 4000, duration_seconds: 2800 },
    { id: 'act_006', sport: null, title: 'Unknown Cardio', distance_meters: 5000, duration_seconds: 1800 },
    { id: 'act_007', sport: '', title: 'Unmapped Workout', distance_meters: 3000, duration_seconds: 1200 },
  ];

  activitiesModule.renderActivityTable(sampleActivities, 'km');
  assert.strictEqual(tbody.children.length, 7, 'Must render all 7 rows');

  // Check badges
  const rows = tbody.children;
  assert.ok(rows[0].innerHTML.includes('badge-hiking'), 'Hiking activity must have badge-hiking');
  assert.ok(rows[0].innerHTML.includes('HIKING'), 'Hiking activity must display HIKING label');

  assert.ok(rows[1].innerHTML.includes('badge-running'), 'Running activity must have badge-running');
  assert.ok(rows[1].innerHTML.includes('RUNNING'), 'Running activity must display RUNNING label');

  assert.ok(rows[2].innerHTML.includes('badge-cycling'), 'Cycling activity must have badge-cycling');
  assert.ok(rows[2].innerHTML.includes('CYCLING'), 'Cycling activity must display CYCLING label');

  assert.ok(rows[3].innerHTML.includes('badge-strength'), 'Strength activity must have badge-strength');
  assert.ok(rows[3].innerHTML.includes('WEIGHTS'), 'Strength activity must display WEIGHTS label');

  assert.ok(rows[4].innerHTML.includes('badge-walking'), 'Walking activity must have badge-walking');
  assert.ok(rows[4].innerHTML.includes('WALKING'), 'Walking activity must display WALKING label');

  // Null and empty sports must default to badge-other and OTHER
  assert.ok(rows[5].innerHTML.includes('badge-other'), 'Null sport must default to badge-other');
  assert.ok(rows[5].innerHTML.includes('OTHER'), 'Null sport must display OTHER label');
  assert.ok(!rows[5].innerHTML.includes('badge-hiking'), 'Null sport must NOT default to badge-hiking');

  assert.ok(rows[6].innerHTML.includes('badge-other'), 'Empty sport must default to badge-other');
  assert.ok(rows[6].innerHTML.includes('OTHER'), 'Empty sport must display OTHER label');
  assert.ok(!rows[6].innerHTML.includes('badge-hiking'), 'Empty sport must NOT default to badge-hiking');

  // Test sport filter isolation between hiking and running
  activitiesModule.setActivitySportFilter('hiking');
  assert.strictEqual(tbody.children.length, 1, 'Hiking filter must return exactly 1 hike');
  assert.ok(tbody.children[0].innerHTML.includes('badge-hiking'), 'Filtered item must be hiking');

  activitiesModule.setActivitySportFilter('running');
  assert.strictEqual(tbody.children.length, 1, 'Running filter must return exactly 1 run');
  assert.ok(tbody.children[0].innerHTML.includes('badge-running'), 'Filtered item must be running');

  activitiesModule.setActivitySportFilter('all');
  assert.strictEqual(tbody.children.length, 7, 'All filter must return all 7 activities');
  console.log('  ✓ T2-01: Activity table fallback correctly assigns badge-other and isolates hiking/running');

  // Test 2: KPI Weekly Load Calculation for Hiking
  console.log('Testing KPI weekly load for hiking with recent 0 load...');
  const rollupWithPastHikes = {
    summary: { total_distance_km: 250.0, total_moving_hours: 30.0 },
    activities: [
      // Old hike 45 days ago
      { id: 'h1', sport: 'hiking', date: '2026-09-01T07:00:00Z', tss: 90, duration_seconds: 7200, distance_meters: 10000 },
      // Recent runs in latest week
      { id: 'r1', sport: 'running', date: '2026-10-20T07:00:00Z', tss: 65, duration_seconds: 3000, distance_meters: 9000 },
      { id: 'r2', sport: 'running', date: '2026-10-22T07:00:00Z', tss: 70, duration_seconds: 3200, distance_meters: 10000 }
    ],
    training_load: {
      weekly: [
        { week: '2026-W36', week_start: '2026-08-31', load: 90, hiking_hours: 2.0, running_hours: 0.0 },
        { week: '2026-W43', week_start: '2026-10-19', load: 135, hiking_hours: 0.0, running_hours: 1.7 }
      ]
    }
  };

  // Render for all sports
  enduranceModule.renderKPICards(rollupWithPastHikes, 'km', 'all');
  assert.strictEqual(kpiWeeklyLoad.textContent, '135 TSS/wk', 'All sports should display latest week load');

  // Render for hiking filter
  enduranceModule.renderKPICards(rollupWithPastHikes, 'km', 'hiking');
  assert.strictEqual(kpiWeeklyLoad.textContent, '0 TSS/wk', 'Hiking filter must show 0 TSS/wk when no hikes in recent week');

  // Render for running filter
  enduranceModule.renderKPICards(rollupWithPastHikes, 'km', 'running');
  assert.strictEqual(kpiWeeklyLoad.textContent, '135 TSS/wk', 'Running filter must show recent week running TSS');

  console.log('  ✓ T2-02: KPI Weekly Load computes 0 TSS/wk for hiking when no recent hikes occurred');

  // Test 3: Chart colors inspection from source file
  console.log('Testing Walking and Hiking distinct chart colors in endurance.js...');
  const enduranceSource = fs.readFileSync(path.resolve(__dirname, '../frontend/src/charts/endurance.js'), 'utf-8');
  assert.ok(enduranceSource.includes("'#10b981'"), 'Walking must retain emerald #10b981');
  assert.ok(enduranceSource.includes("'#06b6d4'"), 'Hiking must use distinct cyan #06b6d4');
  assert.ok(!enduranceSource.includes("'#14b8a6'"), 'Old confusing teal #14b8a6 must be removed');

  console.log('  ✓ T2-03: Hiking uses distinct Cyan (#06b6d4) while Walking retains Emerald (#10b981)');

  console.log('\n=== All Milestone 2 Frontend Tests Passed! ===\n');
}

runM2FrontendSuite().catch(err => {
  console.error(err);
  process.exit(1);
});
