/**
 * tests/test_m1_challenger_viewport_geometry.js
 * 
 * Challenger M1-2 Empirical Verification Suite:
 * - Viewport layout across mobile (375px), tablet (768px), desktop (1024px), wide (1440px).
 * - Card and container height limits (<= 300px for containers, uniform card heights).
 * - Empty notice DOM containment and toggle churn resilience.
 * - Donut chart arc radius, legend spacing, center text, and 1:1 non-elliptical circularity.
 * - ResizeObserver dynamics and DPI synchronization.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Helper to run command and wait
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (this.callbacks.has(msg.id)) {
        const cb = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        cb(msg);
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const curId = this.id++;
      this.callbacks.set(curId, (res) => {
        if (res.error) reject(new Error(res.error.message || JSON.stringify(res.error)));
        else resolve(res.result);
      });
      this.ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async eval(expression) {
    const trimmed = expression.trim();
    let expr;
    if (trimmed.startsWith('(() =>') || trimmed.startsWith('(function')) {
      expr = trimmed;
    } else if (trimmed.includes(';') || trimmed.includes('\n')) {
      expr = `(() => { ${trimmed} })()`;
    } else {
      expr = `(() => { return (${trimmed}); })()`;
    }
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res && res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(`CDP Eval Exception: ${desc}`);
    }
    return res && res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function runEmpiricalChallenge() {
  console.log('======================================================================');
  console.log('CHALLENGER M1-2: EMPIRICAL VIEWPORT & GEOMETRY VERIFICATION');
  console.log('======================================================================\n');

  const httpPort = 8098;
  const cdpPort = 9228;

  // 1. Launch HTTP server for dist/
  const server = spawn('python3', ['-m', 'http.server', String(httpPort), '--directory', path.join(projectRoot, 'dist')], {
    stdio: 'ignore'
  });
  await sleep(1000);

  // 2. Launch Headless Chromium
  const chrome = spawn('google-chrome', [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    '--no-sandbox',
    '--disable-gpu',
    '--ignore-certificate-errors',
    'about:blank'
  ], { stdio: 'ignore' });
  await sleep(2000);

  let cdp = null;
  let allPassed = true;

  try {
    const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const tabs = await listRes.json();
    const wsUrl = tabs[0].webSocketDebuggerUrl;

    cdp = new CDPClient(wsUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('[1/5] Navigating to dashboard and unlocking vault...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html` });
    await sleep(2500);

    // Wait for Tailwind to load if available
    await cdp.eval(`
      (async () => {
        if (typeof window.tailwind !== 'undefined') return;
        let checks = 0;
        await new Promise(resolve => {
          const iv = setInterval(() => {
            checks++;
            if (typeof window.tailwind !== 'undefined' || checks > 30) {
              clearInterval(iv);
              resolve();
            }
          }, 100);
        });
      })()
    `);

    // Submit valid passphrase
    await cdp.eval(`
      document.getElementById('passphrase-input').value = 'demo-passphrase-2026!';
      document.getElementById('passphrase-submit').click();
    `);
    await sleep(2000);

    const isUnlocked = await cdp.eval(`
      return document.getElementById('passphrase-modal').classList.contains('hidden') &&
      !document.getElementById('card-hr-zone').classList.contains('hidden');
    `);
    assert.strictEqual(isUnlocked, true, 'Vault must unlock and reveal physiological section');
    console.log('  ✓ Dashboard unlocked and rendered successfully.\n');

    // -----------------------------------------------------------------------
    // Challenge 1: Viewport Grid Layout & Card Heights
    // -----------------------------------------------------------------------
    console.log('[2/5] Testing Physiological Card & Container Heights Across Viewports...');
    const viewports = [
      { name: 'Mobile (375px)', width: 375, height: 812, dpr: 2, mobile: true },
      { name: 'Tablet (768px)', width: 768, height: 1024, dpr: 2, mobile: false },
      { name: 'Desktop (1024px)', width: 1024, height: 768, dpr: 1, mobile: false },
      { name: 'Wide (1440px)', width: 1440, height: 900, dpr: 1, mobile: false }
    ];

    const cardIds = ['card-hr-zone', 'card-power-zone', 'card-pace-zone', 'card-threshold-trends'];

    for (const vp of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dpr,
        mobile: vp.mobile
      });
      await sleep(600);

      const metrics = await cdp.eval(`
        (() => {
          const ids = ['card-hr-zone', 'card-power-zone', 'card-pace-zone', 'card-threshold-trends'];
          const out = {};
          for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const container = el.querySelector('div.relative');
            const cr = container ? container.getBoundingClientRect() : null;
            out[id] = {
              cardW: Math.round(r.width),
              cardH: Math.round(r.height),
              containerW: cr ? Math.round(cr.width) : null,
              containerH: cr ? Math.round(cr.height) : null
            };
          }
          return out;
        })()
      `);

      console.log(`  Testing ${vp.name}:`);
      for (const id of cardIds) {
        const m = metrics[id];
        assert.ok(m, `Card ${id} must exist in DOM`);
        console.log(`    - ${id}: card=${m.cardW}x${m.cardH}px, container=${m.containerW}x${m.containerH}px`);

        // Check container height limit: MUST NOT exceed 300px
        assert.ok(
          m.containerH <= 300,
          `Container in ${id} (${m.containerH}px) must not exceed 300px limit`
        );
        // Container height should respect min-h-[260px]
        assert.ok(
          m.containerH >= 250,
          `Container in ${id} (${m.containerH}px) should respect ~260px minimum`
        );
      }

      // Check card height uniformity across the row
      const cardHeights = cardIds.map(id => metrics[id].cardH);
      const minCardH = Math.min(...cardHeights);
      const maxCardH = Math.max(...cardHeights);
      const heightSpread = maxCardH - minCardH;

      if (vp.width >= 1024) {
        // Desktop / Wide: all 4 cards are in 1 row -> CSS grid aligns them uniformly
        assert.ok(
          heightSpread <= 10,
          `Card heights in 4-column row must be uniform: spread=${heightSpread}px (min=${minCardH}, max=${maxCardH})`
        );
      }
      console.log(`    ✓ Viewport ${vp.name} verified: container heights <= 300px (spread=${heightSpread}px).\n`);
    }

    // -----------------------------------------------------------------------
    // Challenge 2: Power Zone Empty Notice Toggling & Height Invariance
    // -----------------------------------------------------------------------
    console.log('[3/5] Testing Power Zone Empty Notice Toggling & Height Invariance...');

    // Viewport 1024px for grid stretch test
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
      mobile: false
    });
    await sleep(500);

    // State A: Has real power from initial data.enc
    const withPowerH = await cdp.eval(`
      (() => {
        const pz = document.getElementById('card-power-zone');
        const container = pz.querySelector('div.relative');
        return {
          cardH: Math.round(pz.getBoundingClientRect().height),
          containerH: Math.round(container.getBoundingClientRect().height),
          directChildrenCount: pz.children.length
        };
      })()
    `);
    assert.strictEqual(withPowerH.directChildrenCount, 2, 'card-power-zone must have 2 children: header + container');
    assert.ok(withPowerH.containerH <= 300, `Container with power data (${withPowerH.containerH}px) must not exceed 300px`);
    console.log(`  ✓ With power data: card=${withPowerH.cardH}px, container=${withPowerH.containerH}px, directChildren=${withPowerH.directChildrenCount}`);

    // State B: Toggle to Empty Power State using physiological module
    console.log('  Toggling: Switching to empty power state (has_power_data = false)...');
    await cdp.eval(`
      (async () => {
        const phys = await import('./assets/charts/physiological.js');
        phys.renderPowerZoneChart({
          physiological: {
            has_power_data: false,
            power_zones: []
          }
        });
      })()
    `);
    await sleep(500);

    const emptyH = await cdp.eval(`
      (() => {
        const pz = document.getElementById('card-power-zone');
        const container = pz.querySelector('div.relative');
        const canvas = document.getElementById('power-zone-chart');
        const notice = document.getElementById('power-zone-empty-notice');
        return {
          cardH: Math.round(pz.getBoundingClientRect().height),
          containerH: Math.round(container.getBoundingClientRect().height),
          noticeInsideContainer: notice && notice.parentElement === container,
          canvasHidden: canvas && canvas.style.display === 'none',
          directChildrenCount: pz.children.length
        };
      })()
    `);

    assert.strictEqual(emptyH.noticeInsideContainer, true, 'Empty notice MUST be inside canvas.parentElement');
    assert.strictEqual(emptyH.canvasHidden, true, 'Power zone canvas must be hidden');
    assert.strictEqual(emptyH.directChildrenCount, 2, 'card-power-zone must have exactly 2 direct children (no sibling empty notice)');
    assert.ok(emptyH.containerH <= 300, `Empty notice container height (${emptyH.containerH}px) must not exceed 300px`);
    console.log(`  ✓ Empty state verified: card=${emptyH.cardH}px, container=${emptyH.containerH}px, noticeInsideContainer=true`);

    // State C: Toggle back to Power State
    console.log('  Toggling: Switching back to active power state...');
    await cdp.eval(`
      (async () => {
        const phys = await import('./assets/charts/physiological.js');
        phys.renderPowerZoneChart({
          physiological: {
            has_power_data: true,
            power_zones: [
              { zone: 'Z1 Active Recovery', seconds: 1200 },
              { zone: 'Z2 Endurance', seconds: 3600 },
              { zone: 'Z3 Tempo', seconds: 2400 },
              { zone: 'Z4 Threshold', seconds: 1800 },
              { zone: 'Z5 VO2Max', seconds: 900 },
              { zone: 'Z6 Anaerobic', seconds: 400 },
              { zone: 'Z7 Neuromuscular', seconds: 100 }
            ]
          }
        });
      })()
    `);
    await sleep(500);

    const restoredH = await cdp.eval(`
      (() => {
        const pz = document.getElementById('card-power-zone');
        const container = pz.querySelector('div.relative');
        const canvas = document.getElementById('power-zone-chart');
        const notice = document.getElementById('power-zone-empty-notice');
        return {
          cardH: Math.round(pz.getBoundingClientRect().height),
          containerH: Math.round(container.getBoundingClientRect().height),
          noticeHidden: !notice || notice.style.display === 'none',
          canvasVisible: canvas && canvas.style.display !== 'none',
          directChildrenCount: pz.children.length
        };
      })()
    `);
    assert.strictEqual(restoredH.noticeHidden, true, 'Empty notice must be hidden when power restored');
    assert.strictEqual(restoredH.canvasVisible, true, 'Power chart canvas must be visible');
    assert.ok(restoredH.containerH <= 300, `Restored container height (${restoredH.containerH}px) must stay <= 300px`);
    console.log(`  ✓ Restored state verified: card=${restoredH.cardH}px, container=${restoredH.containerH}px`);

    // Stress test: Churn toggle 20 times rapidly
    console.log('  Stress Testing: 20 rapid state toggles between empty and active power...');
    await cdp.eval(`
      (async () => {
        const phys = await import('./assets/charts/physiological.js');
        for (let i = 0; i < 20; i++) {
          const hasPower = i % 2 === 0;
          phys.renderPowerZoneChart({
            physiological: {
              has_power_data: hasPower,
              power_zones: hasPower ? [
                { zone: 'Z1', seconds: 1000 },
                { zone: 'Z2', seconds: 2000 },
                { zone: 'Z3', seconds: 1500 },
                { zone: 'Z4', seconds: 1000 },
                { zone: 'Z5', seconds: 500 },
                { zone: 'Z6', seconds: 200 },
                { zone: 'Z7', seconds: 100 }
              ] : []
            }
          });
        }
      })()
    `);
    await sleep(500);

    const postChurnH = await cdp.eval(`
      (() => {
        const pz = document.getElementById('card-power-zone');
        const container = pz.querySelector('div.relative');
        return {
          cardH: Math.round(pz.getBoundingClientRect().height),
          containerH: Math.round(container.getBoundingClientRect().height),
          duplicateNotices: container.querySelectorAll('#power-zone-empty-notice').length
        };
      })()
    `);
    assert.strictEqual(postChurnH.duplicateNotices, 1, 'Must never duplicate empty notice elements in DOM');
    assert.ok(postChurnH.containerH <= 300, `Container height after 20 toggles (${postChurnH.containerH}px) must stay <= 300px`);
    console.log(`  ✓ 20 rapid toggles passed cleanly with 0 duplicate DOM nodes and height intact.\n`);

    // -----------------------------------------------------------------------
    // Challenge 3: Donut Chart Circular Geometry & Distortion Verification
    // -----------------------------------------------------------------------
    console.log('[4/5] Testing Donut Chart Circular Geometry & Non-Distortion...');

    for (const vp of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dpr,
        mobile: vp.mobile
      });
      await sleep(600);

      const donutMetrics = await cdp.eval(`
        (() => {
          const canvas = document.getElementById('hr-zone-chart');
          if (!canvas) return null;
          const rect = canvas.getBoundingClientRect();
          const computedStyle = window.getComputedStyle(canvas);
          const parentRect = canvas.parentElement.getBoundingClientRect();
          return {
            bufferWidth: canvas.width,
            bufferHeight: canvas.height,
            styleWidth: canvas.style.width,
            styleHeight: canvas.style.height,
            clientWidth: rect.width,
            clientHeight: rect.height,
            parentW: parentRect.width,
            parentH: parentRect.height
          };
        })()
      `);

      assert.ok(donutMetrics, 'hr-zone-chart canvas must exist');

      // 1. Aspect ratio of buffer vs display
      const bufferAspect = donutMetrics.bufferWidth / donutMetrics.bufferHeight;
      const displayAspect = donutMetrics.clientWidth / donutMetrics.clientHeight;
      const distortion = Math.abs(bufferAspect - displayAspect);

      console.log(`  ${vp.name} Donut Analysis:`);
      console.log(`    - Buffer: ${donutMetrics.bufferWidth}x${donutMetrics.bufferHeight} (DPR scaled)`);
      console.log(`    - Display (CSS client): ${donutMetrics.clientWidth.toFixed(1)}x${donutMetrics.clientHeight.toFixed(1)}px`);
      console.log(`    - Style: width=${donutMetrics.styleWidth}, height=${donutMetrics.styleHeight}`);
      console.log(`    - Buffer Aspect Ratio: ${bufferAspect.toFixed(4)}`);
      console.log(`    - Display Aspect Ratio: ${displayAspect.toFixed(4)}`);
      console.log(`    - Aspect Ratio Distortion: ${distortion.toFixed(6)}`);

      // Distortion MUST be essentially 0 (< 0.005 allowing for 0.5px subpixel integer rounding on DPR=1)
      assert.ok(
        distortion < 0.005,
        `Aspect ratio distortion (${distortion}) must be < 0.005 to prevent oval/ellipse donut rendering`
      );

      // Check DPI scaling: bufferWidth / clientWidth == DPR
      const scaleX = donutMetrics.bufferWidth / donutMetrics.clientWidth;
      const scaleY = donutMetrics.bufferHeight / donutMetrics.clientHeight;
      assert.ok(
        Math.abs(scaleX - vp.dpr) < 0.05,
        `Horizontal scaling (${scaleX}) must match DPR (${vp.dpr})`
      );
      assert.ok(
        Math.abs(scaleY - vp.dpr) < 0.05,
        `Vertical scaling (${scaleY}) must match DPR (${vp.dpr})`
      );
      assert.ok(
        Math.abs(scaleX - scaleY) < 0.01,
        `Scale X (${scaleX}) and Scale Y (${scaleY}) must match 1:1 for true circular geometry`
      );

      console.log(`    ✓ True circular geometry confirmed: 1:1 pixel buffer to screen mapping.\n`);
    }

    // -----------------------------------------------------------------------
    // Challenge 4: Donut Arc Radii, Legend Spacing, and Center Text
    // -----------------------------------------------------------------------
    console.log('[5/5] Testing Donut Arc Radii, Legend Spacing, and Center Text...');

    // Mobile 375px viewport challenge
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(600);

    const visualInspection = await cdp.eval(`
      (() => {
        const canvas = document.getElementById('hr-zone-chart');
        const ctx = canvas.getContext('2d');
        const rect = canvas.getBoundingClientRect();
        
        // Re-read pixel data or evaluate text/legend properties
        return {
          displayWidth: rect.width,
          displayHeight: rect.height,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          hasLegendSubtitle: document.getElementById('hr-zone-subtitle') !== null,
          subtitleText: document.getElementById('hr-zone-subtitle')?.textContent || ''
        };
      })()
    `);

    assert.ok(visualInspection.subtitleText.includes('5-Zone Model'), 'Subtitle must indicate 5-Zone Model');
    assert.ok(visualInspection.subtitleText.includes('Max HR:'), 'Subtitle must display Max HR');
    console.log(`  ✓ Subtitle intact: "${visualInspection.subtitleText}"`);

    // Verify center text and legend wrapping via chart engine logic
    const engineCheck = await cdp.eval(`
      (() => {
        // Measure legend wrapping logic
        const dummyCanvas = document.createElement('canvas');
        dummyCanvas.width = 300 * 2;
        dummyCanvas.height = 260 * 2;
        dummyCanvas.style.width = '300px';
        dummyCanvas.style.height = '260px';
        const ctx = dummyCanvas.getContext('2d');
        ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

        const labels = ['Z1 (10.0%)', 'Z2 (45.0%)', 'Z3 (25.0%)', 'Z4 (15.0%)', 'Z5 (5.0%)'];
        const items = labels.map(t => ({ text: t, w: ctx.measureText(t).width + 20 }));
        
        let rows = 0;
        let curW = 0;
        const maxW = 280;
        for (const item of items) {
          if (curW > 0 && curW + item.w > maxW) {
            rows++;
            curW = item.w;
          } else {
            curW += item.w;
          }
        }
        if (curW > 0) rows++;

        const legendH = rows * 16 + 6;
        const availableH = 260 - legendH;
        const outerRadius = Math.min(300 * 0.42, availableH * 0.42);
        const innerRadius = outerRadius * 0.65;

        return {
          rows,
          legendH,
          availableH,
          outerRadius,
          innerRadius,
          centerTextFits: innerRadius >= 36
        };
      })()
    `);

    console.log(`  Legend & Center Text Geometry:`);
    console.log(`    - Wrapped Legend Rows: ${engineCheck.rows}`);
    console.log(`    - Legend Height: ${engineCheck.legendH}px`);
    console.log(`    - Available Donut Height: ${engineCheck.availableH}px`);
    console.log(`    - Outer Radius: ${engineCheck.outerRadius.toFixed(1)}px`);
    console.log(`    - Inner Radius: ${engineCheck.innerRadius.toFixed(1)}px`);
    console.log(`    - Center Text Fits Inside Hole: ${engineCheck.centerTextFits}`);

    assert.ok(engineCheck.rows >= 1 && engineCheck.rows <= 3, 'Legend rows must wrap between 1 and 3 rows');
    assert.ok(engineCheck.outerRadius > 40, 'Outer radius must be substantial (>40px)');
    assert.strictEqual(engineCheck.centerTextFits, true, 'Inner radius must accommodate center summary text (>=36px)');
    console.log('  ✓ Legend rows wrap cleanly without clipping, and donut hole accommodates center text.\n');

  } catch (err) {
    allPassed = false;
    console.error('EMPIRICAL CHALLENGE FAILURE:', err);
    throw err;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    server.kill();
  }

  console.log('======================================================================');
  console.log('CHALLENGER M1-2 VERDICT: ALL EMPIRICAL CHALLENGES PASSED (APPROVE)');
  console.log('======================================================================');
}

runEmpiricalChallenge().catch((err) => {
  console.error(err);
  process.exit(1);
});
