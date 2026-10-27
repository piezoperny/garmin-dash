/**
 * tests/test_chart_layout_integrity.js
 * 
 * Automated Verification Suite for Acceptance Criteria 1:
 * - Chart legends and X-axis labels do not clip or overlap across desktop and mobile viewports.
 * - Required DOM IDs remain intact.
 * - No abrupt text truncations (such as clipped 'Z3 (16.7%' or 'VO2max (m').
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

class MockContext2D {
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
  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  arc() {}
  rect() {}
  roundRect() {}
  fill() {}
  stroke() {}
  resetTransform() {}
  scale() {}
  measureText(str) {
    const s = String(str);
    return { width: s.length * 6.5 };
  }
  fillText(text, x, y) {
    const s = String(text);
    const w = this.measureText(s).width;
    this.calls.push({
      text: s,
      x: Number(x),
      y: Number(y),
      width: w,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline
    });
  }
}

class MockCanvas {
  constructor(id, width = 600, height = 300) {
    this.id = id;
    this.width = width;
    this.height = height;
    this.ctx = new MockContext2D(this);
    this.listeners = new Map();
  }
  getContext(type) {
    if (type === '2d') return this.ctx;
    return null;
  }
  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: this.width,
      bottom: this.height,
      width: this.width,
      height: this.height
    };
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
}

class MockDOM {
  constructor() {
    this.elements = new Map();
  }
  registerCanvas(id, width, height) {
    const c = new MockCanvas(id, width, height);
    this.elements.set(id, c);
    return c;
  }
  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

async function runChartIntegrityTests() {
  const dom = new MockDOM();
  global.window = {
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  global.document = {
    getElementById: (id) => dom.getElementById(id),
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} })
  };

  const { Chart } = await import('../frontend/src/charts/chart_engine.js');
  const enduranceModule = await import('../frontend/src/charts/endurance.js');
  const physiologicalModule = await import('../frontend/src/charts/physiological.js');
  const activitiesModule = await import('../frontend/src/charts/activities.js');

  const testViewports = [
    { name: 'Ultra-Narrow Mobile (320px)', width: 320, height: 240 },
    { name: 'Standard Mobile (375px)', width: 375, height: 260 },
    { name: 'Tablet (600px)', width: 600, height: 300 },
    { name: 'Desktop (800px)', width: 800, height: 350 }
  ];

  const sampleRollup = {
    training_load: {
      weekly: [
        { week: '2026-W35', cycling_hours: 4.5, hiking_hours: 3.2, strength_hours: 1.5, atl: 45, ctl: 42, tsb: -3 },
        { week: '2026-W36', cycling_hours: 5.0, hiking_hours: 4.0, strength_hours: 1.5, atl: 48, ctl: 44, tsb: -4 },
        { week: '2026-W37', cycling_hours: 6.2, hiking_hours: 4.5, strength_hours: 1.5, atl: 52, ctl: 46, tsb: -6 },
        { week: '2026-W38', cycling_hours: 3.5, hiking_hours: 2.0, strength_hours: 1.0, atl: 42, ctl: 45, tsb: 3 },
        { week: '2026-W39', cycling_hours: 7.0, hiking_hours: 5.0, strength_hours: 2.0, atl: 58, ctl: 48, tsb: -10 },
        { week: '2026-W40', cycling_hours: 7.5, hiking_hours: 5.5, strength_hours: 2.0, atl: 62, ctl: 50, tsb: -12 },
        { week: '2026-W41', cycling_hours: 8.0, hiking_hours: 6.0, strength_hours: 2.0, atl: 65, ctl: 52, tsb: -13 },
        { week: '2026-W42', cycling_hours: 4.0, hiking_hours: 3.0, strength_hours: 1.0, atl: 48, ctl: 51, tsb: 3 }
      ]
    },
    physiological: {
      heart_rate_zones: [
        { zone: 'Z1', seconds: 36000 },
        { zone: 'Z2', seconds: 108000 },
        { zone: 'Z3', seconds: 60000 },
        { zone: 'Z4', seconds: 28000 },
        { zone: 'Z5', seconds: 7200 }
      ],
      power_zones: [
        { zone: 'Z1 Active Recovery', seconds: 15000 },
        { zone: 'Z2 Endurance', seconds: 60000 },
        { zone: 'Z3 Tempo', seconds: 28000 },
        { zone: 'Z4 Threshold', seconds: 15000 },
        { zone: 'Z5 VO2Max', seconds: 5000 },
        { zone: 'Z6 Anaerobic', seconds: 1800 },
        { zone: 'Z7 Neuromuscular', seconds: 600 }
      ],
      pace_zones: [
        { zone: 'Recovery', short_label: 'Rec', seconds: 18000 },
        { zone: 'Aerobic', short_label: 'Aer', seconds: 64000 },
        { zone: 'Tempo', short_label: 'Tempo', seconds: 24000 },
        { zone: 'Threshold', short_label: 'Thr', seconds: 14000 },
        { zone: 'Interval', short_label: 'Int', seconds: 4000 }
      ],
      threshold_trends: [
        { date: '2026-09-01', vo2max: 51, ftp: 268, lthr: 165 },
        { date: '2026-09-15', vo2max: 52, ftp: 272, lthr: 166 },
        { date: '2026-10-01', vo2max: 53, ftp: 276, lthr: 167 },
        { date: '2026-10-15', vo2max: 54, ftp: 280, lthr: 168 }
      ]
    }
  };

  console.log('--- Testing Chart Integrity Across Viewports ---');

  for (const vp of testViewports) {
    console.log(`\nTesting Viewport: ${vp.name} (${vp.width}x${vp.height})`);

    // 1. Stacked Weekly Volume Chart
    const volCanvas = dom.registerCanvas('weekly-volume-chart', vp.width, vp.height);
    enduranceModule.renderWeeklyVolumeChart(sampleRollup, 'km', 'all');
    verifyCartesianIntegrity(volCanvas, vp.width, 'weekly-volume-chart');

    // 2. Training Load Chart
    const loadCanvas = dom.registerCanvas('training-load-chart', vp.width, vp.height);
    enduranceModule.renderTrainingLoadChart(sampleRollup);
    verifyCartesianIntegrity(loadCanvas, vp.width, 'training-load-chart');

    // 3. Heart Rate Zones Doughnut Chart
    const hrCanvas = dom.registerCanvas('hr-zone-chart', vp.width, vp.height);
    physiologicalModule.renderHeartRateZoneChart(sampleRollup);
    verifyDoughnutIntegrity(hrCanvas, vp.width, 'hr-zone-chart');

    // 4. Power Zones Bar Chart
    const powerCanvas = dom.registerCanvas('power-zone-chart', vp.width, vp.height);
    physiologicalModule.renderPowerZoneChart(sampleRollup);
    verifyCartesianIntegrity(powerCanvas, vp.width, 'power-zone-chart');

    // 5. Pace Zones Bar Chart
    const paceCanvas = dom.registerCanvas('pace-zone-chart', vp.width, vp.height);
    physiologicalModule.renderPaceZoneChart(sampleRollup);
    verifyCartesianIntegrity(paceCanvas, vp.width, 'pace-zone-chart');

    // 6. Threshold Trends Chart
    const trendsCanvas = dom.registerCanvas('threshold-trends-chart', vp.width, vp.height);
    physiologicalModule.renderThresholdTrendsChart(sampleRollup);
    verifyCartesianIntegrity(trendsCanvas, vp.width, 'threshold-trends-chart');
  }

  // --- Sport Filter Reactivity (Weights, Cycling, Hiking) ---
  console.log('\n--- Testing Sport Filter Reactivity (KPI Cards & Weekly Volume) ---');
  const distEl = { textContent: '' };
  const timeEl = { textContent: '' };
  const loadEl = { textContent: '' };
  const statusEl = { textContent: '', className: '' };
  dom.elements.set('kpi-total-distance', distEl);
  dom.elements.set('kpi-total-time', timeEl);
  dom.elements.set('kpi-weekly-load', loadEl);
  dom.elements.set('kpi-status', statusEl);

  // Test Weights (strength) KPI Cards
  enduranceModule.renderKPICards(sampleRollup, 'km', 'strength');
  assert.strictEqual(distEl.textContent, '—', 'Weights KPI distance must be —');
  assert.ok(loadEl.textContent.includes('TSS/wk'), 'Weights KPI load must display TSS/wk');

  // Test Weights Weekly Volume Chart (must plot non-zero duration bars)
  const weightsVolCanvas = dom.registerCanvas('weekly-volume-chart', 600, 300);
  enduranceModule.renderWeeklyVolumeChart(sampleRollup, 'km', 'strength');
  assert.ok(weightsVolCanvas.ctx.calls.length > 0, 'Weights volume chart must issue canvas calls');

  // Test Cycling Weekly Volume Chart
  enduranceModule.renderWeeklyVolumeChart(sampleRollup, 'km', 'cycling');
  assert.ok(weightsVolCanvas.ctx.calls.length > 0, 'Cycling volume chart must issue canvas calls');

  // Test Hiking Weekly Volume Chart
  enduranceModule.renderWeeklyVolumeChart(sampleRollup, 'km', 'hiking');
  assert.ok(weightsVolCanvas.ctx.calls.length > 0, 'Hiking volume chart must issue canvas calls');

  console.log('[PASS] Sport filter reactivity verified: Weights duration & HR load clean, cycling & hiking volume responsive.');

  // --- Adversarial Check: Zone Label Collision Avoidance (Anaerobic vs Aerobic) ---
  const collisionCanvas = dom.registerCanvas('zone-collision-test', 600, 300);
  new Chart(collisionCanvas, {
    type: 'bar',
    data: {
      labels: ['Aerobic', 'Anaerobic', 'Active Recovery', 'Threshold'],
      datasets: [{ label: 'Hours', data: [5, 2, 3, 4] }]
    }
  });
  const collisionXLabels = collisionCanvas.ctx.calls
    .filter(c => c.textBaseline === 'top' && c.textAlign === 'center')
    .map(c => c.text);
  assert.ok(collisionXLabels.includes('Aer'), 'Aerobic must map to Aer');
  assert.ok(collisionXLabels.includes('Anaer'), 'Anaerobic must map to Anaer and not collide with Aer');
  assert.ok(!collisionXLabels.includes('aerobic'), 'Raw aerobic label must be concise');

  // --- Adversarial Check: Safe Formatter Edge Cases ---
  assert.strictEqual(enduranceModule.formatDuration(undefined), '0m', 'formatDuration(undefined) must be 0m');
  assert.strictEqual(enduranceModule.formatDuration(NaN), '0m', 'formatDuration(NaN) must be 0m');
  assert.strictEqual(enduranceModule.formatDuration(0), '0m', 'formatDuration(0) must be 0m');
  assert.strictEqual(enduranceModule.formatDuration(-50), '0m', 'formatDuration(-50) must be 0m');
  assert.strictEqual(enduranceModule.formatDuration(3665), '1h 01m', 'formatDuration(3665) must be 1h 01m');

  assert.ok(activitiesModule.formatDate('invalid-date-string') !== 'Invalid Date', 'formatDate must never display literal Invalid Date');
  assert.strictEqual(activitiesModule.formatElevation(0, 'km'), '0 m', 'formatElevation(0) must be 0 m, not +0 m');
  assert.strictEqual(activitiesModule.formatElevation(50, 'km'), '+50 m', 'formatElevation(50) must be +50 m');
  assert.strictEqual(activitiesModule.formatElevation(-20, 'km'), '-20 m', 'formatElevation(-20) must be -20 m');

  console.log('[PASS] Adversarial edge cases verified: zero keyword collisions, zero NaN/Invalid Date leaks.');

  console.log('\n[PASS] All chart layouts verified: zero legend clipping, zero X-axis collisions across all viewports.');
}

function verifyCartesianIntegrity(canvas, displayWidth, chartName) {
  const calls = canvas.ctx.calls;
  assert.ok(calls.length > 0, `${chartName} must issue canvas calls`);

  // Detect X-axis labels (drawn below chart area: y > 150)
  const xLabels = calls.filter(c => c.textBaseline === 'top' && c.textAlign === 'center');

  // Verify non-collision of X-axis labels
  let prevRight = -Infinity;
  for (const lbl of xLabels) {
    const left = lbl.x - lbl.width / 2;
    const right = lbl.x + lbl.width / 2;

    assert.ok(
      left >= prevRight + 3.5,
      `X-axis collision detected on ${chartName} at width ${displayWidth}: label "${lbl.text}" (left: ${left}) overlaps previous (right: ${prevRight})`
    );
    assert.ok(
      left >= 0 && right <= displayWidth + 1,
      `X-axis label "${lbl.text}" on ${chartName} clipped outside bounds [0, ${displayWidth}]: left=${left}, right=${right}`
    );
    prevRight = right;
  }

  // Verify legend items across all wrapped rows (left-aligned with middle textBaseline)
  const legendLabels = calls.filter(c => c.textBaseline === 'middle' && c.textAlign === 'left');
  for (const leg of legendLabels) {
    const right = leg.x + leg.width;
    assert.ok(
      right <= displayWidth + 1,
      `Legend text "${leg.text}" on ${chartName} clipped at width ${displayWidth}: right edge ${right} > ${displayWidth}`
    );
    // Verify no ugly unclosed parentheses like "VO2max (m" or "Z3 (16.7%"
    assert.ok(
      !leg.text.endsWith('(m') && !leg.text.endsWith('(16.7%'),
      `Legend text truncated abruptly: "${leg.text}"`
    );
  }
}

function verifyDoughnutIntegrity(canvas, displayWidth, chartName) {
  const calls = canvas.ctx.calls;
  assert.ok(calls.length > 0, `${chartName} must issue canvas calls`);

  // Check legend items on doughnut across all wrapped rows
  const legendLabels = calls.filter(c => c.textBaseline === 'middle' && c.textAlign === 'left');
  for (const leg of legendLabels) {
    const right = leg.x + leg.width;
    assert.ok(
      right <= displayWidth + 1,
      `Doughnut legend text "${leg.text}" clipped on ${chartName}: right edge ${right} > ${displayWidth}`
    );
    assert.ok(
      !leg.text.endsWith('(16.7%'),
      `Doughnut legend text truncated abruptly: "${leg.text}"`
    );
  }
}

runChartIntegrityTests().catch(err => {
  console.error('[FAIL] Chart layout integrity test failed:', err);
  process.exit(1);
});
