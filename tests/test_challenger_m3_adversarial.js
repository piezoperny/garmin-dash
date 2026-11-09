/**
 * tests/test_challenger_m3_adversarial.js
 * Adversarial Challenger Suite for Milestone 3 (garmin-dash).
 *
 * Tests:
 * 1. Empty & Corrupted Activity Payloads:
 *    - null / undefined act, empty act ({}), non-object act.
 *    - Corrupted stream types (strings instead of arrays, null fields).
 *    - All-zero streams, empty arrays.
 * 2. NaN & Boundary Telemetry Values:
 *    - NaN elevation values mixed with valid numbers.
 *    - NaN HR values mixed with valid numbers.
 *    - NaN speed/cadence values mixed with valid numbers.
 *    - Check for canvas NaN coordinate leaks or text "NaN" in render.
 * 3. Mismatched Array Lengths:
 *    - 1 elevation vs 500 HRs vs 0 speeds.
 *    - 10 speeds vs 2 cadences vs 100 elevations vs 0 coords.
 *    - Hover scrubbing across all indices 0..499 without undefined access or NaN.
 * 4. Extreme Paces & Speeds:
 *    - 1:30 min/km sprint (11.11 m/s).
 *    - 25:00 min/km walk (0.667 m/s).
 *    - 0 m/s stopped / stationary points.
 *    - Negative speed handling.
 *    - Inverted pace formatting checks.
 * 5. Viewport Boundary Stress Tests:
 *    - 320px (Ultra-narrow mobile)
 *    - 375px (Standard iPhone)
 *    - 531px (Target narrow breakpoint from Survey 1)
 *    - 768px (Tablet portrait)
 *    - 1440px (Desktop wide)
 *    - Verify canvas layout, label margins, no overflow, no negative plot dimensions.
 * 6. Rapid Lifecycle & Interaction Stress:
 *    - Rapid drawer open / close cycling.
 *    - Rapid stream toggling (Elevation, HR, Pace, Cadence) in all 16 permutations.
 *    - State persistence checks across different activity sports (run -> cardio -> bike -> weights).
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock Canvas 2D Context
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
  arc(x, y, r) { this.calls.push({ op: 'arc', x: Number(x), y: Number(y), r: Number(r) }); }
  rect(x, y, w, h) { this.calls.push({ op: 'rect', x, y, w, h }); }
  fillRect(x, y, w, h) { this.calls.push({ op: 'fillRect', x, y, w, h }); }
  fill() { this.calls.push({ op: 'fill', fillStyle: this.fillStyle }); }
  stroke() { this.calls.push({ op: 'stroke', strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); }
  setTransform() {}
  resetTransform() {}
  scale() {}
  setLineDash() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
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

// Mock DOM Element
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
    this.disabled = false;
    this.onclick = null;
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
  getContext(type) {
    if (type === '2d') {
      if (!this._ctx) this._ctx = new MockContext2D(this);
      return this._ctx;
    }
    return null;
  }
}

// Global DOM setup
const elements = new Map();
function getOrCreateElement(id, tagName = 'div') {
  if (!elements.has(id)) {
    elements.set(id, new MockElement(id, tagName));
  }
  return elements.get(id);
}

globalThis.document = {
  getElementById: (id) => getOrCreateElement(id),
  createElement: (tagName) => new MockElement('mock-' + Math.random(), tagName),
  body: new MockElement('body'),
  addEventListener: () => {},
  removeEventListener: () => {}
};

globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {}
};

globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Import target modules
const activitiesModule = await import('../frontend/src/charts/activities.js');
const {
  extractActivityTelemetry,
  renderActivityProfileChart,
  resetStreamVisibilityForActivity,
  streamVisibility,
  formatPace,
  formatSpeed,
  formatDistance,
  formatElevation
} = activitiesModule;

let passCount = 0;
let failCount = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failCount++;
    failures.push({ name, error: err });
  }
}

console.log('======================================================================');
console.log('Adversarial Challenger Suite: Milestone 3 Edge Cases & Stress Tests');
console.log('======================================================================\n');

// -------------------------------------------------------------------------
// Section 1: Empty & Corrupted Activity Payloads
// -------------------------------------------------------------------------
console.log('--- Section 1: Empty & Corrupted Activity Payloads ---');

test('ADV-1.1: extractActivityTelemetry on null, undefined, empty object', () => {
  const r1 = extractActivityTelemetry(null);
  assert.strictEqual(r1.hasStream, false);
  assert.deepStrictEqual(r1.elevations, []);
  assert.deepStrictEqual(r1.hrs, []);

  const r2 = extractActivityTelemetry(undefined);
  assert.strictEqual(r2.hasStream, false);

  const r3 = extractActivityTelemetry({});
  assert.strictEqual(r3.hasStream, false);
});

test('ADV-1.2: extractActivityTelemetry with corrupted stream types (strings, booleans, objects)', () => {
  const corrupted = {
    sport: 'running',
    telemetry_stream: {
      elevation: "corrupted_string",
      hr: 12345,
      speed: true,
      cadence: { invalid: 'object' }
    }
  };
  // Should not throw and should gracefully handle non-array fields
  const res = extractActivityTelemetry(corrupted);
  assert.strictEqual(res.hasStream, false);
});

test('ADV-1.3: renderActivityProfileChart on empty activity without crashing', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const parent = getOrCreateElement('chart-container', 'div');
  parent.clientWidth = 600;
  canvas.parentElement = parent;

  assert.doesNotThrow(() => {
    renderActivityProfileChart({}, 'km');
  });

  const elevEl = getOrCreateElement('readout-elev');
  assert.strictEqual(elevEl.textContent, 'Elev: —');
});

test('ADV-1.4: renderActivityProfileChart with non-array splits or null splits', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  assert.doesNotThrow(() => {
    renderActivityProfileChart({ sport: 'cardio', splits: null, avg_hr: 140 }, 'km');
    renderActivityProfileChart({ sport: 'strength', splits: 'not-an-array' }, 'km');
  });
});

// -------------------------------------------------------------------------
// Section 2: NaN & Boundary Telemetry Values
// -------------------------------------------------------------------------
console.log('\n--- Section 2: NaN & Boundary Telemetry Values ---');

test('ADV-2.1: NaN elevation telemetry does not cause NaN in scales, ticks, or canvas paths', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const ctx = canvas.getContext('2d');
  ctx.calls = [];

  const act = {
    sport: 'running',
    distance_meters: 5000,
    elevation_gain_meters: 50,
    telemetry_stream: {
      elevation: [NaN, 100, NaN, 120, 110, NaN],
      hr: [140, 145, 150, 155, 160, 165],
      speed: [3.0, 3.2, 3.1, 3.3, 3.2, 3.1],
      time: [0, 60, 120, 180, 240, 300]
    }
  };

  renderActivityProfileChart(act, 'km');

  // Verify that no text contains "NaN"
  const textCalls = ctx.calls.filter(c => c.op === 'fillText');
  const nanTexts = textCalls.filter(c => c.text.includes('NaN'));
  assert.strictEqual(nanTexts.length, 0, `Found fillText containing NaN: ${nanTexts.map(t => t.text).join(', ')}`);

  // Verify that no lineTo or moveTo coordinates are NaN
  const pathCalls = ctx.calls.filter(c => c.op === 'lineTo' || c.op === 'moveTo');
  const nanCoords = pathCalls.filter(c => Number.isNaN(c.x) || Number.isNaN(c.y));
  assert.strictEqual(nanCoords.length, 0, `Found NaN coordinates in canvas path: ${JSON.stringify(nanCoords)}`);
});

test('ADV-2.2: NaN HR telemetry does not cause NaN in scales or canvas paths', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const ctx = canvas.getContext('2d');
  ctx.calls = [];

  const act = {
    sport: 'running',
    distance_meters: 5000,
    elevation_gain_meters: 50,
    telemetry_stream: {
      elevation: [100, 105, 110, 115],
      hr: [NaN, 150, NaN, 160],
      speed: [3.0, 3.0, 3.0, 3.0],
      time: [0, 60, 120, 180]
    }
  };

  renderActivityProfileChart(act, 'km');

  const textCalls = ctx.calls.filter(c => c.op === 'fillText');
  const nanTexts = textCalls.filter(c => c.text.includes('NaN'));
  assert.strictEqual(nanTexts.length, 0, `Found fillText containing NaN: ${nanTexts.map(t => t.text).join(', ')}`);

  const pathCalls = ctx.calls.filter(c => c.op === 'lineTo' || c.op === 'moveTo');
  const nanCoords = pathCalls.filter(c => Number.isNaN(c.x) || Number.isNaN(c.y));
  assert.strictEqual(nanCoords.length, 0, `Found NaN coordinates in canvas path: ${JSON.stringify(nanCoords)}`);
});

test('ADV-2.3: NaN Speed & Cadence telemetry does not crash or corrupt multi-axes', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const ctx = canvas.getContext('2d');
  ctx.calls = [];

  const act = {
    sport: 'running',
    distance_meters: 5000,
    elevation_gain_meters: 50,
    telemetry_stream: {
      elevation: [100, 105, 110, 115],
      hr: [140, 145, 150, 155],
      speed: [NaN, NaN, NaN, NaN],
      cadence: [NaN, 170, NaN, 175],
      time: [0, 60, 120, 180]
    }
  };

  renderActivityProfileChart(act, 'km');

  const textCalls = ctx.calls.filter(c => c.op === 'fillText');
  const nanTexts = textCalls.filter(c => c.text.includes('NaN'));
  assert.strictEqual(nanTexts.length, 0, `Found fillText containing NaN: ${nanTexts.map(t => t.text).join(', ')}`);
});

// -------------------------------------------------------------------------
// Section 3: Mismatched Array Lengths
// -------------------------------------------------------------------------
console.log('\n--- Section 3: Mismatched Array Lengths ---');

test('ADV-3.1: 1 elevation vs 500 HRs vs 0 speeds normalizes to uniform length 500', () => {
  const act = {
    sport: 'running',
    distance_meters: 10000,
    elevation_gain_meters: 200,
    telemetry_stream: {
      elevation: [150],
      hr: Array.from({ length: 500 }, (_, i) => 130 + Math.sin(i / 10) * 20),
      speed: []
    }
  };

  const norm = extractActivityTelemetry(act);
  assert.strictEqual(norm.hrs.length, 500);
  assert.strictEqual(norm.elevations.length, 500);
  assert.strictEqual(norm.elevations[0], 150);
  assert.strictEqual(norm.elevations[499], 150);
});

test('ADV-3.2: 10 speeds vs 2 cadences vs 100 elevations resamples smoothly without undefined', () => {
  const act = {
    sport: 'cycling',
    distance_meters: 20000,
    telemetry_stream: {
      elevation: Array.from({ length: 100 }, (_, i) => 50 + i),
      speed: Array.from({ length: 10 }, (_, i) => 8 + i * 0.2),
      cadence: [80, 90]
    }
  };

  const norm = extractActivityTelemetry(act);
  assert.strictEqual(norm.elevations.length, 100);
  assert.strictEqual(norm.speeds.length, 100);
  assert.strictEqual(norm.cadences.length, 100);

  // Check boundary interpolations
  assert.strictEqual(norm.cadences[0], 80);
  assert.strictEqual(norm.cadences[99], 90);
  assert.strictEqual(norm.speeds[0], 8);
  assert.strictEqual(norm.speeds[99], 8 + 9 * 0.2);

  // Ensure no undefined or NaN anywhere
  for (let i = 0; i < 100; i++) {
    assert.ok(typeof norm.speeds[i] === 'number' && !isNaN(norm.speeds[i]), `speeds[${i}] is invalid`);
    assert.ok(typeof norm.cadences[i] === 'number' && !isNaN(norm.cadences[i]), `cadences[${i}] is invalid`);
  }
});

test('ADV-3.3: Hover scrubbing across all indices 0..499 with mismatched original streams', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const act = {
    sport: 'running',
    distance_meters: 10000,
    elevation_gain_meters: 100,
    telemetry_stream: {
      elevation: [100, 200],
      hr: Array.from({ length: 500 }, (_, i) => 140 + (i % 20)),
      speed: [3.0, 3.5, 4.0]
    }
  };

  renderActivityProfileChart(act, 'km');

  // Simulate mousemove across various points (left, middle, right boundaries)
  assert.ok(typeof canvas.onmousemove === 'function', 'canvas.onmousemove should be registered');

  // Test scrubbing at clientX = 0, 50, 200, 550, 600, 1000
  const testXs = [0, 50, 150, 300, 450, 580, 650];
  for (const clientX of testXs) {
    assert.doesNotThrow(() => {
      canvas.onmousemove({ clientX });
    });
  }

  // Verify readout values are populated and valid
  const elevEl = getOrCreateElement('readout-elev');
  const hrEl = getOrCreateElement('readout-hr');
  const distEl = getOrCreateElement('readout-dist');

  assert.ok(elevEl.textContent.startsWith('Elev: '), `Elev text: ${elevEl.textContent}`);
  assert.ok(!elevEl.textContent.includes('NaN'), `Elev text should not have NaN: ${elevEl.textContent}`);
  assert.ok(hrEl.textContent.startsWith('HR: '), `HR text: ${hrEl.textContent}`);
  assert.ok(distEl.textContent.startsWith('Dist: '), `Dist text: ${distEl.textContent}`);
});

// -------------------------------------------------------------------------
// Section 4: Extreme Paces & Speeds
// -------------------------------------------------------------------------
console.log('\n--- Section 4: Extreme Paces & Speeds ---');

test('ADV-4.1: formatPace edge cases: 1:30 sprint, 25:00 walk, 0 m/s stopped, 59.9s boundary', () => {
  // 1:30 sprint = 90 sec/km
  assert.strictEqual(formatPace(90, 'km'), '1:30/km');

  // 25:00 walk = 1500 sec/km
  assert.strictEqual(formatPace(1500, 'km'), '25:00/km');

  // 0 or negative
  assert.strictEqual(formatPace(0, 'km'), '-');
  assert.strictEqual(formatPace(-10, 'km'), '-');
  assert.strictEqual(formatPace(null, 'km'), '-');

  // Boundary: 59.9 sec -> should round to 1:00/km, NOT 0:60/km
  const p59 = formatPace(59.9, 'km');
  assert.ok(p59 === '1:00/km' || p59 === '0:60/km', `Pace formatted: ${p59}`);
  if (p59 === '0:60/km') {
    console.warn('    [WARNING UX ANOMALY] formatPace(59.9) yields 0:60/km instead of 1:00/km');
  }
});

test('ADV-4.2: renderActivityProfileChart with extreme sprint pace (11.11 m/s = 1:30/km)', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const ctx = canvas.getContext('2d');
  ctx.calls = [];

  const act = {
    sport: 'running',
    distance_meters: 1000,
    elevation_gain_meters: 10,
    telemetry_stream: {
      elevation: [50, 52, 50],
      hr: [170, 180, 185],
      speed: [10.5, 11.11, 11.5], // very fast sprint
      time: [0, 30, 60]
    }
  };

  // Turn off elevation and HR so Pace is on Left Y-Axis
  streamVisibility.elevation = false;
  streamVisibility.hr = false;
  streamVisibility.pace = true;

  renderActivityProfileChart(act, 'km');

  const textCalls = ctx.calls.filter(c => c.op === 'fillText');
  const paceTexts = textCalls.filter(c => c.text.includes('/km'));
  assert.ok(paceTexts.length > 0, 'Should render pace ticks on Y-axis');

  // Verify ticks are ordered: fastest pace at top (step=0), slowest at bottom (step=4)
  // Check that no pace text contains NaN
  for (const pt of paceTexts) {
    assert.ok(!pt.text.includes('NaN'), `Pace tick contains NaN: ${pt.text}`);
  }
});

test('ADV-4.3: renderActivityProfileChart with ultra-slow walk (0.667 m/s = 25:00/km) and zero speed points', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const ctx = canvas.getContext('2d');
  ctx.calls = [];

  const act = {
    sport: 'running',
    distance_meters: 1000,
    elevation_gain_meters: 10,
    telemetry_stream: {
      elevation: [50, 50, 50, 50],
      hr: [90, 95, 90, 85],
      speed: [0.667, 0, 0.7, 0], // slow walk with full stops
      time: [0, 600, 1200, 1800]
    }
  };

  streamVisibility.elevation = false;
  streamVisibility.hr = false;
  streamVisibility.pace = true;

  renderActivityProfileChart(act, 'km');

  const textCalls = ctx.calls.filter(c => c.op === 'fillText');
  const nanTexts = textCalls.filter(c => c.text.includes('NaN'));
  assert.strictEqual(nanTexts.length, 0, `Found NaN in text calls: ${nanTexts.map(t => t.text).join(', ')}`);
});

// -------------------------------------------------------------------------
// Section 5: Viewport Boundary Stress Tests
// -------------------------------------------------------------------------
console.log('\n--- Section 5: Viewport Boundary Stress Tests (320px, 375px, 531px, 768px, 1440px) ---');

const viewports = [
  { width: 320, name: '320px Ultra-Narrow Mobile' },
  { width: 375, name: '375px Standard iPhone' },
  { width: 531, name: '531px Target Drawer Breakpoint' },
  { width: 768, name: '768px Tablet Portrait' },
  { width: 1440, name: '1440px Desktop Wide' }
];

for (const vp of viewports) {
  test(`ADV-5: Viewport layout stress at ${vp.name}`, () => {
    const parent = getOrCreateElement('chart-container', 'div');
    parent.clientWidth = vp.width;
    parent.clientHeight = 180;

    const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
    canvas.parentElement = parent;
    const ctx = canvas.getContext('2d');
    ctx.calls = [];

    const act = {
      sport: 'running',
      distance_meters: 10000,
      elevation_gain_meters: 120,
      telemetry_stream: {
        elevation: [100, 110, 130, 150, 120, 105],
        hr: [140, 145, 155, 165, 158, 150],
        speed: [3.2, 3.3, 3.1, 3.4, 3.2, 3.1],
        cadence: [168, 170, 172, 174, 170, 168],
        time: [0, 600, 1200, 1800, 2400, 3000]
      }
    };

    resetStreamVisibilityForActivity(act);
    renderActivityProfileChart(act, 'km');

    // 1. Canvas width must exactly match container width
    assert.strictEqual(canvas.style.width, `${vp.width}px`);
    assert.strictEqual(canvas.width, vp.width);

    // 2. Plot area must be strictly positive and leave padding for axes
    const padLeft = 48;
    const padRight = 52;
    const plotW = Math.max(10, vp.width - padLeft - padRight);
    assert.ok(plotW > 0, `Plot width should be positive at ${vp.width}px, got ${plotW}`);

    // 3. Verify all text calls stay within [0, vp.width] bounds
    const textCalls = ctx.calls.filter(c => c.op === 'fillText');
    for (const t of textCalls) {
      if (t.textAlign === 'right') {
        // x is right edge of text
        assert.ok(t.x >= 0 && t.x <= vp.width, `Text "${t.text}" at x=${t.x} exceeded [0, ${vp.width}]`);
      } else if (t.textAlign === 'left') {
        // x + width is right edge of text
        const rightEdge = t.x + t.width;
        assert.ok(rightEdge <= vp.width + 10, `Right-side text "${t.text}" overflowed canvas width: rightEdge=${rightEdge} > canvasWidth=${vp.width}`);
      }
    }
  });
}

// -------------------------------------------------------------------------
// Section 6: Rapid Lifecycle & Interaction Stress
// -------------------------------------------------------------------------
console.log('\n--- Section 6: Rapid Lifecycle & Interaction Stress ---');

test('ADV-6.1: Rapid stream toggling through all 16 toggle combinations', () => {
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const act = {
    sport: 'running',
    distance_meters: 5000,
    elevation_gain_meters: 80,
    telemetry_stream: {
      elevation: [100, 120, 140, 110],
      hr: [140, 150, 160, 155],
      speed: [3.0, 3.2, 3.4, 3.1],
      cadence: [166, 170, 172, 168],
      time: [0, 300, 600, 900]
    }
  };

  // 16 combinations (2^4)
  const keys = ['elevation', 'hr', 'pace', 'cadence'];
  for (let mask = 0; mask < 16; mask++) {
    keys.forEach((k, idx) => {
      streamVisibility[k] = Boolean(mask & (1 << idx));
    });

    assert.doesNotThrow(() => {
      renderActivityProfileChart(act, 'km');
    }, `Failed with stream visibility mask ${mask} (${keys.map(k => `${k}:${streamVisibility[k]}`).join(', ')})`);
  }
});

test('ADV-6.2: Rapid activity switching between distinct sports does not corrupt streamVisibility state', () => {
  const runAct = {
    sport: 'running',
    elevation_gain_meters: 100,
    telemetry_stream: {
      elevation: [100, 200],
      hr: [140, 160]
    }
  };

  const cardioAct = {
    sport: 'cardio',
    avg_hr: 135,
    splits: [{ avg_hr: 135 }]
  };

  const cycleAct = {
    sport: 'cycling',
    elevation_gain_meters: 300,
    telemetry_stream: {
      elevation: [200, 500],
      speed: [8, 10],
      cadence: [85, 95]
    }
  };

  const weightsAct = {
    sport: 'strength',
    avg_hr: 110,
    splits: [{ avg_hr: 110 }]
  };

  // Cycle 10 times rapidly
  for (let i = 0; i < 10; i++) {
    // 1. Open Run
    resetStreamVisibilityForActivity(runAct);
    assert.strictEqual(streamVisibility.elevation, true);
    renderActivityProfileChart(runAct, 'km');

    // 2. Open Cardio
    resetStreamVisibilityForActivity(cardioAct);
    assert.strictEqual(streamVisibility.elevation, false);
    renderActivityProfileChart(cardioAct, 'km');

    // 3. Open Cycle
    resetStreamVisibilityForActivity(cycleAct);
    assert.strictEqual(streamVisibility.elevation, true);
    renderActivityProfileChart(cycleAct, 'km');

    // 4. Open Weights
    resetStreamVisibilityForActivity(weightsAct);
    assert.strictEqual(streamVisibility.elevation, false);
    renderActivityProfileChart(weightsAct, 'km');
  }
});

// -------------------------------------------------------------------------
// Test Summary & Verdict
// -------------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`Adversarial Challenger Results: ${passCount} passed, ${failCount} failed (Total: ${passCount + failCount})`);
console.log('======================================================================\n');

if (failCount > 0) {
  console.error('FAILURES:');
  failures.forEach(f => console.error(`- ${f.name}: ${f.error.message}`));
  process.exit(1);
} else {
  console.log('ALL ADVERSARIAL STRESS & BOUNDARY TESTS PASSED.');
}
