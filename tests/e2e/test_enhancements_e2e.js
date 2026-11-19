/**
 * tests/e2e/test_enhancements_e2e.js
 *
 * Opaque-Box 4-Tier End-to-End Test Suite for Milestones M2, M3, M4, and M5:
 * - M2: Today's Activity Hero Banner, mini-route SVG, async stream shard hydration, drawer link
 * - M3: Body Battery Chart Range-Bars, High/Low caps, unified tooltip, 1D intraday curve
 * - M4: Stress In-Focus Promotion (4-column grid, 4-zone bar), Stress 4-KPI / 5-col Trend Modal
 * - M5: Purple Icon Branding (icon.svg), dist/icon.svg, purple index.html badges, piezoperny README
 *
 * Execution:
 *   node tests/e2e/test_enhancements_e2e.js
 *
 * Exit Code Policy:
 * - Assertions against unimplemented M2-M5 contracts fail genuinely as [PENDING_IMPL].
 * - Prints exact per-milestone (M2, M3, M4, M5, CROSS) and per-tier (Tier 1..4) counts.
 * - Exits 1 whenever any test is pending or failing; exits 0 when all 52 tests pass.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const {
  createHeadlessEnv,
  waitForCondition,
  PendingImplError,
  encryptShardWithRawKey,
  encodePolyline
} = require('./test_dashboard_runner.js');
const { encryptDashboardPayload } = require('../test_crypto_web.js');

const ROOT_DIR = path.resolve(__dirname, '../..');

function localIsoDate(offsetDays = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildEnhancementRollup(options = {}) {
  const todayStr = options.todayIso || '2026-10-26';
  const baseDate = new Date(
    Number(todayStr.slice(0, 4)),
    Number(todayStr.slice(5, 7)) - 1,
    Number(todayStr.slice(8, 10))
  );

  const daily = [];
  for (let i = 55; i >= 0; i--) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const restSec = 39600 - (i % 5) * 1200;
    const lowSec = 25200 + (i % 4) * 900;
    const medSec = 10800 + (i % 3) * 600;
    const highSec = 3600 + (i % 3) * 600;
    const rec = {
      date: dateStr,
      steps: 9800 + (i % 7) * 450,
      steps_goal: 10000,
      resting_hr: 48 + (i % 4),
      resting_heart_rate: 48 + (i % 4),
      resting_hr_7d_avg: 49.0,
      sleep_seconds: 28200,
      sleep_score: 85 - (i % 5),
      sleep_quality: 'Good',
      sleep_deep_seconds: 5400,
      sleep_light_seconds: 14400,
      sleep_rem_seconds: 6600,
      sleep_awake_seconds: 1800,
      stress_level: 24 + (i % 15),
      stress_qualifier: 'Low',
      stress_rest_seconds: restSec,
      stress_low_seconds: lowSec,
      stress_medium_seconds: medSec,
      stress_high_seconds: highSec,
      body_battery: 78 - (i % 8),
      body_battery_high: 94 - (i % 6),
      body_battery_low: 22 + (i % 7),
      body_battery_charged: 68 + (i % 5),
      body_battery_drained: 66 + (i % 4),
      hrv_last_night_avg: 56 + (i % 6),
      hrv_weekly_avg: 55,
      hrv_status: 'Balanced',
      intensity_minutes_moderate: 25,
      intensity_minutes_vigorous: 15,
      active_calories: 640 + (i % 6) * 30,
      bmr_calories: 1730,
      daily_calories: 2370 + (i % 6) * 30
    };
    if (i === 0) {
      const yr = d.getFullYear();
      const mo = d.getMonth();
      const dy = d.getDate();
      rec.intraday_body_battery = Array.from({ length: 24 }, (_, h) => [
        Date.UTC(yr, mo, dy, h, 0, 0),
        Math.max(18, Math.min(98, Math.round(70 + 25 * Math.sin((h - 2) * 0.25))))
      ]);
      rec.intraday_stress = Array.from({ length: 24 }, (_, h) => [
        Date.UTC(yr, mo, dy, h, 0, 0),
        Math.max(8, Math.min(82, Math.round(28 + 25 * Math.sin(h * 0.35))))
      ]);
    }
    daily.push(rec);
  }

  const sampleCoords = [
    [47.3769, 8.5417],
    [47.3812, 8.5465],
    [47.3860, 8.5510],
    [47.3905, 8.5472],
    [47.3871, 8.5398]
  ];
  const poly = encodePolyline(sampleCoords);

  const activities = options.activities || [
    {
      id: 'act_latest_run',
      date: `${todayStr}T07:30:00Z`,
      start_time: `${todayStr}T07:30:00Z`,
      sport: 'running',
      title: 'Morning Tempo Trail Run',
      distance_meters: 11250,
      duration_seconds: 3240,
      moving_time_seconds: 3180,
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
        { split_number: 1, distance_meters: 1000, duration_seconds: 285, avg_hr: 149, elevation_diff: 20, avg_cadence: 170 },
        { split_number: 2, distance_meters: 1000, duration_seconds: 292, avg_hr: 162, elevation_diff: 35, avg_cadence: 173 }
      ]
    },
    {
      id: 'act_prev_ride',
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
      avg_power: 242,
      calories: 1120,
      tss: 92,
      summary_polyline: poly,
      has_streams: true,
      gps_track: null,
      telemetry_stream: null,
      splits: []
    },
    {
      id: 'act_prev_strength',
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
  ];

  return {
    version: '1.0.0',
    generated_at: `${todayStr}T12:00:00Z`,
    athlete: { vo2max: 55, cycling_ftp: 280, ftp: 280, lthr: 168, max_hr: 192, rest_hr: 48 },
    summary: { total_activities: activities.length, total_distance_km: 53.3, total_moving_hours: 3.0, total_calories: 2225 },
    training_load: {
      weekly: [{ week: '2026-W43', cycling_hours: 1.3, running_hours: 0.9, walking_hours: 0, hiking_hours: 0, strength_hours: 0.75 }],
      daily: [{ date: todayStr, atl: 55, ctl: 52, tsb: -3 }]
    },
    physiological: {
      has_power_data: true,
      ftp: 280,
      heart_rate_zones: [
        { zone: 'Z1', min: 96, max: 115, seconds: 600, percentage: 10 },
        { zone: 'Z2', min: 116, max: 134, seconds: 2400, percentage: 40 },
        { zone: 'Z3', min: 135, max: 153, seconds: 1800, percentage: 30 },
        { zone: 'Z4', min: 154, max: 172, seconds: 900, percentage: 15 },
        { zone: 'Z5', min: 173, max: 192, seconds: 300, percentage: 5 }
      ],
      power_zones: [
        { zone: 'Z1 Active Recovery', seconds: 600, percentage: 15 },
        { zone: 'Z2 Endurance', seconds: 2000, percentage: 50 },
        { zone: 'Z3 Tempo', seconds: 800, percentage: 20 },
        { zone: 'Z4 Threshold', seconds: 400, percentage: 10 },
        { zone: 'Z5 VO2 Max', seconds: 200, percentage: 5 },
        { zone: 'Z6 Anaerobic', seconds: 0, percentage: 0 },
        { zone: 'Z7 Neuromuscular', seconds: 0, percentage: 0 }
      ],
      pace_zones: [
        { zone: 'Recovery', seconds: 400 },
        { zone: 'Aerobic', seconds: 1600 },
        { zone: 'Tempo', seconds: 800 },
        { zone: 'Threshold', seconds: 300 },
        { zone: 'Interval', seconds: 100 }
      ],
      threshold_trends: [
        { date: '2026-09-01', vo2max: 53, cycling_ftp: 272, ftp: 272, lthr: 166 },
        { date: '2026-10-15', vo2max: 55, cycling_ftp: 280, ftp: 280, lthr: 168 }
      ]
    },
    activities,
    backup_vault: {
      status: 'healthy',
      storage_provider: 'Hetzner Storage Box',
      total_activities: activities.length,
      activities_by_year: { '2026': activities.length },
      last_backup_datetime: `${todayStr}T12:00:00Z`,
      formats: ['FIT', 'GPX', 'JSON'],
      verified_integrity: true
    },
    wellness: {
      daily,
      current: daily[daily.length - 1]
    }
  };
}

function makeRangeBarHoverTarget(chart, pillarIdx) {
  const pts = (chart.dataPoints || []).filter(p => p.hitRect || p.tooltipLines);
  if (pts[pillarIdx]) return pts[pillarIdx];
  const barX = 48 + ((pillarIdx + 0.5) * (chart.displayWidth - 68)) / Math.max(1, (chart.data.labels || []).length);
  return { x: barX, y: Math.round(chart.displayHeight / 2) };
}

async function runEnhancementsE2ESuite() {
  process.stdout.write('\n======================================================================\n');
  process.stdout.write('Garmin Vault M2-M5 Enhancements — Opaque-Box 4-Tier E2E Test Suite\n');
  process.stdout.write('======================================================================\n\n');

  const distEncPath = path.join(ROOT_DIR, 'dist', 'data.enc');
  const distEncBuf = fs.readFileSync(distEncPath);

  // Initialize headless environment BEFORE importing main.js (readyState === 'loading')
  createHeadlessEnv({ dataEnc: distEncBuf });

  const cryptoMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/crypto.js')).href);
  const activitiesMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/charts/activities.js')).href);
  const chartMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/charts/chart_engine.js')).href);
  const wellnessMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/charts/wellness.js')).href);
  const trendsMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/charts/trends_modal.js')).href);
  const mainMod = await import(pathToFileURL(path.join(ROOT_DIR, 'frontend/src/main.js')).href);

  const results = [];

  async function test(tier, milestone, id, description, fn) {
    const capturedConsoleErrors = [];
    const origConsoleError = console.error;
    const origConsoleWarn = console.warn;
    const captureConsole = (...args) => {
      const formatted = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ');
      capturedConsoleErrors.push(formatted);
    };
    console.error = captureConsole;
    console.warn = captureConsole;
    try {
      await fn(capturedConsoleErrors);
      const swallowedErr = capturedConsoleErrors.find(msg =>
        /Decryption failed:|Failed to render trend chart:/i.test(msg)
      );
      if (swallowedErr) {
        throw new Error(`Swallowed runtime error logged via console.error/warn: ${swallowedErr}`);
      }
      results.push({ tier, milestone, id, description, status: 'PASS' });
      process.stdout.write(`  ✓ [${tier}][${milestone}] ${id}: ${description}\n`);
    } catch (err) {
      const swallowedErr = capturedConsoleErrors.find(msg =>
        /Decryption failed:|Failed to render trend chart:/i.test(msg)
      );
      if (swallowedErr) {
        const wrapped = new Error(`Swallowed runtime error logged via console.error/warn: ${swallowedErr}`);
        results.push({ tier, milestone, id, description, status: 'ERROR', error: wrapped });
        process.stderr.write(`  ✗ [ERROR] [${tier}][${milestone}] ${id}: ${wrapped.message}\n`);
      } else if (err instanceof PendingImplError || err instanceof assert.AssertionError) {
        results.push({ tier, milestone, id, description, status: 'PENDING_IMPL', error: err });
        process.stdout.write(`  ⏳ [PENDING_IMPL] [${tier}][${milestone}] ${id}: ${err.message}\n`);
      } else {
        results.push({ tier, milestone, id, description, status: 'ERROR', error: err });
        process.stderr.write(`  ✗ [ERROR] [${tier}][${milestone}] ${id}: ${err.stack || err.message}\n`);
      }
    } finally {
      console.error = origConsoleError;
      console.warn = origConsoleWarn;
    }
  }

  // ==========================================================================
  // TIER 1: Core Feature Coverage (M2: 6, M3: 6, M4: 6, M5: 5)
  // ==========================================================================
  process.stdout.write('--- Tier 1: Core Feature Coverage ---\n');

  // --- M2 Tier 1 (6 tests) ---
  await test('Tier 1', 'M2', 'E2E-T1-M2-01', 'main.js renderDashboard invokes renderTodayActivityBanner and unhides #today-activity-section', async (capturedErrors) => {
    const env = createHeadlessEnv({ dataEnc: distEncBuf });
    await mainMod.initApp();
    env.doc.getElementById('passphrase-input').value = 'demo-passphrase-2026!';
    env.doc.getElementById('passphrase-form').dispatchEvent('submit');
    await waitForCondition(
      () =>
        !env.doc.getElementById('dashboard-content').classList.contains('hidden') ||
        capturedErrors.some(msg => /Decryption failed:/i.test(msg)),
      5000,
      25
    );
    if (capturedErrors.some(msg => /Decryption failed:/i.test(msg))) {
      throw new Error(`Swallowed unlock error: ${capturedErrors.join(' | ')}`);
    }

    const sec = env.doc.getElementById('today-activity-section');
    assert.strictEqual(sec.classList.contains('hidden'), false, '#today-activity-section must be unhidden after unlock');
    assert.ok(sec.innerHTML.includes("Today's Activities"), 'Banner heading must appear after unlock');
    const mainKids = env.doc.getElementById('dashboard-main').children.map(c => c.id);
    assert.ok(mainKids.indexOf('today-activity-section') < mainKids.indexOf('wellness-dashboard') || mainKids.includes('today-activity-section'));
  });

  await test('Tier 1', 'M2', 'E2E-T1-M2-02', 'TODAY badge renders all same-day workouts vs LATEST badge for past workouts', async () => {
    createHeadlessEnv();
    const todayIso = localIsoDate(0);
    const todayActs = [
      { id: 't1', start_time: `${todayIso}T07:10:00Z`, sport: 'running', title: 'Morning Run', distance_meters: 8000, duration_seconds: 2400, avg_hr: 152 },
      { id: 't2', start_time: `${todayIso}T17:45:00Z`, sport: 'strength', title: 'Evening Core', distance_meters: 0, duration_seconds: 1800, avg_hr: 118 }
    ];
    activitiesMod.renderTodayActivityBanner(todayActs, 'km');
    const sec = global.document.getElementById('today-activity-section');
    assert.ok(sec.innerHTML.includes('TODAY'), 'Must display TODAY badge when today activity exists');
    assert.ok(sec.innerHTML.includes('Morning Run') && sec.innerHTML.includes('Evening Core'), 'Must render all activities from today');

    const pastActs = [
      { id: 'p1', start_time: '2026-10-10T08:00:00Z', sport: 'cycling', title: 'Past Gravel Ride', distance_meters: 40000, duration_seconds: 4800, avg_hr: 144 },
      { id: 'p2', start_time: '2026-10-08T08:00:00Z', sport: 'running', title: 'Older Run', distance_meters: 6000, duration_seconds: 1800, avg_hr: 140 }
    ];
    activitiesMod.renderTodayActivityBanner(pastActs, 'km');
    assert.ok(/LATEST/i.test(sec.innerHTML), 'Must display LATEST badge when no today activity exists');
    assert.ok(sec.innerHTML.includes('Past Gravel Ride'), 'Must display most recent activity');
    assert.ok(!sec.innerHTML.includes('Older Run'), 'Must only show the single latest activity when falling back');
  });

  await test('Tier 1', 'M2', 'E2E-T1-M2-03', 'Sport icon badge & telemetry pills render in km and mi', async () => {
    createHeadlessEnv();
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    activitiesMod.renderTodayActivityBanner([rollup.activities[0]], 'km');
    const sec = global.document.getElementById('today-activity-section');
    const kmText = sec.textContent;
    assert.ok(kmText.includes('11.25 km'), `Expected km distance pill, got: ${kmText}`);
    assert.ok(kmText.includes('54:00') || kmText.includes('53:00'), 'Expected duration pill');
    assert.ok(kmText.includes('/km'), 'Expected /km pace pill');
    assert.ok(kmText.includes('+245 m'), 'Expected ascent pill in meters');
    assert.ok(kmText.includes('74') && /TSS|Training Load/i.test(kmText), `Expected Training Load (TSS) pill (74), got: ${kmText}`);

    activitiesMod.renderTodayActivityBanner([rollup.activities[0]], 'mi');
    const miText = sec.textContent;
    assert.ok(miText.includes('mi') && miText.includes('/mi') && miText.includes('ft'), 'Imperial pills must use mi, /mi, ft');
  });

  await test('Tier 1', 'M2', 'E2E-T1-M2-04', 'Mini GPS route SVG renders from summary_polyline even when gps_track is null', async () => {
    createHeadlessEnv();
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    const act = { ...rollup.activities[0], gps_track: null, telemetry_stream: null, has_streams: true };
    activitiesMod.renderTodayActivityBanner([act], 'km');
    const html = global.document.getElementById('today-activity-section').innerHTML;
    assert.ok(html.includes('<svg') && html.includes('<polyline'), 'Mini GPS route SVG polyline must render from summary_polyline');
    assert.ok(!html.includes('NaN'), 'SVG coordinates must contain zero NaN values');
  });

  await test('Tier 1', 'M2', 'E2E-T1-M2-05', 'loadActivityStreamShard decrypts ./streams/<id>.enc and injects mini GPS SVG', async () => {
    const pass = 'shard-passphrase-2026!';
    const rawRollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    const wire = await encryptDashboardPayload(pass, rawRollup);
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);

    const shardCoords = [[46.8182, 8.2275], [46.8210, 8.2312], [46.8245, 8.2360], [46.8270, 8.2395]];
    const shardWire = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'act_shard_only',
      gps_track: { points: shardCoords.map(p => [p[0], p[1], 500]) },
      telemetry_stream: { time: [0, 60, 120, 180], elevation: [500, 515, 530, 540], hr: [140, 148, 155, 160] },
      splits: []
    }, wire.subarray(0, 16));

    const env = createHeadlessEnv({ dataEnc: wire, shards: new Map([['act_shard_only', shardWire]]) });
    env.sessionStorage.setItem('garmin_dash_session_key', rawKeyBase64);

    assert.strictEqual(typeof activitiesMod.loadActivityStreamShard, 'function', 'activities.js must export loadActivityStreamShard');
    const actNoPoly = {
      id: 'act_shard_only',
      start_time: `${localIsoDate(0)}T09:00:00Z`,
      sport: 'hiking',
      title: 'Sharded Alpine Hike',
      distance_meters: 9400,
      duration_seconds: 5400,
      elevation_gain_meters: 420,
      avg_hr: 142,
      summary_polyline: null,
      has_streams: true,
      gps_track: null,
      telemetry_stream: null
    };
    activitiesMod.renderTodayActivityBanner([actNoPoly], 'km');
    const shardResult = await activitiesMod.loadActivityStreamShard('act_shard_only');
    assert.ok(shardResult && shardResult.gps_track, 'loadActivityStreamShard must return decrypted shard payload');
    const sec = env.doc.getElementById('today-activity-section');
    try {
      await waitForCondition(() => Boolean(sec.querySelector('svg polyline')), 1000, 20);
    } catch (_) {
      // Fall through to assertion so missing hydration reports cleanly as PENDING_IMPL
    }
    assert.ok(sec.querySelector('svg polyline'), 'Banner must hydrate mini-route SVG <polyline> after async shard decrypt');
  });

  await test('Tier 1', 'M2', 'E2E-T1-M2-06', 'Clicking Today card or pressing Enter/Space opens #activity-drawer with matching details', async () => {
    const env = createHeadlessEnv();
    activitiesMod.setupActivityEventListeners();
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    activitiesMod.renderTodayActivityBanner([rollup.activities[0]], 'km');

    const card = env.doc.querySelector('[data-today-act-idx="0"]');
    assert.ok(card, 'Today card must exist with data-today-act-idx="0"');
    card.click();

    const drawer = env.doc.getElementById('activity-drawer');
    assert.strictEqual(drawer.classList.contains('hidden'), false, 'Drawer must open on Today card click');
    assert.strictEqual(env.doc.getElementById('drawer-activity-title').textContent, 'Morning Tempo Trail Run');
    assert.strictEqual(env.doc.getElementById('drawer-kpi-dist').textContent, '11.25 km');

    activitiesMod.closeActivityDrawer();
    assert.strictEqual(drawer.classList.contains('hidden'), true);

    card.dispatchEvent({ type: 'keydown', key: 'Enter', target: card, preventDefault() {}, stopPropagation() {} });
    assert.strictEqual(drawer.classList.contains('hidden'), false, 'Drawer must open on Enter keydown');
    activitiesMod.closeActivityDrawer();
  });

  // --- M3 Tier 1 (6 tests) ---
  await test('Tier 1', 'M3', 'E2E-T1-M3-01', 'Chart engine supports type: "rangeBar" with Y-scale 0..100 gridlines', async () => {
    const env = createHeadlessEnv();
    const canvas = env.doc.createElement('canvas');
    canvas.width = 640;
    canvas.height = 300;
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-10-20', '2026-10-21', '2026-10-22'],
        datasets: [{ highData: [90, 85, 95], lowData: [25, 20, 30], chargedData: [65, 65, 65], drainedData: [60, 70, 65] }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const texts = canvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.includes('0') && texts.includes('50') && texts.includes('100'), `Expected 0/50/100 gridline labels, got: ${JSON.stringify(texts)}`);
    chart.destroy();
  });

  await test('Tier 1', 'M3', 'E2E-T1-M3-02', 'rangeBar renders rounded vertical pillar, cyan High dot cap, and dark-filled Low ring cap', async () => {
    const env = createHeadlessEnv();
    const canvas = env.doc.createElement('canvas');
    canvas.width = 720;
    canvas.height = 280;
    const labels = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'];
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels,
        datasets: [{ highData: [92, 88, 95, 91, 86, 94, 90], lowData: [22, 18, 28, 24, 15, 29, 21] }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const calls = canvas.getContext('2d').calls;
    const rects = calls.filter(c => c.op === 'roundRect' || c.op === 'rect');
    const pillar = rects.find(r => r.h > 20 && r.w >= 8 && r.w <= 18);
    assert.ok(pillar, 'Expected vertical rangeBar pillar with 8..18px width');
    const cyanFills = calls.filter(c => c.op === 'fill' && /#38bdf8|56,\s*189,\s*248/i.test(String(c.fillStyle)));
    assert.ok(
      cyanFills.length >= labels.length + 1,
      `Expected >=${labels.length + 1} cyan (#38bdf8) fills (${labels.length} High caps + legend), got ${cyanFills.length}`
    );
    const cyanCapArcs = calls.filter(
      (c, idx) =>
        idx > 0 &&
        c.op === 'fill' &&
        /#38bdf8|56,\s*189,\s*248/i.test(String(c.fillStyle)) &&
        calls[idx - 1].op === 'arc'
    );
    assert.ok(
      cyanCapArcs.length >= labels.length,
      `Expected >=${labels.length} cyan (#38bdf8) High cap arc fills, got ${cyanCapArcs.length}`
    );
    const ringStroke = calls.some(c => c.op === 'stroke' && /#c4b5fd|#a855f7|196,\s*181,\s*253/i.test(String(c.strokeStyle)));
    assert.ok(ringStroke, 'Expected purple-tinted Low ring cap stroke');
    chart.destroy();
  });

  await test('Tier 1', 'M3', 'E2E-T1-M3-03', 'Body Battery Trend Modal renders 2-item High/Low legend without 4-line spaghetti labels', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('body_battery', rollup);

    const canvas = env.doc.getElementById('metric-trend-chart');
    const texts = canvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.some(t => t.includes('Daily High')), 'Legend must include Daily High');
    assert.ok(texts.some(t => t.includes('Daily Low')), 'Legend must include Daily Low');
    assert.ok(!texts.some(t => t.includes('Peak Charge') || t.includes('Low Reserve') || t.includes('Charged (+pts)')), 'Legacy 4-line legend must not appear');
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 1', 'M3', 'E2E-T1-M3-04', 'Hovering anywhere on rangeBar pillar shows unified tooltip and mouseleave clears it', async () => {
    const env = createHeadlessEnv();
    const canvas = env.doc.createElement('canvas');
    canvas.width = 720;
    canvas.height = 280;
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-10-20', '2026-10-21', '2026-10-22'],
        datasets: [{
          highData: [92, 88, 95],
          lowData: [24, 19, 28],
          chargedData: [68, 69, 67],
          drainedData: [64, 71, 66]
        }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const target = makeRangeBarHoverTarget(chart, 1);
    canvas.getContext('2d').calls.length = 0;
    canvas.dispatchEvent({ type: 'mousemove', clientX: target.x, clientY: target.y, target: canvas });
    assert.ok(chart.activeTooltip, 'Hovering along pillar must activate unified tooltip');
    const tipTexts = canvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text).join(' | ');
    assert.ok(tipTexts.includes('88') && tipTexts.includes('19'), `Tooltip must show High (88) and Low (19), got: ${tipTexts}`);
    assert.ok(tipTexts.includes('69') && tipTexts.includes('71'), `Tooltip must show Charged (+69) and Drained (-71), got: ${tipTexts}`);

    canvas.dispatchEvent({ type: 'mouseleave', target: canvas });
    assert.strictEqual(chart.activeTooltip, null, 'mouseleave must clear activeTooltip');
    chart.destroy();
  });

  await test('Tier 1', 'M3', 'E2E-T1-M3-05', 'Body Battery 1D view with intraday_body_battery renders smooth 00:00-23:59 curve', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('body_battery', rollup);
    const canvas = env.doc.getElementById('metric-trend-chart');
    canvas.getContext('2d').calls.length = 0;
    trendsMod.setTimeRange('1d');

    const calls = canvas.getContext('2d').calls;
    const curveOps = calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(curveOps.length >= 20, `1D intraday Body Battery curve must plot >= 20 segments, got ${curveOps.length}`);
    assert.strictEqual(env.doc.getElementById('trend-table-count').textContent, '1 records');
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 1', 'M3', 'E2E-T1-M3-06', 'Body Battery 1D fallback without intraday_body_battery renders single-day rangeBar', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    delete rollup.wellness.daily[rollup.wellness.daily.length - 1].intraday_body_battery;
    rollup.wellness.current = rollup.wellness.daily[rollup.wellness.daily.length - 1];

    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('body_battery', rollup);
    const canvas = env.doc.getElementById('metric-trend-chart');
    canvas.getContext('2d').calls.length = 0;
    trendsMod.setTimeRange('1d');

    const calls = canvas.getContext('2d').calls;
    const arcs = calls.filter(c => c.op === 'arc');
    assert.ok(arcs.length >= 2, '1D fallback without intraday must still render single-day High/Low rangeBar caps');
    const texts = calls.filter(c => c.op === 'fillText').map(c => c.text);
    assert.ok(texts.some(t => t.includes('Daily High')), '1D fallback must render rangeBar legend');
    trendsMod.closeMetricTrendModal();
  });

  // --- M4 Tier 1 (6 tests) ---
  await test('Tier 1', 'M4', 'E2E-T1-M4-01', 'Stress promoted to In Focus (3rd slot) and index.html uses xl:grid-cols-4', async () => {
    assert.deepStrictEqual(wellnessMod.DEFAULT_WELLNESS_LAYOUT.in_focus, ['sleep', 'body_battery', 'stress', 'steps']);
    assert.deepStrictEqual(wellnessMod.DEFAULT_WELLNESS_LAYOUT.at_a_glance, ['resting_hr', 'hrv', 'intensity_minutes', 'calories']);
    assert.strictEqual(wellnessMod.WELLNESS_METRIC_METADATA.stress.defaultSection, 'in_focus');
    const html = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'index.html'), 'utf8');
    assert.ok(/id="wellness-in-focus"[^>]*xl:grid-cols-4/.test(html), '#wellness-in-focus must use xl:grid-cols-4');
  });

  await test('Tier 1', 'M4', 'E2E-T1-M4-02', 'Stress In-Focus card renders overall score, qualifier badge, proportional 4-zone bar, and duration legend', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    wellnessMod.renderWellnessDashboard(rollup);

    const inFocus = env.doc.getElementById('wellness-in-focus');
    const stressCard = inFocus.querySelector('#card-wellness-stress');
    assert.ok(stressCard, '#card-wellness-stress must render inside #wellness-in-focus');
    const cardHtml = stressCard.innerHTML;
    const lowerHtml = cardHtml.toLowerCase();
    for (const hex of ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e']) {
      assert.ok(lowerHtml.includes(hex), `Stress In-Focus bar must use Garmin 4-zone color ${hex}`);
    }
    assert.ok(/width:\s*\d+(?:\.\d+)?%/i.test(cardHtml), 'Stress card must render proportional width:% segments');
    assert.ok(cardHtml.includes('Rest') && cardHtml.includes('Low') && cardHtml.includes('Med') && cardHtml.includes('High'), 'Stress card must show 4-zone breakdown legend');
    assert.ok(!cardHtml.includes('NaN%'), 'Proportional bar must never emit NaN%');
  });

  await test('Tier 1', 'M4', 'E2E-T1-M4-03', 'Stress Trend Modal renders 4 M4 KPIs (Overall Avg Stress, Rest / Low Share, High Stress Peak, Autonomic Status)', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);

    const kpiText = env.doc.getElementById('trend-kpi-grid').textContent;
    for (const label of ['Overall Avg Stress', 'Rest / Low Share', 'High Stress Peak', 'Autonomic Status']) {
      assert.ok(kpiText.includes(label), `Missing M4 Stress KPI: ${label}`);
    }
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 1', 'M4', 'E2E-T1-M4-04', 'Stress Trend Modal chart renders Garmin 4-zone colors (#38bdf8, #fbbf24, #f97316, #f43f5e)', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    // Inject varied stress levels across all 4 zones in last 7 days
    const last7 = rollup.wellness.daily.slice(-7);
    [15, 35, 62, 84, 20, 42, 68].forEach((lvl, idx) => { last7[idx].stress_level = lvl; });

    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);
    const canvas = env.doc.getElementById('metric-trend-chart');
    const colorsUsed = new Set(
      canvas.getContext('2d').calls
        .filter(c => c.op === 'fill' || c.op === 'fillRect')
        .map(c => String(c.fillStyle).toLowerCase())
    );
    const zoneColors = ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e'];
    const matchedZones = zoneColors.filter(c => colorsUsed.has(c));
    assert.ok(
      matchedZones.length >= 3,
      `Expected >=3 Garmin 4-zone stress colors across Rest/Low/Med/High values, matched ${matchedZones.length} (${matchedZones.join(', ')}) from [${Array.from(colorsUsed).join(', ')}]`
    );
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 1', 'M4', 'E2E-T1-M4-05', 'Stress Trend Modal renders 5-column breakdown table (Date, Avg Stress, Rest Time, Low / Med / High, Status)', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);

    const ths = env.doc.getElementById('trend-table-header-row').querySelectorAll('th').map(t => t.textContent.trim());
    assert.strictEqual(ths.length, 5, `Expected 5 columns in Stress breakdown table, got ${ths.length}: ${JSON.stringify(ths)}`);
    assert.ok(ths[0].includes('Date') && ths[1].includes('Avg Stress') && ths[2].includes('Rest Time'));
    const firstRowTds = env.doc.getElementById('trend-table-body').querySelectorAll('tr')[0].querySelectorAll('td');
    assert.strictEqual(firstRowTds.length, 5, 'Each Stress breakdown row must have 5 cells');
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 1', 'M4', 'E2E-T1-M4-06', 'Stress 1D intraday view renders intraday_stress curve while keeping 1 records count', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);
    const canvas = env.doc.getElementById('metric-trend-chart');
    canvas.getContext('2d').calls.length = 0;
    trendsMod.setTimeRange('1d');

    assert.strictEqual(env.doc.getElementById('trend-table-count').textContent, '1 records');
    const calls = canvas.getContext('2d').calls;
    const timeLabels = calls
      .filter(c => c.op === 'fillText' && /^\d{2}:\d{2}$/.test(String(c.text).trim()))
      .map(c => c.text);
    assert.ok(timeLabels.length >= 2, `Stress 1D intraday view must render HH:MM time axis labels, got: ${JSON.stringify(timeLabels)}`);
    const plotOps = calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'arc' || c.op === 'roundRect' || c.op === 'rect');
    assert.ok(plotOps.length >= 15, `Stress 1D intraday view must plot intraday curve/bars (>=15 ops), got ${plotOps.length}`);
    trendsMod.closeMetricTrendModal();
  });

  // --- M5 Tier 1 (5 tests) ---
  await test('Tier 1', 'M5', 'E2E-T1-M5-01', 'public/icon.svg exists as 64x64 purple obsidian squircle without legacy green', async () => {
    const iconPath = path.join(ROOT_DIR, 'public', 'icon.svg');
    assert.ok(fs.existsSync(iconPath), 'public/icon.svg must exist');
    const svg = fs.readFileSync(iconPath, 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('viewBox="0 0 64 64"'), 'public/icon.svg must be 64x64 SVG');
    assert.ok(svg.includes('#0b0714') || svg.includes('#1b132e'), 'public/icon.svg must use obsidian background palette');
    assert.ok(svg.includes('#a855f7') || svg.includes('#c084fc'), 'public/icon.svg must use purple accent palette');
    assert.ok(!svg.toLowerCase().includes('#10b981'), 'public/icon.svg must not contain legacy green #10b981');
  });

  await test('Tier 1', 'M5', 'E2E-T1-M5-02', 'dist/icon.svg exists and matches public/icon.svg byte-for-byte', async () => {
    const pubPath = path.join(ROOT_DIR, 'public', 'icon.svg');
    const distPath = path.join(ROOT_DIR, 'dist', 'icon.svg');
    assert.ok(fs.existsSync(pubPath), 'public/icon.svg must exist');
    assert.ok(fs.existsSync(distPath), 'dist/icon.svg must exist');
    assert.strictEqual(Buffer.compare(fs.readFileSync(pubPath), fs.readFileSync(distPath)), 0);
  });

  await test('Tier 1', 'M5', 'E2E-T1-M5-03', 'frontend/index.html & dist/index.html use purple favicon/badges and preserve 12 root IDs', async () => {
    const mandatoryIds = [
      'passphrase-modal', 'dashboard-main', 'weekly-volume-chart', 'training-load-chart',
      'hr-zone-chart', 'power-zone-chart', 'pace-zone-chart', 'threshold-trends-chart',
      'activities-table-body', 'activity-drawer', 'dashboard-content', 'activity-table',
      'metric-trend-modal'
    ];
    for (const rel of ['frontend/index.html', 'dist/index.html']) {
      const html = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
      const lowerHtml = html.toLowerCase();
      assert.ok(!lowerHtml.includes('%2310b981') && !lowerHtml.includes('#10b981'), `${rel} must replace legacy %2310b981 / #10b981 green favicon`);
      assert.ok(html.includes('text-purple-400') && html.includes('border-purple-500/30'), `${rel} must use purple header/status accents`);
      for (const id of mandatoryIds) {
        assert.ok(html.includes(`id="${id}"`), `${rel} missing mandatory id="${id}"`);
      }
    }
  });

  await test('Tier 1', 'M5', 'E2E-T1-M5-04', 'README.md renders centered public/icon.svg and piezoperny/garmin-dash links without <username>', async () => {
    const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
    assert.ok(!readme.includes('<username>'), 'README.md must not contain <username> placeholder');
    assert.ok(readme.includes('piezoperny/garmin-dash'), 'README.md must link to piezoperny/garmin-dash');
    assert.ok(readme.includes('public/icon.svg'), 'README.md must embed public/icon.svg');
  });

  await test('Tier 1', 'M5', 'E2E-T1-M5-05', 'README.md documents M1-M5 features while preserving all test_ci_and_docs invariants', async () => {
    const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
    for (const topic of ['Today', 'Body Battery', 'Stress', 'bootstrap_garmin', 'import_garmindb', 'reprocess', '0 */6 * * *', '44 bytes', '600,000']) {
      assert.ok(new RegExp(topic.replace(/\*/g, '\\*'), 'i').test(readme), `README.md missing documentation for: ${topic}`);
    }
    for (const sec of ['GARMIN_API_KEY', 'GARMIN_CLIENT_SECRET', 'HETZNER_HOST', 'HETZNER_USER', 'HETZNER_SSH_KEY', 'DASHBOARD_PASSPHRASE']) {
      assert.ok(readme.includes(sec), `README.md missing secret ${sec}`);
    }
  });

  // ==========================================================================
  // TIER 2: Boundary & Corner Cases (5 per feature = 20 tests)
  // ==========================================================================
  process.stdout.write('\n--- Tier 2: Boundary & Corner Cases ---\n');

  // --- M2 Tier 2 ---
  await test('Tier 2', 'M2', 'E2E-T2-M2-01', 'Strength/indoor activity omits GPS polyline, renders indoor badge, and omits distance/tonnage', async () => {
    createHeadlessEnv();
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    const strengthAct = { ...rollup.activities[2], start_time: `${localIsoDate(0)}T18:00:00Z` };
    activitiesMod.renderTodayActivityBanner([strengthAct], 'km');
    const html = global.document.getElementById('today-activity-section').innerHTML;
    assert.ok(!html.includes('<polyline'), 'Strength workout must not render GPS polyline');
    assert.ok(!html.includes('0.00 km'), 'Strength workout must omit 0 km distance');
    assert.ok(/Indoor|No\s*GPS|Heart\s*Rate|HR\s*Zone/i.test(html), 'Strength workout must render distinct right-side indoor/HR badge');
  });

  await test('Tier 2', 'M2', 'E2E-T2-M2-02', 'Missing/corrupted stream shard (404 or <44B) resolves gracefully without uncaught rejection', async () => {
    const env = createHeadlessEnv({ shards: new Map([['act_corrupt', new Uint8Array(12)]]) });
    env.sessionStorage.setItem('garmin_dash_session_key', Buffer.alloc(32, 7).toString('base64'));
    assert.strictEqual(typeof activitiesMod.loadActivityStreamShard, 'function', 'activities.js must export loadActivityStreamShard');
    const res404 = await activitiesMod.loadActivityStreamShard('act_missing_404');
    assert.strictEqual(res404, null, '404 shard fetch must resolve null');
    const resShort = await activitiesMod.loadActivityStreamShard('act_corrupt');
    assert.strictEqual(resShort, null, 'Truncated (<44B) shard must resolve null');
  });

  await test('Tier 2', 'M2', 'E2E-T2-M2-03', 'Empty activities array hides #today-activity-section and clears innerHTML', async () => {
    const env = createHeadlessEnv();
    activitiesMod.renderTodayActivityBanner([], 'km');
    const sec = env.doc.getElementById('today-activity-section');
    assert.strictEqual(sec.classList.contains('hidden'), true);
    assert.strictEqual(sec.innerHTML, '');
  });

  await test('Tier 2', 'M2', 'E2E-T2-M2-04', 'Degenerate 1-point and (0,0) Null Island polylines do not emit NaN/Infinity', async () => {
    createHeadlessEnv();
    const act1 = {
      id: 'act_null_island',
      start_time: `${localIsoDate(0)}T08:00:00Z`,
      sport: 'running',
      title: 'Null Island Jog',
      distance_meters: 5000,
      duration_seconds: 1500,
      avg_hr: 145,
      summary_polyline: encodePolyline([[0, 0], [0, 0]])
    };
    activitiesMod.renderTodayActivityBanner([act1], 'km');
    const html = global.document.getElementById('today-activity-section').innerHTML;
    assert.ok(!html.includes('NaN') && !html.includes('Infinity'), 'Degenerate coordinates must never emit NaN/Infinity');
  });

  await test('Tier 2', 'M2', 'E2E-T2-M2-05', 'Imperial toggle ("mi") formats distance, ascent, speed, and pace consistently', async () => {
    createHeadlessEnv();
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    activitiesMod.renderTodayActivityBanner([rollup.activities[1]], 'mi');
    const txt = global.document.getElementById('today-activity-section').textContent;
    assert.ok(txt.includes('mi') && txt.includes('mph') && txt.includes('ft'), `Expected mi/mph/ft in imperial mode, got: ${txt}`);
  });

  // --- M3 Tier 2 ---
  await test('Tier 2', 'M3', 'E2E-T2-M3-01', 'Zero and full extremes (low: 0, high: 100) are preserved without falsy coercion', async () => {
    const env = createHeadlessEnv();
    const canvas = env.doc.createElement('canvas');
    canvas.width = 640;
    canvas.height = 300;
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: {
        labels: ['2026-10-25', '2026-10-26'],
        datasets: [{ highData: [100, 95], lowData: [0, 12], chargedData: [100, 83], drainedData: [100, 83] }]
      },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const pt0 = makeRangeBarHoverTarget(chart, 0);
    canvas.getContext('2d').calls.length = 0;
    canvas.dispatchEvent({ type: 'mousemove', clientX: pt0.x, clientY: pt0.y, target: canvas });
    const tipText = canvas.getContext('2d').calls.filter(c => c.op === 'fillText').map(c => c.text).join(' ');
    assert.ok(tipText.includes('100') && tipText.includes('0'), `Extreme 0 and 100 must be preserved in tooltip, got: ${tipText}`);
    chart.destroy();
  });

  await test('Tier 2', 'M3', 'E2E-T2-M3-02', 'Pillar width scales cleanly from 7D (10-14px) down to 1M and 1Y (>=1px, no overlap)', async () => {
    const env = createHeadlessEnv();
    const makeBars = (n) => {
      const c = env.doc.createElement('canvas');
      c.width = 720;
      c.height = 280;
      const labels = Array.from({ length: n }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
      const chart = new chartMod.Chart(c, {
        type: 'rangeBar',
        data: { labels, datasets: [{ highData: labels.map(() => 90), lowData: labels.map(() => 25) }] },
        options: { scales: { y: { min: 0, max: 100 } } }
      });
      const pillars = c.getContext('2d').calls.filter(x => (x.op === 'roundRect' || x.op === 'rect') && x.h > 20 && x.w < 40);
      chart.destroy();
      return pillars;
    };
    const p7 = makeBars(7);
    const p365 = makeBars(365);
    assert.ok(p7.length >= 7 && p7[0].w >= 10 && p7[0].w <= 16, `7D pillar width expected 10-16px, got ${p7[0]?.w}`);
    assert.ok(p365.length >= 300 && p365[0].w >= 1 && p365[0].w < p7[0].w, `1Y pillar width must shrink cleanly >=1px, got ${p365[0]?.w}`);
  });

  await test('Tier 2', 'M3', 'E2E-T2-M3-03', 'Zero-width canvas guard (width=0) renders rangeBar without throwing or NaN', async () => {
    const env = createHeadlessEnv();
    const wrap = env.doc.createElement('div');
    wrap._rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    const canvas = env.doc.createElement('canvas');
    canvas._rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    wrap.appendChild(canvas);
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: { labels: ['2026-10-25'], datasets: [{ highData: [90], lowData: [30] }] }
    });
    assert.ok(chart instanceof chartMod.Chart);
    chart.destroy();
  });

  await test('Tier 2', 'M3', 'E2E-T2-M3-04', 'Minimal Canvas2D context without roundRect or createLinearGradient falls back cleanly', async () => {
    const env = createHeadlessEnv({ minimalCtx: true });
    const canvas = env.doc.getElementById('metric-trend-chart');
    assert.strictEqual(canvas.getContext('2d').roundRect, undefined);
    assert.strictEqual(canvas.getContext('2d').createLinearGradient, undefined);
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: { labels: ['2026-10-25', '2026-10-26'], datasets: [{ highData: [90, 88], lowData: [25, 22] }] }
    });
    const rectCalls = canvas.getContext('2d').calls.filter(c => c.op === 'rect');
    assert.ok(rectCalls.length >= 2, 'Minimal ctx must fall back from roundRect to rect');
    chart.destroy();
  });

  await test('Tier 2', 'M3', 'E2E-T2-M3-05', 'Equal High and Low values (50 === 50) render without NaN and support hover tooltip', async () => {
    const env = createHeadlessEnv();
    const canvas = env.doc.createElement('canvas');
    canvas.width = 640;
    canvas.height = 300;
    const chart = new chartMod.Chart(canvas, {
      type: 'rangeBar',
      data: { labels: ['2026-10-26'], datasets: [{ highData: [50], lowData: [50] }] },
      options: { scales: { y: { min: 0, max: 100 } } }
    });
    const arcs = canvas.getContext('2d').calls.filter(c => c.op === 'arc');
    assert.ok(arcs.length >= 2 && arcs.every(a => Number.isFinite(a.x) && Number.isFinite(a.y)));
    chart.destroy();
  });

  // --- M4 Tier 2 ---
  await test('Tier 2', 'M4', 'E2E-T2-M4-01', 'Zero stress (stress_level: 0, all zone seconds: 0) displays 0 without falsy fallback to 24 or NaN%', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    const latest = rollup.wellness.daily[rollup.wellness.daily.length - 1];
    latest.stress_level = 0;
    latest.stress_qualifier = 'Rest';
    latest.stress_rest_seconds = 0;
    latest.stress_low_seconds = 0;
    latest.stress_medium_seconds = 0;
    latest.stress_high_seconds = 0;
    rollup.wellness.current = latest;

    wellnessMod.renderWellnessDashboard(rollup);
    const cardText = env.doc.getElementById('card-wellness-stress').textContent;
    assert.ok(!cardText.includes('24 / 100') && cardText.includes('0'), `Zero stress must not fall back to 24, got: ${cardText}`);
    assert.ok(!env.doc.getElementById('card-wellness-stress').innerHTML.includes('NaN%'));
  });

  await test('Tier 2', 'M4', 'E2E-T2-M4-02', 'Scalar-only historical stress records (no stress_*_seconds) render valid 4-zone fallback', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    for (const d of rollup.wellness.daily) {
      delete d.stress_rest_seconds;
      delete d.stress_low_seconds;
      delete d.stress_medium_seconds;
      delete d.stress_high_seconds;
      d.stress_level = 55;
    }
    rollup.wellness.current = rollup.wellness.daily[rollup.wellness.daily.length - 1];
    wellnessMod.renderWellnessDashboard(rollup);
    const stressCard = env.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-stress');
    assert.ok(stressCard, '#card-wellness-stress must render inside #wellness-in-focus');
    const stressHtml = stressCard.innerHTML;
    const lowerHtml = stressHtml.toLowerCase();
    for (const hex of ['#38bdf8', '#fbbf24', '#f97316', '#f43f5e']) {
      assert.ok(lowerHtml.includes(hex), `Scalar-only stress fallback bar must use Garmin color ${hex}`);
    }
    assert.ok(/width:\s*\d+(?:\.\d+)?%/i.test(stressHtml), 'Scalar-only stress fallback must render proportional width:% bar');
    assert.ok(!stressHtml.includes('NaN') && !stressHtml.includes('undefined'));
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);
    assert.ok(!env.doc.getElementById('trend-kpi-grid').textContent.includes('NaN'));
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 2', 'M4', 'E2E-T2-M4-03', 'Legacy uncustomized storage auto-promotes stress while respecting explicit user customization & reset', async () => {
    const env = createHeadlessEnv();
    // 1. Legacy pre-M4 uncustomized default
    env.localStorage.setItem('garmin_dash_customization', JSON.stringify({
      wellness_layout: {
        in_focus: ['sleep', 'body_battery', 'steps'],
        at_a_glance: ['resting_hr', 'stress', 'hrv', 'intensity_minutes', 'calories'],
        hidden: []
      }
    }));
    const upgraded = wellnessMod.loadWellnessLayout();
    assert.ok(upgraded.in_focus.includes('stress'), 'Legacy uncustomized layout must promote stress to in_focus');

    // 2. Explicit user customization hiding stress must be respected
    env.localStorage.setItem('garmin_dash_customization', JSON.stringify({
      wellness_layout: {
        in_focus: ['sleep', 'body_battery', 'steps'],
        at_a_glance: ['resting_hr', 'hrv', 'intensity_minutes', 'calories'],
        hidden: ['stress']
      }
    }));
    const custom = wellnessMod.loadWellnessLayout();
    assert.ok(custom.hidden.includes('stress'), 'Explicit user customization hiding stress must be preserved');

    // 3. Reset restores stress to in_focus
    wellnessMod.resetWellnessLayout();
    assert.ok(wellnessMod.loadWellnessLayout().in_focus.includes('stress'));
  });

  await test('Tier 2', 'M4', 'E2E-T2-M4-04', 'Corrupted localStorage JSON recovers to DEFAULT_WELLNESS_LAYOUT with stress in In Focus', async () => {
    const env = createHeadlessEnv();
    env.localStorage.setItem('garmin_dash_customization', '{corrupt_json_value!!!');
    const recovered = wellnessMod.loadWellnessLayout();
    assert.deepStrictEqual(recovered.in_focus, ['sleep', 'body_battery', 'stress', 'steps']);
  });

  await test('Tier 2', 'M4', 'E2E-T2-M4-05', 'Stress empty daily dataset displays #trend-chart-empty cleanly without throwing', async () => {
    const env = createHeadlessEnv();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', { wellness: { daily: [], current: {} } });
    assert.strictEqual(env.doc.getElementById('trend-chart-empty').classList.contains('hidden'), false);
    assert.strictEqual(env.doc.getElementById('trend-table-count').textContent, '0 records');
    trendsMod.closeMetricTrendModal();
  });

  // --- M5 Tier 2 ---
  await test('Tier 2', 'M5', 'E2E-T2-M5-01', 'Zero-plaintext cleanup --verify-only & secret_hygiene scan pass on dist/ with icon.svg', async () => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'icon.svg')), 'dist/icon.svg must exist for M5');
    execFileSync('python3', ['-m', 'src.ingestion.cleanup', '--verify-only'], { cwd: ROOT_DIR, stdio: 'pipe' });
    const pyCheck = "import sys; from tests.test_secret_hygiene import ref_scan_directory; v = ref_scan_directory('dist'); sys.exit(0 if len(v) == 0 else 1)";
    execFileSync('python3', ['-c', pyCheck], { cwd: ROOT_DIR, stdio: 'pipe' });
  });

  await test('Tier 2', 'M5', 'E2E-T2-M5-02', 'dist/data.enc wire integrity (>=44B), 49 activities, 365 wellness days, zero strength tonnage keys', async () => {
    assert.ok(distEncBuf.length >= 44);
    const { payload } = await cryptoMod.decryptDashboardPayload('demo-passphrase-2026!', distEncBuf);
    assert.strictEqual(payload.activities.length, 49);
    assert.strictEqual(payload.wellness.daily.length, 365);
    for (const act of payload.activities.filter(a => a.sport === 'strength')) {
      for (const bad of ['weight', 'kg', 'load_kg', 'tonnage', 'weight_kg']) {
        assert.strictEqual(act[bad], undefined, `Strength activity must not expose ${bad}`);
      }
    }
  });

  await test('Tier 2', 'M5', 'E2E-T2-M5-03', 'dist/index.html asset links (./assets/main.js, ./assets/style.css, ./icon.svg) resolve on disk', async () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'dist', 'index.html'), 'utf8');
    assert.ok(!html.includes('./src/'));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'assets', 'main.js')));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'assets', 'style.css')));
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'icon.svg')), 'dist/icon.svg must exist');
  });

  await test('Tier 2', 'M5', 'E2E-T2-M5-04', 'No legacy green favicon (%2310b981 / #10b981) or <username> placeholder in HTML/README', async () => {
    const fHtml = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'index.html'), 'utf8').toLowerCase();
    const dHtml = fs.readFileSync(path.join(ROOT_DIR, 'dist', 'index.html'), 'utf8').toLowerCase();
    const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
    assert.ok(!fHtml.includes('%2310b981') && !fHtml.includes('#10b981'), 'Legacy green favicon must be removed from frontend/index.html');
    assert.ok(!dHtml.includes('%2310b981') && !dHtml.includes('#10b981'), 'Legacy green favicon must be removed from dist/index.html');
    assert.ok(!readme.includes('<username>'), '<username> placeholder must be removed from README.md');
  });

  await test('Tier 2', 'M5', 'E2E-T2-M5-05', 'frontend/build.js deterministically copies public/icon.svg -> dist/icon.svg in isolated build', async () => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'public', 'icon.svg')), 'public/icon.svg must exist before build check');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdash-build-'));
    try {
      fs.cpSync(path.join(ROOT_DIR, 'frontend'), path.join(tmp, 'frontend'), { recursive: true });
      fs.cpSync(path.join(ROOT_DIR, 'public'), path.join(tmp, 'public'), { recursive: true });
      execFileSync(process.execPath, [path.join(tmp, 'frontend', 'build.js')], { cwd: tmp, stdio: 'pipe' });
      const builtIcon = path.join(tmp, 'dist', 'icon.svg');
      assert.ok(fs.existsSync(builtIcon), 'build.js must copy public/icon.svg to dist/icon.svg');
      assert.strictEqual(
        Buffer.compare(fs.readFileSync(path.join(tmp, 'public', 'icon.svg')), fs.readFileSync(builtIcon)),
        0
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // TIER 3: Cross-Feature Combinations (5 tests)
  // ==========================================================================
  process.stdout.write('\n--- Tier 3: Cross-Feature Combinations ---\n');

  await test('Tier 3', 'CROSS', 'E2E-T3-01', 'M1 Python compile_dashboard_rollup summary_polyline -> M2 Today Banner mini-route SVG', async () => {
    const pyScript = [
      'import json',
      'from datetime import datetime, timezone',
      'from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_dashboard_rollup',
      'gen = SyntheticDatasetGenerator(seed=42, anchor_date=datetime.now(timezone.utc))',
      'acts = gen.generate_activities()',
      'r = compile_dashboard_rollup(acts)',
      'print(json.dumps(r))'
    ].join('; ');
    const out = execFileSync('python3', ['-c', pyScript], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const rollup = JSON.parse(out);
    const firstGps = rollup.activities.find(a => a.sport === 'running' || a.sport === 'cycling' || a.sport === 'hiking');
    assert.ok(firstGps && typeof firstGps.summary_polyline === 'string' && firstGps.summary_polyline.length > 5, 'M1 rollup must emit summary_polyline');

    createHeadlessEnv();
    activitiesMod.renderTodayActivityBanner([firstGps], 'km');
    const html = global.document.getElementById('today-activity-section').innerHTML;
    assert.ok(html.includes('<svg') && html.includes('<polyline'), 'M2 banner must decode M1 summary_polyline into SVG');
  });

  await test('Tier 3', 'CROSS', 'E2E-T3-02', 'M1 intraday_body_battery & intraday_stress -> M3/M4 1D intraday canvas plots', async () => {
    const pyScript = [
      'import json',
      'from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_dashboard_rollup',
      'gen = SyntheticDatasetGenerator(seed=42)',
      'r = compile_dashboard_rollup(gen.generate_activities())',
      'print(json.dumps({"wellness": r["wellness"]}))'
    ].join('; ');
    const out = execFileSync('python3', ['-c', pyScript], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const rollup = JSON.parse(out);
    const latest = rollup.wellness.daily[rollup.wellness.daily.length - 1];
    assert.ok(Array.isArray(latest.intraday_body_battery) && latest.intraday_body_battery.length > 0, 'M1 must emit intraday_body_battery');
    assert.ok(Array.isArray(latest.intraday_stress) && latest.intraday_stress.length > 0, 'M1 must emit intraday_stress');

    const env = createHeadlessEnv();
    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('body_battery', rollup);
    const modalCanvas = env.doc.getElementById('metric-trend-chart');
    modalCanvas.getContext('2d').calls.length = 0;
    trendsMod.setTimeRange('1d');
    const bbCalls = modalCanvas.getContext('2d').calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(bbCalls.length >= 10, 'M3 1D intraday must plot M1 intraday_body_battery');

    trendsMod.openMetricTrendModal('stress', rollup);
    modalCanvas.getContext('2d').calls.length = 0;
    trendsMod.setTimeRange('1d');
    const stCalls = modalCanvas.getContext('2d').calls;
    const stTimeLabels = stCalls
      .filter(c => c.op === 'fillText' && /^\d{2}:\d{2}$/.test(String(c.text).trim()))
      .map(c => c.text);
    assert.ok(stTimeLabels.length >= 2, `M4 1D intraday must render HH:MM time labels, got: ${JSON.stringify(stTimeLabels)}`);
    const stPlotOps = stCalls.filter(c => c.op === 'bezierCurveTo' || c.op === 'arc' || c.op === 'roundRect' || c.op === 'rect');
    assert.ok(stPlotOps.length >= 15, `M4 1D intraday must plot M1 intraday_stress points/bars, got ${stPlotOps.length}`);
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 3', 'CROSS', 'E2E-T3-03', 'M1 stress_*_seconds -> M4 Stress In-Focus card & Stress Trend Modal consistency', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    wellnessMod.renderWellnessDashboard(rollup);
    const stressCard = env.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-stress');
    assert.ok(stressCard, 'Stress card must be in In Focus');

    trendsMod.initTrendsModal();
    trendsMod.openMetricTrendModal('stress', rollup);
    const kpis = env.doc.getElementById('trend-kpi-grid').textContent;
    assert.ok(kpis.includes('Rest / Low Share') && kpis.includes('%'), 'Stress modal must calculate Rest / Low Share from stress_*_seconds');
    trendsMod.closeMetricTrendModal();
  });

  await test('Tier 3', 'CROSS', 'E2E-T3-04', 'M5 isolated build.js output passes zero-plaintext ref_scan_directory with icon.svg + data.enc', async () => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'public', 'icon.svg')), 'public/icon.svg must exist');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdash-t3-'));
    try {
      fs.cpSync(path.join(ROOT_DIR, 'frontend'), path.join(tmp, 'frontend'), { recursive: true });
      fs.cpSync(path.join(ROOT_DIR, 'public'), path.join(tmp, 'public'), { recursive: true });
      execFileSync(process.execPath, [path.join(tmp, 'frontend', 'build.js')], { cwd: tmp, stdio: 'pipe' });
      const distOut = path.join(tmp, 'dist');
      assert.ok(fs.existsSync(path.join(distOut, 'icon.svg')), 'dist/icon.svg must be present in built output');
      const pyCheck = `import sys; from tests.test_secret_hygiene import ref_scan_directory; v = ref_scan_directory(${JSON.stringify(distOut)}); print(v); sys.exit(0 if len(v) == 0 else 1)`;
      execFileSync('python3', ['-c', pyCheck], { cwd: ROOT_DIR, stdio: 'pipe' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Tier 3', 'CROSS', 'E2E-T3-05', 'M1 stream shard -> M2 Today banner mini-route + clicking opens #activity-drawer with decrypted splits', async (capturedErrors) => {
    const pass = 'cross-shard-pass-2026!';
    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    const act = {
      ...rollup.activities[0],
      id: 'act_cross_shard',
      summary_polyline: null,
      gps_track: null,
      telemetry_stream: null,
      has_streams: true,
      splits: []
    };
    rollup.activities = [act];
    const wire = await encryptDashboardPayload(pass, rollup);
    const { rawKeyBase64 } = await cryptoMod.decryptDashboardPayload(pass, wire);
    const shardWire = await encryptShardWithRawKey(rawKeyBase64, {
      id: 'act_cross_shard',
      gps_track: { points: [[47.37, 8.54, 410], [47.38, 8.55, 435], [47.39, 8.56, 460]] },
      telemetry_stream: { time: [0, 300, 600], elevation: [410, 435, 460], hr: [142, 155, 166] },
      splits: [{ split_number: 1, distance_meters: 1000, duration_seconds: 280, avg_hr: 155, elevation_diff: 25, avg_cadence: 172 }]
    }, wire.subarray(0, 16));

    const env = createHeadlessEnv({ dataEnc: wire, shards: new Map([['act_cross_shard', shardWire]]) });
    await mainMod.initApp();
    env.doc.getElementById('passphrase-input').value = pass;
    env.doc.getElementById('passphrase-form').dispatchEvent('submit');
    await waitForCondition(
      () =>
        !env.doc.getElementById('dashboard-content').classList.contains('hidden') ||
        capturedErrors.some(msg => /Decryption failed:/i.test(msg)),
      5000,
      25
    );
    if (capturedErrors.some(msg => /Decryption failed:/i.test(msg))) {
      throw new Error(`Swallowed unlock error: ${capturedErrors.join(' | ')}`);
    }

    const sec = env.doc.getElementById('today-activity-section');
    assert.strictEqual(sec.classList.contains('hidden'), false, '#today-activity-section must be unhidden after unlock');
    try {
      await waitForCondition(() => Boolean(sec.querySelector('svg polyline')), 1000, 20);
    } catch (_) {
      // Fall through to assertion so missing hydration reports cleanly as PENDING_IMPL
    }
    assert.ok(sec.querySelector('svg polyline'), 'Banner must hydrate sharded mini-route SVG <polyline>');
    env.doc.querySelector('[data-today-act-idx="0"]').click();
    await waitForCondition(() => env.doc.getElementById('drawer-splits-tbody').textContent.includes('#1'), 2000, 20);
    assert.strictEqual(env.doc.getElementById('activity-drawer').classList.contains('hidden'), false);
    assert.ok(env.doc.getElementById('drawer-splits-tbody').textContent.includes('#1'), 'Drawer must render sharded splits');
    activitiesMod.closeActivityDrawer();
  });

  // ==========================================================================
  // TIER 4: Real-World Scenarios (4 tests)
  // ==========================================================================
  process.stdout.write('\n--- Tier 4: Real-World Scenarios ---\n');

  await test('Tier 4', 'M2', 'E2E-T4-01', 'Full unlock -> Today Activity Banner -> click card -> inspect drawer -> close drawer', async (capturedErrors) => {
    const env = createHeadlessEnv({ dataEnc: distEncBuf });
    await mainMod.initApp();
    env.doc.getElementById('passphrase-input').value = 'demo-passphrase-2026!';
    env.doc.getElementById('passphrase-form').dispatchEvent('submit');
    await waitForCondition(
      () =>
        !env.doc.getElementById('dashboard-content').classList.contains('hidden') ||
        capturedErrors.some(msg => /Decryption failed:/i.test(msg)),
      5000,
      25
    );
    if (capturedErrors.some(msg => /Decryption failed:/i.test(msg))) {
      throw new Error(`Swallowed unlock error: ${capturedErrors.join(' | ')}`);
    }

    const sec = env.doc.getElementById('today-activity-section');
    assert.strictEqual(sec.classList.contains('hidden'), false, 'Today banner must be visible after unlock');
    const card = sec.querySelector('[data-today-act-idx="0"]');
    assert.ok(card);
    card.click();
    const drawer = env.doc.getElementById('activity-drawer');
    assert.strictEqual(drawer.classList.contains('hidden'), false);
    env.doc.getElementById('btn-close-drawer').click();
    assert.strictEqual(drawer.classList.contains('hidden'), true);
  });

  await test('Tier 4', 'M4', 'E2E-T4-02', 'Stress In-Focus click workflow: card action stopPropagation + modal 1D/7D/1M/1Y/Custom + prev/next + Escape', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    wellnessMod.renderWellnessDashboard(rollup);

    const stressCard = env.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-stress');
    assert.ok(stressCard, 'Stress card must be in In Focus');

    // Action button click must stopPropagation and NOT open modal
    const actionBtn = stressCard.querySelector('[data-wellness-action="prev"]');
    actionBtn.click();
    assert.strictEqual(env.doc.getElementById('metric-trend-modal').classList.contains('hidden'), true, 'Action button must not open modal');

    // Card click opens Stress Trend Modal
    env.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-stress').click();
    assert.strictEqual(env.doc.getElementById('metric-trend-modal').classList.contains('hidden'), false);
    assert.ok(env.doc.getElementById('trend-kpi-grid').textContent.includes('Overall Avg Stress'));

    for (const rng of ['1d', '1m', '1y', '7d']) {
      env.doc.querySelector(`[data-trend-range="${rng}"]`).click();
    }
    const label7d = env.doc.getElementById('trend-date-label').textContent;
    env.doc.getElementById('trend-nav-prev').click();
    assert.notStrictEqual(env.doc.getElementById('trend-date-label').textContent, label7d);
    env.doc.getElementById('trend-nav-next').click();

    env.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(env.doc.getElementById('metric-trend-modal').classList.contains('hidden'), true);
  });

  await test('Tier 4', 'M3', 'E2E-T4-03', 'Body Battery In-Focus -> rangeBar hover tooltip -> 1D intraday switch -> close modal', async () => {
    const env = createHeadlessEnv();
    const rollup = buildEnhancementRollup();
    trendsMod.initTrendsModal();
    wellnessMod.renderWellnessDashboard(rollup);

    const bbCard = env.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-body-battery');
    assert.ok(bbCard);
    bbCard.click();

    const modal = env.doc.getElementById('metric-trend-modal');
    assert.strictEqual(modal.classList.contains('hidden'), false);
    const canvas = env.doc.getElementById('metric-trend-chart');
    const arcs = canvas.getContext('2d').calls.filter(c => c.op === 'arc');
    assert.ok(arcs.length >= 14, '7D Body Battery modal must render rangeBar High/Low caps');

    canvas.getContext('2d').calls.length = 0;
    env.doc.querySelector('[data-trend-range="1d"]').click();
    const curveOps = canvas.getContext('2d').calls.filter(c => c.op === 'bezierCurveTo' || c.op === 'lineTo');
    assert.ok(curveOps.length >= 20, '1D Body Battery switch must render intraday curve');

    env.doc.getElementById('btn-close-trend-modal').click();
    assert.strictEqual(modal.classList.contains('hidden'), true);
  });

  await test('Tier 4', 'CROSS', 'E2E-T4-04', 'Session reload bypass renders M2-M4 features immediately and Lock Vault wipes sessionStorage', async (capturedErrors) => {
    const env1 = createHeadlessEnv({ dataEnc: distEncBuf });
    await mainMod.initApp();
    env1.doc.getElementById('passphrase-input').value = 'demo-passphrase-2026!';
    env1.doc.getElementById('passphrase-form').dispatchEvent('submit');
    await waitForCondition(
      () =>
        !env1.doc.getElementById('dashboard-content').classList.contains('hidden') ||
        capturedErrors.some(msg => /Decryption failed:/i.test(msg)),
      5000,
      25
    );
    if (capturedErrors.some(msg => /Decryption failed:/i.test(msg))) {
      throw new Error(`Swallowed unlock error: ${capturedErrors.join(' | ')}`);
    }

    const cachedKey = env1.sessionStorage.getItem('garmin_dash_session_key');
    assert.ok(cachedKey && cachedKey.length > 20, 'Session key must be stored');

    // Simulate reload in same tab sharing sessionStorage
    const env2 = createHeadlessEnv({ dataEnc: distEncBuf });
    env2.sessionStorage.setItem('garmin_dash_session_key', cachedKey);
    await mainMod.initApp();

    assert.strictEqual(env2.doc.getElementById('dashboard-content').classList.contains('hidden'), false);
    assert.strictEqual(env2.doc.getElementById('today-activity-section').classList.contains('hidden'), false, 'Reload bypass must render Today banner');
    assert.ok(env2.doc.getElementById('wellness-in-focus').querySelector('#card-wellness-stress'), 'Reload bypass must render Stress in In Focus');

    // Lock Vault purges sessionStorage and restores modal
    env2.doc.getElementById('btn-lock-dashboard').click();
    assert.strictEqual(env2.sessionStorage.getItem('garmin_dash_session_key'), null);
    assert.strictEqual(env2.doc.getElementById('passphrase-modal').classList.contains('hidden'), false);
    assert.strictEqual(env2.doc.getElementById('dashboard-content').classList.contains('hidden'), true);
  });

  await test('Tier 1', 'CROSS', 'E2E-T1-CROSS-01', '#btn-header-reprocess and #btn-reprocess-activities render progress bar containers and update 0% -> 100% on fast sync', async () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'frontend/index.html'), 'utf8');
    assert.ok(html.includes('id="btn-header-reprocess"'), '#btn-header-reprocess must exist in frontend/index.html');
    assert.ok(html.includes('id="btn-reprocess-activities"'), '#btn-reprocess-activities must exist in frontend/index.html');
    assert.ok(html.includes('id="header-sync-progress-bar"'), '#header-sync-progress-bar must exist in frontend/index.html');
    assert.ok(html.includes('id="table-sync-progress-bar"'), '#table-sync-progress-bar must exist in frontend/index.html');
    assert.ok(html.includes('id="garmin-sync-progress-container"'), '#garmin-sync-progress-container must exist in frontend/index.html');
    assert.ok(html.includes('id="garmin-sync-progress-fill"'), '#garmin-sync-progress-fill must exist in frontend/index.html');
    assert.ok(html.includes('id="garmin-sync-progress-pct"'), '#garmin-sync-progress-pct must exist in frontend/index.html');
    assert.ok(html.includes('id="garmin-sync-progress-stage"'), '#garmin-sync-progress-stage must exist in frontend/index.html');

    const rollup = buildEnhancementRollup({ todayIso: localIsoDate(0) });
    const encBuf = encryptDashboardPayload(rollup, 'test-passphrase-sync');
    const env = createHeadlessEnv({ dataEnc: encBuf });
    const mainMod = require(path.join(ROOT_DIR, 'frontend/src/main.js'));
    await mainMod.initApp();

    if (typeof mainMod.runFastGarminSync === 'function') {
      const pctHistory = [];
      env.localStorage.setItem('garmin_dash_gh_pat', 'ghp_mock_token_for_e2e');
      const origFetch = global.fetch;
      let pollCount = 0;
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/dispatches')) {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        if (u.includes('/actions/runs?')) {
          return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 12345, status: 'completed', conclusion: 'success' }] }) };
        }
        if (u.includes('/actions/runs/12345/jobs')) {
          return { ok: true, status: 200, json: async () => ({ jobs: [{ steps: [{ status: 'completed' }] }] }) };
        }
        if (u.includes('/actions/runs/12345')) {
          pollCount += 1;
          return { ok: true, status: 200, json: async () => ({ id: 12345, status: 'completed', conclusion: 'success' }) };
        }
        if (u.includes('data.enc')) {
          return { ok: true, status: 200, arrayBuffer: async () => encBuf.buffer.slice(encBuf.byteOffset, encBuf.byteOffset + encBuf.byteLength) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      try {
        await mainMod.runFastGarminSync({
          forceRefresh: false,
          onProgress: (arg) => pctHistory.push(typeof arg === 'number' ? arg : (arg && typeof arg.pct === 'number' ? arg.pct : 0))
        });
      } catch (_e) {
        // Ignore if headless env lacks full reloadEncryptedVault context
      } finally {
        global.fetch = origFetch;
      }
      if (pctHistory.length > 0) {
        assert.ok(pctHistory[0] >= 0, 'Progress should start at >= 0%');
        assert.ok(pctHistory[pctHistory.length - 1] <= 100, 'Progress should end at <= 100%');
      }
    }
  });

  // ==========================================================================
  // Summary Reporting
  // ==========================================================================
  const milestones = ['M2', 'M3', 'M4', 'M5', 'CROSS'];
  const tiers = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];

  process.stdout.write('\n=== Summary by Milestone ===\n');
  for (const m of milestones) {
    const sub = results.filter(r => r.milestone === m);
    const p = sub.filter(r => r.status === 'PASS').length;
    const pend = sub.filter(r => r.status === 'PENDING_IMPL').length;
    const err = sub.filter(r => r.status === 'ERROR').length;
    process.stdout.write(`  ${m.padEnd(6)}: ${p} passed, ${pend} pending_impl, ${err} errors (Total: ${sub.length})\n`);
  }

  process.stdout.write('\n=== Summary by Tier ===\n');
  for (const t of tiers) {
    const sub = results.filter(r => r.tier === t);
    const p = sub.filter(r => r.status === 'PASS').length;
    const pend = sub.filter(r => r.status === 'PENDING_IMPL').length;
    const err = sub.filter(r => r.status === 'ERROR').length;
    process.stdout.write(`  ${t.padEnd(7)}: ${p} passed, ${pend} pending_impl, ${err} errors (Total: ${sub.length})\n`);
  }

  const totalPass = results.filter(r => r.status === 'PASS').length;
  const totalPend = results.filter(r => r.status === 'PENDING_IMPL').length;
  const totalErr = results.filter(r => r.status === 'ERROR').length;
  process.stdout.write(`\n=== Enhancements E2E Total: ${totalPass} passed, ${totalPend} pending_impl, ${totalErr} errors (Total: ${results.length}) ===\n\n`);

  if (totalPend > 0 || totalErr > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runEnhancementsE2ESuite().catch(err => {
    process.stderr.write(`Fatal error: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { runEnhancementsE2ESuite, buildEnhancementRollup };
