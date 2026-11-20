/**
 * frontend/src/charts/achievements.js
 *
 * Milestone 4 (M4):
 * 1. Personal Records (PR) & Trophy Case (#pr-trophy-case)
 * 2. 365-Day Year-in-Pixels Consistency Heatmap (#consistency-heatmap-card)
 */

import { openActivityDrawer, escapeHtml } from './activities.js';
import { normalizeSportCategory, extractDateStr } from './calendar.js';

function getDistanceMeters(act) {
  if (!act || typeof act !== 'object') return 0;
  if (act.distance_meters != null && act.distance_meters !== '' && Number.isFinite(Number(act.distance_meters))) {
    return Number(act.distance_meters);
  }
  if (act.distance_m != null && act.distance_m !== '' && Number.isFinite(Number(act.distance_m))) {
    return Number(act.distance_m);
  }
  if (act.distance_km != null && act.distance_km !== '' && Number.isFinite(Number(act.distance_km))) {
    return Number(act.distance_km) * 1000;
  }
  if (act.distance != null && act.distance !== '' && Number.isFinite(Number(act.distance))) {
    return Number(act.distance);
  }
  return 0;
}

function getElevationMeters(act) {
  if (!act || typeof act !== 'object') return 0;
  const val = act.elevation_gain_meters ?? act.elevation_gain_m ?? act.elevation_m ?? act.elevation_gain ?? 0;
  return Number.isFinite(Number(val)) ? Number(val) : 0;
}

function getAvgPower(act) {
  if (!act || typeof act !== 'object') return 0;
  const val = act.avg_power ?? act.average_power ?? act.power ?? 0;
  return Number.isFinite(Number(val)) ? Number(val) : 0;
}

function getTSS(act) {
  if (!act || typeof act !== 'object') return 0;
  const val = act.tss ?? act.training_stress_score ?? 0;
  return Number.isFinite(Number(val)) ? Number(val) : 0;
}

function getDurationSeconds(act) {
  if (!act || typeof act !== 'object') return 0;
  const val = act.duration_seconds ?? act.duration_s ?? act.duration_sec ?? act.duration ?? 0;
  return Number.isFinite(Number(val)) ? Number(val) : 0;
}

function formatPRDistance(meters, unit = 'km') {
  if (!meters || meters <= 0) return '--';
  if (unit === 'mi' || unit === 'imperial') {
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatPRElevation(meters, unit = 'km') {
  if (!meters || meters <= 0) return '--';
  if (unit === 'mi' || unit === 'imperial') {
    return `+${Math.round(meters * 3.28084).toLocaleString()} ft`;
  }
  return `+${Math.round(meters).toLocaleString()} m`;
}

function formatPRDuration(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const totalMins = Math.round(seconds / 60);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

function getSportIcon(sport) {
  switch (sport) {
    case 'cycling': return '🚴';
    case 'running': return '🏃';
    case 'hiking': return '🥾';
    case 'strength': return '🏋️';
    case 'swimming': return '🏊';
    default: return '⚡';
  }
}

/**
 * Computes the 6 Personal Record categories from an array of activities.
 * @param {Array} activities
 * @param {number|null} activeYear - Optional year filter (e.g. 2026)
 * @returns {Array<object>}
 */
export function computePersonalRecords(activities = [], activeYear = null) {
  const list = Array.isArray(activities) ? activities : [];
  const filtered = activeYear
    ? list.filter(a => {
        const d = extractDateStr(a);
        return d && d.startsWith(String(activeYear));
      })
    : list;

  const findMax = (items, valueFn) => {
    let bestAct = null;
    let bestVal = 0;
    for (const act of items) {
      const v = valueFn(act);
      if (v > bestVal) {
        bestVal = v;
        bestAct = act;
      }
    }
    return { activity: bestAct, value: bestVal };
  };

  const cyclingActs = filtered.filter(a => normalizeSportCategory(a).toLowerCase() === 'cycling');
  const hikeRunActs = filtered.filter(a => {
    const cat = normalizeSportCategory(a).toLowerCase();
    return cat === 'hiking' || cat === 'running';
  });

  const longestRide = findMax(cyclingActs, getDistanceMeters);
  const longestHikeRun = findMax(hikeRunActs, getDistanceMeters);
  const biggestClimb = findMax(filtered, getElevationMeters);
  const peakPower = findMax(cyclingActs.length ? cyclingActs : filtered, getAvgPower);
  const highestTSS = findMax(filtered, getTSS);
  const longestDuration = findMax(filtered, getDurationSeconds);

  return [
    {
      id: 'longest_ride',
      label: 'Longest Ride (Cycling)',
      sport: 'cycling',
      activity: longestRide.activity,
      value: longestRide.value,
      format: (u) => formatPRDistance(longestRide.value, u)
    },
    {
      id: 'longest_hike_run',
      label: 'Longest Hike / Run',
      sport: longestHikeRun.activity ? normalizeSportCategory(longestHikeRun.activity) : 'running',
      activity: longestHikeRun.activity,
      value: longestHikeRun.value,
      format: (u) => formatPRDistance(longestHikeRun.value, u)
    },
    {
      id: 'biggest_climb',
      label: 'Biggest Elevation Climb',
      sport: biggestClimb.activity ? normalizeSportCategory(biggestClimb.activity) : 'hiking',
      activity: biggestClimb.activity,
      value: biggestClimb.value,
      format: (u) => formatPRElevation(biggestClimb.value, u)
    },
    {
      id: 'peak_power',
      label: 'Peak Cycling Power',
      sport: 'cycling',
      activity: peakPower.activity,
      value: peakPower.value,
      format: () => (peakPower.value > 0 ? `${Math.round(peakPower.value)} W` : '--')
    },
    {
      id: 'highest_tss',
      label: 'Highest Training Load',
      sport: highestTSS.activity ? normalizeSportCategory(highestTSS.activity) : 'cycling',
      activity: highestTSS.activity,
      value: highestTSS.value,
      format: () => (highestTSS.value > 0 ? `${Math.round(highestTSS.value)} TSS` : '--')
    },
    {
      id: 'longest_duration',
      label: 'Longest Workout Duration',
      sport: longestDuration.activity ? normalizeSportCategory(longestDuration.activity) : 'all',
      activity: longestDuration.activity,
      value: longestDuration.value,
      format: () => formatPRDuration(longestDuration.value)
    }
  ];
}

let activePRScope = 'all'; // 'all' | 'year'

/**
 * Renders the Personal Records (PR) & Trophy Case into #pr-trophy-case.
 * @param {object} rollup
 * @param {string} unit
 */
export function renderPRTrophyCase(rollup, unit = 'km') {
  const container = document.getElementById('pr-trophy-case');
  if (!container) return;

  const activities = Array.isArray(rollup?.activities) ? rollup.activities : [];
  const years = activities
    .map(a => extractDateStr(a))
    .filter(Boolean)
    .map(d => Number(d.slice(0, 4)))
    .filter(y => Number.isFinite(y));
  const latestYear = years.length ? Math.max(...years) : new Date().getFullYear();

  const records = computePersonalRecords(
    activities,
    activePRScope === 'year' ? latestYear : null
  );

  container.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <span class="text-amber-400 text-sm">🏆</span>
        <h3 class="text-sm font-semibold text-white tracking-tight">Personal Records &amp; Trophy Case</h3>
        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-amber-300 border-amber-500/35 bg-amber-500/15">
          ${activePRScope === 'year' ? `${latestYear} SEASON` : 'ALL-TIME'}
        </span>
      </div>
      <div class="flex items-center space-x-1 bg-[#0b0714] p-0.5 rounded-lg border border-[#2d2147]">
        <button type="button" data-pr-scope="all" class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${activePRScope === 'all' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-white'}">
          All-Time
        </button>
        <button type="button" data-pr-scope="year" class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${activePRScope === 'year' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-white'}">
          ${latestYear}
        </button>
      </div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
      ${records.map(rec => {
        const act = rec.activity;
        const dateStr = act ? (extractDateStr(act) || '--') : '--';
        const title = act ? escapeHtml(act.activity_name || act.name || act.title || 'Workout') : 'No record yet';
        const valText = rec.format(unit);
        const clickable = Boolean(act);
        return `
          <button
            type="button"
            data-pr-id="${rec.id}"
            ${clickable ? '' : 'disabled'}
            class="text-left group bg-[#1b132e]/70 hover:bg-[#23183b] border border-[#2d2147] hover:border-amber-500/40 rounded-xl p-3 transition flex flex-col justify-between space-y-2 ${clickable ? 'cursor-pointer' : 'opacity-60 cursor-default'}"
          >
            <div class="flex items-center justify-between w-full">
              <span class="inline-flex items-center space-x-1.5 text-[11px] font-semibold text-zinc-300">
                <span>${getSportIcon(rec.sport)}</span>
                <span>${escapeHtml(rec.label)}</span>
              </span>
              <span class="px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold bg-gradient-to-r from-amber-500/20 to-purple-500/20 text-amber-300 border border-amber-500/30">
                PR
              </span>
            </div>
            <div class="text-xl font-bold font-mono text-white group-hover:text-amber-300 transition">
              ${escapeHtml(valText)}
            </div>
            <div class="flex items-center justify-between text-[11px] text-zinc-400 w-full">
              <span class="truncate max-w-[65%]">${title}</span>
              <span class="font-mono text-[10px] text-zinc-500">${escapeHtml(dateStr)}</span>
            </div>
          </button>
        `;
      }).join('')}
    </div>
  `;

  container.querySelectorAll('[data-pr-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      activePRScope = btn.getAttribute('data-pr-scope') || 'all';
      renderPRTrophyCase(rollup, unit);
    });
  });

  container.querySelectorAll('[data-pr-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-pr-id');
      const rec = records.find(r => r.id === id);
      if (rec && rec.activity) {
        openActivityDrawer(rec.activity, unit);
      }
    });
  });
}

/**
 * Computes the 53-week x 7-day (Mon-Sun) 365-day consistency matrix and streak badges.
 * @param {object} rollup
 * @param {string} mode - 'tss' | 'steps' | 'sleep'
 * @param {string|null} referenceDateStr - YYYY-MM-DD end date
 * @returns {object}
 */
export function computeConsistencyData(rollup, mode = 'tss', referenceDateStr = null) {
  const activities = Array.isArray(rollup?.activities) ? rollup.activities : [];
  const wellness = Array.isArray(rollup?.wellness?.daily)
    ? rollup.wellness.daily
    : (Array.isArray(rollup?.daily_wellness)
        ? rollup.daily_wellness
        : (Array.isArray(rollup?.wellness_daily) ? rollup.wellness_daily : []));

  const dailyMap = new Map();

  for (const act of activities) {
    const d = extractDateStr(act);
    if (!d) continue;
    const entry = dailyMap.get(d) || { tss: 0, durationSec: 0, count: 0, steps: 0, stepsGoal: 10000, sleepScore: 0 };
    entry.tss += getTSS(act);
    entry.durationSec += getDurationSeconds(act);
    entry.count += 1;
    dailyMap.set(d, entry);
  }

  for (const w of wellness) {
    const d = extractDateStr(w);
    if (!d) continue;
    const entry = dailyMap.get(d) || { tss: 0, durationSec: 0, count: 0, steps: 0, stepsGoal: 10000, sleepScore: 0 };
    if (w.steps != null) entry.steps = Math.max(entry.steps, Number(w.steps) || 0);
    if (w.steps_goal != null && Number(w.steps_goal) > 0) entry.stepsGoal = Number(w.steps_goal);
    if (w.sleep_score != null) entry.sleepScore = Math.max(entry.sleepScore, Number(w.sleep_score) || 0);
    else if (w.sleep_hours != null) entry.sleepScore = Math.max(entry.sleepScore, Math.round((Number(w.sleep_hours) || 0) * 12));
    else if (w.sleep_seconds != null) entry.sleepScore = Math.max(entry.sleepScore, Math.min(100, Math.round((Number(w.sleep_seconds) / 28800) * 85)));
    if (entry.tss === 0 && w.training_load != null) entry.tss = Number(w.training_load) || 0;
    dailyMap.set(d, entry);
  }

  let endDate;
  if (referenceDateStr) {
    endDate = new Date(`${referenceDateStr}T00:00:00Z`);
    if (Number.isNaN(endDate.getTime())) {
      endDate = new Date();
    }
  } else {
    const allDates = Array.from(dailyMap.keys()).sort();
    endDate = allDates.length ? new Date(`${allDates[allDates.length - 1]}T00:00:00Z`) : new Date();
  }

  // Build 365 days ending at endDate, aligned to a 53-week x 7-day (Mon-Sun) grid
  const startRaw = new Date(endDate);
  startRaw.setUTCDate(startRaw.getUTCDate() - 364);
  const startDow = (startRaw.getUTCDay() + 6) % 7; // 0 = Mon, 6 = Sun
  const gridStart = new Date(startRaw);
  gridStart.setUTCDate(gridStart.getUTCDate() - startDow);

  const weeks = [];
  let activeDays365 = 0;
  let totalSec365 = 0;
  let currentActiveStreak = 0;
  let runningActiveStreak = 0;
  let longestStepStreak = 0;
  let runningStepStreak = 0;

  for (let w = 0; w < 53; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(gridStart);
      cellDate.setUTCDate(gridStart.getUTCDate() + w * 7 + d);
      const dateStr = cellDate.toISOString().slice(0, 10);
      const inRange = cellDate >= startRaw && cellDate <= endDate;
      const data = dailyMap.get(dateStr) || { tss: 0, durationSec: 0, count: 0, steps: 0, stepsGoal: 10000, sleepScore: 0 };

      let value = 0;
      let level = 0;
      if (inRange) {
        if (data.count > 0) {
          activeDays365 += 1;
          totalSec365 += data.durationSec;
          runningActiveStreak += 1;
        } else {
          runningActiveStreak = 0;
        }
        currentActiveStreak = runningActiveStreak;

        if (data.steps >= data.stepsGoal && data.steps > 0) {
          runningStepStreak += 1;
          if (runningStepStreak > longestStepStreak) longestStepStreak = runningStepStreak;
        } else {
          runningStepStreak = 0;
        }

        if (mode === 'tss') {
          value = data.tss;
          level = value <= 0 ? 0 : value < 40 ? 1 : value < 80 ? 2 : value < 130 ? 3 : 4;
        } else if (mode === 'steps') {
          value = data.steps;
          const ratio = data.stepsGoal > 0 ? value / data.stepsGoal : 0;
          level = value <= 0 ? 0 : ratio < 0.5 ? 1 : ratio < 0.85 ? 2 : ratio < 1.0 ? 3 : 4;
        } else {
          value = data.sleepScore;
          level = value <= 0 ? 0 : value < 55 ? 1 : value < 70 ? 2 : value < 85 ? 3 : 4;
        }
      }

      week.push({
        dateStr,
        inRange,
        value,
        level,
        count: data.count,
        tss: data.tss,
        steps: data.steps,
        sleepScore: data.sleepScore
      });
    }
    weeks.push(week);
  }

  return {
    mode,
    weeks,
    badges: {
      currentActiveStreak,
      longestStepStreak,
      activeDays365,
      totalAnnualHours: Math.round((totalSec365 / 3600) * 10) / 10
    }
  };
}

let activeHeatmapMode = 'tss';

const LEVEL_COLORS = {
  0: 'bg-[#161026] border-[#261c3d]',
  1: 'bg-purple-900/60 border-purple-700/40',
  2: 'bg-purple-700/75 border-purple-500/50',
  3: 'bg-purple-500/85 border-purple-400/60',
  4: 'bg-emerald-400 border-emerald-300/80'
};

/**
 * Renders the 365-Day Year-in-Pixels Consistency Heatmap into a container.
 * @param {object} rollup
 * @param {HTMLElement|null} containerEl
 * @param {object} options - { onSelectDate }
 */
export function renderConsistencyHeatmap(rollup, containerEl = null, options = {}) {
  const target = containerEl || document.getElementById('consistency-heatmap-card');
  if (!target) return;

  const data = computeConsistencyData(rollup, activeHeatmapMode);
  const { badges, weeks } = data;

  target.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <h3 class="text-sm font-semibold text-white tracking-tight">365-Day Consistency Heatmap</h3>
        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-emerald-300 border-emerald-500/35 bg-emerald-500/15">
          YEAR IN PIXELS
        </span>
      </div>
      <div class="flex items-center space-x-1 bg-[#0b0714] p-0.5 rounded-lg border border-[#2d2147]">
        <button type="button" data-heatmap-mode="tss" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${activeHeatmapMode === 'tss' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-white'}">
          Training Load (TSS)
        </button>
        <button type="button" data-heatmap-mode="steps" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${activeHeatmapMode === 'steps' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-white'}">
          Daily Steps Goal
        </button>
        <button type="button" data-heatmap-mode="sleep" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${activeHeatmapMode === 'sleep' ? 'bg-purple-600 text-white' : 'text-zinc-400 hover:text-white'}">
          Sleep &amp; Recovery
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Current Active Streak</div>
        <div class="text-base font-bold font-mono text-white">${badges.currentActiveStreak}d</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Longest Step Goal Streak</div>
        <div class="text-base font-bold font-mono text-emerald-400">${badges.longestStepStreak}d</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Active Days (Last 365d)</div>
        <div class="text-base font-bold font-mono text-purple-300">${badges.activeDays365}</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Total Annual Hours</div>
        <div class="text-base font-bold font-mono text-amber-300">${badges.totalAnnualHours}h</div>
      </div>
    </div>

    <div class="overflow-x-auto pt-2">
      <div class="inline-grid grid-flow-col gap-1" style="grid-template-rows: repeat(7, minmax(0, 1fr));">
        ${weeks.map(week => week.map(cell => {
          const colorCls = cell.inRange ? (LEVEL_COLORS[cell.level] || LEVEL_COLORS[0]) : 'opacity-0 pointer-events-none';
          const metricLabel = activeHeatmapMode === 'tss'
            ? `${Math.round(cell.tss)} TSS`
            : activeHeatmapMode === 'steps'
              ? `${cell.steps.toLocaleString()} steps`
              : `Sleep ${cell.sleepScore}`;
          const title = `${cell.dateStr}: ${metricLabel} (${cell.count} workouts)`;
          return `<button type="button" data-heatmap-date="${cell.dateStr}" title="${escapeHtml(title)}" class="w-2.5 h-2.5 rounded-[2px] border ${colorCls} hover:ring-1 hover:ring-white transition"></button>`;
        }).join('')).join('')}
      </div>
    </div>
  `;

  target.querySelectorAll('[data-heatmap-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeHeatmapMode = btn.getAttribute('data-heatmap-mode') || 'tss';
      renderConsistencyHeatmap(rollup, target, options);
    });
  });

  target.querySelectorAll('[data-heatmap-date]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dateStr = btn.getAttribute('data-heatmap-date');
      if (dateStr && typeof options.onSelectDate === 'function') {
        options.onSelectDate(dateStr);
      }
    });
  });
}
