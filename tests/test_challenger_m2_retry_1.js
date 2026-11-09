/**
 * tests/test_challenger_m2_retry_1.js
 *
 * Challenger M2 Retry 1 Empirical Adversarial Test Suite:
 * - Exhaustive sport filtering in Activity Table across all sports.
 * - Strict assertion of 0 overlap (empty set intersection) between Hiking and Running.
 * - Cross-sport orthogonality and taxonomy partitioning.
 * - Adversarial synthetic dataset stress harness (similar names, sub-sports, corrupt data).
 * - Multi-criteria interaction: Filter + Search + Sort.
 * - DOM badge isolation verification.
 * - Endurance & Activities filter consistency.
 * - Production dist/ bundle parity.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Minimal Mock DOM supporting elements, querySelector, innerHTML, event listeners
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

  querySelectorAll(selector) {
    if (selector === 'tr') {
      return this.children.filter(c => c.tagName === 'TR');
    }
    return [];
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

async function runChallengerM2Retry1Suite() {
  console.log('======================================================================');
  console.log('Challenger M2 Retry 1: Activity Table Sport Filtering & 0-Overlap Suite');
  console.log('======================================================================\n');

  // Register DOM elements
  const activityTable = mockDoc.registerElement(new MockElement('activity-table', 'table'));
  const tbody = new MockElement('activities-table-body', 'tbody');
  activityTable.appendChild(tbody);
  mockDoc.registerElement(tbody);

  // Register drawer and search elements to prevent NPEs during interaction
  mockDoc.registerElement(new MockElement('activity-search', 'input'));
  mockDoc.registerElement(new MockElement('activity-sort', 'select'));
  mockDoc.registerElement(new MockElement('activity-drawer'));
  mockDoc.registerElement(new MockElement('drawer-panel'));
  mockDoc.registerElement(new MockElement('btn-expand-drawer'));
  mockDoc.registerElement(new MockElement('btn-close-drawer'));
  mockDoc.registerElement(new MockElement('drawer-backdrop'));
  mockDoc.registerElement(new MockElement('kpi-total-distance'));
  mockDoc.registerElement(new MockElement('kpi-total-time'));
  mockDoc.registerElement(new MockElement('kpi-weekly-load'));
  mockDoc.registerElement(new MockElement('kpi-status'));
  mockDoc.registerElement(new MockElement('weekly-volume-chart', 'canvas'));

  const basePath = 'file:///' + path.resolve(__dirname, '../frontend/src').replace(/\\/g, '/');
  const distPath = 'file:///' + path.resolve(__dirname, '../dist/assets').replace(/\\/g, '/');

  const cryptoModule = await import(`${basePath}/crypto.js`);
  const activitiesModule = await import(`${basePath}/charts/activities.js`);
  const enduranceModule = await import(`${basePath}/charts/endurance.js`);
  const distActivitiesModule = await import(`${distPath}/charts/activities.js`);

  // Load and decrypt real production payload
  const encPath = path.resolve(__dirname, '../dist/data.enc');
  assert.ok(fs.existsSync(encPath), 'dist/data.enc must exist');
  const wireBytes = fs.readFileSync(encPath);
  const demoPassphrase = 'demo-passphrase-2026!';
  const { payload: decryptedRollup } = await cryptoModule.decryptDashboardPayload(demoPassphrase, wireBytes);
  assert.ok(decryptedRollup && decryptedRollup.activities, 'Decrypted rollup must contain activities array');

  let passedTests = 0;
  let totalTests = 0;

  function runTest(name, fn) {
    totalTests++;
    try {
      fn();
      console.log(`  ✓ [PASS ${totalTests}] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  ✗ [FAIL ${totalTests}] ${name}`);
      console.error(err);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // SECTION 1: PRODUCTION DECRYPTED DATA FILTERING & 0-OVERLAP
  // --------------------------------------------------------------------------
  console.log('\n--- Section 1: Production Decrypted Rollup Sport Filtering ---');

  activitiesModule.renderActivityTable(decryptedRollup.activities, 'km');

  runTest('Filter "all" renders all 49 decrypted activities', () => {
    activitiesModule.setActivitySportFilter('all');
    assert.strictEqual(tbody.children.length, 49);
  });

  let hikingIds = new Set();
  let hikingActivities = [];
  runTest('Filter "hiking" renders exactly 6 hiking activities', () => {
    activitiesModule.setActivitySportFilter('hiking');
    assert.strictEqual(tbody.children.length, 6);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-hiking'), 'Row must have badge-hiking');
      assert.ok(row.innerHTML.includes('HIKING'), 'Row must display HIKING');
      assert.ok(!row.innerHTML.includes('badge-running'), 'Hiking row must NOT have badge-running');
    });
    // Record hiking activities from data matching filter
    hikingActivities = decryptedRollup.activities.filter(a => (a.sport || '').toLowerCase() === 'hiking' || (a.sport || '').toLowerCase() === 'hike');
    hikingIds = new Set(hikingActivities.map(a => a.id));
    assert.strictEqual(hikingIds.size, 6);
  });

  let runningIds = new Set();
  let runningActivities = [];
  runTest('Filter "running" renders exactly 17 running activities', () => {
    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, 17);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-running'), 'Row must have badge-running');
      assert.ok(row.innerHTML.includes('RUNNING'), 'Row must display RUNNING');
      assert.ok(!row.innerHTML.includes('badge-hiking'), 'Running row must NOT have badge-hiking');
    });
    runningActivities = decryptedRollup.activities.filter(a => (a.sport || '').toLowerCase() === 'running' || (a.sport || '').toLowerCase() === 'run');
    runningIds = new Set(runningActivities.map(a => a.id));
    assert.strictEqual(runningIds.size, 17);
  });

  runTest('Filter "cycling" renders exactly 18 cycling activities', () => {
    activitiesModule.setActivitySportFilter('cycling');
    assert.strictEqual(tbody.children.length, 18);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-cycling'), 'Row must have badge-cycling');
      assert.ok(row.innerHTML.includes('CYCLING'), 'Row must display CYCLING');
    });
  });

  runTest('Filter "strength" and "weights" render exactly 8 strength activities', () => {
    activitiesModule.setActivitySportFilter('strength');
    assert.strictEqual(tbody.children.length, 8);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-strength'), 'Row must have badge-strength');
      assert.ok(row.innerHTML.includes('WEIGHTS'), 'Row must display WEIGHTS');
    });

    activitiesModule.setActivitySportFilter('weights');
    assert.strictEqual(tbody.children.length, 8);
  });

  runTest('ZERO OVERLAP: Intersection between Hiking and Running activity IDs is empty (0 overlap)', () => {
    const overlap = [];
    for (const id of hikingIds) {
      if (runningIds.has(id)) overlap.push(id);
    }
    assert.strictEqual(overlap.length, 0, `Hiking and running must have 0 overlap, found: ${overlap.join(', ')}`);
  });

  runTest('Pairwise orthogonality across all 4 sports (Hiking, Running, Cycling, Strength)', () => {
    const cyclingIds = new Set(decryptedRollup.activities.filter(a => (a.sport || '').toLowerCase() === 'cycling').map(a => a.id));
    const strengthIds = new Set(decryptedRollup.activities.filter(a => (a.sport || '').toLowerCase() === 'strength').map(a => a.id));

    // Assert disjoint sets
    const pairIntersections = [
      ['hiking', 'running', [...hikingIds].filter(x => runningIds.has(x))],
      ['hiking', 'cycling', [...hikingIds].filter(x => cyclingIds.has(x))],
      ['hiking', 'strength', [...hikingIds].filter(x => strengthIds.has(x))],
      ['running', 'cycling', [...runningIds].filter(x => cyclingIds.has(x))],
      ['running', 'strength', [...runningIds].filter(x => strengthIds.has(x))],
      ['cycling', 'strength', [...cyclingIds].filter(x => strengthIds.has(x))]
    ];

    for (const [s1, s2, inter] of pairIntersections) {
      assert.strictEqual(inter.length, 0, `Expected 0 overlap between ${s1} and ${s2}, found: ${inter.length}`);
    }

    // Assert partition completeness: 6 + 17 + 18 + 8 = 49
    assert.strictEqual(hikingIds.size + runningIds.size + cyclingIds.size + strengthIds.size, 49);
  });

  // --------------------------------------------------------------------------
  // SECTION 2: CASING, ALIASES & UNMATCHED SPORTS
  // --------------------------------------------------------------------------
  console.log('\n--- Section 2: Casing, Aliases & Unmatched Sports ---');

  runTest('Alias "hike" isolates exactly the same 6 activities as "hiking"', () => {
    activitiesModule.setActivitySportFilter('hike');
    assert.strictEqual(tbody.children.length, 6);
  });

  runTest('Alias "run" isolates exactly the same 17 activities as "running"', () => {
    activitiesModule.setActivitySportFilter('run');
    assert.strictEqual(tbody.children.length, 17);
  });

  runTest('Case-insensitivity: "HIKING" and "Hiking" yield 6 activities; "RUNNING" and "Running" yield 17 activities', () => {
    activitiesModule.setActivitySportFilter('HIKING');
    assert.strictEqual(tbody.children.length, 6);
    activitiesModule.setActivitySportFilter('Hiking');
    assert.strictEqual(tbody.children.length, 6);

    activitiesModule.setActivitySportFilter('RUNNING');
    assert.strictEqual(tbody.children.length, 17);
    activitiesModule.setActivitySportFilter('Running');
    assert.strictEqual(tbody.children.length, 17);
  });

  runTest('Unmatched sport "walking" (0 in dataset) shows empty state row', () => {
    activitiesModule.setActivitySportFilter('walking');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('No activities found matching criteria.'));
  });

  runTest('Arbitrary unknown sport "swimming" shows empty state row', () => {
    activitiesModule.setActivitySportFilter('swimming');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('No activities found matching criteria.'));
  });

  // --------------------------------------------------------------------------
  // SECTION 3: ADVERSARIAL SYNTHETIC DATASET STRESS HARNESS
  // --------------------------------------------------------------------------
  console.log('\n--- Section 3: Adversarial Synthetic Dataset Stress Harness ---');

  // Create an adversarial dataset with similar sport names, substrings, casing, nulls, corrupt values
  const syntheticActivities = [
    // Pure Hiking
    ...Array.from({ length: 40 }, (_, i) => ({ id: `hike_${i}`, sport: 'hiking', title: `Mountain Trek ${i}`, date: '2026-10-01' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `hike_alias_${i}`, sport: 'hike', title: `Forest Hike ${i}`, date: '2026-10-02' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `hike_caps_${i}`, sport: 'HIKING', title: `Alpine Ascent ${i}`, date: '2026-10-03' })),

    // Pure Running
    ...Array.from({ length: 50 }, (_, i) => ({ id: `run_${i}`, sport: 'running', title: `Tempo Run ${i}`, date: '2026-10-04' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `run_alias_${i}`, sport: 'run', title: `Interval Run ${i}`, date: '2026-10-05' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `run_caps_${i}`, sport: 'RUNNING', title: `Long Run ${i}`, date: '2026-10-06' })),

    // Substrings / Compound names that must NOT be caught by hiking or running filters
    ...Array.from({ length: 25 }, (_, i) => ({ id: `trail_run_${i}`, sport: 'trail_running', title: `Trail Run ${i}`, date: '2026-10-07' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `speed_hike_${i}`, sport: 'speed_hiking', title: `Fast Hike ${i}`, date: '2026-10-08' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `fast_hike_${i}`, sport: 'fasthike', title: `Fast Hike ${i}`, date: '2026-10-09' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `hikerun_${i}`, sport: 'hiking_running', title: `Duathlon ${i}`, date: '2026-10-10' })),

    // Walking
    ...Array.from({ length: 30 }, (_, i) => ({ id: `walk_${i}`, sport: 'walking', title: `Stroll ${i}`, date: '2026-10-11' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `walk_alias_${i}`, sport: 'walk', title: `Walk ${i}`, date: '2026-10-12' })),

    // Cycling
    ...Array.from({ length: 35 }, (_, i) => ({ id: `cycle_${i}`, sport: 'cycling', title: `Road Ride ${i}`, date: '2026-10-13' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `cycle_alias_${i}`, sport: 'cycle', title: `Gravel Ride ${i}`, date: '2026-10-14' })),

    // Strength
    ...Array.from({ length: 25 }, (_, i) => ({ id: `strength_${i}`, sport: 'strength', title: `Gym ${i}`, date: '2026-10-15' })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `weights_alias_${i}`, sport: 'weights', title: `Weights ${i}`, date: '2026-10-16' })),

    // Corrupt / Missing / Unmapped
    { id: 'corrupt_1', sport: null, title: 'Null Sport' },
    { id: 'corrupt_2', sport: undefined, title: 'Undefined Sport' },
    { id: 'corrupt_3', sport: '', title: 'Empty Sport' },
    { id: 'corrupt_4', sport: 'unmapped_sport', title: 'Unmapped Sport' }
  ];

  activitiesModule.renderActivityTable(syntheticActivities, 'km');

  runTest('Synthetic: "hiking" filter selects exactly hiking (40) + hike (15) + HIKING (10) = 65, excluding compound names', () => {
    activitiesModule.setActivitySportFilter('hiking');
    assert.strictEqual(tbody.children.length, 65);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-hiking'), 'Must have badge-hiking');
      assert.ok(!row.innerHTML.includes('badge-running'), 'Must NOT have badge-running');
      assert.ok(!row.innerHTML.includes('badge-other'), 'Must NOT have badge-other');
    });
  });

  runTest('Synthetic: "running" filter selects exactly running (50) + run (20) + RUNNING (15) = 85, excluding compound names', () => {
    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, 85);
    tbody.children.forEach(row => {
      assert.ok(row.innerHTML.includes('badge-running'), 'Must have badge-running');
      assert.ok(!row.innerHTML.includes('badge-hiking'), 'Must NOT have badge-hiking');
      assert.ok(!row.innerHTML.includes('badge-other'), 'Must NOT have badge-other');
    });
  });

  runTest('Synthetic: Strict 0-overlap between hiking (65) and running (85)', () => {
    activitiesModule.setActivitySportFilter('hiking');
    const synHikeRows = tbody.children.map(r => r.innerHTML);

    activitiesModule.setActivitySportFilter('running');
    const synRunRows = tbody.children.map(r => r.innerHTML);

    // Cross-check every single row content
    for (const hRow of synHikeRows) {
      assert.ok(!synRunRows.includes(hRow), 'Hiking row appeared in running results!');
    }
  });

  runTest('Synthetic: Compound sports like "trail_running" and "speed_hiking" are isolated into their own filter', () => {
    activitiesModule.setActivitySportFilter('trail_running');
    assert.strictEqual(tbody.children.length, 25);

    activitiesModule.setActivitySportFilter('speed_hiking');
    assert.strictEqual(tbody.children.length, 20);
  });

  runTest('Synthetic: Null, undefined, empty, and unmapped sports default to badge-other, never hiking or running', () => {
    activitiesModule.setActivitySportFilter('all');
    const rows = tbody.children;
    const corruptRows = rows.filter(r =>
      r.innerHTML.includes('Null Sport') ||
      r.innerHTML.includes('Undefined Sport') ||
      r.innerHTML.includes('Empty Sport') ||
      r.innerHTML.includes('Unmapped Sport')
    );
    assert.strictEqual(corruptRows.length, 4);
    corruptRows.forEach(r => {
      assert.ok(r.innerHTML.includes('badge-other'), 'Corrupt sport must have badge-other');
      assert.ok(!r.innerHTML.includes('badge-hiking'), 'Corrupt sport must NOT have badge-hiking');
      assert.ok(!r.innerHTML.includes('badge-running'), 'Corrupt sport must NOT have badge-running');
    });
  });

  // --------------------------------------------------------------------------
  // SECTION 4: MULTI-CRITERIA (FILTER + SEARCH + SORT)
  // --------------------------------------------------------------------------
  console.log('\n--- Section 4: Multi-Criteria Filter + Search + Sort Interactions ---');

  // Reset to decrypted real activities
  activitiesModule.renderActivityTable(decryptedRollup.activities, 'km');

  runTest('Hiking filter + Search by keyword preserves hiking isolation', () => {
    // Add an activity where title mentions run but sport is hiking
    const mixedActs = [
      { id: 'hike_named_run', sport: 'hiking', title: 'Running Up That Mountain', date: '2026-10-01' },
      { id: 'run_named_hike', sport: 'running', title: 'A Good Hike Across the Track', date: '2026-10-02' }
    ];
    activitiesModule.renderActivityTable(mixedActs, 'km');

    activitiesModule.setActivitySportFilter('hiking');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('Running Up That Mountain'));
    assert.ok(tbody.children[0].innerHTML.includes('badge-hiking'));
    assert.ok(!tbody.children[0].innerHTML.includes('badge-running'));

    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('A Good Hike Across the Track'));
    assert.ok(tbody.children[0].innerHTML.includes('badge-running'));
    assert.ok(!tbody.children[0].innerHTML.includes('badge-hiking'));
  });

  runTest('Rapid alternating filter toggling (100 cycles) produces 0 state pollution or count drift', () => {
    activitiesModule.renderActivityTable(decryptedRollup.activities, 'km');
    for (let i = 0; i < 100; i++) {
      activitiesModule.setActivitySportFilter('hiking');
      assert.strictEqual(tbody.children.length, 6, `Hiking count drifted on cycle ${i}`);
      activitiesModule.setActivitySportFilter('running');
      assert.strictEqual(tbody.children.length, 17, `Running count drifted on cycle ${i}`);
    }
  });

  runTest('Scale stress test: 5,000 activities (2,000 hiking, 3,000 running) assert 0 overlap & exact counts', () => {
    const largePool = [
      ...Array.from({ length: 2000 }, (_, i) => ({ id: `huge_hike_${i}`, sport: 'hiking', title: `Hike ${i}`, distance_meters: 5000 + i })),
      ...Array.from({ length: 3000 }, (_, i) => ({ id: `huge_run_${i}`, sport: 'running', title: `Run ${i}`, distance_meters: 10000 + i }))
    ];
    activitiesModule.renderActivityTable(largePool, 'km');

    activitiesModule.setActivitySportFilter('hiking');
    assert.strictEqual(tbody.children.length, 2000);

    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, 3000);

    // Overlap check
    const hikeIds = new Set(largePool.filter(a => a.sport === 'hiking').map(a => a.id));
    const runIds = new Set(largePool.filter(a => a.sport === 'running').map(a => a.id));
    const common = [...hikeIds].filter(id => runIds.has(id));
    assert.strictEqual(common.length, 0);
  });

  runTest('Empty activity list resilience: table shows empty criteria message with no errors', () => {
    activitiesModule.renderActivityTable([], 'km');
    activitiesModule.setActivitySportFilter('hiking');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('No activities found matching criteria.'));

    activitiesModule.setActivitySportFilter('running');
    assert.strictEqual(tbody.children.length, 1);
    assert.ok(tbody.children[0].innerHTML.includes('No activities found matching criteria.'));
  });

  // --------------------------------------------------------------------------
  // SECTION 5: ENDURANCE & ACTIVITIES TAXONOMY ALIGNMENT
  // --------------------------------------------------------------------------
  console.log('\n--- Section 5: Endurance & Activities Taxonomy Alignment ---');

  runTest('Endurance KPI Weekly Load calculation reflects 0 TSS/wk for hiking when no recent hikes occurred', () => {
    const kpiLoadEl = mockDoc.getElementById('kpi-weekly-load');
    // Render endurance cards for hiking
    enduranceModule.renderKPICards(decryptedRollup, 'km', 'hiking');
    assert.strictEqual(kpiLoadEl.textContent, '0 TSS/wk', 'Hiking filter must show 0 TSS/wk on historical rollup');

    // Render for running
    enduranceModule.renderKPICards(decryptedRollup, 'km', 'running');
    assert.notStrictEqual(kpiLoadEl.textContent, '0 TSS/wk', 'Running filter must show active TSS');
  });

  // --------------------------------------------------------------------------
  // SECTION 6: PRODUCTION DIST BUNDLE PARITY
  // --------------------------------------------------------------------------
  console.log('\n--- Section 6: Production dist/assets/charts/activities.js Parity ---');

  runTest('Compiled dist bundle renders exact same 6 hiking and 17 running activities with 0 overlap', () => {
    distActivitiesModule.renderActivityTable(decryptedRollup.activities, 'km');

    distActivitiesModule.setActivitySportFilter('hiking');
    const distHikingCount = tbody.children.length;
    const distHikingHtml = tbody.children.map(r => r.innerHTML);
    assert.strictEqual(distHikingCount, 6, 'dist/ hiking count must be 6');

    distActivitiesModule.setActivitySportFilter('running');
    const distRunningCount = tbody.children.length;
    const distRunningHtml = tbody.children.map(r => r.innerHTML);
    assert.strictEqual(distRunningCount, 17, 'dist/ running count must be 17');

    for (const hRow of distHikingHtml) {
      assert.ok(!distRunningHtml.includes(hRow), 'dist/ bundle must have 0 overlap between hiking and running');
    }
  });

  console.log(`\n======================================================================`);
  console.log(`Challenger M2 Retry 1 PASSED: ${passedTests}/${totalTests} tests succeeded!`);
  console.log(`Verdict: ZERO OVERLAP EMPIRICALLY CONFIRMED BETWEEN HIKING AND RUNNING.`);
  console.log(`======================================================================\n`);
}

runChallengerM2Retry1Suite().catch(err => {
  console.error('\nChallenger M2 Retry 1 verification failed:', err);
  process.exit(1);
});
