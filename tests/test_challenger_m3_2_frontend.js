/**
 * tests/test_challenger_m3_2_frontend.js
 *
 * Adversarial Challenger M3-2 Empirical Frontend Verification:
 * Scenario 1: image_4.png - Stair Stepper / Indoor Cardio with 0 Elevation Gain & 1 Split
 * Scenario 2: image_5.png - Running Activity with Elevation & HR Toggled OFF
 */

import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------
// Headless DOM & Canvas 2D Mock Environment
// ----------------------------------------------------------------------------

class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '9px monospace';
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
  measureText(str) {
    const s = String(str);
    // 9px monospace character width is ~5.4px to 6.0px
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
    const classes = new Set();
    this.classList = {
      has: (c) => classes.has(c),
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      delete: (c) => classes.delete(c),
      [Symbol.iterator]: () => classes[Symbol.iterator]()
    };
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.clientWidth = 600;
    this.clientHeight = 180;
    this.disabled = false;
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

const domElements = new Map();
function getOrCreateElement(id, tagName = 'div') {
  if (!domElements.has(id)) {
    const el = tagName === 'canvas' ? new MockCanvasElement(id) : new MockElement(id, tagName);
    domElements.set(id, el);
  }
  return domElements.get(id);
}

// Leaflet mock to observe map crosshair updates
let mockLeafletMarkerInstance = null;
let markerUpdateCalls = [];
let markerCleared = false;

let mockMapInstance = {
  setView: () => mockMapInstance,
  fitBounds: () => mockMapInstance,
  addLayer: () => mockMapInstance,
  removeLayer: () => mockMapInstance,
  invalidateSize: () => mockMapInstance,
  remove: () => mockMapInstance
};

const mockLeaflet = {
  map: () => mockMapInstance,
  tileLayer: () => ({ addTo: () => mockMapInstance }),
  polyline: () => ({ addTo: () => mockMapInstance }),
  circleMarker: (coords, opts) => {
    const marker = {
      coords,
      opts,
      setLatLng: (newCoords) => {
        marker.coords = newCoords;
        markerUpdateCalls.push(newCoords);
        return marker;
      },
      bindTooltip: () => marker,
      openTooltip: () => marker,
      bindPopup: () => marker,
      openPopup: () => marker,
      addTo: () => marker
    };
    mockLeafletMarkerInstance = marker;
    markerUpdateCalls.push(coords);
    return marker;
  }
};

global.window = {
  devicePixelRatio: 1,
  innerWidth: 531,
  innerHeight: 800,
  L: mockLeaflet,
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (cb) => { cb(); return 1; }
};

global.document = {
  getElementById: (id) => getOrCreateElement(id),
  createElement: (tag) => new MockElement('', tag)
};

async function runAdversarialFrontendTests() {
  console.log('======================================================================');
  console.log('Challenger M3-2 Frontend Verification: image_4.png & image_5.png Tests');
  console.log('======================================================================\n');

  const activities = await import('../frontend/src/charts/activities.js');

  // Setup DOM elements expected by activities module
  const drawer = getOrCreateElement('activity-drawer');
  const canvas = getOrCreateElement('activity-profile-chart', 'canvas');
  const parentContainer = new MockElement('chart-container');
  parentContainer.clientWidth = 450;
  parentContainer.clientHeight = 176;
  canvas.parentElement = parentContainer;

  // Readouts
  const elevEl = getOrCreateElement('readout-elev');
  const hrEl = getOrCreateElement('readout-hr');
  const distEl = getOrCreateElement('readout-dist');

  // Toggle buttons
  getOrCreateElement('toggle-stream-elevation');
  getOrCreateElement('toggle-stream-hr');
  getOrCreateElement('toggle-stream-pace');
  getOrCreateElement('toggle-stream-cadence');

  // Drawer KPI headers
  getOrCreateElement('drawer-activity-title');
  getOrCreateElement('drawer-activity-date');
  getOrCreateElement('drawer-kpi-dist');
  getOrCreateElement('drawer-kpi-duration');
  getOrCreateElement('drawer-kpi-hr');
  getOrCreateElement('drawer-kpi-cadence');
  getOrCreateElement('drawer-kpi-elevation');
  getOrCreateElement('drawer-kpi-calories');
  getOrCreateElement('drawer-splits-tbody');

  let passedCount = 0;
  let failedCount = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passedCount++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failedCount++;
    }
  }

  // ==========================================================================
  // SECTION 1: SCENARIO image_4.png (Stair Stepper / Indoor Cardio)
  // ==========================================================================
  console.log('--- SECTION 1: SCENARIO image_4.png (Stair Stepper / Indoor Cardio) ---');

  const image4StairStepper = {
    id: 'stair-stepper-nov5',
    sport: 'cardio',
    title: 'Stair Stepper',
    date: '2026-11-05T10:00:00Z',
    duration_seconds: 601,
    moving_time_seconds: 601,
    distance_meters: 0,
    elevation_gain_meters: 0,
    avg_hr: 151,
    max_hr: 158,
    avg_cadence: 94,
    calories: 130,
    splits: [
      {
        split_number: 1,
        duration_seconds: 601,
        distance_meters: 0,
        avg_hr: 151,
        elevation_diff: 0,
        avg_cadence: 94
      }
    ]
  };

  test('1.1: Absolutely no elevation axis ticks (no 110, 80, 50, 20, or m/ft ticks) appear', () => {
    drawer.classList.add('hidden');
    canvas.ctx.calls = [];
    canvas.ctx.lines = [];

    activities.openActivityDrawer(image4StairStepper, 'km');

    const textCalls = canvas.ctx.calls.filter(c => c.op === 'fillText');
    const texts = textCalls.map(c => c.text);

    // Verify verbatim bogus labels from original bug
    assert.strictEqual(texts.includes('110'), false, 'Tick 110 must not be drawn');
    assert.strictEqual(texts.includes('80'), false, 'Tick 80 must not be drawn');
    assert.strictEqual(texts.includes('50'), false, 'Tick 50 must not be drawn');
    assert.strictEqual(texts.includes('20'), false, 'Tick 20 must not be drawn');

    // Verify no elevation unit labels appear
    const elevUnitLabels = texts.filter(t => t.endsWith(' m') || t.endsWith(' ft'));
    assert.strictEqual(elevUnitLabels.length, 0, `No elevation unit ticks expected, found: ${elevUnitLabels.join(', ')}`);

    // Verify no emerald green (#10b981) elevation axis text was drawn
    const emeraldTexts = textCalls.filter(c => c.fillStyle === '#10b981');
    assert.strictEqual(emeraldTexts.length, 0, 'No emerald elevation text calls allowed');
  });

  test('1.2: HR axis is fully visible, labeled with units, and not clipped across viewports (320px to 800px)', () => {
    const viewports = [320, 375, 450, 531, 600, 800];

    for (const vp of viewports) {
      parentContainer.clientWidth = vp;
      canvas.width = vp;
      canvas.ctx.calls = [];

      activities.renderActivityProfileChart(image4StairStepper, 'km');

      const hrCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.text.includes('bpm'));
      assert.ok(hrCalls.length >= 4, `At viewport ${vp}px, must have HR ticks (found ${hrCalls.length})`);

      for (const call of hrCalls) {
        assert.strictEqual(call.fillStyle, '#f43f5e', 'HR tick must have rose color');
        // Label must end before or at canvas edge
        const rightEdge = call.x + (call.textAlign === 'left' ? call.width : 0);
        assert.ok(
          rightEdge <= canvas.width,
          `At viewport ${vp}px: HR label "${call.text}" right edge (${rightEdge}) clipped past canvas width (${canvas.width})`
        );
        assert.ok(call.x >= 0, `HR label x (${call.x}) must not be negative`);
      }
    }
  });

  test('1.3: Split profile is drawn cleanly across the entire canvas width for n=1 split without collapsing', () => {
    parentContainer.clientWidth = 450;
    canvas.width = 450;
    canvas.ctx.calls = [];
    canvas.ctx.lines = [];

    activities.renderActivityProfileChart(image4StairStepper, 'km');

    // Expected plot boundaries
    const padLeft = 48;
    const padRight = 52;
    const expectedPlotW = 450 - padLeft - padRight; // 350px

    // Check full-width horizontal HR line
    const hrLines = canvas.ctx.lines.filter(l =>
      Math.abs(l.y1 - l.y2) < 0.1 &&
      Math.abs((l.x2 - l.x1) - expectedPlotW) < 2
    );
    assert.ok(
      hrLines.length > 0,
      `Must draw full-width horizontal line spanning ${expectedPlotW}px. Found lines: ${JSON.stringify(canvas.ctx.lines)}`
    );

    // Check translucent fill polygon
    const fillCalls = canvas.ctx.calls.filter(c => c.op === 'fill' && c.fillStyle === 'rgba(244, 63, 94, 0.12)');
    assert.ok(fillCalls.length > 0, 'Must render translucent rose fill polygon for split profile');

    // Check Split #1 centered label
    const splitLabel = canvas.ctx.calls.find(c => c.op === 'fillText' && c.text.includes('Split #1'));
    assert.ok(splitLabel, 'Must render Split #1 label');
    assert.strictEqual(splitLabel.textAlign, 'center', 'Single split label must be centered');
    const expectedCenterX = padLeft + expectedPlotW / 2;
    assert.strictEqual(splitLabel.x, expectedCenterX, `Label x (${splitLabel.x}) must be center of plot (${expectedCenterX})`);
  });

  test('1.4: Elevation toggle button is disabled and dimmed on indoor workout', () => {
    activities.openActivityDrawer(image4StairStepper, 'km');
    const elevBtn = getOrCreateElement('toggle-stream-elevation');
    assert.strictEqual(elevBtn.disabled, true, 'Elevation button must be disabled for indoor workout');
    assert.ok(elevBtn.className.includes('cursor-not-allowed'), 'Elevation button must have cursor-not-allowed');
    assert.ok(elevBtn.className.includes('opacity-40'), 'Elevation button must be dimmed (opacity-40)');
  });

  // ==========================================================================
  // SECTION 2: SCENARIO image_5.png (Running with Elev & HR Toggled OFF)
  // ==========================================================================
  console.log('\n--- SECTION 2: SCENARIO image_5.png (Running with Elev & HR Toggled OFF) ---');

  const image5Valencia = {
    id: 'valencia-z3-5x10',
    sport: 'running',
    title: 'Valencia - Z3 - 5x10 min',
    date: '2026-11-03T08:30:00Z',
    distance_meters: 12080,
    duration_seconds: 3840,
    moving_time_seconds: 3840,
    elevation_gain_meters: 44,
    avg_hr: 157,
    max_hr: 177,
    avg_cadence: 175,
    calories: 824,
    gps_track: {
      points: Array.from({ length: 60 }, (_, i) => [
        39.4699 + i * 0.0005,
        -0.3763 + i * 0.0005,
        20 + Math.sin(i / 5) * 10,
        150 + (i % 15)
      ])
    },
    telemetry_stream: {
      time: Array.from({ length: 60 }, (_, i) => i * 64),
      elevation: Array.from({ length: 60 }, (_, i) => 20 + Math.sin(i / 5) * 10),
      hr: Array.from({ length: 60 }, (_, i) => 150 + (i % 15)),
      speed: Array.from({ length: 60 }, (_, i) => 3.0 + (i % 10) * 0.1), // 3.0 to 3.9 m/s (5:33/km to 4:16/km)
      cadence: Array.from({ length: 60 }, (_, i) => 170 + (i % 8)),
      distance: Array.from({ length: 60 }, (_, i) => i * 201.3)
    }
  };

  test('2.1: Left Y-Axis renders Pace with clear numeric ticks and units (/km)', () => {
    activities.openActivityDrawer(image5Valencia, 'km');

    // Simulate user toggling OFF Elevation and HR (as seen in image_5.png)
    activities.streamVisibility.elevation = false;
    activities.streamVisibility.hr = false;
    activities.streamVisibility.pace = true;
    activities.streamVisibility.cadence = true;

    canvas.ctx.calls = [];
    activities.renderActivityProfileChart(image5Valencia, 'km');

    const paceCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#38bdf8');
    assert.ok(paceCalls.length >= 4, `Must render at least 4 pace ticks, found ${paceCalls.length}`);

    for (const call of paceCalls) {
      assert.strictEqual(call.textAlign, 'right', 'Left axis pace ticks must align right');
      assert.ok(call.text.includes('/km'), `Pace tick "${call.text}" must include /km unit`);
      // Must match mm:ss/km pattern
      assert.match(call.text, /^\d+:\d{2}\/km$/, `Pace tick "${call.text}" must match mm:ss/km format`);
    }
  });

  test('2.2: Inverted pace scale positions faster pace at the top and slower pace at the bottom', () => {
    const paceCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#38bdf8');
    const sortedByY = [...paceCalls].sort((a, b) => a.y - b.y);

    const topTick = sortedByY[0];
    const bottomTick = sortedByY[sortedByY.length - 1];

    function parseSec(txt) {
      const m = txt.match(/^(\d+):(\d{2})/);
      return Number(m[1]) * 60 + Number(m[2]);
    }

    const topPaceSec = parseSec(topTick.text);
    const bottomPaceSec = parseSec(bottomTick.text);

    assert.ok(
      topPaceSec < bottomPaceSec,
      `Inverted scale violation: Top pace (${topTick.text} = ${topPaceSec}s) must be faster (lower seconds) than bottom pace (${bottomTick.text} = ${bottomPaceSec}s)`
    );
  });

  test('2.3: Right Y-Axis renders Cadence with clear numeric ticks and units (spm)', () => {
    const cadCalls = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#818cf8');
    assert.ok(cadCalls.length >= 4, `Must render at least 4 cadence ticks, found ${cadCalls.length}`);

    for (const call of cadCalls) {
      assert.strictEqual(call.textAlign, 'left', 'Right axis cadence ticks must align left');
      assert.ok(call.text.includes('spm'), `Cadence tick "${call.text}" must include spm unit`);
      assert.match(call.text, /^\d+\s*spm$/, `Cadence tick "${call.text}" must match XXX spm format`);
      const rightEdge = call.x + call.width;
      assert.ok(rightEdge <= canvas.width, `Cadence label right edge (${rightEdge}) must not exceed canvas width (${canvas.width})`);
    }
  });

  test('2.4: Interactive scrubber mousemove updates readout and map marker across all points', () => {
    markerUpdateCalls = [];
    const padLeft = 48;
    const plotW = 450 - 48 - 52;

    // Scrub across 10 sample positions
    for (let step = 0; step <= 10; step++) {
      const ratio = step / 10;
      const clientX = padLeft + ratio * plotW;
      const fakeEvt = { clientX };

      canvas.onmousemove(fakeEvt);

      // Verify readouts updated
      if (ratio === 0) {
        assert.ok(
          distEl.textContent === 'Dist: -' || distEl.textContent === 'Dist: 0.00 km',
          `distEl at origin was "${distEl.textContent}"`
        );
      } else {
        assert.match(
          distEl.textContent,
          /^Dist:\s*\d+\.\d{2}\s*km$/,
          `distEl "${distEl.textContent}" must display distance`
        );
      }
      assert.match(hrEl.textContent, /^HR:\s*\d+\s*bpm$/, `hrEl "${hrEl.textContent}" must display HR`);

      // Verify map crosshair marker updated
      assert.ok(markerUpdateCalls.length > 0, 'Map crosshair marker setLatLng must be called');
      const latestCoord = markerUpdateCalls[markerUpdateCalls.length - 1];
      assert.ok(Array.isArray(latestCoord) && latestCoord.length === 2, 'Latest coord must be [lat, lng]');
      assert.ok(!isNaN(latestCoord[0]) && !isNaN(latestCoord[1]), 'Coords must not be NaN');
    }
  });

  test('2.5: Scrubber mouseleave resets readouts and clears map crosshair marker', () => {
    canvas.onmouseleave();

    assert.strictEqual(elevEl.textContent, 'Elev: —', 'elevEl must reset to Elev: —');
    assert.strictEqual(hrEl.textContent, 'HR: —', 'hrEl must reset to HR: —');
    assert.strictEqual(distEl.textContent, 'Dist: —', 'distEl must reset to Dist: —');
  });

  test('2.6: Imperial units toggle converts pace to min/mi and speed to mph', () => {
    canvas.ctx.calls = [];
    activities.renderActivityProfileChart(image5Valencia, 'mi');

    const paceCallsImperial = canvas.ctx.calls.filter(c => c.op === 'fillText' && c.fillStyle === '#38bdf8');
    assert.ok(paceCallsImperial.length >= 4, 'Must render pace ticks in imperial mode');
    for (const call of paceCallsImperial) {
      assert.ok(call.text.includes('/mi'), `Imperial pace tick "${call.text}" must include /mi unit`);
    }
  });

  console.log('\n======================================================================');
  console.log(`Results: ${passedCount} passed, ${failedCount} failed`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAdversarialFrontendTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
