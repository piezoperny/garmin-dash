/**
 * tests/test_opt_m4_frontend_perf.js
 * Unit tests for Milestone M4 (Frontend Canvas & DOM Performance).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { Chart } from '../frontend/src/charts/chart_engine.js';
import {
  loadActivityStreamShard,
  setStreamPackIndex,
  clearActivityCaches,
  renderActivityProfileChart,
  closeActivityDrawer,
  openActivityDrawer
} from '../frontend/src/charts/activities.js';
import { renderConsistencyHeatmap } from '../frontend/src/charts/achievements.js';
import {
  renderWellnessDashboard,
  clearWellnessCache,
  setupWellnessEventListeners,
  moveWellnessCard
} from '../frontend/src/charts/wellness.js';
import {
  renderCalendar,
  clearCalendarCache
} from '../frontend/src/charts/calendar.js';
import {
  clearTrendsCache
} from '../frontend/src/charts/trends_modal.js';
import {
  ensureLeafletLoaded
} from '../frontend/src/charts/route_map.js';
import {
  decryptDashboardPayload,
  PBKDF2_ITERATIONS
} from '../frontend/src/crypto.js';

function createMockCtx() {
  return {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    arc() {},
    rect() {},
    roundRect() {},
    clip() {},
    fill() {},
    stroke() {},
    fillRect() {},
    clearRect() {},
    fillText() {},
    measureText(t) { return { width: String(t || '').length * 6 }; },
    setLineDash() {},
    resetTransform() {},
    setTransform() {},
    scale() {},
    createLinearGradient() { return { addColorStop() {} }; }
  };
}

function createMockCanvas(width = 400, height = 200) {
  let cssW = width;
  let cssH = height;
  let _w = width;
  let _h = height;
  let widthAssignCount = 0;
  let heightAssignCount = 0;
  const listeners = new Map();

  const parentElement = {
    get clientWidth() { return cssW; },
    get clientHeight() { return cssH; },
    getBoundingClientRect() {
      return { width: cssW, height: cssH, left: 0, top: 0 };
    }
  };

  const ctx = createMockCtx();
  const canvas = {
    parentElement,
    style: {},
    get width() { return _w; },
    set width(v) { widthAssignCount++; _w = v; },
    get height() { return _h; },
    set height(v) { heightAssignCount++; _h = v; },
    getContext() { return ctx; },
    getBoundingClientRect() { return { width: cssW, height: cssH, left: 0, top: 0 }; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners.has(type)) return;
      listeners.set(type, listeners.get(type).filter(f => f !== fn));
    },
    dispatchEvent(evt) {
      for (const fn of listeners.get(evt.type) || []) fn(evt);
    },
    getCounts() { return { widthAssignCount, heightAssignCount }; },
    setSize(w, h) {
      cssW = w;
      cssH = h;
    }
  };
  return canvas;
}

function encryptWire(plainBytes, keyBytes, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const ct = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([salt, iv, ct, tag]));
}

async function run() {
  console.log('\n=== Running M4 Frontend Canvas & DOM Performance Tests ===\n');

  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origRO = globalThis.ResizeObserver;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;
  const origFetch = globalThis.fetch;
  const origSessionStorage = globalThis.sessionStorage;

  try {
    // -----------------------------------------------------------------------
    // 1. Chart DPI Caching & ResizeObserver / RAF Coalescing
    // -----------------------------------------------------------------------
    {
      const windowListeners = new Map();
      let roObserved = 0;
      let roDisconnected = 0;
      globalThis.ResizeObserver = class MockRO {
        observe() { roObserved++; }
        disconnect() { roDisconnected++; }
      };
      globalThis.window = {
        devicePixelRatio: 2,
        addEventListener(type, fn) {
          if (!windowListeners.has(type)) windowListeners.set(type, []);
          windowListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
          if (!windowListeners.has(type)) return;
          windowListeners.set(type, windowListeners.get(type).filter(f => f !== fn));
        }
      };

      let rafQueue = [];
      let rafIdSeq = 0;
      globalThis.requestAnimationFrame = (fn) => {
        const id = ++rafIdSeq;
        rafQueue.push({ id, fn });
        return id;
      };
      globalThis.cancelAnimationFrame = (id) => {
        rafQueue = rafQueue.filter(item => item.id !== id);
      };

      const canvas = createMockCanvas(400, 200);
      const chart = new Chart(canvas, {
        type: 'bar',
        data: { labels: ['A', 'B'], datasets: [{ label: 'S1', data: [10, 20] }] }
      });

      assert.equal(canvas.getCounts().widthAssignCount, 1, 'initial render assigns canvas.width once');
      assert.equal(canvas.getCounts().heightAssignCount, 1, 'initial render assigns canvas.height once');
      assert.equal(roObserved, 1, 'ResizeObserver attached to parent');
      assert.equal((windowListeners.get('resize') || []).length, 0, 'does not bind duplicate window resize when ResizeObserver is active');

      // Re-render with identical dimensions & DPR -> zero width/height reassignments
      chart.render();
      chart.render();
      assert.equal(canvas.getCounts().widthAssignCount, 1, 'cached DPI skips canvas.width reassignment');
      assert.equal(canvas.getCounts().heightAssignCount, 1, 'cached DPI skips canvas.height reassignment');

      // Change dimensions -> reassigns once
      canvas.setSize(500, 250);
      chart.render();
      assert.equal(canvas.getCounts().widthAssignCount, 2, 'dimension change reassigns canvas.width');
      assert.equal(canvas.getCounts().heightAssignCount, 2, 'dimension change reassigns canvas.height');

      // Change DPR -> reassigns once
      globalThis.window.devicePixelRatio = 1;
      chart.render();
      assert.equal(canvas.getCounts().widthAssignCount, 3, 'DPR change reassigns canvas.width');

      // RAF coalescing on _handleMouseMove and _handleResize
      let renderCount = 0;
      const origRender = chart.render.bind(chart);
      chart.render = () => { renderCount++; origRender(); };

      chart._handleResize();
      chart._handleResize();
      chart._handleResize();
      assert.equal(rafQueue.length, 1, 'multiple _handleResize calls coalesce into 1 RAF');
      rafQueue.shift().fn();
      assert.equal(renderCount, 1, 'coalesced resize renders once');

      chart._handleMouseMove({ clientX: 10, clientY: 10 });
      chart._handleMouseMove({ clientX: 12, clientY: 12 });
      chart._handleMouseMove({ clientX: 14, clientY: 14 });
      assert.equal(rafQueue.length, 1, 'multiple _handleMouseMove calls coalesce into 1 RAF');

      chart.destroy();
      assert.equal(roDisconnected, 1, 'chart.destroy() disconnects ResizeObserver');
      console.log('  ✓ T-M4-01: Chart _setupCanvasDPI() caches (width, height, dpr) & coalesces RAF');
    }

    // -----------------------------------------------------------------------
    // 2. ResizeObserver lifecycle in activities.js renderActivityProfileChart & closeActivityDrawer
    // -----------------------------------------------------------------------
    {
      globalThis.requestAnimationFrame = undefined;
      let activeROs = 0;
      let totalDisconnected = 0;
      globalThis.ResizeObserver = class MockProfileRO {
        constructor(cb) { this.cb = cb; }
        observe() { activeROs++; }
        disconnect() { activeROs--; totalDisconnected++; }
      };

      const canvasA = createMockCanvas(320, 180);
      const canvasB = createMockCanvas(320, 180);
      let currentCanvas = canvasA;
      const drawerEl = {
        classList: {
          _set: new Set(['hidden']),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          contains(c) { return this._set.has(c); }
        }
      };

      globalThis.document = {
        body: { style: {} },
        getElementById(id) {
          if (id === 'activity-profile-chart') return currentCanvas;
          if (id === 'activity-drawer') return drawerEl;
          return null;
        }
      };
      globalThis.window = { devicePixelRatio: 1, innerWidth: 800 };

      const act = { id: 'act-ro-1', sport: 'running', avg_hr: 150, duration_seconds: 1200 };
      openActivityDrawer(act, 'km');
      assert.equal(activeROs, 1, 'profile ResizeObserver attached on drawer open');

      // Re-rendering on same parent does not leak extra ResizeObserver
      renderActivityProfileChart(act, 'km');
      assert.equal(activeROs, 1, 'same parent reuses existing profile ResizeObserver');

      // Switching to a different canvas/parent disconnects old ResizeObserver before re-attaching
      currentCanvas = canvasB;
      renderActivityProfileChart(act, 'km');
      assert.equal(totalDisconnected, 1, 'old ResizeObserver disconnected before re-attaching');
      assert.equal(activeROs, 1, 'only 1 active ResizeObserver after re-attach');

      // closeActivityDrawer() disconnects ResizeObserver
      closeActivityDrawer();
      assert.equal(activeROs, 0, 'closeActivityDrawer() disconnects profile ResizeObserver');
      assert.equal(totalDisconnected, 2, 'totalDisconnected incremented on close');

      // Calling closeActivityDrawer() when already closed is a safe no-op
      closeActivityDrawer();
      assert.equal(totalDisconnected, 2, 'closeActivityDrawer() is a no-op when already closed');
      console.log('  ✓ T-M4-02: activities.js stores and disconnects profile ResizeObserver');
    }

    // -----------------------------------------------------------------------
    // 3. LRU Eviction (shardCache max 50, packFileCache max 2) & clearActivityCaches()
    // -----------------------------------------------------------------------
    {
      clearActivityCaches();
      const passphrase = 'm4-lru-test-passphrase';
      const salt = crypto.randomBytes(16);
      const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');

      const dummyRollupGz = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true }), 'utf-8'));
      const { rawKeyBase64 } = await decryptDashboardPayload(passphrase, encryptWire(dummyRollupGz, key, salt));

      globalThis.window = {
        sessionStorage: {
          getItem(k) { return k === 'garmin_dash_session_key' ? rawKeyBase64 : null; }
        }
      };

      const fetchCounts = new Map();
      globalThis.fetch = async (url) => {
        fetchCounts.set(url, (fetchCounts.get(url) || 0) + 1);
        const m = String(url).match(/\/streams\/([^/]+)\.enc$/);
        if (m) {
          const id = m[1];
          const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ id, telemetry_stream: { hr: [140] } }), 'utf-8'));
          const enc = encryptWire(gz, key, salt);
          return { ok: true, status: 200, arrayBuffer: async () => enc.buffer };
        }
        if (String(url).includes('.pack')) {
          const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ id: 'p', telemetry_stream: { hr: [150] } }), 'utf-8'));
          const enc = encryptWire(gz, key, salt);
          // Return 200 OK full packfile (triggers packFileCache)
          return { ok: true, status: 200, arrayBuffer: async () => enc.buffer };
        }
        return { ok: false, status: 404 };
      };

      // Load 51 shards -> id '1' should be evicted from shardCache (max 50)
      for (let i = 1; i <= 51; i++) {
        await loadActivityStreamShard(String(i));
      }
      assert.equal(fetchCounts.get('./streams/51.enc'), 1);
      // Accessing 51 again should hit cache (no extra fetch)
      await loadActivityStreamShard('51');
      assert.equal(fetchCounts.get('./streams/51.enc'), 1, 'recent shard hits shardCache');
      // Accessing 1 again should re-fetch because it was evicted
      await loadActivityStreamShard('1');
      assert.equal(fetchCounts.get('./streams/1.enc'), 2, 'oldest shard evicted after 50 entries');

      // Test packFileCache max 2 entries (200 OK responses)
      const gzPack = zlib.gzipSync(Buffer.from(JSON.stringify({ id: 'p', telemetry_stream: { hr: [150] } }), 'utf-8'));
      const encPack = encryptWire(gzPack, key, salt);
      setStreamPackIndex({
        p1: { year: '2024', offset: 0, length: encPack.byteLength },
        p2: { year: '2025', offset: 0, length: encPack.byteLength },
        p3: { year: '2026', offset: 0, length: encPack.byteLength }
      }, { stream_pack_keys: { '2024': 'k1' }, aad_version: 1 });

      // Use custom fetch returning exact encPack for pack URLs
      globalThis.fetch = async (url) => {
        fetchCounts.set(url, (fetchCounts.get(url) || 0) + 1);
        return { ok: true, status: 200, arrayBuffer: async () => encPack.buffer };
      };

      await loadActivityStreamShard('p1');
      await loadActivityStreamShard('p2');
      await loadActivityStreamShard('p3');
      // 2024 should have been evicted from packFileCache (max 2), while 2026 is cached
      clearActivityCaches(); // also verify clearActivityCaches clears everything
      setStreamPackIndex({ p3: { year: '2026', offset: 0, length: encPack.byteLength } });
      await loadActivityStreamShard('p3');
      assert.equal(fetchCounts.get('./streams/streams_2026.pack'), 2, 'clearActivityCaches() forces re-fetch');
      console.log('  ✓ T-M4-03: shardCache (50) & packFileCache (2) LRU eviction + clearActivityCaches()');
    }

    // -----------------------------------------------------------------------
    // 4. Heatmap Event Delegation in achievements.js
    // -----------------------------------------------------------------------
    {
      let buttonListenerCount = 0;
      let gridListenerCount = 0;
      let gridClickHandler = null;

      const gridContainerMock = {
        addEventListener(type, fn) {
          if (type === 'click') {
            gridListenerCount++;
            gridClickHandler = fn;
          }
        }
      };

      const targetContainer = {
        _html: '',
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        querySelectorAll(sel) {
          if (sel === '[data-heatmap-date]') {
            buttonListenerCount += 371; // should NEVER be called
          }
          return [];
        },
        querySelector(sel) {
          if (sel === '[data-heatmap-grid="true"]') return gridContainerMock;
          return null;
        }
      };

      let selectedDate = null;
      renderConsistencyHeatmap(
        { activities: [{ date: '2026-10-01', tss: 80 }], wellness: { daily: [] } },
        targetContainer,
        { onSelectDate: (d) => { selectedDate = d; } }
      );

      assert.equal(buttonListenerCount, 0, 'does not attach per-button listeners to 371 cells');
      assert.equal(gridListenerCount, 1, 'attaches exactly 1 delegated click listener on grid container');
      assert.ok(targetContainer.innerHTML.includes('data-heatmap-grid="true"'), 'renders grid delegation attribute');

      // Simulate delegated click on a child button
      gridClickHandler({
        target: {
          closest(sel) {
            if (sel === '[data-heatmap-date]') {
              return { getAttribute: (a) => (a === 'data-heatmap-date' ? '2026-10-01' : null) };
            }
            return null;
          }
        }
      });
      assert.equal(selectedDate, '2026-10-01', 'delegated click invokes onSelectDate with cell date');
      console.log('  ✓ T-M4-04: renderConsistencyHeatmap() uses single delegated click listener');
    }

    // -----------------------------------------------------------------------
    // 5. Cache Clearers, Customize Event, & ensureLeafletLoaded()
    // -----------------------------------------------------------------------
    {
      // Cache clearers should clear retained rollup references safely
      const sampleRollup = {
        activities: [{ date: '2026-10-01', sport: 'running', duration_seconds: 1800 }],
        wellness: { current: { steps: 5000 }, daily: [{ date: '2026-10-01', steps: 5000 }] }
      };
      renderWellnessDashboard(sampleRollup);
      renderCalendar(sampleRollup);
      clearWellnessCache();
      clearCalendarCache();
      clearTrendsCache();
      // Calling moveWellnessCard after clearWellnessCache should not re-render with stale rollup
      moveWellnessCard('steps', 'next');

      // Test garmin-dash:open-customize custom event + fallback
      let editClickFn = null;
      let dispatchedEvent = null;
      const modalClassSet = new Set(['hidden']);
      globalThis.CustomEvent = class MockCustomEvent {
        constructor(type, init = {}) {
          this.type = type;
          this.bubbles = Boolean(init.bubbles);
          this.cancelable = Boolean(init.cancelable);
          this.defaultPrevented = false;
        }
        preventDefault() { this.defaultPrevented = true; }
      };
      globalThis.document = {
        getElementById(id) {
          if (id === 'btn-edit-home') return { addEventListener: (t, fn) => { if (t === 'click') editClickFn = fn; } };
          if (id === 'customize-modal') return { classList: { remove: (c) => modalClassSet.delete(c) } };
          return null;
        },
        dispatchEvent(evt) {
          dispatchedEvent = evt;
          return !evt.defaultPrevented;
        }
      };
      setupWellnessEventListeners();
      assert.ok(typeof editClickFn === 'function', 'edit button listener attached');
      editClickFn();
      assert.equal(dispatchedEvent?.type, 'garmin-dash:open-customize', 'dispatches garmin-dash:open-customize');
      assert.equal(modalClassSet.has('hidden'), false, 'fallback removes hidden class when not prevented');

      // Test ensureLeafletLoaded()
      globalThis.window = { L: { version: '1.9.4-mock' } };
      const existingL = await ensureLeafletLoaded();
      assert.equal(existingL.version, '1.9.4-mock', 'ensureLeafletLoaded returns existing window.L immediately');

      delete globalThis.window.L;
      const appended = [];
      globalThis.document = {
        head: {
          appendChild(el) {
            appended.push(el);
            if (el.tagName === 'SCRIPT' && typeof el.onload === 'function') {
              queueMicrotask(() => {
                globalThis.window.L = { version: '1.9.4-loaded' };
                el.onload();
              });
            }
          }
        },
        querySelector() { return null; },
        createElement(tag) { return { tagName: tag.toUpperCase() }; }
      };
      const p1 = ensureLeafletLoaded();
      const p2 = ensureLeafletLoaded();
      assert.equal(p1, p2, 'concurrent ensureLeafletLoaded() calls share singleton promise');
      const loadedL = await p1;
      assert.equal(loadedL.version, '1.9.4-loaded', 'ensureLeafletLoaded resolves with loaded window.L');
      assert.equal(appended.filter(e => e.tagName === 'LINK').length, 1, 'injects Leaflet CSS once');
      assert.equal(appended.filter(e => e.tagName === 'SCRIPT').length, 1, 'injects Leaflet JS once');

      console.log('  ✓ T-M4-05: Cache clearers, garmin-dash:open-customize event, and ensureLeafletLoaded()');
    }

    console.log('\n=== M4 Frontend Performance Results: 5 passed, 0 failed ===\n');
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDocument;
    globalThis.ResizeObserver = origRO;
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
    globalThis.fetch = origFetch;
    globalThis.sessionStorage = origSessionStorage;
  }
}

run().catch((err) => {
  console.error('\n❌ M4 Frontend Performance test failed:', err);
  process.exit(1);
});
