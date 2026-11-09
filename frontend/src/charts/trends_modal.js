/**
 * frontend/src/charts/trends_modal.js
 * 
 * Milestone 4: Singular Metric Trend Modals across Time Periods (Garmin Connect Style)
 * 
 * Features:
 * - Clickable metric cards (Sleep, HRV, Resting HR, Steps, Body Battery, Stress, Intensity Minutes, Calories, Thresholds)
 * - Obsidian Dark / Zinc theme (#09090b, #111114, #1f1f24, #18181b, tabular-nums)
 * - Time range selection: 1D, 7D, 1M, 1Y, and Custom date range
 * - Chronological navigation (◀ / ▶) with automatic boundary clamping
 * - High-DPI Canvas 2D trend charts with goal lines, baseline bands, and stacked stages
 * - 4 KPI stat cards in modal header
 * - Detailed chronological telemetry breakdown table
 * - Fullscreen expand/collapse and accessible modal dismissal (Close button, backdrop click, Escape key)
 */

import { Chart } from './chart_engine.js';

// Module state
const state = {
  activeMetric: 'sleep',
  activeRange: '7d',
  anchorDate: null, // Date object (end of window)
  customStartDate: null, // 'YYYY-MM-DD'
  customEndDate: null,   // 'YYYY-MM-DD'
  isExpanded: false,
  chartInstance: null,
  activeRollup: null,
  customThresholds: null
};

// Metric Configurations & Metadata
export const METRIC_CONFIGS = {
  sleep: {
    id: 'sleep',
    title: 'Sleep Duration & Stages',
    subtitle: 'Daily hypnogram stages, sleep score & duration trends',
    unit: 'hours',
    badge: 'OPTIMAL',
    badgeColor: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10',
    icon: `<svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>`
  },
  hrv: {
    id: 'hrv',
    title: 'HRV Status',
    subtitle: 'Nightly HRV root-mean-square (ms) with 7-day rolling average & baseline',
    unit: 'ms',
    badge: 'BALANCED',
    badgeColor: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
    icon: `<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/></svg>`
  },
  resting_hr: {
    id: 'resting_hr',
    title: 'Resting Heart Rate',
    subtitle: 'Daily minimum heart rate & 7-day baseline trends',
    unit: 'bpm',
    badge: 'GOOD',
    badgeColor: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
    icon: `<svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`
  },
  steps: {
    id: 'steps',
    title: 'Daily Steps',
    subtitle: 'Step counts vs 10,000-step daily goal',
    unit: 'steps',
    badge: 'ON TRACK',
    badgeColor: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
    icon: `<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>`
  },
  body_battery: {
    id: 'body_battery',
    title: 'Body Battery',
    subtitle: 'Energy charged during sleep vs drained during daytime activities',
    unit: 'pts',
    badge: 'CHARGED',
    badgeColor: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
    icon: `<svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`
  },
  stress: {
    id: 'stress',
    title: 'Stress Level',
    subtitle: 'All-day autonomic nervous balance across Rest, Low, Med, High zones',
    unit: 'pts',
    badge: 'REST',
    badgeColor: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    icon: `<svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
  },
  intensity_minutes: {
    id: 'intensity_minutes',
    title: 'Active Intensity Minutes',
    subtitle: 'Moderate and vigorous aerobic minutes vs 150m weekly WHO goal',
    unit: 'min',
    badge: 'GOAL MET',
    badgeColor: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
    icon: `<svg class="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
  },
  calories: {
    id: 'calories',
    title: 'Daily Calories',
    subtitle: 'Active calorie expenditure stacked on Basal Metabolic Rate (BMR)',
    unit: 'kcal',
    badge: 'NORMAL',
    badgeColor: 'text-orange-400 border-orange-500/30 bg-orange-500/10',
    icon: `<svg class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z"/></svg>`
  },
  thresholds: {
    id: 'thresholds',
    title: 'Threshold Performance Trends',
    subtitle: 'Aerobic VO2max, Cycling FTP (Watts) & Lactate Threshold HR (bpm)',
    unit: 'mixed',
    badge: 'PROGRESSING',
    badgeColor: 'text-purple-400 border-purple-500/30 bg-purple-500/10',
    icon: `<svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`
  }
};

/**
 * Normalizes input date to local start of day.
 */
function normalizeDate(d) {
  if (!d) return new Date();
  const date = typeof d === 'string' ? new Date(d) : new Date(d.getTime());
  if (isNaN(date.getTime())) return new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Formats a Date into ISO string YYYY-MM-DD.
 */
function toISODate(d) {
  const dt = normalizeDate(d);
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats date for display label (e.g. "Oct 26, 2026").
 */
function formatDisplayDate(d) {
  const dt = normalizeDate(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Parses and returns all available daily records sorted ascending.
 */
function getSortedDailyRecords(rollup) {
  const daily = rollup?.wellness?.daily;
  if (!Array.isArray(daily) || daily.length === 0) return [];
  return [...daily].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Determines latest available recorded date in dataset.
 */
function getDatasetMaxDate(rollup) {
  const daily = getSortedDailyRecords(rollup);
  if (daily.length > 0) {
    return normalizeDate(daily[daily.length - 1].date);
  }
  return normalizeDate(new Date());
}

/**
 * Determines earliest available recorded date in dataset.
 */
function getDatasetMinDate(rollup) {
  const daily = getSortedDailyRecords(rollup);
  if (daily.length > 0) {
    return normalizeDate(daily[0].date);
  }
  return normalizeDate(new Date());
}

/**
 * Filters dataset based on active range and anchor date.
 */
export function getFilteredTelemetryData(metricKey, range, anchorDate, rollup, customStart = null, customEnd = null) {
  const daily = getSortedDailyRecords(rollup);
  const maxDt = getDatasetMaxDate(rollup);
  const anchor = normalizeDate(anchorDate || maxDt);

  let startDate;
  let endDate = anchor;

  if (range === '1d') {
    startDate = anchor;
    endDate = anchor;
  } else if (range === '7d') {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6);
  } else if (range === '1m') {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 29);
  } else if (range === '1y') {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 364);
  } else if (range === 'custom') {
    if (customStart && customEnd) {
      startDate = normalizeDate(customStart);
      endDate = normalizeDate(customEnd);
      if (startDate > endDate) {
        // Swap if out of order
        const temp = startDate;
        startDate = endDate;
        endDate = temp;
      }
    } else {
      startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6);
    }
  } else {
    startDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 6);
  }

  const startIso = toISODate(startDate);
  const endIso = toISODate(endDate);

  if (metricKey === 'thresholds') {
    const rawTrends = rollup?.physiological?.threshold_trends || [];
    const filtered = rawTrends.filter(t => t.date >= startIso && t.date <= endIso);
    return {
      startDate,
      endDate,
      startIso,
      endIso,
      records: filtered.length > 0 ? filtered : (range === '1y' || range === '1m' ? rawTrends : filtered),
      totalAvailable: rawTrends.length
    };
  }

  const records = daily.filter(d => d.date >= startIso && d.date <= endIso);

  return {
    startDate,
    endDate,
    startIso,
    endIso,
    records,
    totalAvailable: daily.length
  };
}

/**
 * Opens the Metric Trend Modal initialized to the selected metric.
 * @param {string} metricKey
 * @param {object} rollup
 * @param {object} [customThresholds]
 */
export function openMetricTrendModal(metricKey, rollup, customThresholds = null) {
  const modal = document.getElementById('metric-trend-modal');
  if (!modal) return;

  state.activeMetric = METRIC_CONFIGS[metricKey] ? metricKey : 'sleep';
  state.activeRollup = rollup;
  state.customThresholds = customThresholds;
  state.activeRange = '7d';
  state.customStartDate = null;
  state.customEndDate = null;
  state.isExpanded = false;

  const panel = document.getElementById('trend-modal-panel');
  if (panel) {
    panel.classList.add('max-w-4xl', 'rounded-2xl', 'max-h-[92vh]');
    panel.classList.remove('w-full', 'h-full', 'max-h-screen', 'rounded-none');
  }
  modal.classList.add('p-3', 'sm:p-6');

  const maxDt = getDatasetMaxDate(rollup);
  state.anchorDate = maxDt;

  // Show modal
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  renderModalState();
}

/**
 * Closes the Metric Trend Modal and cleans up chart instance.
 */
export function closeMetricTrendModal() {
  const modal = document.getElementById('metric-trend-modal');
  if (!modal) return;

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  state.isExpanded = false;
  const panel = document.getElementById('trend-modal-panel');
  if (panel) {
    panel.classList.add('max-w-4xl', 'rounded-2xl', 'max-h-[92vh]');
    panel.classList.remove('w-full', 'h-full', 'max-h-screen', 'rounded-none');
  }
  modal.classList.add('p-3', 'sm:p-6');

  if (state.chartInstance) {
    try {
      state.chartInstance.destroy();
    } catch {}
    state.chartInstance = null;
  }
}

/**
 * Toggles fullscreen expand state of modal.
 */
export function toggleExpandModal() {
  const panel = document.getElementById('trend-modal-panel');
  const modal = document.getElementById('metric-trend-modal');
  if (!panel || !modal) return;

  state.isExpanded = !state.isExpanded;

  if (state.isExpanded) {
    panel.classList.remove('max-w-4xl', 'rounded-2xl', 'max-h-[92vh]');
    panel.classList.add('w-full', 'h-full', 'max-h-screen', 'rounded-none');
    modal.classList.remove('p-3', 'sm:p-6');
  } else {
    panel.classList.add('max-w-4xl', 'rounded-2xl', 'max-h-[92vh]');
    panel.classList.remove('w-full', 'h-full', 'max-h-screen', 'rounded-none');
    modal.classList.add('p-3', 'sm:p-6');
  }

  if (state.chartInstance && typeof state.chartInstance._handleResize === 'function') {
    setTimeout(() => {
      if (state.chartInstance && typeof state.chartInstance._handleResize === 'function') {
        state.chartInstance._handleResize();
      }
    }, 50);
  }
}

/**
 * Updates UI controls and re-renders chart, KPIs, and table.
 */
export function renderModalState() {
  const metric = state.activeMetric;
  const cfg = METRIC_CONFIGS[metric] || METRIC_CONFIGS.sleep;
  const rollup = state.activeRollup;

  // 1. Header Details
  const iconEl = document.getElementById('trend-metric-icon');
  const titleEl = document.getElementById('trend-metric-title');
  const subtitleEl = document.getElementById('trend-metric-subtitle');
  const badgeEl = document.getElementById('trend-metric-badge');

  if (iconEl) iconEl.innerHTML = cfg.icon;
  if (titleEl) titleEl.textContent = cfg.title;
  if (subtitleEl) subtitleEl.textContent = cfg.subtitle;
  if (badgeEl) {
    badgeEl.textContent = cfg.badge;
    badgeEl.className = `px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${cfg.badgeColor}`;
  }

  // 2. Active Range Buttons
  const rangeButtons = document.querySelectorAll('[data-trend-range]');
  rangeButtons.forEach(btn => {
    const r = btn.getAttribute('data-trend-range');
    if (r === state.activeRange) {
      btn.className = 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#1f1f24] text-white shadow-sm transition';
    } else {
      btn.className = 'px-2.5 py-1 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition';
    }
  });

  // 3. Custom Date Container Visibility
  const customContainer = document.getElementById('trend-custom-date-container');
  if (customContainer) {
    if (state.activeRange === 'custom') {
      customContainer.classList.remove('hidden');
      const startIn = document.getElementById('trend-input-start-date');
      const endIn = document.getElementById('trend-input-end-date');
      if (startIn && !startIn.value && state.customStartDate) startIn.value = state.customStartDate;
      if (endIn && !endIn.value && state.customEndDate) endIn.value = state.customEndDate;
    } else {
      customContainer.classList.add('hidden');
    }
  }

  // 4. Filter Telemetry Data
  const filter = getFilteredTelemetryData(
    metric,
    state.activeRange,
    state.anchorDate,
    rollup,
    state.customStartDate,
    state.customEndDate
  );

  // 5. Date Navigator Label & Pagination Buttons
  const labelEl = document.getElementById('trend-date-label');
  const prevBtn = document.getElementById('trend-nav-prev');
  const nextBtn = document.getElementById('trend-nav-next');

  if (labelEl) {
    if (state.activeRange === '1d') {
      labelEl.textContent = formatDisplayDate(filter.startDate);
    } else if (state.activeRange === '1y' && filter.records.length > 0 && filter.records.length < 300) {
      labelEl.textContent = `${formatDisplayDate(filter.startDate)} – ${formatDisplayDate(filter.endDate)} (${filter.records.length} days recorded)`;
    } else {
      labelEl.textContent = `${formatDisplayDate(filter.startDate)} – ${formatDisplayDate(filter.endDate)}`;
    }
  }

  const maxDt = getDatasetMaxDate(rollup);
  const minDt = getDatasetMinDate(rollup);
  if (nextBtn) {
    const isAtLatest = normalizeDate(filter.endDate) >= maxDt;
    if (isAtLatest) {
      nextBtn.classList.add('opacity-30', 'cursor-not-allowed', 'pointer-events-none');
    } else {
      nextBtn.classList.remove('opacity-30', 'cursor-not-allowed', 'pointer-events-none');
    }
  }
  if (prevBtn) {
    const isAtEarliest = normalizeDate(filter.startDate) <= minDt;
    if (isAtEarliest) {
      prevBtn.classList.add('opacity-30', 'cursor-not-allowed', 'pointer-events-none');
    } else {
      prevBtn.classList.remove('opacity-30', 'cursor-not-allowed', 'pointer-events-none');
    }
  }

  // 6. Render KPI Stat Cards
  renderKPICards(metric, filter.records, cfg);

  // 7. Render Main Chart
  renderMetricChart(metric, filter.records, filter.startDate, filter.endDate);

  // 8. Render Breakdown Table
  renderBreakdownTable(metric, filter.records, cfg);
}

/**
 * Chronological Pagination (◀ previous / ▶ next).
 */
export function navigateDatePeriod(direction) {
  const maxDt = getDatasetMaxDate(state.activeRollup);
  const minDt = getDatasetMinDate(state.activeRollup);
  const current = normalizeDate(state.anchorDate || maxDt);
  let daysShift = 7;

  if (state.activeRange === '1d') daysShift = 1;
  else if (state.activeRange === '7d') daysShift = 7;
  else if (state.activeRange === '1m') daysShift = 30;
  else if (state.activeRange === '1y') daysShift = 365;
  else if (state.activeRange === 'custom' && state.customStartDate && state.customEndDate) {
    const s = normalizeDate(state.customStartDate);
    const e = normalizeDate(state.customEndDate);
    daysShift = Math.max(1, Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)));
  }

  const newAnchor = new Date(current.getFullYear(), current.getMonth(), current.getDate() + (direction * daysShift));

  // Clamping to dataset boundaries
  if (newAnchor > maxDt) {
    state.anchorDate = maxDt;
  } else if (newAnchor < minDt) {
    state.anchorDate = minDt;
  } else {
    state.anchorDate = newAnchor;
  }

  renderModalState();
}

/**
 * Sets active time range filter.
 */
export function setTimeRange(range) {
  state.activeRange = range;
  const maxDt = getDatasetMaxDate(state.activeRollup);
  state.anchorDate = maxDt;

  if (range === 'custom') {
    const startIn = document.getElementById('trend-input-start-date');
    const endIn = document.getElementById('trend-input-end-date');
    const startDefault = new Date(maxDt.getFullYear(), maxDt.getMonth(), maxDt.getDate() - 14);
    if (startIn && !startIn.value) startIn.value = toISODate(startDefault);
    if (endIn && !endIn.value) endIn.value = toISODate(maxDt);
    state.customStartDate = startIn ? startIn.value : toISODate(startDefault);
    state.customEndDate = endIn ? endIn.value : toISODate(maxDt);
  }

  renderModalState();
}

/**
 * Applies custom date inputs.
 */
export function applyCustomDateRange() {
  const startIn = document.getElementById('trend-input-start-date');
  const endIn = document.getElementById('trend-input-end-date');
  const errEl = document.getElementById('trend-custom-error');

  if (!startIn || !endIn) return;
  const s = startIn.value;
  const e = endIn.value;

  if (!s || !e || isNaN(new Date(s).getTime()) || isNaN(new Date(e).getTime())) {
    if (errEl) {
      errEl.textContent = 'Please select both valid start and end dates.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (s > e) {
    if (errEl) {
      errEl.textContent = 'Start date must be before or equal to end date.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  if (errEl) errEl.classList.add('hidden');

  state.activeRange = 'custom';
  state.customStartDate = s;
  state.customEndDate = e;
  state.anchorDate = normalizeDate(e);

  renderModalState();
}

/**
 * Renders 4 KPI stat cards inside modal header.
 */
function renderKPICards(metric, records, cfg) {
  const grid = document.getElementById('trend-kpi-grid');
  if (!grid) return;

  if (!records || records.length === 0) {
    grid.innerHTML = `
      <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-zinc-400">Average</div>
        <div class="text-lg font-bold font-mono text-zinc-500 tabular-nums my-1">—</div>
        <div class="text-[10px] text-zinc-500">No data</div>
      </div>
      <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-zinc-400">Minimum</div>
        <div class="text-lg font-bold font-mono text-zinc-500 tabular-nums my-1">—</div>
        <div class="text-[10px] text-zinc-500">No data</div>
      </div>
      <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-zinc-400">Maximum</div>
        <div class="text-lg font-bold font-mono text-zinc-500 tabular-nums my-1">—</div>
        <div class="text-[10px] text-zinc-500">No data</div>
      </div>
      <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-zinc-400">Period Total</div>
        <div class="text-lg font-bold font-mono text-zinc-500 tabular-nums my-1">—</div>
        <div class="text-[10px] text-zinc-500">No data</div>
      </div>
    `;
    return;
  }

  let kpi1 = { label: 'Average', val: '—', sub: '' };
  let kpi2 = { label: 'Minimum', val: '—', sub: '' };
  let kpi3 = { label: 'Maximum', val: '—', sub: '' };
  let kpi4 = { label: 'Current / Total', val: '—', sub: '' };

  if (metric === 'sleep') {
    const hours = records.map(r => (r.sleep_seconds || 0) / 3600);
    const scores = records.map(r => r.sleep_score || 80);
    const avgH = hours.reduce((s, h) => s + h, 0) / hours.length;
    const minH = Math.min(...hours);
    const maxH = Math.max(...hours);
    const avgScore = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);

    kpi1 = { label: 'Avg Duration', val: `${Math.floor(avgH)}h ${Math.round((avgH % 1) * 60)}m`, sub: `${avgH.toFixed(1)} hrs/night` };
    kpi2 = { label: 'Min Sleep', val: `${Math.floor(minH)}h ${Math.round((minH % 1) * 60)}m`, sub: 'Shortest night' };
    kpi3 = { label: 'Max Sleep', val: `${Math.floor(maxH)}h ${Math.round((maxH % 1) * 60)}m`, sub: 'Peak recovery' };
    kpi4 = { label: 'Avg Sleep Score', val: `${avgScore} / 100`, sub: avgScore >= 80 ? 'Optimal' : 'Fair' };
  } else if (metric === 'hrv') {
    const vals = records.map(r => r.hrv_last_night_avg || 54);
    const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const latest = vals[vals.length - 1];

    kpi1 = { label: '7D Avg HRV', val: `${avg} ms`, sub: 'Rolling baseline' };
    kpi2 = { label: 'Min HRV', val: `${min} ms`, sub: 'Lowest night' };
    kpi3 = { label: 'Max HRV', val: `${max} ms`, sub: 'Peak vagal tone' };
    kpi4 = { label: 'Latest Night', val: `${latest} ms`, sub: 'Baseline 48–62 ms' };
  } else if (metric === 'resting_hr') {
    const vals = records.map(r => r.resting_hr || 48);
    const avg = Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const latest = vals[vals.length - 1];

    kpi1 = { label: 'Period Avg RHR', val: `${avg} bpm`, sub: 'Mean resting pulse' };
    kpi2 = { label: 'Lowest RHR', val: `${min} bpm`, sub: 'Deep rest floor' };
    kpi3 = { label: 'Highest RHR', val: `${max} bpm`, sub: 'Fatigue / stress peak' };
    kpi4 = { label: 'Latest Day', val: `${latest} bpm`, sub: 'Optimal aerobic recovery' };
  } else if (metric === 'steps') {
    const recordedRecs = records.filter(r => !r.unrecorded && (r.steps || 0) > 0);
    const effectiveRecs = recordedRecs.length > 0 ? recordedRecs : records;
    const vals = effectiveRecs.map(r => r.steps || 0);
    const sum = records.reduce((s, r) => s + (r.steps || 0), 0);
    const avg = vals.length > 0 ? Math.round(sum / vals.length) : 0;
    const min = vals.length > 0 ? Math.min(...vals) : 0;
    const max = vals.length > 0 ? Math.max(...vals) : 0;
    const daysMet = vals.filter(v => v >= 10000).length;
    const pctMet = vals.length > 0 ? Math.round((daysMet / vals.length) * 100) : 0;

    kpi1 = { label: 'Daily Average', val: `${avg.toLocaleString()} steps`, sub: `${pctMet}% of goal met (${effectiveRecs.length} recorded days)` };
    kpi2 = { label: 'Min Day', val: `${min.toLocaleString()} steps`, sub: 'Active recovery day' };
    kpi3 = { label: 'Max Day', val: `${max.toLocaleString()} steps`, sub: 'Long hike / excursion' };
    kpi4 = { label: 'Period Total', val: `${sum.toLocaleString()} steps`, sub: `${effectiveRecs.length} days accumulated` };
  } else if (metric === 'body_battery') {
    const highs = records.map(r => r.body_battery_high ?? 90);
    const lows = records.map(r => r.body_battery_low ?? 25);
    const charged = records.map(r => r.body_battery_charged ?? 65);
    const drained = records.map(r => r.body_battery_drained ?? 68);

    const avgHigh = Math.round(highs.reduce((s, v) => s + v, 0) / highs.length);
    const avgLow = Math.round(lows.reduce((s, v) => s + v, 0) / lows.length);
    const avgChg = Math.round(charged.reduce((s, v) => s + v, 0) / charged.length);
    const avgDrn = Math.round(drained.reduce((s, v) => s + v, 0) / drained.length);

    kpi1 = { label: 'Avg Peak Battery', val: `${avgHigh} pts`, sub: 'Morning charge level' };
    kpi2 = { label: 'Avg Low Battery', val: `${avgLow} pts`, sub: 'Bedtime reserve level' };
    kpi3 = { label: 'Avg Charged', val: `+${avgChg} pts`, sub: 'Nightly replenishment' };
    kpi4 = { label: 'Avg Drained', val: `-${avgDrn} pts`, sub: 'Daily expenditure' };
  } else if (metric === 'stress') {
    const vals = records.map(r => (typeof r.stress_level === 'number' && !isNaN(r.stress_level)) ? r.stress_level : 24);
    const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const qualifier = avg < 25 ? 'Rest / Low' : (avg < 50 ? 'Low Stress' : 'Medium');

    kpi1 = { label: 'Average Stress', val: `${avg} pts`, sub: qualifier };
    kpi2 = { label: 'Minimum Stress', val: `${min} pts`, sub: 'Restful recovery' };
    kpi3 = { label: 'Peak Stress', val: `${max} pts`, sub: 'Workout / high load' };
    kpi4 = { label: 'Status', val: 'BALANCED', sub: 'Autonomic equilibrium' };
  } else if (metric === 'intensity_minutes') {
    const mod = records.map(r => r.intensity_minutes_moderate || 0);
    const vig = records.map(r => r.intensity_minutes_vigorous || 0);
    const totalMod = mod.reduce((s, v) => s + v, 0);
    const totalVig = vig.reduce((s, v) => s + v, 0);
    const totalWeighted = totalMod + totalVig * 2;
    const weeklyRate = Math.round((totalWeighted / Math.max(1, records.length)) * 7);

    kpi1 = { label: 'Total Active', val: `${totalWeighted} min`, sub: 'Moderate + (Vigorous × 2)' };
    kpi2 = { label: 'Moderate', val: `${totalMod} min`, sub: 'Zone 2 / brisk pace' };
    kpi3 = { label: 'Vigorous', val: `${totalVig} min`, sub: 'Zone 4+ high intensity' };
    kpi4 = { label: 'Weekly Pace', val: `${weeklyRate} min/wk`, sub: `${Math.round((weeklyRate / 150) * 100)}% of WHO 150m goal` };
  } else if (metric === 'calories') {
    const active = records.map(r => (typeof r.active_calories === 'number' && !isNaN(r.active_calories)) ? r.active_calories : 0);
    const bmr = records.map(r => (typeof r.bmr_calories === 'number' && !isNaN(r.bmr_calories)) ? r.bmr_calories : 1730);
    const totals = records.map(r => (typeof r.daily_calories === 'number' && !isNaN(r.daily_calories)) ? r.daily_calories : (((typeof r.active_calories === 'number' && !isNaN(r.active_calories)) ? r.active_calories : 0) + ((typeof r.bmr_calories === 'number' && !isNaN(r.bmr_calories)) ? r.bmr_calories : 1730)));

    const sumTotal = totals.reduce((s, v) => s + v, 0);
    const avgTotal = Math.round(sumTotal / totals.length);
    const avgActive = Math.round(active.reduce((s, v) => s + v, 0) / active.length);
    const maxBurn = Math.max(...totals);

    kpi1 = { label: 'Avg Daily Burn', val: `${avgTotal.toLocaleString()} kcal`, sub: 'Active + BMR calories' };
    kpi2 = { label: 'Avg Active Burn', val: `${avgActive.toLocaleString()} kcal`, sub: 'Workout expenditure' };
    kpi3 = { label: 'Max Single Day', val: `${maxBurn.toLocaleString()} kcal`, sub: 'Peak calorie burn' };
    kpi4 = { label: 'Period Total', val: `${sumTotal.toLocaleString()} kcal`, sub: `${records.length} days burned` };
  } else if (metric === 'thresholds') {
    const ftp = records.map(r => (typeof r.cycling_ftp === 'number' && !isNaN(r.cycling_ftp)) ? r.cycling_ftp : ((typeof r.ftp === 'number' && !isNaN(r.ftp)) ? r.ftp : 280));
    const vo2 = records.map(r => (typeof r.vo2max === 'number' && !isNaN(r.vo2max)) ? r.vo2max : 54);
    const lthr = records.map(r => (typeof r.lthr === 'number' && !isNaN(r.lthr)) ? r.lthr : 168);

    const latestFtp = ftp[ftp.length - 1];
    const latestVo2 = vo2[vo2.length - 1];
    const latestLthr = lthr[lthr.length - 1];
    const ftpDelta = ftp.length > 1 ? latestFtp - ftp[0] : 0;

    kpi1 = { label: 'Cycling FTP', val: `${latestFtp} W`, sub: `${ftpDelta >= 0 ? '+' : ''}${ftpDelta} W progression` };
    kpi2 = { label: 'VO2max', val: `${latestVo2} ml/kg`, sub: 'Aerobic engine ceiling' };
    kpi3 = { label: 'Lactate Threshold', val: `${latestLthr} bpm`, sub: 'Anaerobic tipping point' };
    kpi4 = { label: 'Power-to-Weight', val: `${(latestFtp / 72.0).toFixed(2)} W/kg`, sub: 'Based on 72 kg weight' };
  }

  grid.innerHTML = `
    <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-zinc-400">${kpi1.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-white tabular-nums my-1">${kpi1.val}</div>
      <div class="text-[10px] text-zinc-500 font-mono">${kpi1.sub}</div>
    </div>
    <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-zinc-400">${kpi2.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-white tabular-nums my-1">${kpi2.val}</div>
      <div class="text-[10px] text-zinc-500 font-mono">${kpi2.sub}</div>
    </div>
    <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-zinc-400">${kpi3.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-white tabular-nums my-1">${kpi3.val}</div>
      <div class="text-[10px] text-zinc-500 font-mono">${kpi3.sub}</div>
    </div>
    <div class="bg-[#18181b] border border-[#1f1f24] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-zinc-400">${kpi4.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-emerald-400 tabular-nums my-1">${kpi4.val}</div>
      <div class="text-[10px] text-zinc-500 font-mono">${kpi4.sub}</div>
    </div>
  `;
}

/**
 * Builds datasets and renders canvas chart for selected metric.
 */
function renderMetricChart(metric, records, startDate, endDate) {
  const canvas = document.getElementById('metric-trend-chart');
  const emptyNotice = document.getElementById('trend-chart-empty');
  if (!canvas) return;

  if (state.chartInstance) {
    try {
      state.chartInstance.destroy();
    } catch {}
    state.chartInstance = null;
  }

  if (!records || records.length === 0) {
    if (emptyNotice) emptyNotice.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    const w = typeof canvas.width === 'number' && !isNaN(canvas.width) ? canvas.width : (canvas.clientWidth || 600);
    const h = typeof canvas.height === 'number' && !isNaN(canvas.height) ? canvas.height : (canvas.clientHeight || 300);
    if (ctx) ctx.clearRect(0, 0, w, h);
    return;
  }

  if (emptyNotice) emptyNotice.classList.add('hidden');

  const labels = records.map(r => r.date || 'Day');
  let chartConfig = null;

  if (metric === 'sleep') {
    const deep = records.map(r => Math.round(((r.sleep_deep_seconds || 0) / 3600) * 10) / 10);
    const light = records.map(r => Math.round(((r.sleep_light_seconds || 0) / 3600) * 10) / 10);
    const rem = records.map(r => Math.round(((r.sleep_rem_seconds || 0) / 3600) * 10) / 10);
    const awake = records.map(r => Math.round(((r.sleep_awake_seconds || 0) / 3600) * 10) / 10);
    const scores = records.map(r => Math.round(((r.sleep_score || 80) / 10) * 10) / 10); // Scaled to 0-10h overlay

    chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Deep (h)', data: deep, backgroundColor: '#6366f1' },
          { label: 'Light (h)', data: light, backgroundColor: '#38bdf8' },
          { label: 'REM (h)', data: rem, backgroundColor: '#a855f7' },
          { label: 'Awake (h)', data: awake, backgroundColor: '#f43f5e' },
          { label: 'Score (/10)', data: scores, type: 'line', borderColor: '#fbbf24', borderWidth: 2 }
        ]
      },
      options: {
        scales: {
          x: { stacked: true },
          y: { stacked: true, min: 0, max: 12 }
        },
        annotations: [
          { type: 'line', y: 8.0, color: 'rgba(52, 211, 153, 0.6)', borderDash: [4, 4], label: '8h Target' }
        ]
      }
    };
  } else if (metric === 'hrv') {
    const nightly = records.map(r => r.hrv_last_night_avg || 54);
    const weekly = records.map(r => r.hrv_weekly_avg || 53);

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Nightly HRV (ms)', data: nightly, borderColor: '#10b981', borderWidth: 2, fill: true },
          { label: '7D Rolling Avg', data: weekly, borderColor: '#34d399', borderWidth: 1.5 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false, min: 30, max: 85 }
        },
        annotations: [
          { type: 'band', yMin: 48, yMax: 62, color: 'rgba(16, 185, 129, 0.12)', label: 'Baseline (48–62 ms)' }
        ]
      }
    };
  } else if (metric === 'resting_hr') {
    const rhr = records.map(r => r.resting_hr || 48);
    const rhrAvg = records.map(r => r.resting_hr_7d_avg || 48);

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Daily RHR (bpm)', data: rhr, borderColor: '#f43f5e', borderWidth: 2, fill: true },
          { label: '7D Avg (bpm)', data: rhrAvg, borderColor: '#fb7185', borderWidth: 1.5 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false }
        },
        annotations: [
          { type: 'band', yMin: 44, yMax: 54, color: 'rgba(244, 63, 94, 0.08)', label: 'Normal Range (44-54 bpm)' }
        ]
      }
    };
  } else if (metric === 'steps') {
    const stepsData = records.map(r => r.steps || 0);

    chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Daily Steps',
            data: stepsData,
            backgroundColor: '#10b981'
          }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false }
        },
        annotations: [
          { type: 'line', y: 10000, color: '#10b981', borderDash: [4, 4], label: 'Goal: 10,000' }
        ]
      }
    };
  } else if (metric === 'body_battery') {
    const highs = records.map(r => r.body_battery_high ?? 90);
    const lows = records.map(r => r.body_battery_low ?? 25);
    const charged = records.map(r => r.body_battery_charged ?? 65);
    const drained = records.map(r => r.body_battery_drained ?? 68);

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Peak Charge', data: highs, borderColor: '#10b981', borderWidth: 2 },
          { label: 'Low Reserve', data: lows, borderColor: '#f43f5e', borderWidth: 2 },
          { label: 'Charged (+pts)', data: charged, borderColor: '#34d399', borderWidth: 1.5 },
          { label: 'Drained (-pts)', data: drained, borderColor: '#fb923c', borderWidth: 1.5 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false, min: 0, max: 100 }
        }
      }
    };
  } else if (metric === 'stress') {
    const stressVals = records.map(r => (typeof r.stress_level === 'number' && !isNaN(r.stress_level)) ? r.stress_level : 24);

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Daily Stress Score', data: stressVals, borderColor: '#fbbf24', borderWidth: 2, fill: true }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false, min: 0, max: 100 }
        },
        annotations: [
          { type: 'band', yMin: 0, yMax: 25, color: 'rgba(52, 211, 153, 0.08)', label: 'Rest (0-25)' },
          { type: 'band', yMin: 25, yMax: 50, color: 'rgba(56, 189, 248, 0.08)', label: 'Low (25-50)' },
          { type: 'band', yMin: 50, yMax: 75, color: 'rgba(251, 191, 36, 0.08)', label: 'Med (50-75)' },
          { type: 'band', yMin: 75, yMax: 100, color: 'rgba(248, 113, 113, 0.08)', label: 'High (75-100)' }
        ]
      }
    };
  } else if (metric === 'intensity_minutes') {
    const moderate = records.map(r => r.intensity_minutes_moderate || 0);
    const vigorous = records.map(r => r.intensity_minutes_vigorous || 0);

    chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Moderate (min)', data: moderate, backgroundColor: '#38bdf8' },
          { label: 'Vigorous (min)', data: vigorous, backgroundColor: '#6366f1' }
        ]
      },
      options: {
        scales: {
          x: { stacked: true },
          y: { stacked: true }
        },
        annotations: [
          { type: 'line', y: 150, color: '#38bdf8', borderDash: [4, 4], label: 'WHO Weekly 150m' }
        ]
      }
    };
  } else if (metric === 'calories') {
    const active = records.map(r => (typeof r.active_calories === 'number' && !isNaN(r.active_calories)) ? r.active_calories : 0);
    const bmr = records.map(r => (typeof r.bmr_calories === 'number' && !isNaN(r.bmr_calories)) ? r.bmr_calories : 1730);

    chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Active (kcal)', data: active, backgroundColor: '#f97316' },
          { label: 'BMR (kcal)', data: bmr, backgroundColor: '#3f3f46' }
        ]
      },
      options: {
        scales: {
          x: { stacked: true },
          y: { stacked: true }
        }
      }
    };
  } else if (metric === 'thresholds') {
    const ftp = records.map(r => (typeof r.cycling_ftp === 'number' && !isNaN(r.cycling_ftp)) ? r.cycling_ftp : ((typeof r.ftp === 'number' && !isNaN(r.ftp)) ? r.ftp : 280));
    const lthr = records.map(r => (typeof r.lthr === 'number' && !isNaN(r.lthr)) ? r.lthr : 168);
    const vo2 = records.map(r => (typeof r.vo2max === 'number' && !isNaN(r.vo2max)) ? r.vo2max : 54);

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Cycling FTP (Watts)', data: ftp, borderColor: '#a78bfa', borderWidth: 2 },
          { label: 'LTHR (bpm)', data: lthr, borderColor: '#f43f5e', borderWidth: 2 },
          { label: 'VO2max (ml/kg)', data: vo2, borderColor: '#34d399', borderWidth: 2 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false }
        }
      }
    };
  }

  if (chartConfig) {
    try {
      state.chartInstance = new Chart(canvas, chartConfig);
    } catch (e) {
      console.warn('Failed to render trend chart:', e);
    }
  }
}

/**
 * Renders chronological telemetry breakdown table.
 */
function renderBreakdownTable(metric, records, cfg) {
  const countEl = document.getElementById('trend-table-count');
  const theadRow = document.getElementById('trend-table-header-row');
  const tbody = document.getElementById('trend-table-body');

  if (countEl) {
    countEl.textContent = `${records ? records.length : 0} records`;
  }

  if (!tbody || !theadRow) return;

  if (!records || records.length === 0) {
    theadRow.innerHTML = `<th class="py-2.5 px-3">Date</th><th class="py-2.5 px-3">Value</th><th class="py-2.5 px-3">Status</th>`;
    tbody.innerHTML = `<tr><td colspan="3" class="py-4 text-center text-zinc-500 font-sans text-xs">No records found for the selected period.</td></tr>`;
    return;
  }

  // Reverse chronological for table display (newest first)
  const displayRecords = [...records].reverse();

  if (metric === 'sleep') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Total Duration</th>
      <th class="py-2 px-3 text-right">Sleep Score</th>
      <th class="py-2 px-3 text-right">Deep / REM</th>
      <th class="py-2 px-3 text-right">Quality</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const h = ((r.sleep_seconds || 0) / 3600);
      const score = r.sleep_score || 80;
      const deepH = (((r.sleep_deep_seconds || 0) / 3600)).toFixed(1);
      const remH = (((r.sleep_rem_seconds || 0) / 3600)).toFixed(1);
      const qual = r.sleep_quality || (score >= 80 ? 'Good' : 'Fair');
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-white font-mono">${Math.floor(h)}h ${Math.round((h % 1) * 60)}m</td>
          <td class="py-2 px-3 text-right text-amber-400 font-mono">${score}</td>
          <td class="py-2 px-3 text-right text-zinc-400 font-mono">${deepH}h / ${remH}h</td>
          <td class="py-2 px-3 text-right">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${score >= 80 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-800/40'}">
              ${qual.toUpperCase()}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'hrv') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Last Night HRV</th>
      <th class="py-2 px-3 text-right">7D Baseline</th>
      <th class="py-2 px-3 text-right">Status</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const ln = r.hrv_last_night_avg || 54;
      const wk = r.hrv_weekly_avg || 53;
      const st = r.hrv_status || 'Balanced';
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono font-bold">${ln} ms</td>
          <td class="py-2 px-3 text-right text-zinc-400 font-mono">${wk} ms</td>
          <td class="py-2 px-3 text-right">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono border text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
              ${st.toUpperCase()}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'steps') {
    const recordedRecs = records.filter(r => !r.unrecorded && (r.steps || 0) > 0);
    const avg = recordedRecs.length > 0
      ? Math.round(recordedRecs.reduce((s, r) => s + (r.steps || 0), 0) / recordedRecs.length)
      : 0;
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Steps</th>
      <th class="py-2 px-3 text-right">Goal (10k)</th>
      <th class="py-2 px-3 text-right">Delta vs Avg</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const isUnrecorded = Boolean(r.unrecorded || ((r.steps === 0 || r.steps === null) && records.some(x => x.unrecorded)));
      if (isUnrecorded && (r.steps === 0 || r.steps === null)) {
        return `
          <tr class="hover:bg-[#18181b]/50 transition opacity-60">
            <td class="py-2 px-3 text-zinc-400 font-sans">${r.date}</td>
            <td class="py-2 px-3 text-right text-zinc-500 font-mono italic">Unrecorded</td>
            <td class="py-2 px-3 text-right text-zinc-500 font-mono">—</td>
            <td class="py-2 px-3 text-right font-mono text-zinc-500">—</td>
          </tr>
        `;
      }
      const s = r.steps || 0;
      const pct = Math.round((s / 10000) * 100);
      const delta = s - avg;
      const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`;
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-white font-mono font-bold">${s.toLocaleString()}</td>
          <td class="py-2 px-3 text-right ${pct >= 100 ? 'text-emerald-400' : 'text-zinc-400'} font-mono">${pct}%</td>
          <td class="py-2 px-3 text-right font-mono ${delta >= 0 ? 'text-emerald-400' : 'text-zinc-500'}">${deltaStr}</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'resting_hr') {
    const avg = Math.round((records.reduce((s, r) => s + (r.resting_hr || 48), 0) / records.length) * 10) / 10;
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Resting HR</th>
      <th class="py-2 px-3 text-right">7D Average</th>
      <th class="py-2 px-3 text-right">Delta vs Avg</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const val = r.resting_hr || 48;
      const r7 = r.resting_hr_7d_avg || val;
      const delta = Math.round((val - avg) * 10) / 10;
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-rose-400 font-mono font-bold">${val} bpm</td>
          <td class="py-2 px-3 text-right text-zinc-400 font-mono">${r7} bpm</td>
          <td class="py-2 px-3 text-right font-mono ${delta <= 0 ? 'text-emerald-400' : 'text-rose-400'}">${delta >= 0 ? '+' : ''}${delta} bpm</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'body_battery') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Peak</th>
      <th class="py-2 px-3 text-right">Low</th>
      <th class="py-2 px-3 text-right">Charged</th>
      <th class="py-2 px-3 text-right">Drained</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono font-bold">${r.body_battery_high ?? 90}</td>
          <td class="py-2 px-3 text-right text-rose-400 font-mono">${r.body_battery_low ?? 25}</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono">+${r.body_battery_charged ?? 65}</td>
          <td class="py-2 px-3 text-right text-orange-400 font-mono">-${r.body_battery_drained ?? 68}</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'stress') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Stress Score</th>
      <th class="py-2 px-3 text-right">Level</th>
      <th class="py-2 px-3 text-right">Status</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const sc = (typeof r.stress_level === 'number' && !isNaN(r.stress_level)) ? r.stress_level : 24;
      const q = r.stress_qualifier || (sc < 25 ? 'Rest' : 'Low');
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-amber-400 font-mono font-bold">${sc}</td>
          <td class="py-2 px-3 text-right text-zinc-300 font-mono">${q}</td>
          <td class="py-2 px-3 text-right">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${sc < 25 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'}">
              ${q.toUpperCase()}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'intensity_minutes') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Moderate</th>
      <th class="py-2 px-3 text-right">Vigorous</th>
      <th class="py-2 px-3 text-right">Total Weighted</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const m = r.intensity_minutes_moderate || 0;
      const v = r.intensity_minutes_vigorous || 0;
      const tot = m + v * 2;
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-sky-400 font-mono">${m} min</td>
          <td class="py-2 px-3 text-right text-indigo-400 font-mono">${v} min</td>
          <td class="py-2 px-3 text-right text-white font-mono font-bold">${tot} min</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'calories') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Active</th>
      <th class="py-2 px-3 text-right">BMR</th>
      <th class="py-2 px-3 text-right">Total Burn</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const act = (typeof r.active_calories === 'number' && !isNaN(r.active_calories)) ? r.active_calories : 0;
      const bmr = (typeof r.bmr_calories === 'number' && !isNaN(r.bmr_calories)) ? r.bmr_calories : 1730;
      const tot = (typeof r.daily_calories === 'number' && !isNaN(r.daily_calories)) ? r.daily_calories : (act + bmr);
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-orange-400 font-mono">${act.toLocaleString()} kcal</td>
          <td class="py-2 px-3 text-right text-zinc-400 font-mono">${bmr.toLocaleString()} kcal</td>
          <td class="py-2 px-3 text-right text-white font-mono font-bold">${tot.toLocaleString()} kcal</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'thresholds') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Cycling FTP</th>
      <th class="py-2 px-3 text-right">VO2max</th>
      <th class="py-2 px-3 text-right">LTHR</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const ftp = (typeof r.cycling_ftp === 'number' && !isNaN(r.cycling_ftp)) ? r.cycling_ftp : ((typeof r.ftp === 'number' && !isNaN(r.ftp)) ? r.ftp : 280);
      const vo2 = (typeof r.vo2max === 'number' && !isNaN(r.vo2max)) ? r.vo2max : 54;
      const lthr = (typeof r.lthr === 'number' && !isNaN(r.lthr)) ? r.lthr : 168;
      return `
        <tr class="hover:bg-[#18181b]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-purple-400 font-mono font-bold">${ftp} W</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono font-bold">${vo2} ml/kg</td>
          <td class="py-2 px-3 text-right text-rose-400 font-mono font-bold">${lthr} bpm</td>
        </tr>
      `;
    }).join('');
  }
}

/**
 * Initializes all trends modal UI event listeners.
 */
export function initTrendsModal() {
  const modal = document.getElementById('metric-trend-modal');
  if (!modal) return;

  // Backdrop click dismiss
  const backdrop = document.getElementById('trend-modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      closeMetricTrendModal();
    });
  }

  // Close button
  const closeBtn = document.getElementById('btn-close-trend-modal');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeMetricTrendModal();
    });
  }

  // Fullscreen expand button
  const expandBtn = document.getElementById('btn-expand-trend-modal');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      toggleExpandModal();
    });
  }

  // Time range selector buttons (1D, 7D, 1M, 1Y, Custom)
  const rangeButtons = document.querySelectorAll('[data-trend-range]');
  rangeButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const r = btn.getAttribute('data-trend-range');
      if (r) setTimeRange(r);
    });
  });

  // Chronological navigation buttons
  const prevBtn = document.getElementById('trend-nav-prev');
  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigateDatePeriod(-1);
    });
  }

  const nextBtn = document.getElementById('trend-nav-next');
  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      navigateDatePeriod(1);
    });
  }

  // Custom date Apply button
  const applyBtn = document.getElementById('trend-btn-apply-custom');
  if (applyBtn) {
    applyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      applyCustomDateRange();
    });
  }

  // Escape key listener
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('metric-trend-modal');
      if (m && !m.classList.contains('hidden')) {
        closeMetricTrendModal();
      }
    }
  });
}
