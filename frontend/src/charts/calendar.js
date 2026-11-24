/**
 * frontend/src/charts/calendar.js
 *
 * Garmin Connect-style Training & Wellness Calendar.
 * Supports both an inline collapsible section (#calendar-section) and a
 * fullscreen modal (#calendar-modal), sharing reactive state:
 * - Month / Year navigation (Prev, Next, Year selector, Today)
 * - Sport Filter Pills (All, Running, Cycling, Strength, Hiking, Walking, Other)
 * - Wellness Layer Toggle Chips (Body Battery, Sleep, Steps, RHR & Stress)
 * - 8-column Mon–Sun + Weekly Summary grid
 * - Selected Day Detail Panel (#calendar-day-detail) with activity cards & 4-pill wellness summary
 */

import { openActivityDrawer } from './activities.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const CALENDAR_SPORT_FILTERS = [
  'All',
  'Running',
  'Cycling',
  'Strength',
  'Hiking',
  'Walking',
  'Other'
];

export const WELLNESS_LAYERS = [
  { id: 'body_battery', label: 'Body Battery', icon: '⚡' },
  { id: 'sleep', label: 'Sleep', icon: '🌙' },
  { id: 'steps', label: 'Steps', icon: '👣' },
  { id: 'rhr_stress', label: 'RHR & Stress', icon: '❤️' }
];

const CALENDAR_COLLAPSED_KEY = 'garmin_dash_calendar_collapsed';
const CUSTOMIZATION_KEY = 'garmin_dash_customization';

export function loadCalendarCollapsedState() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(CALENDAR_COLLAPSED_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    const custRaw = localStorage.getItem(CUSTOMIZATION_KEY);
    if (custRaw) {
      const parsed = JSON.parse(custRaw);
      if (typeof parsed?.calendar_collapsed === 'boolean') {
        return parsed.calendar_collapsed;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return false;
}

export function saveCalendarCollapsedState(collapsed) {
  const val = Boolean(collapsed);
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CALENDAR_COLLAPSED_KEY, val ? 'true' : 'false');
    const custRaw = localStorage.getItem(CUSTOMIZATION_KEY);
    let cust = {};
    if (custRaw) {
      try { cust = JSON.parse(custRaw) || {}; } catch { cust = {}; }
    }
    cust.calendar_collapsed = val;
    localStorage.setItem(CUSTOMIZATION_KEY, JSON.stringify(cust));
  } catch {
    // Ignore storage errors
  }
}

export function applyCalendarCollapsedState(collapsed) {
  const val = Boolean(collapsed);
  const inlineBody = document.getElementById('calendar-inline-body');
  if (inlineBody) {
    inlineBody.classList.toggle('hidden', val);
  }
  const toggleBtn = document.getElementById('btn-toggle-inline-calendar');
  if (toggleBtn) {
    toggleBtn.textContent = val ? 'Expand' : 'Collapse';
    toggleBtn.setAttribute('aria-expanded', val ? 'false' : 'true');
  }
}

// Shared reactive calendar state
const calendarState = {
  year: null,
  month: null, // 0-indexed (0 = Jan, 11 = Dec)
  selectedDate: null,
  sportFilter: 'All',
  activeLayers: new Set(['body_battery', 'sleep', 'steps', 'rhr_stress']),
  inlineCollapsed: loadCalendarCollapsedState(),
  modalOpen: false,
  rollup: null,
  unit: 'metric',
  latestDateStr: null,
  onOpenMetricTrend: null,
  initialized: false
};

/**
 * Normalizes an activity's sport/type into one of the canonical calendar categories.
 * @param {object} act
 * @returns {'Running'|'Cycling'|'Strength'|'Hiking'|'Walking'|'Other'}
 */
export function normalizeSportCategory(act) {
  const raw = String(act?.type || act?.sport || act?.activity_type || '').toLowerCase();
  if (raw.includes('run') || raw.includes('treadmill') || raw.includes('trail')) return 'Running';
  if (raw.includes('cycl') || raw.includes('bik') || raw.includes('ride') || raw.includes('spin')) return 'Cycling';
  if (raw.includes('strength') || raw.includes('weight') || raw.includes('gym') || raw.includes('lift')) return 'Strength';
  if (raw.includes('hik') || raw.includes('mount')) return 'Hiking';
  if (raw.includes('walk')) return 'Walking';
  return 'Other';
}

/**
 * Extracts YYYY-MM-DD from an activity or wellness record.
 * @param {object} item
 * @returns {string|null}
 */
export function extractDateStr(item) {
  const raw = item?.date || item?.start_time || item?.timestamp || item?.calendar_date;
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Formats duration in seconds to a compact string (e.g. "1h 25m" or "42m").
 * @param {number} seconds
 * @returns {string}
 */
export function formatCalendarDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0m';
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (hrs > 0) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  return `${Math.max(1, mins)}m`;
}

/**
 * Formats distance in meters to km or mi.
 * @param {number} meters
 * @param {'metric'|'imperial'} unit
 * @returns {string}
 */
export function formatCalendarDistance(meters, unit = 'metric') {
  const m = Math.max(0, Number(meters) || 0);
  if (unit === 'imperial' || unit === 'mi') {
    const mi = m / 1609.344;
    return `${mi.toFixed(mi >= 10 ? 1 : 2)} mi`;
  }
  const km = m / 1000;
  return `${km.toFixed(km >= 10 ? 1 : 2)} km`;
}

function getActivityDistanceMeters(act) {
  if (typeof act?.distance_meters === 'number') return act.distance_meters;
  if (typeof act?.distance_m === 'number') return act.distance_m;
  if (typeof act?.distance_km === 'number') return act.distance_km * 1000;
  if (typeof act?.distance === 'number') return act.distance;
  return 0;
}

function getActivityDurationSec(act) {
  if (typeof act?.duration_seconds === 'number') return act.duration_seconds;
  if (typeof act?.moving_time_seconds === 'number') return act.moving_time_seconds;
  if (typeof act?.duration_s === 'number') return act.duration_s;
  if (typeof act?.duration_sec === 'number') return act.duration_sec;
  if (typeof act?.duration_min === 'number') return act.duration_min * 60;
  if (typeof act?.duration === 'number') return act.duration;
  return 0;
}

function getActivityElevationM(act) {
  if (typeof act?.elevation_gain_meters === 'number') return act.elevation_gain_meters;
  if (typeof act?.elevation_gain_m === 'number') return act.elevation_gain_m;
  if (typeof act?.elevation_m === 'number') return act.elevation_m;
  return 0;
}

function getActivityTss(act) {
  if (typeof act?.tss === 'number') return act.tss;
  if (typeof act?.training_stress_score === 'number') return act.training_stress_score;
  return 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateStr(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/**
 * Builds the 8-column (Mon–Sun + Weekly Summary) calendar grid for a given month.
 *
 * @param {number} year - Full year (e.g. 2026)
 * @param {number} month - 0-indexed month (0..11)
 * @param {Array<object>} activities - All activities
 * @param {Array<object>} wellnessRecords - Daily wellness records
 * @param {string} sportFilter - 'All' or one of CALENDAR_SPORT_FILTERS
 * @param {string|null} todayDateStr - Optional YYYY-MM-DD highlight date
 * @returns {Array<{ days: Array<object>, summary: object }>}
 */
export function buildCalendarWeeks(
  year,
  month,
  activities = [],
  wellnessRecords = [],
  sportFilter = 'All',
  todayDateStr = null
) {
  // Index activities by date
  const actsByDate = new Map();
  for (const act of activities || []) {
    if (sportFilter && sportFilter !== 'All' && normalizeSportCategory(act) !== sportFilter) {
      continue;
    }
    const dStr = extractDateStr(act);
    if (!dStr) continue;
    if (!actsByDate.has(dStr)) actsByDate.set(dStr, []);
    actsByDate.get(dStr).push(act);
  }

  // Index wellness by date
  const wellnessByDate = new Map();
  for (const w of wellnessRecords || []) {
    const dStr = extractDateStr(w);
    if (dStr) wellnessByDate.set(dStr, w);
  }

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // Convert JS getUTCDay() (0=Sun..6=Sat) to Mon=0..Sun=6
  const startOffset = (firstOfMonth.getUTCDay() + 6) % 7;

  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const weeks = [];

  for (let i = 0; i < totalCells; i += 7) {
    const days = [];
    let activityCount = 0;
    let totalDistanceMeters = 0;
    let totalDurationSec = 0;
    let totalCalories = 0;
    let totalElevationM = 0;
    let totalTss = 0;
    let sleepSum = 0;
    let sleepCount = 0;
    let bbPeakSum = 0;
    let bbPeakCount = 0;

    for (let d = 0; d < 7; d++) {
      const cellIdx = i + d;
      const dayOffset = cellIdx - startOffset + 1;
      const cellDate = new Date(Date.UTC(year, month, dayOffset));
      const cYear = cellDate.getUTCFullYear();
      const cMonth = cellDate.getUTCMonth();
      const cDay = cellDate.getUTCDate();
      const dateStr = toDateStr(cYear, cMonth, cDay);
      const inMonth = cMonth === month && cYear === year;

      const dayActs = actsByDate.get(dateStr) || [];
      const dayWellness = wellnessByDate.get(dateStr) || null;

      for (const act of dayActs) {
        activityCount += 1;
        totalDistanceMeters += getActivityDistanceMeters(act);
        totalDurationSec += getActivityDurationSec(act);
        totalCalories += Number(act?.calories) || 0;
        totalElevationM += getActivityElevationM(act);
        totalTss += getActivityTss(act);
      }

      if (dayWellness) {
        if (typeof dayWellness.sleep_score === 'number') {
          sleepSum += dayWellness.sleep_score;
          sleepCount += 1;
        }
        if (typeof dayWellness.body_battery_high === 'number') {
          bbPeakSum += dayWellness.body_battery_high;
          bbPeakCount += 1;
        }
      }

      days.push({
        dateStr,
        dayNum: cDay,
        inMonth,
        isToday: todayDateStr ? dateStr === todayDateStr : false,
        activities: dayActs,
        wellness: dayWellness
      });
    }

    weeks.push({
      days,
      summary: {
        activityCount,
        totalDistanceMeters,
        totalDurationSec,
        totalCalories: Math.round(totalCalories),
        totalElevationM: Math.round(totalElevationM),
        totalTss: Math.round(totalTss),
        avgSleepScore: sleepCount > 0 ? Math.round(sleepSum / sleepCount) : null,
        avgBodyBatteryPeak: bbPeakCount > 0 ? Math.round(bbPeakSum / bbPeakCount) : null
      }
    });
  }

  return weeks;
}

function getSportPillStyle(category) {
  switch (category) {
    case 'Running':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'Cycling':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'Strength':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'Hiking':
      return 'bg-teal-500/15 text-teal-300 border-teal-500/30';
    case 'Walking':
      return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    default:
      return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
  }
}

function getSportEmoji(category) {
  switch (category) {
    case 'Running': return '🏃';
    case 'Cycling': return '🚴';
    case 'Strength': return '🏋️';
    case 'Hiking': return '🥾';
    case 'Walking': return '🚶';
    default: return '⚡';
  }
}

function formatSleepDuration(minutesOrHours) {
  const val = Number(minutesOrHours);
  if (!Number.isFinite(val) || val <= 0) return '--';
  const totalMins = val > 24 ? Math.round(val) : Math.round(val * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${h}h ${pad2(m)}m`;
}

function renderCalendarHTML(containerId, isModal = false) {
  const { year, month, selectedDate, sportFilter, activeLayers, rollup, unit, latestDateStr } = calendarState;
  const activities = rollup?.activities || [];
  const wellnessRecords = rollup?.wellness?.daily || rollup?.wellness_daily || [];

  const weeks = buildCalendarWeeks(year, month, activities, wellnessRecords, sportFilter, latestDateStr);
  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  // Determine available years for dropdown
  const yearSet = new Set([year - 1, year, year + 1]);
  for (const act of activities) {
    const d = extractDateStr(act);
    if (d) yearSet.add(Number(d.slice(0, 4)));
  }
  const sortedYears = Array.from(yearSet).sort((a, b) => b - a);

  const navHtml = `
    <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <button type="button" data-cal-action="prev-month" class="px-2.5 py-1.5 rounded-lg bg-[#1b132e] hover:bg-[#2d2147] text-zinc-200 border border-[#2d2147] text-xs font-semibold transition" aria-label="Previous Month">◀</button>
        <div class="text-sm font-semibold text-white min-w-[130px] text-center">${monthLabel}</div>
        <button type="button" data-cal-action="next-month" class="px-2.5 py-1.5 rounded-lg bg-[#1b132e] hover:bg-[#2d2147] text-zinc-200 border border-[#2d2147] text-xs font-semibold transition" aria-label="Next Month">▶</button>
        <select data-cal-action="select-year" class="bg-[#0b0714] border border-[#2d2147] rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-purple-400">
          ${sortedYears.map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
        <button type="button" data-cal-action="today" class="px-2.5 py-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 text-xs font-semibold transition">Today</button>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        ${CALENDAR_SPORT_FILTERS.map(sf => `
          <button
            type="button"
            data-cal-sport="${sf}"
            class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
              sportFilter === sf
                ? 'bg-purple-500/25 text-white border-purple-400'
                : 'bg-[#130d21] text-zinc-400 border-[#2d2147] hover:text-zinc-200'
            }"
          >${sf}</button>
        `).join('')}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mr-1">Wellness Layers:</span>
        ${WELLNESS_LAYERS.map(layer => {
          const active = activeLayers.has(layer.id);
          return `
            <button
              type="button"
              data-cal-layer="${layer.id}"
              class="px-2.5 py-1 rounded-full text-[11px] font-medium border transition flex items-center space-x-1 ${
                active
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                  : 'bg-[#130d21] text-zinc-500 border-[#2d2147] hover:text-zinc-300'
              }"
            >
              <span>${layer.icon}</span>
              <span>${layer.label}</span>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const gridHeaderHtml = `
    <div class="grid grid-cols-8 gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 pb-1.5">
      ${WEEKDAY_HEADERS.map(d => `<div class="text-center py-1">${d}</div>`).join('')}
      <div class="text-center py-1 text-purple-300">Week Summary</div>
    </div>
  `;

  const gridRowsHtml = weeks.map(week => {
    const dayCellsHtml = week.days.map(day => {
      const isSelected = selectedDate === day.dateStr;
      const borderClass = isSelected
        ? 'border-purple-400 ring-1 ring-purple-400/50 bg-[#1b132e]'
        : day.isToday
          ? 'border-emerald-500/50 bg-[#130d21]'
          : 'border-[#2d2147] bg-[#0e091a] hover:border-purple-500/40';
      const opacityClass = day.inMonth ? '' : 'opacity-45';

      const actPills = day.activities.slice(0, 3).map((act, idx) => {
        const cat = normalizeSportCategory(act);
        const distM = getActivityDistanceMeters(act);
        const durS = getActivityDurationSec(act);
        const metricText = distM > 0 ? formatCalendarDistance(distM, unit) : formatCalendarDuration(durS);
        const actId = act.id ?? act.activity_id ?? `${day.dateStr}-${idx}`;
        return `
          <button
            type="button"
            data-cal-act-date="${day.dateStr}"
            data-cal-act-idx="${idx}"
            data-cal-act-id="${actId}"
            class="w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center justify-between gap-1 transition hover:brightness-125 ${getSportPillStyle(cat)}"
            title="${act.name || cat}"
          >
            <span class="truncate">${getSportEmoji(cat)} ${metricText}</span>
          </button>
        `;
      }).join('');

      const extraCount = day.activities.length > 3
        ? `<div class="text-[9px] text-zinc-400 font-mono pl-1">+${day.activities.length - 3} more</div>`
        : '';

      const w = day.wellness;
      const wellnessBadges = [];
      if (w) {
        if (activeLayers.has('body_battery') && typeof w.body_battery_high === 'number') {
          const lo = typeof w.body_battery_low === 'number' ? w.body_battery_low : '--';
          wellnessBadges.push(`<span class="text-[9px] font-mono text-sky-300">⚡${w.body_battery_high}/${lo}</span>`);
        }
        if (activeLayers.has('sleep') && (typeof w.sleep_score === 'number' || typeof w.sleep_duration_min === 'number')) {
          const sTxt = typeof w.sleep_score === 'number' ? `${w.sleep_score}` : formatSleepDuration(w.sleep_duration_min);
          wellnessBadges.push(`<span class="text-[9px] font-mono text-purple-300">🌙${sTxt}</span>`);
        }
        if (activeLayers.has('steps') && typeof w.steps === 'number') {
          const k = w.steps >= 1000 ? `${(w.steps / 1000).toFixed(1)}k` : `${w.steps}`;
          wellnessBadges.push(`<span class="text-[9px] font-mono text-emerald-300">👣${k}</span>`);
        }
        if (activeLayers.has('rhr_stress') && (typeof w.resting_hr === 'number' || typeof w.stress_avg === 'number')) {
          const rhr = typeof w.resting_hr === 'number' ? `${w.resting_hr}` : '--';
          wellnessBadges.push(`<span class="text-[9px] font-mono text-rose-300">❤️${rhr}</span>`);
        }
      }

      return `
        <div
          data-cal-date="${day.dateStr}"
          role="button"
          tabindex="0"
          class="min-h-[88px] ${isModal ? 'sm:min-h-[108px]' : ''} p-1.5 rounded-lg border cursor-pointer transition flex flex-col justify-between ${borderClass} ${opacityClass}"
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-[11px] font-mono font-semibold ${day.isToday ? 'text-emerald-400' : 'text-zinc-300'}">${day.dayNum}</span>
            ${day.isToday ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>' : ''}
          </div>
          <div class="space-y-1 flex-1">
            ${actPills}
            ${extraCount}
          </div>
          ${wellnessBadges.length > 0 ? `<div class="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-1 pt-1 border-t border-[#2d2147]/60">${wellnessBadges.join('')}</div>` : ''}
        </div>
      `;
    }).join('');

    const s = week.summary;
    const summaryCellHtml = `
      <div class="min-h-[88px] ${isModal ? 'sm:min-h-[108px]' : ''} p-2 rounded-lg border border-[#2d2147] bg-[#130d21]/90 flex flex-col justify-between text-[10px]">
        <div class="font-mono font-semibold text-purple-300">${s.activityCount} ${s.activityCount === 1 ? 'workout' : 'workouts'}</div>
        <div class="space-y-0.5 text-zinc-300 font-mono">
          <div>${formatCalendarDistance(s.totalDistanceMeters, unit)}</div>
          <div>${formatCalendarDuration(s.totalDurationSec)}</div>
          ${s.totalTss > 0 ? `<div class="text-amber-300">${s.totalTss} TSS</div>` : `<div class="text-zinc-400">${s.totalCalories} kcal</div>`}
        </div>
        ${s.avgSleepScore !== null ? `<div class="text-[9px] text-zinc-400 font-mono pt-1 border-t border-[#2d2147]/60">🌙 ${s.avgSleepScore} avg</div>` : ''}
      </div>
    `;

    return `<div class="grid grid-cols-8 gap-1.5">${dayCellsHtml}${summaryCellHtml}</div>`;
  }).join('');

  return `
    ${navHtml}
    <div class="overflow-x-auto">
      <div class="min-w-[680px] space-y-1.5">
        ${gridHeaderHtml}
        ${gridRowsHtml}
      </div>
    </div>
    <div id="${containerId}-day-detail" class="pt-3 border-t border-[#2d2147]">
      ${renderSelectedDayDetailHTML()}
    </div>
  `;
}

function renderSelectedDayDetailHTML() {
  const { selectedDate, rollup, unit, sportFilter } = calendarState;
  if (!selectedDate) {
    return `<div class="text-xs text-zinc-500 py-2">Select a day on the calendar to inspect workouts and daily wellness.</div>`;
  }

  const allActs = rollup?.activities || [];
  const dayActs = allActs.filter(a => {
    if (extractDateStr(a) !== selectedDate) return false;
    if (sportFilter && sportFilter !== 'All' && normalizeSportCategory(a) !== sportFilter) return false;
    return true;
  });

  const wellnessRecords = rollup?.wellness?.daily || rollup?.wellness_daily || [];
  const dayWellness = wellnessRecords.find(w => extractDateStr(w) === selectedDate) || null;

  const actsHtml = dayActs.length > 0
    ? dayActs.map((act, idx) => {
        const cat = normalizeSportCategory(act);
        const dist = formatCalendarDistance(getActivityDistanceMeters(act), unit);
        const dur = formatCalendarDuration(getActivityDurationSec(act));
        const hr = act.avg_hr ? `${Math.round(act.avg_hr)} bpm` : '--';
        const cals = act.calories ? `${Math.round(act.calories)} kcal` : '--';
        return `
          <div
            data-cal-detail-act-idx="${idx}"
            role="button"
            tabindex="0"
            class="p-3 rounded-xl bg-[#130d21] hover:bg-[#1b132e] border border-[#2d2147] hover:border-purple-500/40 cursor-pointer transition flex items-center justify-between gap-3"
          >
            <div class="flex items-center space-x-3 min-w-0">
              <span class="px-2 py-1 rounded-lg text-xs font-semibold border ${getSportPillStyle(cat)}">${getSportEmoji(cat)} ${cat}</span>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-white truncate">${act.title || act.name || cat}</div>
                <div class="text-[11px] text-zinc-400 font-mono">${selectedDate}</div>
              </div>
            </div>
            <div class="flex items-center space-x-4 text-xs font-mono text-zinc-300 shrink-0">
              <span>${dist}</span>
              <span>${dur}</span>
              <span class="hidden sm:inline text-rose-300">${hr}</span>
              <span class="hidden md:inline text-amber-300">${cals}</span>
            </div>
          </div>
        `;
      }).join('')
    : `<div class="text-xs text-zinc-500 py-2">No ${sportFilter !== 'All' ? sportFilter.toLowerCase() + ' ' : ''}activities recorded on ${selectedDate}.</div>`;

  const sleepMinutes = dayWellness
    ? (dayWellness.sleep_duration_min ?? (typeof dayWellness.sleep_seconds === 'number' ? Math.round(dayWellness.sleep_seconds / 60) : null))
    : null;
  const stressVal = dayWellness ? (dayWellness.stress_level ?? dayWellness.stress_avg ?? '--') : '--';

  const wellnessPillsHtml = dayWellness ? `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">🌙 Sleep</div>
        <div class="text-sm font-semibold text-purple-300 font-mono mt-0.5">${dayWellness.sleep_score ?? '--'} <span class="text-[11px] text-zinc-400">${formatSleepDuration(sleepMinutes)}</span></div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">⚡ Body Battery</div>
        <div class="text-sm font-semibold text-sky-300 font-mono mt-0.5">${dayWellness.body_battery_high ?? '--'} / ${dayWellness.body_battery_low ?? '--'}</div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">👣 Steps</div>
        <div class="text-sm font-semibold text-emerald-300 font-mono mt-0.5">${typeof dayWellness.steps === 'number' ? dayWellness.steps.toLocaleString() : '--'}</div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">❤️ RHR / Stress</div>
        <div class="text-sm font-semibold text-rose-300 font-mono mt-0.5">${dayWellness.resting_hr ?? '--'} bpm • ${stressVal}</div>
      </div>
    </div>
  ` : '';

  return `
    <div id="calendar-day-detail" class="space-y-2.5">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-mono uppercase tracking-wider text-purple-300">Selected Day: ${selectedDate}</h3>
        <span class="text-[11px] text-zinc-400 font-mono">${dayActs.length} ${dayActs.length === 1 ? 'activity' : 'activities'}</span>
      </div>
      <div class="space-y-2">${actsHtml}</div>
      ${wellnessPillsHtml}
    </div>
  `;
}

function bindCalendarContainerEvents(container, isModal) {
  if (!container) return;

  const prevBtn = container.querySelector('[data-cal-action="prev-month"]');
  const nextBtn = container.querySelector('[data-cal-action="next-month"]');
  const yearSel = container.querySelector('[data-cal-action="select-year"]');
  const todayBtn = container.querySelector('[data-cal-action="today"]');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (calendarState.month === 0) {
        calendarState.month = 11;
        calendarState.year -= 1;
      } else {
        calendarState.month -= 1;
      }
      rerenderActiveCalendars();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (calendarState.month === 11) {
        calendarState.month = 0;
        calendarState.year += 1;
      } else {
        calendarState.month += 1;
      }
      rerenderActiveCalendars();
    });
  }

  if (yearSel) {
    yearSel.addEventListener('change', (e) => {
      const y = Number(e.target.value);
      if (Number.isFinite(y)) {
        calendarState.year = y;
        rerenderActiveCalendars();
      }
    });
  }

  if (todayBtn) {
    todayBtn.addEventListener('click', () => {
      const target = calendarState.latestDateStr || new Date().toISOString().slice(0, 10);
      const [y, m] = target.split('-').map(Number);
      calendarState.year = y;
      calendarState.month = m - 1;
      calendarState.selectedDate = target;
      rerenderActiveCalendars();
    });
  }

  container.querySelectorAll('[data-cal-sport]').forEach(btn => {
    btn.addEventListener('click', () => {
      calendarState.sportFilter = btn.getAttribute('data-cal-sport') || 'All';
      rerenderActiveCalendars();
    });
  });

  container.querySelectorAll('[data-cal-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layerId = btn.getAttribute('data-cal-layer');
      if (!layerId) return;
      if (calendarState.activeLayers.has(layerId)) {
        calendarState.activeLayers.delete(layerId);
      } else {
        calendarState.activeLayers.add(layerId);
      }
      rerenderActiveCalendars();
    });
  });

  container.querySelectorAll('[data-cal-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      calendarState.selectedDate = cell.getAttribute('data-cal-date');
      rerenderActiveCalendars();
    });
  });

  container.querySelectorAll('[data-cal-act-date]').forEach(pill => {
    pill.addEventListener('click', (e) => {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      const dStr = pill.getAttribute('data-cal-act-date');
      const idx = Number(pill.getAttribute('data-cal-act-idx'));
      const dayActs = (calendarState.rollup?.activities || []).filter(a => {
        if (extractDateStr(a) !== dStr) return false;
        if (calendarState.sportFilter !== 'All' && normalizeSportCategory(a) !== calendarState.sportFilter) return false;
        return true;
      });
      const act = dayActs[idx];
      if (act) openActivityDrawer(act, calendarState.unit);
    });
  });

  container.querySelectorAll('[data-cal-detail-act-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = Number(card.getAttribute('data-cal-detail-act-idx'));
      const dayActs = (calendarState.rollup?.activities || []).filter(a => {
        if (extractDateStr(a) !== calendarState.selectedDate) return false;
        if (calendarState.sportFilter !== 'All' && normalizeSportCategory(a) !== calendarState.sportFilter) return false;
        return true;
      });
      const act = dayActs[idx];
      if (act) openActivityDrawer(act, calendarState.unit);
    });
  });
}

function rerenderActiveCalendars() {
  if (!calendarState.rollup) return;

  const badge = document.getElementById('calendar-month-badge');
  if (badge && calendarState.year !== null && calendarState.month !== null) {
    badge.textContent = `${MONTH_NAMES[calendarState.month].toUpperCase()} ${calendarState.year}`;
  }

  const inlineBody = document.getElementById('calendar-inline-body');
  if (inlineBody && !calendarState.inlineCollapsed) {
    inlineBody.innerHTML = renderCalendarHTML('calendar-inline', false);
    bindCalendarContainerEvents(inlineBody, false);
  }

  const modalBody = document.getElementById('calendar-modal-body');
  if (modalBody && calendarState.modalOpen) {
    modalBody.innerHTML = renderCalendarHTML('calendar-modal', true);
    bindCalendarContainerEvents(modalBody, true);
  }
}

/**
 * Initializes calendar DOM event listeners (navbar button, inline collapse, modal close, Escape).
 */
export function initCalendar({ onOpenMetricTrend } = {}) {
  if (onOpenMetricTrend) {
    calendarState.onOpenMetricTrend = onOpenMetricTrend;
  }
  if (calendarState.initialized) return;
  calendarState.initialized = true;

  const headerBtn = document.getElementById('btn-header-calendar');
  if (headerBtn) {
    headerBtn.addEventListener('click', () => openCalendarModal());
  }

  const openModalBtn = document.getElementById('btn-open-calendar-modal');
  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => openCalendarModal());
  }

  const toggleInlineBtn = document.getElementById('btn-toggle-inline-calendar');
  if (toggleInlineBtn) {
    applyCalendarCollapsedState(calendarState.inlineCollapsed);
    toggleInlineBtn.addEventListener('click', () => {
      calendarState.inlineCollapsed = !calendarState.inlineCollapsed;
      saveCalendarCollapsedState(calendarState.inlineCollapsed);
      applyCalendarCollapsedState(calendarState.inlineCollapsed);
      if (!calendarState.inlineCollapsed) {
        rerenderActiveCalendars();
      }
    });
  }

  const closeModalBtn = document.getElementById('btn-close-calendar-modal');
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => closeCalendarModal());
  }

  const modal = document.getElementById('calendar-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCalendarModal();
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('[data-open-calendar="true"]')) {
      openCalendarModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && calendarState.modalOpen) {
      closeCalendarModal();
    }
  });
}

/**
 * Renders the calendar with the latest rollup data and unit.
 * @param {object} rollup
 * @param {'metric'|'imperial'} unit
 */
export function renderCalendar(rollup, unit = 'metric') {
  if (!rollup) return;
  calendarState.rollup = rollup;
  calendarState.unit = unit;

  // Determine latest date from activities or wellness
  let latest = null;
  for (const act of rollup.activities || []) {
    const d = extractDateStr(act);
    if (d && (!latest || d > latest)) latest = d;
  }
  for (const w of rollup.wellness?.daily || rollup.wellness_daily || []) {
    const d = extractDateStr(w);
    if (d && (!latest || d > latest)) latest = d;
  }
  calendarState.latestDateStr = latest || new Date().toISOString().slice(0, 10);

  if (calendarState.year === null || calendarState.month === null) {
    const [y, m] = calendarState.latestDateStr.split('-').map(Number);
    calendarState.year = y;
    calendarState.month = m - 1;
    calendarState.selectedDate = calendarState.latestDateStr;
  }

  const section = document.getElementById('calendar-section');
  if (section) section.classList.remove('hidden');

  applyCalendarCollapsedState(calendarState.inlineCollapsed);

  rerenderActiveCalendars();
}

/**
 * Opens the fullscreen calendar modal.
 */
export function openCalendarModal() {
  const modal = document.getElementById('calendar-modal');
  if (!modal) return;
  calendarState.modalOpen = true;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  rerenderActiveCalendars();
}

/**
 * Closes the fullscreen calendar modal.
 */
export function closeCalendarModal() {
  const modal = document.getElementById('calendar-modal');
  if (!modal) return;
  calendarState.modalOpen = false;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

/**
 * Clears retained calendar rollup cache (called on Lock Vault).
 */
export function clearCalendarCache() {
  calendarState.rollup = null;
  calendarState.selectedDate = null;
  calendarState.latestDateStr = null;
}
