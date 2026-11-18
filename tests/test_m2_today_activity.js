/**
 * tests/test_m2_today_activity.js
 *
 * Milestone M2 Comprehensive Unit & Integration Test Suite:
 * Today's Activity Hero Card, Mini Route SVG, Async Stream Shard Loader, & XSS Safety
 *
 * Covers:
 *  - M2-UNIT-01: main.js renderDashboard wiring, DOM order, reload bypass, and lock cleanup
 *  - M2-UNIT-02: Today vs Latest fallback, sorting, empty/null/undefined handling
 *  - M2-UNIT-03: Sport icon badge, full telemetry pills (incl. TSS), km/mi formatting & unit toggle
 *  - M2-UNIT-04: Zero/missing telemetry & Indoor/Strength handling (even with avg_hr=0)
 *  - M2-UNIT-05: Mini GPS Route SVG rendering (summary_polyline, gps_track.polyline, gps_track.points) & outlier/Null Island safety
 *  - M2-UNIT-06: loadActivityStreamShard contract, concurrent deduplication, missing key, 404, <44B, tampered ciphertext
 *  - M2-UNIT-07: Async shard hydration in renderTodayActivityBanner + no infinite loop on null/non-GPS shard
 *  - M2-UNIT-08: Drawer interaction (click, Enter, Space, Escape, close button) & sharded splits
 *  - M2-UNIT-09: XSS escaping via escapeHtml across Today banner, activity table, and split rows
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  createHeadlessEnv,
  encryptShardWithRawKey,
  encodePolyline
} = require('./e2e/test_dashboard_runner.js');
const { encryptDashboardPayload } = require('./test_crypto_web.js');

const ROOT_DIR = path.resolve(__dirname, '..');

function localIsoDate(offsetDays = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildSampleRollup(todayIso = localIsoDate(0)) {
  const coords = [
    [47.3769, 8.5417],
    [47.3812, 8.5465],
    [47.3860, 8.5510],
    [47.3905, 8.5472]
  ];
  const poly = encodePolyline(coords);

  return {
    version: '1.0.0',
    generated_at: `${todayIso}T12:00:00Z`,
    athlete: { vo2max: 55, cycling_ftp: 280, ftp: 280, lthr: 168, max_hr: 192, rest_hr: 48 },
    summary: { total_activities: 3, total_distance_km: 53.25, total_moving_hours: 2.98, total_calories: 2225 },
    training_load: {
      weekly: [{ week: '2026-W46', cycling_hours: 1.3, running_hours: 0.9, walking_hours: 0, hiking_hours: 0, strength_hours: 0.75 }],
      daily: [{ date: todayIso, atl: 55, ctl: 52, tsb: -3 }]
    },
    physiological: {
      has_power_data: true,
      ftp: 280,
      heart_rate_zones: [{ zone: 'Z2', seconds: 2400, percentage: 100 }],
      power_zones: [{ zone: 'Z2 Endurance', seconds: 2000, percentage: 100 }],
      pace_zones: [{ zone: 'Aerobic', seconds: 1600 }],
      threshold_trends: [{ date: todayIso, vo2max: 55, cycling_ftp: 280, ftp: 280, lthr: 168 }]
    },
    activities: [
      {
        id: 'run_today_1',
        date: `${todayIso}T07:30:00Z`,
        start_time: `${todayIso}T07:30:00Z`,
        sport: 'running',
        title: 'Morning Tempo Trail Run',
        distance_meters: 11250,
        duration_seconds: 3240,
        moving_time_seconds: 3240,
        avg_pace_sec_km: 288,
        elevation_gain_meters: 245,
        avg_hr: 158,
        max_hr: 179,
        avg_cadence: 172,
        calories: 785,
        tss: 74,
        training_stress_score: 74,
        summary_polyline: poly,
        has_streams: true,
        gps_track: null,
        telemetry_stream: null,
        splits: [
          { split_number: 1, distance_meters: 1000, duration_seconds: 285, avg_hr: 149, elevation_diff: 20, avg_cadence: 170 }
        ]
      },
      {
        id: 'ride_past_1',
        date: '2026-10-20T16:15:00Z',
        start_time: '2026-10-20T16:15:00Z',
        sport: 'cycling',
        title: 'Evening Sweetspot Ride',
        distance_meters: 42000,
        duration_seconds: 4800,
        moving_time_seconds: 4720,
        elevation_gain_meters: 510,
        avg_hr: 151,
        max_hr: 174,
        avg_cadence: 90,
        calories: 1120,
        tss: 92,
        summary_polyline: poly,
        has_streams: false,
        gps_track: null,
        telemetry_stream: null,
        splits: []
      },
      {
        id: 'strength_past_1',
        date: '2026-10-19T18:00:00Z',
        start_time: '2026-10-19T18:00:00Z',
        sport: 'strength',
        title: 'Weights & Core Mobility',
        distance_meters: 0,
        duration_seconds: 2700,
        moving_time_seconds: 2700,
        elevation_gain_meters: 0,
        avg_hr: 121,
        max_hr: 148,
        calories: 320,
        tss: 36,
        has_streams: false,
        gps_track: null,
        telemetry_stream: null,
        splits: []
      }
    ],
    wellness: {
      daily: [{
        date: todayIso,
        steps: 9800,
        steps_goal: 10000,
        resting_hr: 48,
        sleep_seconds: 28200,
        sleep_score: 85,
        stress_level: 24,
        body_battery: 78,
        body_battery_high: 94,
        body_battery_low: 22
      }],
      current: null
    }
  };
}

async function runTests() {
  process.stdout.write('\n=== Running M2 Today\'s Activity Hero Card Unit & Integration Suite ===\n\n');

  // Create initial headless environment BEFORE importing main.js
  createHeadlessEnv();
  const cryptoMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/crypto.js')).href);
  const activitiesMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/charts/activities.js')).href);
  const mainMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/main.js')).href);

  let passed = 0;
  let failed = 0;

  async function test(id, description, fn) {
    try {
      await fn();
      passed++;
      process.stdout.write(`  ✓ ${id}: ${description}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`  ✗ ${id}: ${description}\n    ${err.stack || err.message}\n`);
    }
  }

  // M2-UNIT-01: main.js wiring, DOM order, reload bypass, lock cleanup
  await test('M2-UNIT-01', 'main.js renderDashboard invokes renderTodayActivityBanner on unlock, reload bypass, and clears on lock', async () => {
    const pass = 'm2-unit-pass-2026!';
    const rollup = buildSampleRollup(localIsoDate(0));
    const wire = await encryptDashboardPayload(pass, rollup);

    const env1 = createHeadlessEnv({ dataEnc: wire });
    await mainMod.initApp();
    env1.doc.getElementById('passphrase-input').value = pass;
    env1.doc.getElementById('passphrase-form').dispatchEvent('submit');

    const start = Date.now();
    while (env1.doc.getElementById('dashboard-content').classList.contains('hidden')) {
      if (Date.now() - start > 5000) throw new Error('Timed out waiting for unlock');
      await new Promise(r => setTimeout(r, 25));
    }

    const sec1 = env1.doc.getElementById('today-activity-section');
    assert.strictEqual(sec1.classList.contains('hidden'), false, '#today-activity-section must unhide on unlock');
    assert.ok(sec1.innerHTML.includes('Morning Tempo Trail Run'), 'Banner must display today activity title');
    const mainKids = env1.doc.getElementById('dashboard-main').children.map(c => c.id);
    assert.ok(
      mainKids.indexOf('today-activity-section') < mainKids.indexOf('wellness-dashboard'),
      '#today-activity-section must appear before #wellness-dashboard in #dashboard-main'
    );

    // Reload bypass using cached session key
    const cachedKey = env1.sessionStorage.getItem('garmin_dash_session_key');
    const env2 = createHeadlessEnv({ dataEnc: wire });
    env2.sessionStorage.setItem('garmin_dash_session_key', cachedKey);
    await mainMod.initApp();
    const sec2 = env2.doc.getElementById('today-activity-section');
    assert.strictEqual(sec2.classList.contains('hidden'), false, 'Reload bypass must render Today banner');
    assert.ok(sec2.innerHTML.includes('Morning Tempo Trail Run'));

    // Lock vault clears banner
    env2.doc.getElementById('btn-lock-dashboard').click();
    assert.strictEqual(sec2.classList.contains('hidden'), true, 'Lock vault must hide #today-activity-section');
    assert.strictEqual(sec2.innerHTML, '', 'Lock vault must clear #today-activity-section innerHTML');
  });

  // Also check frontend/index.html static ordering
  await test('M2-UNIT-01b', 'frontend/index.html places #today-activity-section before #wellness-dashboard inside #dashboard-main', async () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'index.html'), 'utf8');
    const mainPos = html.indexOf('id="dashboard-main"');
    const todayPos = html.indexOf('id="today-activity-section"');
    const wellnessPos = html.indexOf('id="wellness-dashboard"');
    assert.ok(mainPos > 0 && todayPos > mainPos && wellnessPos > todayPos);
  });

  // M2-UNIT-02: Today vs Latest fallback & empty inputs
  await test('M2-UNIT-02', 'TODAY emerald badge shows all today acts sorted newest-first; past fallback shows single LATEST ACTIVITY; empty hides banner', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const sec = env.doc.getElementById('today-activity-section');

    // Multiple today activities (unsorted input)
    activitiesMod.renderTodayActivityBanner([
      { id: 't_am', start_time: `${todayIso}T07:00:00Z`, sport: 'running', title: 'Early Morning Run', distance_meters: 6000, duration_seconds: 1800 },
      { id: 't_pm', start_time: `${todayIso}T18:30:00Z`, sport: 'strength', title: 'Evening Strength', distance_meters: 0, duration_seconds: 2400 },
      { id: 'old_1', start_time: '2026-10-01T08:00:00Z', sport: 'cycling', title: 'Old October Ride', distance_meters: 30000, duration_seconds: 3600 }
    ], 'km');

    assert.strictEqual(sec.classList.contains('hidden'), false);
    assert.ok(sec.innerHTML.includes('TODAY'));
    assert.ok(sec.innerHTML.includes('2 TODAY'), 'Header badge must reflect 2 TODAY');
    assert.ok(sec.innerHTML.includes('Evening Strength') && sec.innerHTML.includes('Early Morning Run'));
    assert.ok(!sec.innerHTML.includes('Old October Ride'), 'Must not include past days when today activities exist');
    assert.ok(
      sec.innerHTML.indexOf('Evening Strength') < sec.innerHTML.indexOf('Early Morning Run'),
      'Today activities must be sorted newest-first'
    );

    // Past-only fallback
    activitiesMod.renderTodayActivityBanner([
      { id: 'p_older', start_time: '2026-10-08T08:00:00Z', sport: 'running', title: 'Older Run', distance_meters: 5000, duration_seconds: 1500 },
      { id: 'p_latest', start_time: '2026-10-12T16:15:00Z', sport: 'cycling', title: 'Latest Gravel Ride', distance_meters: 40000, duration_seconds: 4800 }
    ], 'km');
    assert.ok(sec.innerHTML.includes('LATEST ACTIVITY'), 'Past fallback must use LATEST ACTIVITY badge');
    assert.ok(sec.innerHTML.includes('text-purple-300'), 'Past fallback badge must use purple styling');
    assert.ok(sec.innerHTML.includes('Latest Gravel Ride'));
    assert.ok(!sec.innerHTML.includes('Older Run'), 'Past fallback must render only single latest activity');

    // Empty / null / undefined
    for (const emptyInput of [[], null, undefined]) {
      activitiesMod.renderTodayActivityBanner(emptyInput, 'km');
      assert.strictEqual(sec.classList.contains('hidden'), true);
      assert.strictEqual(sec.innerHTML, '');
    }
  });

  // M2-UNIT-03: Sport icon badge & telemetry pills in km/mi + unit toggle
  await test('M2-UNIT-03', 'Sport icon badge, full telemetry pills (incl. TSS), and unit toggle (km <-> mi)', async () => {
    const pass = 'm2-unit-toggle-pass!';
    const todayIso = localIsoDate(0);
    const rollup = buildSampleRollup(todayIso);
    const wire = await encryptDashboardPayload(pass, rollup);

    const env = createHeadlessEnv({ dataEnc: wire });
    await mainMod.initApp();
    env.doc.getElementById('passphrase-input').value = pass;
    env.doc.getElementById('passphrase-form').dispatchEvent('submit');

    const start = Date.now();
    while (env.doc.getElementById('dashboard-content').classList.contains('hidden')) {
      if (Date.now() - start > 5000) throw new Error('Timed out waiting for unlock');
      await new Promise(r => setTimeout(r, 25));
    }

    const sec = env.doc.getElementById('today-activity-section');
    const kmHtml = sec.innerHTML;
    const kmText = sec.textContent;
    assert.ok(kmHtml.includes('<svg') && kmHtml.includes('badge-running'), 'Must render sport icon badge');
    assert.ok(kmText.includes('11.25 km'), `Expected 11.25 km, got ${kmText}`);
    assert.ok(kmText.includes('54:00'), 'Expected 54:00 duration');
    assert.ok(kmText.includes('4:48/km'), `Expected 4:48/km pace, got ${kmText}`);
    assert.ok(kmText.includes('+245 m'), 'Expected +245 m ascent');
    assert.ok(kmText.includes('158 bpm'), 'Expected 158 bpm');
    assert.ok(kmText.includes('785 kcal'), 'Expected 785 kcal');
    assert.ok(kmText.includes('74 TSS'), `Expected 74 TSS pill (not truncated), got ${kmText}`);

    // Toggle to imperial via #unit-toggle-btn
    env.doc.getElementById('unit-toggle-btn').click();
    const miText = sec.textContent;
    assert.ok(miText.includes('6.99 mi'), `Expected 6.99 mi after toggle, got ${miText}`);
    assert.ok(miText.includes('/mi') && miText.includes('ft'), 'Expected imperial pace & elevation');

    // Cycling in imperial -> mph
    activitiesMod.renderTodayActivityBanner([rollup.activities[1]], 'mi');
    const cycText = sec.textContent;
    assert.ok(cycText.includes('mi') && cycText.includes('mph') && cycText.includes('ft'), `Expected cycling mi/mph/ft, got ${cycText}`);
  });

  // M2-UNIT-04: Strength/indoor & zero/missing telemetry
  await test('M2-UNIT-04', 'Strength/indoor omits 0.00 km & polyline, renders indoor badge even with avg_hr=0, and omits zero pills', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const sec = env.doc.getElementById('today-activity-section');

    activitiesMod.renderTodayActivityBanner([{
      id: 'str_zero_hr',
      start_time: `${todayIso}T19:00:00Z`,
      sport: 'weights',
      title: 'Kettlebell Conditioning',
      distance_meters: 0,
      duration_seconds: 1800,
      elevation_gain_meters: 0,
      avg_hr: 0,
      calories: 0,
      tss: 0
    }], 'km');

    const html = sec.innerHTML;
    assert.ok(!html.includes('<polyline'), 'Strength workout must never emit GPS polyline');
    assert.ok(!html.includes('0.00 km'), 'Strength workout must never emit 0.00 km');
    assert.ok(!html.includes('NaN') && !html.includes('undefined'), 'Zero/missing fields must not emit NaN/undefined');
    assert.ok(/Indoor|Weights|Strength|bpm/i.test(html), 'Must render right-side indoor/strength badge even when avg_hr is 0');
    assert.ok(!html.includes('0 TSS') && !html.includes('0 kcal'), 'Zero TSS/calories pills must be omitted');
  });

  // M2-UNIT-05: Mini GPS Route SVG & outlier / Null Island safety
  await test('M2-UNIT-05', 'renderMiniRouteSvg handles summary_polyline, gps_track.polyline, gps_track.points, and rejects Null Island / invalid coords', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const sec = env.doc.getElementById('today-activity-section');
    const poly = encodePolyline([[47.37, 8.54], [47.38, 8.55], [47.39, 8.56]]);

    // 1. summary_polyline with gps_track: null
    activitiesMod.renderTodayActivityBanner([{
      id: 'g1', start_time: `${todayIso}T08:00:00Z`, sport: 'running', title: 'Poly Run',
      distance_meters: 5000, duration_seconds: 1500, summary_polyline: poly, gps_track: null
    }], 'km');
    assert.ok(sec.innerHTML.includes('<polyline') && sec.innerHTML.includes('<circle'));

    // 2. gps_track.polyline fallback
    activitiesMod.renderTodayActivityBanner([{
      id: 'g2', start_time: `${todayIso}T08:00:00Z`, sport: 'running', title: 'Track Poly Run',
      distance_meters: 5000, duration_seconds: 1500, summary_polyline: null, gps_track: { polyline: poly }
    }], 'km');
    assert.ok(sec.innerHTML.includes('<polyline'));

    // 3. gps_track.points fallback with mixed outlier/NaN points
    activitiesMod.renderTodayActivityBanner([{
      id: 'g3', start_time: `${todayIso}T08:00:00Z`, sport: 'hiking', title: 'Points Hike',
      distance_meters: 5000, duration_seconds: 1500, summary_polyline: null,
      gps_track: { points: [[0, 0], [999, 999], [47.37, 8.54, 400], [47.38, 8.55, 420], [NaN, 8.56]] }
    }], 'km');
    assert.ok(sec.innerHTML.includes('<polyline') && !sec.innerHTML.includes('NaN') && !sec.innerHTML.includes('Infinity'));

    // 4. Null Island & 1-point polyline -> no NaN/Infinity, no polyline
    for (const badPoly of [encodePolyline([[0, 0], [0, 0]]), encodePolyline([[47.37, 8.54]]), '']) {
      activitiesMod.renderTodayActivityBanner([{
        id: 'g_bad', start_time: `${todayIso}T08:00:00Z`, sport: 'running', title: 'Bad Poly Run',
        distance_meters: 5000, duration_seconds: 1500, summary_polyline: badPoly
      }], 'km');
      assert.ok(!sec.innerHTML.includes('<polyline'), 'Degenerate polyline must not render <polyline>');
      assert.ok(!sec.innerHTML.includes('NaN') && !sec.innerHTML.includes('Infinity'));
    }
  });

  // M2-UNIT-06: loadActivityStreamShard contract & edge cases
  await test('M2-UNIT-06', 'loadActivityStreamShard decrypts valid shard, deduplicates concurrent calls, and resolves null on missing key/404/<44B/tamper', async () => {
    const pass = 'shard-contract-pass!';
    const wire = await encryptDashboardPayload(pass, { ok: true });
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    const validShard = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'shard_ok',
      gps_track: { points: [[47.1, 8.1, 500], [47.2, 8.2, 520]] },
      telemetry_stream: { time: [0, 60], hr: [140, 155] },
      splits: [{ split_number: 1, distance_meters: 1000, duration_seconds: 290, avg_hr: 148 }]
    }, wire.subarray(0, 16));

    const tamperedShard = new Uint8Array(validShard);
    tamperedShard[32] ^= 0xff;

    const env = createHeadlessEnv({
      shards: new Map([
        ['shard_ok', validShard],
        ['shard_short', new Uint8Array(20)],
        ['shard_tamper', tamperedShard]
      ])
    });

    // Missing session key -> null
    assert.strictEqual(await activitiesMod.loadActivityStreamShard('shard_ok'), null);

    // Valid key + concurrent deduplication
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);
    let fetchCount = 0;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('shard_ok')) fetchCount++;
      return origFetch(url, opts);
    };

    const targetAct = { id: 'shard_ok', gps_track: null, telemetry_stream: null, splits: [] };
    const [resA, resB] = await Promise.all([
      activitiesMod.loadActivityStreamShard('shard_ok', targetAct),
      activitiesMod.loadActivityStreamShard('shard_ok')
    ]);
    global.fetch = origFetch;

    assert.strictEqual(fetchCount, 1, 'Concurrent calls for same shard must share a single fetch');
    assert.ok(resA && resA.gps_track && resB && resB.telemetry_stream);
    assert.ok(targetAct.gps_track && targetAct.splits.length === 1 && targetAct._streamsLoaded === true);

    // 404, <44B, tampered ciphertext, empty id -> resolve null cleanly
    assert.strictEqual(await activitiesMod.loadActivityStreamShard('shard_missing_404'), null);
    assert.strictEqual(await activitiesMod.loadActivityStreamShard('shard_short'), null);
    assert.strictEqual(await activitiesMod.loadActivityStreamShard('shard_tamper'), null);
    assert.strictEqual(await activitiesMod.loadActivityStreamShard(''), null);
  });

  // M2-UNIT-07: Async shard hydration in renderTodayActivityBanner + no infinite loop
  await test('M2-UNIT-07', 'renderTodayActivityBanner hydrates sharded GPS mini-route asynchronously and guards against loops on failed/empty shards', async () => {
    const pass = 'async-hydrate-pass!';
    const wire = await encryptDashboardPayload(pass, { ok: true });
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    const shardWire = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'act_hydrate_1',
      gps_track: { points: [[46.81, 8.22, 500], [46.82, 8.23, 525], [46.83, 8.24, 540]] },
      telemetry_stream: { time: [0, 60, 120], elevation: [500, 525, 540], hr: [135, 145, 152] },
      splits: []
    }, wire.subarray(0, 16));

    const env = createHeadlessEnv({ shards: new Map([['act_hydrate_1', shardWire]]) });
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);

    const todayIso = localIsoDate(0);
    const act = {
      id: 'act_hydrate_1',
      start_time: `${todayIso}T09:00:00Z`,
      sport: 'hiking',
      title: 'Sharded Summit Hike',
      distance_meters: 8400,
      duration_seconds: 4200,
      avg_hr: 144,
      summary_polyline: null,
      has_streams: true,
      gps_track: null,
      telemetry_stream: null
    };

    activitiesMod.renderTodayActivityBanner([act], 'km');
    const sec = env.doc.getElementById('today-activity-section');
    assert.ok(!sec.innerHTML.includes('<polyline'), 'Pre-hydration banner should not have polyline yet');

    await new Promise(r => setTimeout(r, 40));
    assert.ok(sec.innerHTML.includes('<svg') && sec.innerHTML.includes('<polyline'), 'Post-hydration banner must render mini GPS SVG');

    // Failing 404 shard must fetch only once and stop without looping
    let missFetches = 0;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('act_missing_shard')) missFetches++;
      return origFetch(url, opts);
    };
    const missAct = {
      id: 'act_missing_shard',
      start_time: `${todayIso}T10:00:00Z`,
      sport: 'running',
      title: 'Missing Shard Run',
      distance_meters: 5000,
      duration_seconds: 1500,
      avg_hr: 150,
      summary_polyline: null,
      has_streams: true,
      gps_track: null
    };
    activitiesMod.renderTodayActivityBanner([missAct], 'km');
    await new Promise(r => setTimeout(r, 40));
    global.fetch = origFetch;
    assert.strictEqual(missFetches, 1, 'Failed shard fetch must not retry in an infinite loop');
    assert.strictEqual(Boolean(missAct._streamsLoaded), false, 'Failed shard must NOT poison _streamsLoaded');
    assert.strictEqual(missAct._streamsLoading, false, 'Failed shard must clear _streamsLoading');
    assert.strictEqual(missAct._bannerShardKey, rawKeyBase64, 'Banner must record attempted session key to stop looping');
  });

  // M2-UNIT-08: Drawer interaction (click, Enter, Space, Escape, close) & sharded splits
  await test('M2-UNIT-08', 'Today card click, Enter, and Space open #activity-drawer with sharded splits; Escape & close button close it', async () => {
    const pass = 'drawer-shard-pass!';
    const wire = await encryptDashboardPayload(pass, { ok: true });
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    const shardWire = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'act_drawer_shard',
      gps_track: { points: [[47.37, 8.54, 410], [47.38, 8.55, 435]] },
      telemetry_stream: { time: [0, 300], elevation: [410, 435], hr: [145, 160] },
      splits: [{ split_number: 1, distance_meters: 1000, duration_seconds: 275, avg_hr: 152, elevation_diff: 25, avg_cadence: 174 }]
    }, wire.subarray(0, 16));

    const env = createHeadlessEnv({ shards: new Map([['act_drawer_shard', shardWire]]) });
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);
    activitiesMod.setupActivityEventListeners();

    const todayIso = localIsoDate(0);
    const act = {
      id: 'act_drawer_shard',
      start_time: `${todayIso}T07:15:00Z`,
      sport: 'running',
      title: 'Sharded Track Intervals',
      distance_meters: 10000,
      duration_seconds: 2800,
      avg_hr: 160,
      summary_polyline: null,
      has_streams: true,
      gps_track: null,
      telemetry_stream: null,
      splits: []
    };

    activitiesMod.renderTodayActivityBanner([act], 'km');
    const card = env.doc.querySelector('[data-today-act-idx="0"]');
    const drawer = env.doc.getElementById('activity-drawer');

    // Click opens drawer and shard hydrates splits
    card.click();
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(drawer.classList.contains('hidden'), false);
    assert.strictEqual(env.doc.getElementById('drawer-activity-title').textContent, 'Sharded Track Intervals');
    assert.ok(env.doc.getElementById('drawer-splits-tbody').textContent.includes('#1'), 'Drawer must render sharded splits');

    // Close button closes drawer
    env.doc.getElementById('btn-close-drawer').click();
    assert.strictEqual(drawer.classList.contains('hidden'), true);

    // Enter key opens drawer
    card.dispatchEvent({ type: 'keydown', key: 'Enter', target: card, preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(drawer.classList.contains('hidden'), false);
    env.window.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(drawer.classList.contains('hidden'), true, 'Escape key must close drawer');

    // Space key opens drawer
    card.dispatchEvent({ type: 'keydown', key: ' ', target: card, preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(drawer.classList.contains('hidden'), false);
    activitiesMod.closeActivityDrawer();
    assert.strictEqual(drawer.classList.contains('hidden'), true);
  });

  // M2-UNIT-09: XSS escaping verification
  await test('M2-UNIT-09', 'escapeHtml neutralizes HTML injection in Today banner, activity table, and split rows', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const xssTitle = '<img src=x onerror="alert(1)"> & <script>evil()</script>';

    assert.strictEqual(
      activitiesMod.escapeHtml(xssTitle),
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;evil()&lt;/script&gt;'
    );

    const xssAct = {
      id: 'xss_1',
      start_time: `${todayIso}T08:00:00Z`,
      sport: 'running',
      title: xssTitle,
      distance_meters: 5000,
      duration_seconds: 1500,
      avg_hr: 150,
      splits: [{ split_number: '<script>1</script>', distance_meters: 1000, duration_seconds: 300, avg_hr: 150 }]
    };

    activitiesMod.renderTodayActivityBanner([xssAct], 'km');
    const bannerHtml = env.doc.getElementById('today-activity-section').innerHTML;
    assert.ok(!bannerHtml.includes('<script>'), 'Today banner must escape <script>');
    assert.ok(!bannerHtml.includes('<img '), 'Today banner must escape <img>');
    assert.ok(bannerHtml.includes('&lt;script&gt;evil()&lt;/script&gt;'));

    activitiesMod.renderActivityTable([xssAct], 'km');
    const tableHtml = env.doc.getElementById('activities-table-body').innerHTML;
    assert.ok(!tableHtml.includes('<script>') && !tableHtml.includes('<img '), 'Activity table must escape injected HTML');

    activitiesMod.openActivityDrawer(xssAct, 'km');
    const splitsHtml = env.doc.getElementById('drawer-splits-tbody').innerHTML;
    assert.ok(!splitsHtml.includes('<script>'), 'Drawer splits table must escape injected HTML');
    activitiesMod.closeActivityDrawer();
  });

  // M2-UNIT-10: Missing rawKey / missing fetch does NOT trigger infinite microtask loop
  await test('M2-UNIT-10', 'Missing rawKey or missing fetch with has_streams:true does NOT loop and renders HR fallback', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const sec = env.doc.getElementById('today-activity-section');

    let getElCalls = 0;
    const origGetEl = env.doc.getElementById.bind(env.doc);
    env.doc.getElementById = (id) => {
      if (id === 'today-activity-section') getElCalls++;
      return origGetEl(id);
    };

    let sessionReads = 0;
    const origGetItem = env.sessionStorage.getItem.bind(env.sessionStorage);
    env.sessionStorage.getItem = (k) => {
      sessionReads++;
      return origGetItem(k);
    };

    const actNoKey = {
      id: 'act_no_key',
      start_time: `${todayIso}T11:00:00Z`,
      sport: 'running',
      title: 'No Key Stream Run',
      distance_meters: 7000,
      duration_seconds: 2100,
      avg_hr: 152,
      max_hr: 170,
      has_streams: true,
      summary_polyline: null,
      gps_track: null
    };

    // Case A: No stored session key
    activitiesMod.renderTodayActivityBanner([actNoKey], 'km');
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(getElCalls, 1, `Expected exactly 1 banner render without key, got ${getElCalls}`);
    assert.ok(sessionReads <= 2, `Expected bounded sessionStorage reads, got ${sessionReads}`);
    assert.ok(sec.innerHTML.includes('152 bpm') && !sec.innerHTML.includes('Loading'), 'Must render HR fallback instead of Loading');

    // Case B: Stored key present, but global.fetch is undefined
    const pass = 'no-fetch-pass!';
    const wire = await encryptDashboardPayload(pass, { ok: true });
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);

    const origFetch = global.fetch;
    global.fetch = undefined;
    try {
      getElCalls = 0;
      activitiesMod.renderTodayActivityBanner([actNoKey], 'km');
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(getElCalls, 1, `Expected exactly 1 banner render when fetch is missing, got ${getElCalls}`);
    } finally {
      global.fetch = origFetch;
    }
  });

  // M2-UNIT-11: openActivityDrawer retries shard fetch after an earlier transient 404 failure
  await test('M2-UNIT-11', 'openActivityDrawer retries shard fetch after an earlier transient 404 -> 200 recovery', async () => {
    const pass = 'retry-shard-pass!';
    const wire = await encryptDashboardPayload(pass, { ok: true });
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    const shardWire = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'act_retry_1',
      gps_track: { points: [[47.37, 8.54, 410], [47.38, 8.55, 435]] },
      telemetry_stream: { time: [0, 300], elevation: [410, 435], hr: [142, 158] },
      splits: [{ split_number: 1, distance_meters: 1000, duration_seconds: 280, avg_hr: 150 }]
    }, wire.subarray(0, 16));

    const env = createHeadlessEnv();
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);

    const todayIso = localIsoDate(0);
    const act = {
      id: 'act_retry_1',
      start_time: `${todayIso}T08:30:00Z`,
      sport: 'running',
      title: 'Transient Recovery Run',
      distance_meters: 5000,
      duration_seconds: 1500,
      avg_hr: 150,
      has_streams: true,
      summary_polyline: null,
      gps_track: null,
      telemetry_stream: null,
      splits: []
    };

    let attempt = 0;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('act_retry_1')) {
        attempt++;
        if (attempt === 1) {
          return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return { ok: true, status: 200, arrayBuffer: async () => shardWire.buffer.slice(shardWire.byteOffset, shardWire.byteOffset + shardWire.byteLength) };
      }
      return origFetch(url, opts);
    };

    try {
      // First attempt via banner fails with 404
      activitiesMod.renderTodayActivityBanner([act], 'km');
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(attempt, 1);
      assert.strictEqual(Boolean(act._streamsLoaded), false);
      assert.strictEqual(act._streamsLoading, false);

      // Second attempt via openActivityDrawer succeeds with 200
      activitiesMod.openActivityDrawer(act, 'km');
      await new Promise(r => setTimeout(r, 40));
      assert.strictEqual(attempt, 2, 'openActivityDrawer must retry transient shard failure');
      assert.strictEqual(act._streamsLoaded, true);
      assert.ok(env.doc.getElementById('drawer-splits-tbody').textContent.includes('#1'), 'Retried shard must hydrate drawer splits');
      activitiesMod.closeActivityDrawer();
    } finally {
      global.fetch = origFetch;
    }
  });

  // M2-UNIT-12: Invalid date strings never outrank valid ISO dates in Latest fallback
  await test('M2-UNIT-12', 'Invalid date strings (unknown-date) never outrank valid ISO dates in Latest fallback', async () => {
    const env = createHeadlessEnv();
    const sec = env.doc.getElementById('today-activity-section');

    activitiesMod.renderTodayActivityBanner([
      { id: 'bad_date_1', start_time: 'unknown-date', sport: 'running', title: 'Unknown Date Run', distance_meters: 5000, duration_seconds: 1500 },
      { id: 'good_date_1', start_time: '2026-10-12T16:15:00Z', sport: 'cycling', title: 'Valid October Ride', distance_meters: 30000, duration_seconds: 3600 },
      { id: 'bad_date_2', date: 'zzz-invalid', sport: 'hiking', title: 'ZZZ Invalid Hike', distance_meters: 4000, duration_seconds: 1800 }
    ], 'km');

    assert.ok(sec.innerHTML.includes('Valid October Ride'), 'Valid ISO date must outrank unparseable date strings');
    assert.ok(!sec.innerHTML.includes('Unknown Date Run') && !sec.innerHTML.includes('ZZZ Invalid Hike'));
  });

  // M2-UNIT-13: Null / undefined / empty object entries in activities do not throw
  await test('M2-UNIT-13', 'renderTodayActivityBanner and renderActivityTable safely handle null, undefined, and empty object entries', async () => {
    const env = createHeadlessEnv();
    const sec = env.doc.getElementById('today-activity-section');
    const tbody = env.doc.getElementById('activities-table-body');

    assert.doesNotThrow(() => {
      activitiesMod.renderTodayActivityBanner([null, undefined, {}], 'km');
    });
    assert.strictEqual(sec.classList.contains('hidden'), false);
    assert.ok(sec.innerHTML.includes('Other Session'));

    assert.doesNotThrow(() => {
      activitiesMod.renderTodayActivityBanner([null, undefined, 'bad', 123], 'km');
    });
    assert.strictEqual(sec.classList.contains('hidden'), true);
    assert.strictEqual(sec.innerHTML, '');

    assert.doesNotThrow(() => {
      activitiesMod.renderActivityTable([null, undefined, {}], 'km');
    });
    assert.ok(tbody.innerHTML.includes('Workout'));
  });

  // M2-UNIT-14: Malformed non-polyline ASCII chars rejected in renderMiniRouteSvg
  await test('M2-UNIT-14', 'Malformed non-polyline ASCII characters (!@#$%^&*()) produce empty route SVG without <polyline>', async () => {
    const env = createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const sec = env.doc.getElementById('today-activity-section');

    activitiesMod.renderTodayActivityBanner([{
      id: 'bad_ascii_poly',
      start_time: `${todayIso}T08:00:00Z`,
      sport: 'running',
      title: 'Corrupt Polyline Run',
      distance_meters: 5000,
      duration_seconds: 1500,
      avg_hr: 145,
      summary_polyline: '!@#$%^&*()'
    }], 'km');

    const html = sec.innerHTML;
    assert.ok(!html.includes('<polyline'), 'Malformed non-polyline ASCII string must not render <polyline>');
    assert.ok(!html.includes('NaN') && !html.includes('Infinity'));
    assert.ok(html.includes('145 bpm'), 'Should fall back cleanly to HR badge');
  });

  process.stdout.write(`\n=== M2 Test Results: ${passed} passed, ${failed} failed (Total: ${passed + failed}) ===\n\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  process.stderr.write(`Fatal error: ${err.stack || err}\n`);
  process.exit(1);
});
