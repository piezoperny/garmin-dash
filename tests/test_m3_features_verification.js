/**
 * tests/test_m3_features_verification.js
 * Comprehensive automated verification for Milestone 3 Activity Drawer & Telemetry Overhaul:
 * 1. Activity drawer canvas layout race & narrow viewport (531px) boundary test
 * 2. Bogus elevation Y-axis suppression on indoor/zero-elevation activities
 * 3. hasStream false positive prevention for cardio/stair-stepper dummy HR
 * 4. Single-split polygon collapse fix (n=1 split draws full-width profile)
 * 5. Dynamic multi-axis support for Pace & Cadence with inverted pace scale & units
 * 6. Telemetry stream array length normalization
 * 7. streamVisibility sensible reset per activity type
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '10px monospace';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.calls = [];
    this.lines = [];
  }
  clearRect() { this.calls.push({ op: 'clearRect' }); }
  beginPath() { this.calls.push({ op: 'beginPath' }); }
  closePath() { this.calls.push({ op: 'closePath' }); }
  moveTo(x, y) {
    this.calls.push({ op: 'moveTo', x: Number(x), y: Number(y) });
    this.lastX = Number(x);
    this.lastY = Number(y);
  }
  lineTo(x, y) {
    this.calls.push({ op: 'lineTo', x: Number(x), y: Number(y) });
    if (this.lastX !== undefined) {
      this.lines.push({ x1: this.lastX, y1: this.lastY, x2: Number(x), y2: Number(y) });
    }
    this.lastX = Number(x);
    this.lastY = Number(y);
  }
  arc(x, y, r) { this.calls.push({ op: 'arc', x, y, r }); }
  rect(x, y, w, h) { this.calls.push({ op: 'rect', x, y, w, h }); }
  fillRect(x, y, w, h) { this.calls.push({ op: 'fillRect', x, y, w, h }); }
  fill() { this.calls.push({ op: 'fill', fillStyle: this.fillStyle }); }
  stroke() { this.calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); }
  setTransform() {}
  resetTransform() {}
  scale() {}
  setLineDash() {}
  measureText(str) {
    const s = String(str);
    return { width: s.length * 6.0 };
  }
  fillText(text, x, y) {
    const s = String(text);
    const w = this.measureText(s).width;
    this.calls.push({
      op: 'fillText',
      text: s,
      x: Number(x),
      y: Number(y),
      width: w,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      fillStyle: this.fillStyle
    });
  }
}

class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.classList = new Set();
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.clientWidth = 600;
    this.clientHeight = 180;
  }
  getBoundingClientRect() {
    return {
      top: 0,
      left: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight
    };
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  addEventListener() {}
  removeEventListener() {}
}

class MockCanvasElement extends MockElement {
  constructor(id, width = 600, height = 180) {
    super(id, 'canvas');
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this.ctx = new MockContext2D(this);
  }
  getContext(type) {
    if (type === '2d') return this.ctx;
    return null;
  }
}

// Global DOM setup
const elements = new Map();

function getOrCreateElement(id, tagName = 'div') {
  if (!elements.has(id)) {
    const el = tagName === 'canvas' ? new MockCanvasElement(id) : new MockElement(id, tagName);
    elements.set(id, el);
  }
  return elements.get(id);
}

global.window = {
  devicePixelRatio: 1,
  innerWidth: 531,
  innerHeight: 800,
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (cb) => { cb(); return 1; }
};

global.document = {
  getElementById: (id) => getOrCreateElement(id),
  createElement: (tag) => new MockElement('', tag)
};

async function runTests() {
  console.log('=== Milestone 3 Automated Verification Suite ===\n');

  const activities = await import('../frontend/src/charts/activities.js');

  // Setup DOM elements
  const drawer = getOrCreateElement('activity-drawer');
  drawer.classList = new Set();
  drawer.classList.contains = function(c) { return this.has(c); };
  drawer.classList.remove = function(c) { this.delete(c); };

  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const parentContainer = new MockElement('chart-container');
  parentContainer.clientWidth = 450; // Emulate 531px viewport with drawer padding
  parentContainer.clientHeight = 176;
  canvas.parentElement = parentContainer;

  // --------------------------------------------------------------------------
  // Test 1: Layout Race & 531px Viewport Canvas Fitting
  // --------------------------------------------------------------------------
  console.log('Test 1: Activity Drawer Canvas Layout Race & 531px Viewport Fitting');
  drawer.classList.add('hidden');
  const stairAct = {
    id: 'stair-01',
    sport: 'cardio',
    title: 'Stair Stepper',
    duration_seconds: 600,
    moving_time_seconds: 600,
    distance_meters: 0,
    elevation_gain_meters: 0,
    avg_hr: 151,
    max_hr: 158,
    splits: [
      { split_number: 1, duration_seconds: 600, distance_meters: 0, avg_hr: 151, elevation_diff: 0 }
    ]
  };

  activities.openActivityDrawer(stairAct, 'km');
  assert.strictEqual(drawer.classList.contains('hidden'), false, 'Drawer must be unhidden');
  assert.ok(canvas.width <= 450, `Canvas width (${canvas.width}) must fit within container clientWidth (450)`);
  assert.strictEqual(canvas.style.maxWidth, '100%', 'Canvas style maxWidth must be 100%');

  // Verify HR label is not clipped beyond canvas width
  const textCalls = canvas.ctx.calls.filter(c => c.op === 'fillText');
  for (const tc of textCalls) {
    if (tc.text.includes('bpm')) {
      const rightEdge = tc.x + (tc.textAlign === 'left' ? tc.width : 0);
      assert.ok(rightEdge <= canvas.width, `HR label right edge (${rightEdge}) must not exceed canvas width (${canvas.width})`);
    }
  }
  console.log('  [PASS] Canvas fits 450px container without overflow; HR axis is fully visible within canvas bounds.');

  // --------------------------------------------------------------------------
  // Test 2: Bogus Elevation Y-Axis Suppression on Indoor Workout
  // --------------------------------------------------------------------------
  console.log('\nTest 2: Bogus Elevation Y-Axis Suppression on Indoor Workouts');
  // Stair Stepper is cardio with zero elevation
  const elevationTexts = textCalls.filter(c => c.fillStyle === '#10b981' && !c.text.includes('bpm'));
  assert.strictEqual(elevationTexts.length, 0, `No elevation ticks should be drawn on indoor workout, found: ${elevationTexts.map(t => t.text)}`);
  
  // Verify that bogus ticks like 110, 80, 50, 20 are NOT drawn
  const bogusLabels = textCalls.filter(c => c.text === '110' || c.text === '80');
  assert.strictEqual(bogusLabels.length, 0, 'Bogus elevation ticks (110, 80) must be completely absent');
  console.log('  [PASS] Bogus elevation Y-axis (110, 80, 50, 20) is suppressed on indoor workout.');

  // --------------------------------------------------------------------------
  // Test 3: hasStream False Positive Prevention
  // --------------------------------------------------------------------------
  console.log('\nTest 3: hasStream False Positive Prevention for Cardio Dummy HR');
  const telem = activities.extractActivityTelemetry(stairAct);
  assert.strictEqual(telem.hasStream, false, 'hasStream must be FALSE when no real telemetry stream exists');
  console.log('  [PASS] Synthetic dummy HR points do not cause hasStream to evaluate to true.');

  // --------------------------------------------------------------------------
  // Test 4: Single-Split Polygon Collapse Fix (n=1 split)
  // --------------------------------------------------------------------------
  console.log('\nTest 4: Single-Split Polygon Collapse Fix');
  // In stairAct, splits.length === 1
  canvas.ctx.lines = [];
  canvas.ctx.calls = [];
  activities.renderActivityProfileChart(stairAct, 'km');
  
  // Verify that a horizontal line of width > 100px was drawn across the plot
  const horizontalLines = canvas.ctx.lines.filter(l => Math.abs(l.y1 - l.y2) < 0.1 && (l.x2 - l.x1) > 100);
  assert.ok(horizontalLines.length > 0, 'Must draw horizontal line spanning the chart width for single split');
  
  // Check that single split text is rendered
  const splitLabels = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.text.includes('Split #1'));
  assert.ok(splitLabels.length > 0, 'Must render Split #1 label for single split');
  console.log('  [PASS] Single-split activity renders full-width line and fill without collapsing to 0px.');

  // --------------------------------------------------------------------------
  // Test 5: Dynamic Multi-Axis for Pace & Cadence with Inverted Pace Scale
  // --------------------------------------------------------------------------
  console.log('\nTest 5: Dynamic Multi-Axis for Pace & Cadence with Inverted Pace Scale');
  // Scenario matching image_5.png: Running activity with Elevation & HR toggled OFF, Pace & Cadence ON
  const valenciaAct = {
    id: 'valencia-01',
    sport: 'running',
    title: 'Valencia - Z3 - 5x10 min',
    distance_meters: 12080,
    duration_seconds: 3600,
    elevation_gain_meters: 44,
    avg_hr: 157,
    avg_cadence: 175,
    telemetry_stream: {
      time: Array.from({ length: 50 }, (_, i) => i * 72),
      elevation: Array.from({ length: 50 }, (_, i) => 20 + Math.sin(i / 5) * 10),
      hr: Array.from({ length: 50 }, (_, i) => 150 + (i % 10)),
      speed: Array.from({ length: 50 }, (_, i) => 3.2 + Math.sin(i / 8) * 0.4), // 3.2 m/s ≈ 5:12/km
      cadence: Array.from({ length: 50 }, (_, i) => 170 + (i % 8))
    }
  };

  activities.openActivityDrawer(valenciaAct, 'km');

  // Toggle OFF Elevation and HR (as in image_5.png)
  activities.streamVisibility.elevation = false;
  activities.streamVisibility.hr = false;
  activities.streamVisibility.pace = true;
  activities.streamVisibility.cadence = true;

  canvas.ctx.calls = [];
  activities.renderActivityProfileChart(valenciaAct, 'km');

  const paceCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#38bdf8');
  assert.ok(paceCalls.length >= 4, `Pace Y-axis ticks must be rendered on Left Axis, found: ${paceCalls.length}`);
  // Check units on pace labels (must have /km)
  assert.ok(paceCalls.some(c => c.text.includes('/km')), 'Pace axis labels must have /km units');

  // Inverted pace scale verification: top tick (y = min y) must be faster pace than bottom tick (y = max y)
  const sortedPaceCalls = [...paceCalls].sort((a, b) => a.y - b.y);
  const topPaceText = sortedPaceCalls[0].text;
  const bottomPaceText = sortedPaceCalls[sortedPaceCalls.length - 1].text;
  // Parse mm:ss
  function parsePaceSec(str) {
    const m = str.match(/(\d+):(\d+)/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }
  const topPaceSec = parsePaceSec(topPaceText);
  const bottomPaceSec = parsePaceSec(bottomPaceText);
  assert.ok(topPaceSec < bottomPaceSec, `Faster pace (lower sec: ${topPaceSec}) must be at top, slower pace (${bottomPaceSec}) at bottom`);

  // Check Cadence ticks on Right Axis
  const cadCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#818cf8');
  assert.ok(cadCalls.length >= 4, `Cadence Y-axis ticks must be rendered on Right Axis, found: ${cadCalls.length}`);
  assert.ok(cadCalls.some(c => c.text.includes('spm')), 'Running cadence axis labels must have spm units');
  console.log('  [PASS] Left axis dynamically renders Pace with inverted scale (/km), Right axis renders Cadence (spm).');

  // --------------------------------------------------------------------------
  // Test 6: Telemetry Stream Array Length Normalization
  // --------------------------------------------------------------------------
  console.log('\nTest 6: Telemetry Stream Array Length Normalization');
  const mismatchedAct = {
    id: 'mismatch-01',
    sport: 'running',
    title: 'Mismatched Stream Lengths',
    distance_meters: 5000,
    duration_seconds: 1500,
    avg_hr: 160,
    telemetry_stream: {
      time: [0, 500, 1000, 1500],
      elevation: [10, 20, 15, 25], // 4 points
      hr: Array.from({ length: 60 }, (_, i) => 140 + i), // 60 points
      speed: [3.0, 3.2, 3.4], // 3 points
      cadence: [170, 172] // 2 points
    }
  };

  const normTelem = activities.extractActivityTelemetry(mismatchedAct);
  assert.strictEqual(normTelem.elevations.length, 60, 'Elevations must be normalized to 60 points');
  assert.strictEqual(normTelem.hrs.length, 60, 'HRs must be 60 points');
  assert.strictEqual(normTelem.speeds.length, 60, 'Speeds must be normalized to 60 points');
  assert.strictEqual(normTelem.cadences.length, 60, 'Cadences must be normalized to 60 points');
  assert.strictEqual(normTelem.times.length, 60, 'Times must be normalized to 60 points');

  // Test scrubbing across all 60 points without undefined index errors
  canvas.ctx.calls = [];
  activities.renderActivityProfileChart(mismatchedAct, 'km');
  for (let idx = 0; idx < 60; idx++) {
    const fakeEvent = {
      clientX: 48 + (idx / 59) * (450 - 48 - 52)
    };
    canvas.onmousemove(fakeEvent);
  }
  console.log('  [PASS] Stream arrays normalized to uniform length; scrubbing 60 indices executed without undefined access.');

  // --------------------------------------------------------------------------
  // Test 7: streamVisibility Sensible Reset per Activity Type
  // --------------------------------------------------------------------------
  console.log('\nTest 7: streamVisibility Sensible Reset per Activity Type');
  // First, open Valencia running workout (has elevation, hr, speed, cadence)
  activities.openActivityDrawer(valenciaAct, 'km');
  assert.strictEqual(activities.streamVisibility.elevation, true, 'Outdoor run must default elevation: true');
  assert.strictEqual(activities.streamVisibility.hr, true, 'Outdoor run must default hr: true');

  // Then open indoor Stair Stepper (cardio, no elevation)
  activities.openActivityDrawer(stairAct, 'km');
  assert.strictEqual(activities.streamVisibility.elevation, false, 'Indoor cardio must reset elevation: false');
  assert.strictEqual(activities.streamVisibility.hr, true, 'Indoor cardio must retain hr: true');
  console.log('  [PASS] streamVisibility is sensibly reset per activity type and does not leak toggle states.');

  console.log('\n======================================================');
  console.log('   All Milestone 3 Features Successfully Verified!');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
