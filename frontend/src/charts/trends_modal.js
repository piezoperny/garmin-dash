/**
 * frontend/src/charts/trends_modal.js
 * 
 * Milestone 4: Singular Metric Trend Modals across Time Periods (Garmin Connect Style)
 * 
 * Features:
 * - Clickable metric cards (Sleep, HRV, Resting HR, Steps, Body Battery, Stress, Intensity Minutes, Calories, Thresholds)
 * - Obsidian Dark / Zinc theme (#0b0714, #130d21, #2d2147, #1b132e, tabular-nums)
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
  if (typeof d === 'string') {
    const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const localDt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!isNaN(localDt.getTime())) return localDt;
    }
    const parsed = new Date(d);
    if (isNaN(parsed.getTime())) return new Date();
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
  const date = new Date(d.getTime());
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
 * Zero-preserving finite number parser.
 */
function toFiniteNumber(val, fallback = null) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Formats YYYY-MM-DD using local calendar components to avoid UTC-1d shift,
 * returning e.g. "Thu, Nov 12".
 */
function formatShortWeekdayDate(isoDateStr) {
  const s = String(isoDateStr || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s || 'Day';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(dt.getTime())) return s || 'Day';
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Extracts, normalizes, filters (< 0 sentinels / NaN), and sorts intraday
 * Body Battery timeline points into UTC HH:MM labels.
 */
function extractIntradayBodyBattery(record) {
  const raw = record?.intraday_body_battery;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const recDateMatch = typeof record?.date === 'string' ? record.date.trim().match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  const pts = [];
  for (const entry of raw) {
    let tsRaw;
    let valRaw;
    if (Array.isArray(entry)) {
      tsRaw = entry[0];
      if (entry.length >= 3 && toFiniteNumber(entry[1], null) === null) {
        valRaw = entry[2];
        if (entry.length >= 4 && toFiniteNumber(valRaw, null) === null) {
          valRaw = entry[3];
        }
      } else {
        valRaw = entry[1];
      }
    } else if (entry && typeof entry === 'object') {
      tsRaw = entry.timestamp ?? entry.ts ?? entry.epoch_ms ?? entry.time ?? entry.x;
      valRaw = entry.value ?? entry.val ?? entry.level ?? entry.bodyBattery ?? entry.y;
    } else {
      continue;
    }

    let tsMs = NaN;
    if (typeof tsRaw === 'number') {
      tsMs = (tsRaw > 0 && tsRaw < 1e12) ? tsRaw * 1000 : tsRaw;
    } else if (typeof tsRaw === 'string' && tsRaw.trim() !== '') {
      const trimmed = tsRaw.trim();
      const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeMatch) {
        const hh = Number(timeMatch[1]);
        const mm = Number(timeMatch[2]);
        const ss = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59) {
          if (recDateMatch) {
            tsMs = Date.UTC(
              Number(recDateMatch[1]),
              Number(recDateMatch[2]) - 1,
              Number(recDateMatch[3]),
              hh,
              mm,
              ss
            );
          } else {
            tsMs = Date.UTC(1970, 0, 1, hh, mm, ss);
          }
        }
      } else {
        const asNum = Number(trimmed);
        if (Number.isFinite(asNum)) {
          tsMs = (asNum > 0 && asNum < 1e12) ? asNum * 1000 : asNum;
        } else {
          tsMs = Date.parse(trimmed);
        }
      }
    }
    if (!Number.isFinite(tsMs)) continue;

    const v = toFiniteNumber(valRaw, null);
    if (v === null || v < 0) continue;

    const value = Math.max(0, Math.min(100, Math.round(v)));
    const dt = new Date(tsMs);
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mm = String(dt.getUTCMinutes()).padStart(2, '0');
    pts.push({ tsMs, timeLabel: `${hh}:${mm}`, value });
  }
  pts.sort((a, b) => a.tsMs - b.tsMs);
  return pts;
}

/**
 * Maps a 0-100 stress score to Garmin 4-zone metadata.
 */
function getStressZoneMeta(score) {
  const s = toFiniteNumber(score, 0);
  if (s <= 25) return { label: 'Rest', color: '#38bdf8', badgeClass: 'text-sky-400 border-sky-500/30 bg-sky-500/10' };
  if (s <= 50) return { label: 'Low', color: '#fbbf24', badgeClass: 'text-amber-400 border-amber-500/30 bg-amber-500/10' };
  if (s <= 75) return { label: 'Medium', color: '#f97316', badgeClass: 'text-orange-400 border-orange-500/30 bg-orange-500/10' };
  return { label: 'High', color: '#f43f5e', badgeClass: 'text-rose-400 border-rose-500/30 bg-rose-500/10' };
}

/**
 * Formats stress duration seconds into compact human-readable string (e.g. "2h 15m" or "45m").
 */
function formatStressDuration(seconds) {
  const s = Math.max(0, Math.round(toFiniteNumber(seconds, 0)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/**
 * Computes 4-zone stress durations (or scalar fallback proportions) for a daily record,
 * preserving zero values cleanly.
 */
function getStressZoneDurations(record) {
  const stress = Math.max(0, Math.min(100, toFiniteNumber(record?.stress_level, 24)));
  const restRaw = toFiniteNumber(record?.stress_rest_seconds, null);
  const lowRaw = toFiniteNumber(record?.stress_low_seconds, null);
  const medRaw = toFiniteNumber(record?.stress_medium_seconds, null);
  const highRaw = toFiniteNumber(record?.stress_high_seconds, null);
  const hasDurations = restRaw !== null || lowRaw !== null || medRaw !== null || highRaw !== null;

  if (hasDurations) {
    const restSec = Math.max(0, restRaw ?? 0);
    const lowSec = Math.max(0, lowRaw ?? 0);
    const medSec = Math.max(0, medRaw ?? 0);
    const highSec = Math.max(0, highRaw ?? 0);
    const totalSec = restSec + lowSec + medSec + highSec;
    const restLowSharePct = totalSec > 0
      ? Math.round(((restSec + lowSec) / totalSec) * 100)
      : (stress <= 50 ? 100 : 0);
    return { hasDurations: true, restSec, lowSec, medSec, highSec, totalSec, restLowSharePct };
  }

  // Scalar-only historical record fallback (16h = 57600s nominal waking/tracked day)
  const wRest = Math.max(5, 100 - stress * 1.15);
  const wLow = Math.max(5, 65 - Math.abs(stress - 38) * 0.9);
  const wMed = Math.max(4, 55 - Math.abs(stress - 63) * 0.95);
  const wHigh = Math.max(2, stress > 50 ? (stress - 40) * 0.85 : stress * 0.12);
  const wSum = wRest + wLow + wMed + wHigh;
  const baseTotal = 57600;
  const restSec = Math.round((wRest / wSum) * baseTotal);
  const lowSec = Math.round((wLow / wSum) * baseTotal);
  const medSec = Math.round((wMed / wSum) * baseTotal);
  const highSec = Math.max(0, baseTotal - restSec - lowSec - medSec);
  const restLowSharePct = Math.round(((restSec + lowSec) / baseTotal) * 100);
  return { hasDurations: false, restSec, lowSec, medSec, highSec, totalSec: baseTotal, restLowSharePct };
}

/**
 * Extracts, normalizes, filters (< 0 sentinels / NaN), and sorts intraday
 * Stress timeline points into UTC HH:MM labels.
 */
function extractIntradayStress(record) {
  const raw = record?.intraday_stress;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const recDateMatch = typeof record?.date === 'string' ? record.date.trim().match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  const pts = [];
  for (const entry of raw) {
    let tsRaw;
    let valRaw;
    if (Array.isArray(entry)) {
      tsRaw = entry[0];
      valRaw = entry[1];
    } else if (entry && typeof entry === 'object') {
      tsRaw = entry.timestamp ?? entry.ts ?? entry.epoch_ms ?? entry.time ?? entry.x;
      valRaw = entry.value ?? entry.val ?? entry.stress ?? entry.stressLevel ?? entry.y;
    } else {
      continue;
    }

    let tsMs = NaN;
    if (typeof tsRaw === 'number') {
      tsMs = (tsRaw > 0 && tsRaw < 1e12) ? tsRaw * 1000 : tsRaw;
    } else if (typeof tsRaw === 'string' && tsRaw.trim() !== '') {
      const trimmed = tsRaw.trim();
      const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeMatch) {
        const hh = Number(timeMatch[1]);
        const mm = Number(timeMatch[2]);
        const ss = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && ss >= 0 && ss <= 59) {
          if (recDateMatch) {
            tsMs = Date.UTC(
              Number(recDateMatch[1]),
              Number(recDateMatch[2]) - 1,
              Number(recDateMatch[3]),
              hh,
              mm,
              ss
            );
          } else {
            tsMs = Date.UTC(1970, 0, 1, hh, mm, ss);
          }
        }
      } else {
        const asNum = Number(trimmed);
        if (Number.isFinite(asNum)) {
          tsMs = (asNum > 0 && asNum < 1e12) ? asNum * 1000 : asNum;
        } else {
          tsMs = Date.parse(trimmed);
        }
      }
    }
    if (!Number.isFinite(tsMs)) continue;

    const v = toFiniteNumber(valRaw, null);
    if (v === null || v < 0) continue;

    const value = Math.max(0, Math.min(100, Math.round(v)));
    const dt = new Date(tsMs);
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mm = String(dt.getUTCMinutes()).padStart(2, '0');
    pts.push({ tsMs, timeLabel: `${hh}:${mm}`, value });
  }
  pts.sort((a, b) => a.tsMs - b.tsMs);
  return pts;
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
      records: filtered.length > 0 ? filtered : (range === '1y' ? rawTrends : filtered),
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
      btn.className = 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#2d2147] text-white shadow-sm transition';
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
      <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-purple-300/75">Average</div>
        <div class="text-lg font-bold font-mono text-purple-300/50 tabular-nums my-1">—</div>
        <div class="text-[10px] text-purple-300/50">No data</div>
      </div>
      <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-purple-300/75">Minimum</div>
        <div class="text-lg font-bold font-mono text-purple-300/50 tabular-nums my-1">—</div>
        <div class="text-[10px] text-purple-300/50">No data</div>
      </div>
      <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-purple-300/75">Maximum</div>
        <div class="text-lg font-bold font-mono text-purple-300/50 tabular-nums my-1">—</div>
        <div class="text-[10px] text-purple-300/50">No data</div>
      </div>
      <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
        <div class="text-[10px] uppercase font-semibold text-purple-300/75">Period Total</div>
        <div class="text-lg font-bold font-mono text-purple-300/50 tabular-nums my-1">—</div>
        <div class="text-[10px] text-purple-300/50">No data</div>
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
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    const sd = Math.max(3, Math.sqrt(variance));
    const avg = Math.round(mean);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const latest = vals[vals.length - 1];

    kpi1 = { label: 'Avg HRV (±SD)', val: `${avg} ± ${Math.round(sd)} ms`, sub: 'Period mean & 1 SD' };
    kpi2 = { label: 'Min HRV', val: `${min} ms`, sub: 'Lowest night' };
    kpi3 = { label: 'Max HRV', val: `${max} ms`, sub: 'Peak vagal tone' };
    kpi4 = { label: 'Latest Night', val: `${latest} ms`, sub: `Target ${Math.round(mean - sd)}–${Math.round(mean + sd)} ms` };
  } else if (metric === 'resting_hr') {
    const vals = records.map(r => r.resting_hr || 48);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    const sd = Math.max(1.5, Math.sqrt(variance));
    const avg = Math.round(mean * 10) / 10;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const latest = vals[vals.length - 1];

    kpi1 = { label: 'Avg RHR (±SD)', val: `${avg} ± ${sd.toFixed(1)} bpm`, sub: 'Mean & 1 SD zone' };
    kpi2 = { label: 'Lowest RHR', val: `${min} bpm`, sub: 'Deep rest floor' };
    kpi3 = { label: 'Highest RHR', val: `${max} bpm`, sub: 'Fatigue / stress peak' };
    kpi4 = { label: 'Latest Day', val: `${latest} bpm`, sub: `Target ${Math.round(mean - sd)}–${Math.round(mean + sd)} bpm` };
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
    const highs = records.map(r => toFiniteNumber(r.body_battery_high, toFiniteNumber(r.body_battery, 90)));
    const lows = records.map(r => toFiniteNumber(r.body_battery_low, toFiniteNumber(r.body_battery, 25)));
    const charged = records.map(r => toFiniteNumber(r.body_battery_charged, toFiniteNumber(r.charged, 65)));
    const drained = records.map(r => toFiniteNumber(r.body_battery_drained, toFiniteNumber(r.drained, 68)));

    const avgHigh = Math.round(highs.reduce((s, v) => s + v, 0) / highs.length);
    const avgLow = Math.round(lows.reduce((s, v) => s + v, 0) / lows.length);
    const avgChg = Math.round(charged.reduce((s, v) => s + v, 0) / charged.length);
    const avgDrn = Math.round(drained.reduce((s, v) => s + v, 0) / drained.length);

    kpi1 = { label: 'Avg Peak Battery', val: `${avgHigh} pts`, sub: 'Morning charge level' };
    kpi2 = { label: 'Avg Low Battery', val: `${avgLow} pts`, sub: 'Bedtime reserve level' };
    kpi3 = { label: 'Avg Charged', val: `+${avgChg} pts`, sub: 'Nightly replenishment' };
    kpi4 = { label: 'Avg Drained', val: `-${avgDrn} pts`, sub: 'Daily expenditure' };
  } else if (metric === 'stress') {
    const vals = records.map(r => Math.max(0, Math.min(100, toFiniteNumber(r.stress_level, 24))));
    const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
    const avgMeta = getStressZoneMeta(avg);

    const zoneDurs = records.map(r => getStressZoneDurations(r));
    const sumRestLow = zoneDurs.reduce((s, d) => s + d.restSec + d.lowSec, 0);
    const sumTotal = zoneDurs.reduce((s, d) => s + d.totalSec, 0);
    const restLowShare = sumTotal > 0
      ? Math.round((sumRestLow / sumTotal) * 100)
      : Math.round(zoneDurs.reduce((s, d) => s + d.restLowSharePct, 0) / zoneDurs.length);

    const peaks = records.map(r => Math.max(0, Math.min(100, toFiniteNumber(r.stress_max, toFiniteNumber(r.stress_level, 24)))));
    const maxPeak = Math.max(...peaks);
    const totalHighSec = zoneDurs.reduce((s, d) => s + d.highSec, 0);

    const autonomicStatus = avg <= 25 ? 'Recovered' : (avg <= 55 && restLowShare >= 50 ? 'Balanced' : 'Stressed');

    kpi1 = { label: 'Overall Avg Stress', val: `${avg} pts`, sub: `${avgMeta.label} zone` };
    kpi2 = { label: 'Rest / Low Share', val: `${restLowShare}%`, sub: 'Recovery & low stress time' };
    kpi3 = { label: 'High Stress Peak', val: `${maxPeak} pts`, sub: totalHighSec > 0 ? `High zone: ${formatStressDuration(totalHighSec)}` : 'Peak recorded load' };
    kpi4 = { label: 'Autonomic Status', val: autonomicStatus, sub: `${records.length} day${records.length === 1 ? '' : 's'} analyzed` };
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
    <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-purple-300/75">${kpi1.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-purple-50 tabular-nums my-1">${kpi1.val}</div>
      <div class="text-[10px] text-purple-300/60 font-mono">${kpi1.sub}</div>
    </div>
    <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-purple-300/75">${kpi2.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-purple-50 tabular-nums my-1">${kpi2.val}</div>
      <div class="text-[10px] text-purple-300/60 font-mono">${kpi2.sub}</div>
    </div>
    <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-purple-300/75">${kpi3.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-purple-50 tabular-nums my-1">${kpi3.val}</div>
      <div class="text-[10px] text-purple-300/60 font-mono">${kpi3.sub}</div>
    </div>
    <div class="bg-[#1b132e] border border-[#2d2147] rounded-xl p-3 flex flex-col justify-between">
      <div class="text-[10px] uppercase font-semibold text-purple-300/75">${kpi4.label}</div>
      <div class="text-base sm:text-lg font-bold font-mono text-emerald-400 tabular-nums my-1">${kpi4.val}</div>
      <div class="text-[10px] text-purple-300/60 font-mono">${kpi4.sub}</div>
    </div>
  `;
}

/**
 * Computes rolling Mean ± 1 Standard Deviation baseline band for HRV & Resting HR.
 */
function computeRollingBaselineBand(records, valueGetter, minSd = 3, windowSize = 14) {
  const allDaily = getSortedDailyRecords(state.activeRollup);
  const source = allDaily.length >= records.length ? allDaily : records;
  const dateIndexMap = new Map();
  source.forEach((r, idx) => {
    if (r?.date) dateIndexMap.set(r.date, idx);
  });

  const periodVals = records.map(valueGetter).filter(v => typeof v === 'number' && !isNaN(v));
  const periodMean = periodVals.length > 0 ? periodVals.reduce((s, v) => s + v, 0) / periodVals.length : 0;
  const periodVar = periodVals.length > 0
    ? periodVals.reduce((s, v) => s + Math.pow(v - periodMean, 2), 0) / periodVals.length
    : 0;
  const periodSd = Math.max(minSd, Math.sqrt(periodVar));

  const yMinSeries = [];
  const yMaxSeries = [];
  const meanSeries = [];

  records.forEach((rec, i) => {
    const srcIdx = rec?.date && dateIndexMap.has(rec.date) ? dateIndexMap.get(rec.date) : -1;
    let windowVals = [];
    if (srcIdx >= 0) {
      const start = Math.max(0, srcIdx - windowSize + 1);
      windowVals = source.slice(start, srcIdx + 1).map(valueGetter).filter(v => typeof v === 'number' && !isNaN(v));
    } else {
      const start = Math.max(0, i - windowSize + 1);
      windowVals = records.slice(start, i + 1).map(valueGetter).filter(v => typeof v === 'number' && !isNaN(v));
    }

    if (windowVals.length < 3) {
      meanSeries.push(periodMean);
      yMinSeries.push(periodMean - periodSd);
      yMaxSeries.push(periodMean + periodSd);
    } else {
      const m = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
      const v = windowVals.reduce((s, val) => s + Math.pow(val - m, 2), 0) / windowVals.length;
      const sd = Math.max(minSd, Math.sqrt(v));
      meanSeries.push(m);
      yMinSeries.push(m - sd);
      yMaxSeries.push(m + sd);
    }
  });

  return { yMinSeries, yMaxSeries, meanSeries, periodMean, periodSd };
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
    const band = computeRollingBaselineBand(records, r => r.hrv_last_night_avg || 54, 3, 14);
    const pointColors = nightly.map((v, i) =>
      v >= band.yMinSeries[i] && v <= band.yMaxSeries[i] ? '#10b981' : '#f59e0b'
    );

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Nightly HRV (ms)', data: nightly, borderColor: '#10b981', borderWidth: 2, fill: false, pointColors, pointRadius: 3.5 },
          { label: '7D Rolling Avg', data: weekly, borderColor: '#c084fc', borderWidth: 1.5, pointRadius: 1.5 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false }
        },
        annotations: [
          {
            type: 'band',
            yMinSeries: band.yMinSeries,
            yMaxSeries: band.yMaxSeries,
            meanSeries: band.meanSeries,
            color: 'rgba(168, 85, 247, 0.16)',
            borderColor: 'rgba(192, 132, 252, 0.25)',
            meanColor: 'rgba(216, 180, 254, 0.65)',
            label: `Baseline Zone (Avg ${Math.round(band.periodMean)} ± ${Math.round(band.periodSd)} ms)`
          }
        ]
      }
    };
  } else if (metric === 'resting_hr') {
    const rhr = records.map(r => r.resting_hr || 48);
    const rhrAvg = records.map(r => r.resting_hr_7d_avg || 48);
    const band = computeRollingBaselineBand(records, r => r.resting_hr || 48, 1.5, 14);
    const pointColors = rhr.map((v, i) =>
      v >= band.yMinSeries[i] && v <= band.yMaxSeries[i] ? '#10b981' : '#f43f5e'
    );

    chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Daily RHR (bpm)', data: rhr, borderColor: '#f43f5e', borderWidth: 2, fill: false, pointColors, pointRadius: 3.5 },
          { label: '7D Avg (bpm)', data: rhrAvg, borderColor: '#c084fc', borderWidth: 1.5, pointRadius: 1.5 }
        ]
      },
      options: {
        scales: {
          x: { stacked: false },
          y: { stacked: false }
        },
        annotations: [
          {
            type: 'band',
            yMinSeries: band.yMinSeries,
            yMaxSeries: band.yMaxSeries,
            meanSeries: band.meanSeries,
            color: 'rgba(168, 85, 247, 0.16)',
            borderColor: 'rgba(192, 132, 252, 0.25)',
            meanColor: 'rgba(216, 180, 254, 0.65)',
            label: `Target Zone (Avg ${band.periodMean.toFixed(1)} ± ${band.periodSd.toFixed(1)} bpm)`
          }
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
    const isSingleDay = state.activeRange === '1d' && records.length === 1;
    const intradayPts = isSingleDay ? extractIntradayBodyBattery(records[0]) : [];

    if (isSingleDay && intradayPts.length > 1) {
      chartConfig = {
        type: 'line',
        data: {
          labels: intradayPts.map(p => p.timeLabel),
          datasets: [
            {
              label: 'Body Battery (pts)',
              data: intradayPts.map(p => p.value),
              borderColor: '#38bdf8',
              borderWidth: 2,
              fill: true,
              pointRadius: intradayPts.length > 48 ? 1.5 : 2.5
            }
          ]
        },
        options: {
          scales: {
            x: { stacked: false },
            y: { stacked: false, min: 0, max: 100 }
          }
        }
      };
    } else {
      const highs = [];
      const lows = [];
      const charged = [];
      const drained = [];
      const tooltipTitles = [];
      const tooltipLines = [];

      for (const r of records) {
        const rawHi = toFiniteNumber(r.body_battery_high, toFiniteNumber(r.body_battery, 90));
        const rawLo = toFiniteNumber(r.body_battery_low, toFiniteNumber(r.body_battery, 25));
        const hi = Math.max(0, Math.min(100, Math.round(Math.max(rawHi, rawLo))));
        const lo = Math.max(0, Math.min(100, Math.round(Math.min(rawHi, rawLo))));
        const chg = Math.max(0, Math.round(toFiniteNumber(r.body_battery_charged, toFiniteNumber(r.charged, 65))));
        const drn = Math.max(0, Math.round(toFiniteNumber(r.body_battery_drained, toFiniteNumber(r.drained, 68))));

        highs.push(hi);
        lows.push(lo);
        charged.push(chg);
        drained.push(drn);
        tooltipTitles.push(formatShortWeekdayDate(r.date));
        tooltipLines.push([
          { text: `Daily High: ${hi} pts`, color: '#38bdf8' },
          { text: `Daily Low: ${lo} pts`, color: '#c4b5fd' },
          { text: `Charged: +${chg} pts | Drained: -${drn} pts`, color: '#a79bc2' }
        ]);
      }

      chartConfig = {
        type: 'rangeBar',
        data: {
          labels,
          datasets: [
            {
              label: 'Body Battery',
              data: highs,
              highData: highs,
              lowData: lows,
              chargedData: charged,
              drainedData: drained,
              tooltipTitles,
              tooltipLines,
              showCapLabels: isSingleDay,
              showValueLabels: isSingleDay,
              highColor: '#38bdf8',
              lowFillColor: '#0b0714',
              lowColor: '#c4b5fd',
              lowStrokeColor: '#c4b5fd',
              pillarTopColor: 'rgba(168, 85, 247, 0.28)',
              pillarBottomColor: '#2d2147',
              legendItems: [
                { label: 'Daily High', color: '#38bdf8', fillColor: '#38bdf8', shape: 'dot', symbol: 'dot' },
                { label: 'Daily Low', color: '#c4b5fd', fillColor: '#0b0714', strokeColor: '#c4b5fd', shape: 'ring', symbol: 'ring' }
              ]
            }
          ]
        },
        options: {
          scales: {
            x: { stacked: false },
            y: { stacked: false, min: 0, max: 100 }
          }
        }
      };
    }
  } else if (metric === 'stress') {
    const stressAnnotations = [
      { type: 'band', yMin: 0, yMax: 25, color: 'rgba(56, 189, 248, 0.08)', label: 'Rest (0-25)', labelColor: '#38bdf8' },
      { type: 'band', yMin: 25, yMax: 50, color: 'rgba(251, 191, 36, 0.08)', label: 'Low (26-50)', labelColor: '#fbbf24' },
      { type: 'band', yMin: 50, yMax: 75, color: 'rgba(249, 115, 22, 0.08)', label: 'Med (51-75)', labelColor: '#f97316' },
      { type: 'band', yMin: 75, yMax: 100, color: 'rgba(244, 63, 94, 0.08)', label: 'High (76-100)', labelColor: '#f43f5e' }
    ];
    const stressLegendItems = [
      { label: 'Rest (0-25)', color: '#38bdf8', shape: 'circle' },
      { label: 'Low (26-50)', color: '#fbbf24', shape: 'circle' },
      { label: 'Med (51-75)', color: '#f97316', shape: 'circle' },
      { label: 'High (76-100)', color: '#f43f5e', shape: 'circle' }
    ];

    const intradayPts = state.activeRange === '1d' && records.length === 1
      ? extractIntradayStress(records[0])
      : [];

    if (intradayPts.length > 1) {
      const pointColors = intradayPts.map(p => getStressZoneMeta(p.value).color);
      chartConfig = {
        type: 'line',
        data: {
          labels: intradayPts.map(p => p.timeLabel),
          datasets: [
            {
              label: 'Intraday Stress',
              data: intradayPts.map(p => p.value),
              borderColor: '#a855f7',
              backgroundColor: 'rgba(168, 85, 247, 0.12)',
              pointColors,
              borderWidth: 2,
              fill: true,
              tooltipTitles: intradayPts.map(p => `${records[0].date} • ${p.timeLabel}`),
              tooltipLines: intradayPts.map(p => [`Stress: ${p.value} pts (${getStressZoneMeta(p.value).label})`]),
              legendItems: stressLegendItems
            }
          ]
        },
        options: {
          scales: {
            x: { stacked: false },
            y: { stacked: false, min: 0, max: 100 }
          },
          annotations: stressAnnotations
        }
      };
    } else {
      const stressVals = records.map(r => Math.max(0, Math.min(100, toFiniteNumber(r.stress_level, 24))));
      const barColors = stressVals.map(v => getStressZoneMeta(v).color);
      const tooltipTitles = records.map(r => formatShortWeekdayDate(r.date));
      const tooltipLines = records.map((r, i) => {
        const sc = stressVals[i];
        const meta = getStressZoneMeta(sc);
        const durs = getStressZoneDurations(r);
        return [
          `Avg Stress: ${sc} pts (${meta.label})`,
          `Rest: ${formatStressDuration(durs.restSec)} | Low: ${formatStressDuration(durs.lowSec)}`,
          `Med: ${formatStressDuration(durs.medSec)} | High: ${formatStressDuration(durs.highSec)}`
        ];
      });

      chartConfig = {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Daily Stress Score',
              data: stressVals,
              backgroundColor: barColors,
              barColors,
              tooltipTitles,
              tooltipLines,
              legendItems: stressLegendItems
            }
          ]
        },
        options: {
          scales: {
            x: { stacked: false },
            y: { stacked: false, min: 0, max: 100 }
          },
          annotations: stressAnnotations
        }
      };
    }
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
          <tr class="hover:bg-[#1b132e]/50 transition opacity-60">
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
      const hi = toFiniteNumber(r.body_battery_high, toFiniteNumber(r.body_battery, 90));
      const lo = toFiniteNumber(r.body_battery_low, toFiniteNumber(r.body_battery, 25));
      const chg = toFiniteNumber(r.body_battery_charged, toFiniteNumber(r.charged, 65));
      const drn = toFiniteNumber(r.body_battery_drained, toFiniteNumber(r.drained, 68));
      return `
        <tr class="hover:bg-[#1b132e]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono font-bold">${hi}</td>
          <td class="py-2 px-3 text-right text-rose-400 font-mono">${lo}</td>
          <td class="py-2 px-3 text-right text-emerald-400 font-mono">+${chg}</td>
          <td class="py-2 px-3 text-right text-orange-400 font-mono">-${drn}</td>
        </tr>
      `;
    }).join('');
  } else if (metric === 'stress') {
    theadRow.innerHTML = `
      <th class="py-2 px-3">Date</th>
      <th class="py-2 px-3 text-right">Avg Stress</th>
      <th class="py-2 px-3 text-right">Rest Time</th>
      <th class="py-2 px-3 text-right">Low / Med / High</th>
      <th class="py-2 px-3 text-right">Status</th>
    `;
    tbody.innerHTML = displayRecords.map(r => {
      const sc = Math.max(0, Math.min(100, Math.round(toFiniteNumber(r.stress_level, 24))));
      const meta = getStressZoneMeta(sc);
      const q = r.stress_qualifier || meta.label;
      const durs = getStressZoneDurations(r);
      return `
        <tr class="hover:bg-[#1b132e]/50 transition">
          <td class="py-2 px-3 text-zinc-300 font-sans">${r.date}</td>
          <td class="py-2 px-3 text-right font-mono font-bold" style="color: ${meta.color};">${sc} pts</td>
          <td class="py-2 px-3 text-right text-sky-400 font-mono">${formatStressDuration(durs.restSec)}</td>
          <td class="py-2 px-3 text-right text-zinc-300 font-mono">${formatStressDuration(durs.lowSec)} / ${formatStressDuration(durs.medSec)} / ${formatStressDuration(durs.highSec)}</td>
          <td class="py-2 px-3 text-right">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono border ${meta.badgeClass}">
              ${String(q).toUpperCase()}
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
        <tr class="hover:bg-[#1b132e]/50 transition">
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
