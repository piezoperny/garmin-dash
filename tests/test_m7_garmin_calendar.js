/**
 * tests/test_m7_garmin_calendar.js
 * Unit & integration tests for M2: Garmin Connect Calendar (Inline + Fullscreen Modal)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal DOM stub for importing activities.js / calendar.js in Node
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
}

const {
  normalizeSportCategory,
  extractDateStr,
  formatCalendarDuration,
  formatCalendarDistance,
  buildCalendarWeeks,
  CALENDAR_SPORT_FILTERS,
  WELLNESS_LAYERS
} = await import('../frontend/src/charts/calendar.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 1. Sport category normalization
assert.equal(normalizeSportCategory({ type: 'running' }), 'Running');
assert.equal(normalizeSportCategory({ type: 'trail_running' }), 'Running');
assert.equal(normalizeSportCategory({ type: 'cycling' }), 'Cycling');
assert.equal(normalizeSportCategory({ type: 'strength_training' }), 'Strength');
assert.equal(normalizeSportCategory({ type: 'hiking' }), 'Hiking');
assert.equal(normalizeSportCategory({ type: 'walking' }), 'Walking');
assert.equal(normalizeSportCategory({ type: 'yoga' }), 'Other');

// 2. Date extraction & formatting helpers
assert.equal(extractDateStr({ date: '2026-11-15T07:30:00Z' }), '2026-11-15');
assert.equal(extractDateStr({ start_time: '2026-11-01 06:00:00' }), '2026-11-01');
assert.equal(extractDateStr({}), null);

assert.equal(formatCalendarDuration(0), '0m');
assert.equal(formatCalendarDuration(2700), '45m');
assert.equal(formatCalendarDuration(5100), '1h 25m');
assert.equal(formatCalendarDistance(10000, 'metric'), '10.0 km');
assert.equal(formatCalendarDistance(5250, 'metric'), '5.25 km');
assert.equal(formatCalendarDistance(1609.344, 'imperial'), '1.00 mi');
assert.equal(formatCalendarDistance(1609.344, 'mi'), '1.00 mi');

// 3. Calendar grid generation (Mon-Sun + Weekly Summary)
const sampleActivities = [
  { id: 1, date: '2026-11-02T07:00:00Z', type: 'running', distance_m: 10000, duration_s: 3000, calories: 650, tss: 72 },
  { id: 2, date: '2026-11-04T17:30:00Z', type: 'cycling', distance_m: 32000, duration_s: 3600, calories: 820, tss: 88 },
  { id: 3, date: '2026-11-07T09:00:00Z', type: 'strength_training', distance_m: 0, duration_s: 2700, calories: 310, tss: 35 }
];

const sampleWellness = [
  { date: '2026-11-02', sleep_score: 84, body_battery_high: 92, body_battery_low: 24, steps: 11200, resting_hr: 47, stress_avg: 22 },
  { date: '2026-11-04', sleep_score: 78, body_battery_high: 86, body_battery_low: 20, steps: 9500, resting_hr: 48, stress_avg: 28 }
];

// November 2026 starts on Sunday (Nov 1, 2026 = Sunday)
const weeksAll = buildCalendarWeeks(2026, 10, sampleActivities, sampleWellness, 'All', '2026-11-07');
assert.ok(weeksAll.length >= 5, 'November 2026 should have at least 5 week rows');
for (const week of weeksAll) {
  assert.equal(week.days.length, 7, 'Each week row must have 7 Mon-Sun days');
  assert.ok(week.summary && typeof week.summary.activityCount === 'number', 'Each week row must have a summary object');
}

// Week 2 (Nov 2 - Nov 8, 2026) should contain all 3 sample activities
const week2 = weeksAll[1];
assert.equal(week2.days[0].dateStr, '2026-11-02');
assert.equal(week2.days[6].dateStr, '2026-11-08');
assert.equal(week2.days[5].isToday, true); // 2026-11-07
assert.equal(week2.summary.activityCount, 3);
assert.equal(week2.summary.totalDistanceMeters, 42000);
assert.equal(week2.summary.totalDurationSec, 9300);
assert.equal(week2.summary.totalCalories, 1780);
assert.equal(week2.summary.totalTss, 195);
assert.equal(week2.summary.avgSleepScore, 81);
assert.equal(week2.summary.avgBodyBatteryPeak, 89);

// Sport filtering
const weeksRun = buildCalendarWeeks(2026, 10, sampleActivities, sampleWellness, 'Running', '2026-11-07');
assert.equal(weeksRun[1].summary.activityCount, 1);
assert.equal(weeksRun[1].summary.totalDistanceMeters, 10000);

// 4. Constants check
assert.deepEqual(CALENDAR_SPORT_FILTERS, ['All', 'Running', 'Cycling', 'Strength', 'Hiking', 'Walking', 'Other']);
assert.equal(WELLNESS_LAYERS.length, 4);

// 5. HTML & activities.js integration checks
const indexHtml = fs.readFileSync(path.join(rootDir, 'frontend', 'index.html'), 'utf8');
for (const id of [
  'calendar-section',
  'calendar-modal',
  'btn-header-calendar',
  'btn-toggle-inline-calendar',
  'btn-open-calendar-modal',
  'btn-close-calendar-modal',
  'calendar-inline-body',
  'calendar-modal-body'
]) {
  assert.ok(indexHtml.includes(`id="${id}"`), `frontend/index.html missing id="${id}"`);
}

const activitiesJs = fs.readFileSync(path.join(rootDir, 'frontend', 'src', 'charts', 'activities.js'), 'utf8');
assert.ok(activitiesJs.includes('data-open-calendar="true"'), 'activities.js missing View Calendar button');

console.log('[PASS] M2 Garmin Connect Calendar tests passed.');
