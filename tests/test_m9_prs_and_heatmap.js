import assert from 'node:assert/strict';
import {
  computePersonalRecords,
  computeConsistencyData,
  renderPRTrophyCase,
  renderConsistencyHeatmap
} from '../frontend/src/charts/achievements.js';

// 1. Test computePersonalRecords with schema variants & all-time vs active-year
const sampleActivities = [
  {
    id: 'a1',
    activity_name: 'Gran Fondo 2025',
    type: 'cycling',
    start_time: '2025-07-12T08:00:00Z',
    distance_km: 140.5,
    elevation_gain_m: 2100,
    average_power: 245,
    training_stress_score: 280,
    duration_sec: 18000
  },
  {
    id: 'a2',
    activity_name: 'Alpine Hike 2026',
    type: 'hiking',
    start_time: '2026-08-01T07:30:00Z',
    distance_m: 28500,
    elevation_gain_meters: 1450,
    tss: 195,
    duration_seconds: 21600
  },
  {
    id: 'a3',
    activity_name: 'Crit Race 2026',
    type: 'cycling',
    start_time: '2026-06-15T17:00:00Z',
    distance_meters: 45000,
    elevation_m: 320,
    avg_power: 310,
    tss: 110,
    duration_s: 3900
  }
];

const allTimePRs = computePersonalRecords(sampleActivities);
assert.equal(allTimePRs.length, 6, 'Should compute all 6 PR categories');

const byId = Object.fromEntries(allTimePRs.map(r => [r.id, r]));
assert.equal(byId.longest_ride.activity.id, 'a1');
assert.equal(byId.longest_ride.format('km'), '140.5 km');
assert.equal(byId.longest_ride.format('mi'), '87.3 mi');

assert.equal(byId.longest_hike_run.activity.id, 'a2');
assert.equal(byId.longest_hike_run.format('km'), '28.5 km');

assert.equal(byId.biggest_climb.activity.id, 'a1');
assert.equal(byId.biggest_climb.format('km'), '+2,100 m');

assert.equal(byId.peak_power.activity.id, 'a3');
assert.equal(byId.peak_power.format('km'), '310 W');

assert.equal(byId.highest_tss.activity.id, 'a1');
assert.equal(byId.highest_tss.format('km'), '280 TSS');

assert.equal(byId.longest_duration.activity.id, 'a2');
assert.equal(byId.longest_duration.format('km'), '6h 0m');

// Active-year filter (2026)
const prs2026 = computePersonalRecords(sampleActivities, 2026);
const byId2026 = Object.fromEntries(prs2026.map(r => [r.id, r]));
assert.equal(byId2026.longest_ride.activity.id, 'a3');
assert.equal(byId2026.biggest_climb.activity.id, 'a2');
assert.equal(byId2026.highest_tss.activity.id, 'a2');

// Empty data handling
const emptyPRs = computePersonalRecords([]);
assert.equal(emptyPRs.length, 6);
for (const rec of emptyPRs) {
  assert.equal(rec.activity, null);
  assert.equal(rec.format('km'), '--');
}

// 2. Test computeConsistencyData (53x7 matrix, modes, streaks)
const rollup = {
  activities: [
    { start_time: '2026-08-01T08:00:00Z', tss: 90, duration_seconds: 3600 },
    { start_time: '2026-08-02T08:00:00Z', tss: 140, duration_seconds: 5400 }
  ],
  daily_wellness: [
    { calendar_date: '2026-07-31', steps: 11000, steps_goal: 10000, sleep_score: 82 },
    { calendar_date: '2026-08-01', steps: 12500, steps_goal: 10000, sleep_score: 88 },
    { calendar_date: '2026-08-02', steps: 8000, steps_goal: 10000, sleep_score: 65 }
  ]
};

const tssData = computeConsistencyData(rollup, 'tss', '2026-08-02');
assert.equal(tssData.weeks.length, 53, 'Heatmap should have 53 weeks');
assert.equal(tssData.weeks[0].length, 7, 'Each week should have 7 days');
assert.equal(tssData.badges.currentActiveStreak, 2);
assert.equal(tssData.badges.longestStepStreak, 2);
assert.equal(tssData.badges.activeDays365, 2);
assert.equal(tssData.badges.totalAnnualHours, 2.5);

const stepsData = computeConsistencyData(rollup, 'steps', '2026-08-02');
assert.equal(stepsData.mode, 'steps');

const sleepData = computeConsistencyData(rollup, 'sleep', '2026-08-02');
assert.equal(sleepData.mode, 'sleep');

// 3. Test DOM rendering & click callback with lightweight mock
function createMockEl() {
  const listeners = {};
  return {
    innerHTML: '',
    addEventListener(ev, fn) {
      listeners[ev] = listeners[ev] || [];
      listeners[ev].push(fn);
    },
    click() {
      (listeners.click || []).forEach(fn => fn());
    },
    querySelectorAll() {
      return [];
    }
  };
}

let selectedDate = null;
const mockContainer = createMockEl();
const mockDateBtn = createMockEl();
mockDateBtn.getAttribute = () => '2026-08-02';
mockContainer.querySelectorAll = (selector) => {
  if (selector === '[data-heatmap-date]') {
    return [mockDateBtn];
  }
  return [];
};

renderConsistencyHeatmap(rollup, mockContainer, {
  onSelectDate: (d) => { selectedDate = d; }
});
assert.ok(mockContainer.innerHTML.includes('365-Day Consistency Heatmap'));
assert.ok(mockContainer.innerHTML.includes('Current Active Streak'));
const dateBtns = mockContainer.querySelectorAll('[data-heatmap-date]');
dateBtns[0].click();
assert.equal(selectedDate, '2026-08-02');

// M1: computeConsistencyData with canonical rollup.wellness.daily and sleep_seconds fallback
const m1Rollup = {
  activities: [],
  wellness: {
    daily: [
      { date: '2026-08-01', steps: 12000, steps_goal: 10000, sleep_score: 90 },
      { date: '2026-08-02', steps: 6000, steps_goal: 10000, sleep_seconds: 28800 }
    ]
  }
};
const m1StepsData = computeConsistencyData(m1Rollup, 'steps', '2026-08-02');
const m1StepsDays = m1StepsData.weeks.flat();
const day1Steps = m1StepsDays.find(d => d && d.dateStr === '2026-08-01');
const day2Steps = m1StepsDays.find(d => d && d.dateStr === '2026-08-02');
assert.equal(day1Steps.steps, 12000);
assert.ok(day1Steps.level >= 3, `Expected steps level >= 3 for 12000/10000, got ${day1Steps.level}`);
assert.equal(day2Steps.steps, 6000);
assert.ok(day2Steps.level >= 1, `Expected steps level >= 1 for 6000/10000, got ${day2Steps.level}`);

const m1SleepData = computeConsistencyData(m1Rollup, 'sleep', '2026-08-02');
const m1SleepDays = m1SleepData.weeks.flat();
const day1Sleep = m1SleepDays.find(d => d && d.dateStr === '2026-08-01');
const day2Sleep = m1SleepDays.find(d => d && d.dateStr === '2026-08-02');
assert.equal(day1Sleep.sleepScore, 90);
assert.equal(day2Sleep.sleepScore, 85);
assert.ok(day2Sleep.level >= 3, `Expected sleep level >= 3 for 85 sleepScore, got ${day2Sleep.level}`);

console.log('[PASS] M4 Personal Records & 365-Day Consistency Heatmap tests passed.');
