/**
 * frontend/src/charts/wellness.js
 * 
 * Minimalist Dark-Themed Garmin Health & Fitness Dashboard
 * - Displays all 8 synced Garmin wellness metrics:
 *   1. Daily Steps (#card-wellness-steps)
 *   2. Resting Heart Rate (#card-wellness-rhr)
 *   3. Sleep Duration, Score & Stages (#card-wellness-sleep)
 *   4. Stress Level & Status (#card-wellness-stress)
 *   5. Body Battery Charged/Drained (#card-wellness-body-battery)
 *   6. HRV Status (#card-wellness-hrv)
 *   7. Active Intensity Minutes (#card-wellness-intensity)
 *   8. Daily Calories (#card-wellness-calories)
 * 
 * Layout Architecture:
 * - "In Focus" (#wellness-in-focus): Hero cards with progress rings, gauges, breakdown bars
 * - "At a Glance" (#wellness-at-a-glance): Compact vital metric cards
 * 
 * Customization & Persistence:
 * - Reorder cards (up/down/drag-and-drop)
 * - Move cards between In Focus and At a Glance
 * - Add / Remove cards
 * - Reset layout to Garmin default
 * - Persisted in localStorage under "garmin_dash_customization"
 */

export const DEFAULT_WELLNESS_LAYOUT = {
  in_focus: ['sleep', 'body_battery', 'steps'],
  at_a_glance: ['resting_hr', 'stress', 'hrv', 'intensity_minutes', 'calories'],
  hidden: []
};

export const WELLNESS_METRIC_METADATA = {
  steps: { id: 'card-wellness-steps', name: 'Daily Steps', defaultSection: 'in_focus' },
  resting_hr: { id: 'card-wellness-rhr', name: 'Resting Heart Rate', defaultSection: 'at_a_glance' },
  sleep: { id: 'card-wellness-sleep', name: 'Sleep', defaultSection: 'in_focus' },
  stress: { id: 'card-wellness-stress', name: 'Stress', defaultSection: 'at_a_glance' },
  body_battery: { id: 'card-wellness-body-battery', name: 'Body Battery', defaultSection: 'in_focus' },
  hrv: { id: 'card-wellness-hrv', name: 'HRV Status', defaultSection: 'at_a_glance' },
  intensity_minutes: { id: 'card-wellness-intensity', name: 'Active Intensity Minutes', defaultSection: 'at_a_glance' },
  calories: { id: 'card-wellness-calories', name: 'Daily Calories', defaultSection: 'at_a_glance' }
};

import { openMetricTrendModal } from './trends_modal.js';
export { openMetricTrendModal };

let activeRollupCache = null;

/**
 * Normalizes any metric key or card ID alias into canonical metric key.
 * @param {string} key
 * @returns {string|null}
 */
export function canonicalizeMetricKey(key) {
  if (!key) return null;
  let k = String(key).replace('card-wellness-', '').toLowerCase().trim();
  if (k === 'rhr') k = 'resting_hr';
  if (k === 'intensity') k = 'intensity_minutes';
  return WELLNESS_METRIC_METADATA[k] ? k : null;
}

/**
 * Loads wellness layout preferences from localStorage.
 * Handles corrupted JSON gracefully with fallback to default layout.
 * @returns {object}
 */
export function loadWellnessLayout() {
  try {
    const store = typeof localStorage !== 'undefined' ? localStorage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    if (!store) return JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT));
    const raw = store.getItem('garmin_dash_customization');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.wellness_layout) {
      return JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT));
    }
    const layout = parsed.wellness_layout;

    let inFocus = (Array.isArray(layout.in_focus) ? layout.in_focus : [])
      .map(canonicalizeMetricKey)
      .filter(Boolean);
    let atAGlance = (Array.isArray(layout.at_a_glance) ? layout.at_a_glance : [])
      .map(canonicalizeMetricKey)
      .filter(Boolean);
    let hidden = (Array.isArray(layout.hidden) ? layout.hidden : [])
      .map(canonicalizeMetricKey)
      .filter(Boolean);

    // Deduplicate across sections
    const seen = new Set();
    inFocus = inFocus.filter(k => !seen.has(k) && seen.add(k));
    atAGlance = atAGlance.filter(k => !seen.has(k) && seen.add(k));
    hidden = hidden.filter(k => !seen.has(k) && seen.add(k));

    return { in_focus: inFocus, at_a_glance: atAGlance, hidden };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT));
  }
}

/**
 * Saves wellness layout preferences to localStorage under garmin_dash_customization.
 * Preserves existing hidden_cards and thresholds keys for backward compatibility.
 * @param {object} layout
 */
export function saveWellnessLayout(layout) {
  try {
    const store = typeof localStorage !== 'undefined' ? localStorage : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    if (!store) return;
    let existing = { hidden_cards: [], thresholds: {} };
    try {
      const raw = store.getItem('garmin_dash_customization');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          existing = parsed;
        }
      }
    } catch {}
    existing.wellness_layout = layout;
    store.setItem('garmin_dash_customization', JSON.stringify(existing));
  } catch (e) {
    // Ignore quota limits
  }
}

/**
 * Resets wellness layout to canonical Garmin default.
 */
export function resetWellnessLayout() {
  saveWellnessLayout(JSON.parse(JSON.stringify(DEFAULT_WELLNESS_LAYOUT)));
  if (activeRollupCache) {
    renderWellnessDashboard(activeRollupCache);
  }
}

/**
 * Moves a metric card within its section or between sections.
 * @param {string} metricKey
 * @param {'up'|'down'|'prev'|'next'|'toggle-section'|'remove'} action
 */
export function moveWellnessCard(metricKey, action) {
  const canonical = canonicalizeMetricKey(metricKey);
  if (!canonical) return;

  const layout = loadWellnessLayout();
  const isInFocus = layout.in_focus.includes(canonical);
  const isAtAGlance = layout.at_a_glance.includes(canonical);

  if (action === 'remove') {
    layout.in_focus = layout.in_focus.filter(k => k !== canonical);
    layout.at_a_glance = layout.at_a_glance.filter(k => k !== canonical);
    if (!layout.hidden.includes(canonical)) {
      layout.hidden.push(canonical);
    }
  } else if (action === 'toggle-section') {
    if (isInFocus) {
      layout.in_focus = layout.in_focus.filter(k => k !== canonical);
      layout.at_a_glance.push(canonical);
    } else if (isAtAGlance) {
      layout.at_a_glance = layout.at_a_glance.filter(k => k !== canonical);
      layout.in_focus.push(canonical);
    }
  } else {
    // Move up/down or prev/next within the same section
    const targetSection = isInFocus ? layout.in_focus : (isAtAGlance ? layout.at_a_glance : null);
    if (targetSection) {
      const idx = targetSection.indexOf(canonical);
      const isBackward = action === 'up' || action === 'prev';
      const targetIdx = isBackward ? idx - 1 : idx + 1;
      if (targetIdx >= 0 && targetIdx < targetSection.length) {
        targetSection.splice(idx, 1);
        targetSection.splice(targetIdx, 0, canonical);
      }
    }
  }

  saveWellnessLayout(layout);
  if (activeRollupCache) {
    renderWellnessDashboard(activeRollupCache);
  }
}

/**
 * Adds a previously hidden card back to In Focus or At a Glance.
 * @param {string} metricKey
 * @param {'in_focus'|'at_a_glance'} section
 */
export function addWellnessCard(metricKey, section = 'at_a_glance') {
  const canonical = canonicalizeMetricKey(metricKey);
  if (!canonical) return;

  const layout = loadWellnessLayout();
  layout.hidden = layout.hidden.filter(k => k !== canonical);
  layout.in_focus = layout.in_focus.filter(k => k !== canonical);
  layout.at_a_glance = layout.at_a_glance.filter(k => k !== canonical);

  if (section === 'in_focus') {
    layout.in_focus.push(canonical);
  } else {
    layout.at_a_glance.push(canonical);
  }

  saveWellnessLayout(layout);
  if (activeRollupCache) {
    renderWellnessDashboard(activeRollupCache);
  }
}

// ============================================================================
// FORMATTERS & MINI SVG CHARTS
// ============================================================================

export function formatSteps(steps) {
  if (steps === null || steps === undefined) return '—';
  return Number(steps).toLocaleString();
}

export function formatSleepDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const sec = Number(seconds) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatCalories(kcal) {
  if (kcal === null || kcal === undefined) return '—';
  return Number(kcal).toLocaleString();
}

export function getStatusBadgeColor(qualifier) {
  const q = String(qualifier || '').toLowerCase();
  if (q.includes('good') || q.includes('balanced') || q.includes('low') || q.includes('optimal')) {
    return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
  }
  if (q.includes('fair') || q.includes('medium') || q.includes('moderate')) {
    return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
  }
  if (q.includes('poor') || q.includes('unbalanced') || q.includes('high')) {
    return 'text-rose-400 border-rose-500/30 bg-rose-500/10';
  }
  return 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10';
}

function renderMiniBarSparkline(data, color = '#10b981', height = 24, width = 72) {
  if (!data || data.length === 0) return '';
  const max = Math.max(...data, 1);
  const barWidth = Math.max(3, Math.floor((width - (data.length - 1) * 3) / data.length));
  const rects = data.map((v, i) => {
    const h = Math.max(3, Math.round(((v || 0) / max) * (height - 4)));
    const x = i * (barWidth + 3);
    const y = height - h;
    const isLatest = i === data.length - 1;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="1.5" fill="${color}" opacity="${isLatest ? '1' : '0.45'}"/>`;
  }).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="overflow-visible shrink-0">${rects}</svg>`;
}

function renderMiniLineSparkline(data, color = '#f43f5e', height = 24, width = 72) {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data, min + 1);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((v, i) => {
    const x = Math.round(i * step);
    const y = Math.round(height - 4 - (((v || min) - min) / range) * (height - 8));
    return `${x},${y}`;
  }).join(' ');
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="overflow-visible shrink-0">
      <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>
    </svg>
  `;
}

function renderCircularRing(pct, radius = 22, strokeWidth = 4, color = '#10b981') {
  const normPct = Math.min(100, Math.max(0, pct || 0));
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (normPct / 100) * circumference;
  const size = (radius + strokeWidth) * 2;
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="transform -rotate-90 shrink-0">
      <circle cx="${radius + strokeWidth}" cy="${radius + strokeWidth}" r="${radius}" stroke="#27272a" stroke-width="${strokeWidth}" fill="none"/>
      <circle cx="${radius + strokeWidth}" cy="${radius + strokeWidth}" r="${radius}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" fill="none" stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}"/>
    </svg>
  `;
}

function renderCardControls(metricKey, isHero) {
  return `
    <div class="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button type="button" data-wellness-action="prev" data-metric="${metricKey}" title="Move earlier" class="p-1 rounded bg-[#18181b] hover:bg-[#27272a] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        ◀
      </button>
      <button type="button" data-wellness-action="next" data-metric="${metricKey}" title="Move later" class="p-1 rounded bg-[#18181b] hover:bg-[#27272a] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        ▶
      </button>
      <button type="button" data-wellness-action="toggle-section" data-metric="${metricKey}" title="${isHero ? 'Move to At a Glance' : 'Promote to In Focus'}" class="p-1 rounded bg-[#18181b] hover:bg-[#27272a] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        ${isHero ? '▼' : '▲'}
      </button>
      <button type="button" data-wellness-action="remove" data-metric="${metricKey}" title="Remove card" class="p-1 rounded bg-[#18181b] hover:bg-rose-950/40 text-zinc-400 hover:text-rose-400 text-[10px] leading-none transition">
        ✕
      </button>
    </div>
  `;
}

// ============================================================================
// METRIC CARD BUILDERS
// ============================================================================

function buildStepsCard(c, daily, isHero) {
  const steps = c.steps || 0;
  const goal = c.steps_goal || 10000;
  const pct = Math.round((steps / goal) * 100);
  const stepsHistory = (daily || []).slice(-7).map(d => d.steps || 0);

  if (isHero) {
    return `
      <div id="card-wellness-steps" draggable="true" data-metric="steps" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>Daily Steps</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${formatSteps(steps)}</div>
            <div class="text-[11px] text-zinc-400 mt-1">Goal: ${formatSteps(goal)} (${pct}%)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('steps', true)}
            ${renderCircularRing(pct, 24, 4, '#10b981')}
          </div>
        </div>
        <div class="pt-4 mt-3 border-t border-[#1f1f24] flex items-center justify-between">
          <span class="text-[11px] text-zinc-500">7-Day Daily Steps</span>
          ${renderMiniBarSparkline(stepsHistory, '#10b981', 22, 90)}
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-steps" draggable="true" data-metric="steps" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Steps</span>
        ${renderCardControls('steps', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${formatSteps(steps)}</div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${pct}% of ${formatSteps(goal)}</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-emerald-500 h-full rounded-full" style="width: ${Math.min(100, pct)}%"></div>
      </div>
    </div>
  `;
}

function buildRhrCard(c, daily, isHero) {
  const rhr = c.resting_hr || c.resting_heart_rate || 48;
  const avg7d = c.resting_hr_7d_avg || 49;
  const rhrHistory = (daily || []).slice(-7).map(d => d.resting_hr || d.resting_heart_rate || 48);

  if (isHero) {
    return `
      <div id="card-wellness-rhr" draggable="true" data-metric="resting_hr" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-rose-500"></span>
              <span>Resting Heart Rate</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${rhr} <span class="text-sm font-sans font-normal text-zinc-500">bpm</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">7-Day Avg: ${avg7d} bpm</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('resting_hr', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusBadgeColor('Optimal')}">Optimal</span>
          </div>
        </div>
        <div class="pt-4 mt-3 border-t border-[#1f1f24] flex items-center justify-between">
          <span class="text-[11px] text-zinc-500">7-Day Trend</span>
          ${renderMiniLineSparkline(rhrHistory, '#f43f5e', 22, 90)}
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-rhr" draggable="true" data-metric="resting_hr" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Resting HR</span>
        ${renderCardControls('resting_hr', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${rhr} <span class="text-xs font-normal text-zinc-500">bpm</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">7d avg: ${avg7d} bpm</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${getStatusBadgeColor('Optimal')}">Optimal</span>
    </div>
  `;
}

function buildSleepCard(c, daily, isHero) {
  const sleepSec = c.sleep_seconds || 27900;
  const score = c.sleep_score || 88;
  const quality = c.sleep_quality || 'Good';
  const deep = c.sleep_deep_seconds || 6300;
  const light = c.sleep_light_seconds || 16200;
  const rem = c.sleep_rem_seconds || 5400;
  const awake = c.sleep_awake_seconds || 1800;
  const totalStages = Math.max(1, deep + light + rem + awake);

  if (isHero) {
    const deepPct = ((deep / totalStages) * 100).toFixed(1);
    const lightPct = ((light / totalStages) * 100).toFixed(1);
    const remPct = ((rem / totalStages) * 100).toFixed(1);
    const awakePct = ((awake / totalStages) * 100).toFixed(1);

    return `
      <div id="card-wellness-sleep" draggable="true" data-metric="sleep" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-indigo-400"></span>
              <span>Sleep</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${formatSleepDuration(sleepSec)}</div>
            <div class="text-[11px] text-zinc-400 mt-1">Score: ${score}/100 • ${quality}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('sleep', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusBadgeColor(quality)}">${quality}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-2">
          <div class="flex items-center justify-between text-[11px] text-zinc-400">
            <span>Sleep Stages</span>
            <span class="text-zinc-500 font-mono text-[10px]">Deep ${formatSleepDuration(deep)} • REM ${formatSleepDuration(rem)}</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 flex overflow-hidden">
            <div style="width: ${deepPct}%" class="bg-indigo-600 h-full" title="Deep: ${formatSleepDuration(deep)}"></div>
            <div style="width: ${lightPct}%" class="bg-indigo-400 h-full" title="Light: ${formatSleepDuration(light)}"></div>
            <div style="width: ${remPct}%" class="bg-violet-400 h-full" title="REM: ${formatSleepDuration(rem)}"></div>
            <div style="width: ${awakePct}%" class="bg-rose-500 h-full" title="Awake: ${formatSleepDuration(awake)}"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-sleep" draggable="true" data-metric="sleep" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Sleep</span>
        ${renderCardControls('sleep', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${formatSleepDuration(sleepSec)}</div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Score: ${score} (${quality})</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${getStatusBadgeColor(quality)}">${quality}</span>
    </div>
  `;
}

function buildStressCard(c, daily, isHero) {
  const stress = c.stress_level || 24;
  const qualifier = c.stress_qualifier || c.stress_status || 'Low';

  if (isHero) {
    return `
      <div id="card-wellness-stress" draggable="true" data-metric="stress" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span>Stress</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${stress} <span class="text-sm font-sans font-normal text-zinc-500">/ 100</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">${qualifier} Stress Level</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('stress', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusBadgeColor(qualifier)}">${qualifier}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-1.5">
          <div class="flex justify-between text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
            <span>Rest (0-25)</span>
            <span>Low (26-50)</span>
            <span>Med (51-75)</span>
            <span>High (76-100)</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2 relative overflow-hidden flex">
            <div class="w-1/4 bg-sky-500/30"></div>
            <div class="w-1/4 bg-emerald-500/30"></div>
            <div class="w-1/4 bg-amber-500/30"></div>
            <div class="w-1/4 bg-rose-500/30"></div>
            <div class="absolute top-0 bottom-0 w-2 bg-white rounded-full shadow" style="left: calc(${Math.min(98, Math.max(2, stress))}% - 4px)"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-stress" draggable="true" data-metric="stress" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Stress</span>
        ${renderCardControls('stress', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${stress} <span class="text-xs font-normal text-zinc-500">/ 100</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${qualifier} Stress</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${getStatusBadgeColor(qualifier)}">${qualifier}</span>
    </div>
  `;
}

function buildBodyBatteryCard(c, daily, isHero) {
  const current = c.body_battery || 82;
  const charged = c.body_battery_charged || c.charged || 65;
  const drained = c.body_battery_drained || c.drained || 43;

  if (isHero) {
    return `
      <div id="card-wellness-body-battery" draggable="true" data-metric="body_battery" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-cyan-400"></span>
              <span>Body Battery</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${current} <span class="text-sm font-sans font-normal text-zinc-500">/ 100</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Charged: +${charged} • Drained: -${drained}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('body_battery', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border border-cyan-500/30 text-cyan-400 bg-cyan-500/10">Active</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Battery Level</span>
            <span class="font-mono text-[10px] text-cyan-400">${current}%</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
            <div class="bg-gradient-to-r from-cyan-600 to-cyan-400 h-full rounded-full" style="width: ${Math.min(100, Math.max(0, current))}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-body-battery" draggable="true" data-metric="body_battery" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Body Battery</span>
        ${renderCardControls('body_battery', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${current} <span class="text-xs font-normal text-zinc-500">/ 100</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">+${charged} / -${drained}</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-cyan-400 h-full rounded-full" style="width: ${Math.min(100, Math.max(0, current))}%"></div>
      </div>
    </div>
  `;
}

function buildHrvCard(c, daily, isHero) {
  const status = c.hrv_status || 'Balanced';
  const weeklyAvg = c.hrv_weekly_avg || 58;
  const lastNight = c.hrv_last_night_avg || 62;

  if (isHero) {
    return `
      <div id="card-wellness-hrv" draggable="true" data-metric="hrv" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-teal-400"></span>
              <span>HRV Status</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${weeklyAvg} <span class="text-sm font-sans font-normal text-zinc-500">ms</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Last Night: ${lastNight} ms (7d avg: ${weeklyAvg} ms)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('hrv', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusBadgeColor(status)}">${status}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Baseline Status</span>
            <span class="text-teal-400 text-[10px] font-semibold">${status}</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2 relative overflow-hidden flex">
            <div class="w-1/3 bg-amber-500/20"></div>
            <div class="w-1/3 bg-emerald-500/40"></div>
            <div class="w-1/3 bg-amber-500/20"></div>
            <div class="absolute top-0 bottom-0 w-2 bg-teal-300 rounded-full" style="left: calc(50% - 4px)"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-hrv" draggable="true" data-metric="hrv" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">HRV Status</span>
        ${renderCardControls('hrv', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${weeklyAvg} <span class="text-xs font-normal text-zinc-500">ms</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Last night: ${lastNight} ms</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${getStatusBadgeColor(status)}">${status}</span>
    </div>
  `;
}

function buildIntensityCard(c, daily, isHero) {
  const weekly = c.intensity_minutes_weekly || c.active_intensity_minutes || 52;
  const goal = c.intensity_minutes_goal || 150;
  const pct = Math.round((weekly / goal) * 100);
  const mod = c.intensity_minutes_moderate || Math.round(weekly * 0.6);
  const vig = c.intensity_minutes_vigorous || Math.round(weekly * 0.4);

  if (isHero) {
    return `
      <div id="card-wellness-intensity" draggable="true" data-metric="intensity_minutes" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-lime-400"></span>
              <span>Active Intensity Minutes</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${weekly} <span class="text-sm font-sans font-normal text-zinc-500">min/wk</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Goal: ${goal} min (${pct}%)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('intensity_minutes', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${pct >= 100 ? 'text-lime-400 border-lime-500/30 bg-lime-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-800'}">${pct >= 100 ? 'Goal Met' : 'In Progress'}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Moderate (${mod}m) • Vigorous (${vig}m)</span>
            <span class="text-lime-400 font-mono text-[10px]">${pct}%</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
            <div class="bg-lime-400 h-full rounded-full" style="width: ${Math.min(100, pct)}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-intensity" draggable="true" data-metric="intensity_minutes" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Intensity Min</span>
        ${renderCardControls('intensity_minutes', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${weekly} <span class="text-xs font-normal text-zinc-500">min</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${pct}% of ${goal}m goal</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-lime-400 h-full rounded-full" style="width: ${Math.min(100, pct)}%"></div>
      </div>
    </div>
  `;
}

function buildCaloriesCard(c, daily, isHero) {
  const total = c.daily_calories || 2410;
  const active = c.active_calories || 680;
  const bmr = c.bmr_calories || Math.max(0, total - active);
  const activePct = Math.round((active / Math.max(1, total)) * 100);

  if (isHero) {
    return `
      <div id="card-wellness-calories" draggable="true" data-metric="calories" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-orange-400"></span>
              <span>Daily Calories</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${formatCalories(total)} <span class="text-sm font-sans font-normal text-zinc-500">kcal</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Active: ${formatCalories(active)} • Resting: ${formatCalories(bmr)}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${renderCardControls('calories', true)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border text-orange-400 border-orange-500/30 bg-orange-500/10">${activePct}% Active</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#1f1f24] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Calorie Burn Split</span>
            <span class="font-mono text-[10px] text-orange-400">${active} Active / ${bmr} BMR</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 flex overflow-hidden">
            <div class="bg-orange-500 h-full" style="width: ${activePct}%" title="Active: ${active} kcal"></div>
            <div class="bg-zinc-700 h-full flex-1" title="Resting: ${bmr} kcal"></div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div id="card-wellness-calories" draggable="true" data-metric="calories" class="bg-[#111114] border border-[#1f1f24] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Calories</span>
        ${renderCardControls('calories', false)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${formatCalories(total)} <span class="text-xs font-normal text-zinc-500">kcal</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Active: ${formatCalories(active)} kcal</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 flex overflow-hidden">
        <div class="bg-orange-500 h-full" style="width: ${activePct}%"></div>
        <div class="bg-zinc-700 h-full flex-1"></div>
      </div>
    </div>
  `;
}

function renderMetricCard(metricKey, c, daily, isHero) {
  switch (metricKey) {
    case 'steps': return buildStepsCard(c, daily, isHero);
    case 'resting_hr': return buildRhrCard(c, daily, isHero);
    case 'sleep': return buildSleepCard(c, daily, isHero);
    case 'stress': return buildStressCard(c, daily, isHero);
    case 'body_battery': return buildBodyBatteryCard(c, daily, isHero);
    case 'hrv': return buildHrvCard(c, daily, isHero);
    case 'intensity_minutes': return buildIntensityCard(c, daily, isHero);
    case 'calories': return buildCaloriesCard(c, daily, isHero);
    default: return '';
  }
}

// ============================================================================
// MAIN DASHBOARD RENDERER & EVENT ATTACHMENT
// ============================================================================

/**
 * Renders the entire Health & Fitness Dashboard ("In Focus" and "At a Glance").
 * @param {object} rollup
 * @param {string} [containerId]
 */
export function renderWellnessDashboard(rollup, containerId = 'wellness-dashboard') {
  if (!rollup) return;
  activeRollupCache = rollup;

  const rootEl = document.getElementById(containerId) || document.getElementById('wellness-dashboard');
  const inFocusContainer = document.getElementById('wellness-in-focus');
  const atAGlanceContainer = document.getElementById('wellness-at-a-glance');
  const emptyNoticeId = 'wellness-empty-notice';
  let emptyNotice = document.getElementById(emptyNoticeId);

  const current = rollup?.wellness?.current;
  const hasWellness = !!(current && typeof current === 'object' && Object.keys(current).length > 0);

  if (!hasWellness) {
    if (inFocusContainer) {
      inFocusContainer.innerHTML = '';
      if (inFocusContainer.style) inFocusContainer.style.display = 'none';
    }
    if (atAGlanceContainer) {
      atAGlanceContainer.innerHTML = '';
      if (atAGlanceContainer.style) atAGlanceContainer.style.display = 'none';
    }

    if (rootEl) {
      if (!emptyNotice) {
        emptyNotice = document.createElement('div');
        emptyNotice.id = emptyNoticeId;
        emptyNotice.className = 'border border-dashed border-[#1f1f24] rounded-xl p-8 text-center flex flex-col items-center justify-center space-y-3';
        emptyNotice.innerHTML = `
          <div class="w-10 h-10 rounded-full bg-zinc-900 border border-[#1f1f24] flex items-center justify-center mb-1">
            <svg class="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <p class="text-xs font-semibold text-zinc-300">No Synced Garmin Wellness Metrics Available</p>
          <p class="text-xs text-zinc-500 max-w-md">No synced Garmin wellness metrics available. Sync with Garmin Connect to view daily wellness data.</p>
        `;
        rootEl.appendChild(emptyNotice);
      }
      if (emptyNotice.classList && typeof emptyNotice.classList.remove === 'function') {
        emptyNotice.classList.remove('hidden');
      }
      if (emptyNotice.style) emptyNotice.style.display = 'flex';
    }
    return;
  }

  // Restore container displays if previously hidden and hide empty notice
  if (emptyNotice) {
    if (emptyNotice.classList && typeof emptyNotice.classList.add === 'function') {
      emptyNotice.classList.add('hidden');
    }
    if (emptyNotice.style) emptyNotice.style.display = 'none';
  }
  if (inFocusContainer && inFocusContainer.style) inFocusContainer.style.display = '';
  if (atAGlanceContainer && atAGlanceContainer.style) atAGlanceContainer.style.display = '';

  const daily = rollup?.wellness?.daily || [];
  const layout = loadWellnessLayout();

  if (inFocusContainer) {
    if (layout.in_focus.length === 0) {
      inFocusContainer.innerHTML = `
        <div class="col-span-full border border-dashed border-[#1f1f24] rounded-xl p-6 text-center text-zinc-500 text-xs">
          No cards currently In Focus. Click "Edit Cards" or use the quick action buttons to promote priority metrics.
        </div>
      `;
    } else {
      inFocusContainer.innerHTML = layout.in_focus
        .map(k => renderMetricCard(k, current, daily, true))
        .join('');
    }
  }

  if (atAGlanceContainer) {
    if (layout.at_a_glance.length === 0) {
      atAGlanceContainer.innerHTML = `
        <div class="col-span-full border border-dashed border-[#1f1f24] rounded-xl p-4 text-center text-zinc-500 text-xs">
          No cards in At a Glance.
        </div>
      `;
    } else {
      atAGlanceContainer.innerHTML = layout.at_a_glance
        .map(k => renderMetricCard(k, current, daily, false))
        .join('');
    }
  }

  attachCardActionListeners();
  attachDragAndDropListeners();
}

/**
 * Attaches click event listeners to card action buttons (prev, next, toggle-section, remove).
 */
function attachCardActionListeners() {
  const root = document.getElementById('wellness-dashboard') || document.getElementById('health-fitness-dashboard') || document;
  if (!root || !root.querySelectorAll) return;

  root.querySelectorAll('[data-wellness-action]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const action = btn.getAttribute('data-wellness-action');
      const metric = btn.getAttribute('data-metric');
      if (action && metric) {
        moveWellnessCard(metric, action);
      }
    };
  });

  // Attach modal opening click handlers to metric cards
  root.querySelectorAll('[data-metric]').forEach(card => {
    if (card.hasAttribute('data-wellness-action')) return;
    card.classList.add('cursor-pointer');
    card.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-wellness-action]')) {
        return;
      }
      const metric = card.getAttribute('data-metric');
      if (metric) {
        openMetricTrendModal(metric, activeRollupCache);
      }
    };
  });
}

/**
 * HTML5 Drag-and-Drop support for cards.
 */
function attachDragAndDropListeners() {
  const cards = document.querySelectorAll ? document.querySelectorAll('[data-metric][draggable="true"]') : [];
  let draggedMetric = null;

  cards.forEach(card => {
    card.ondragstart = (e) => {
      draggedMetric = card.getAttribute('data-metric');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', draggedMetric);
        e.dataTransfer.effectAllowed = 'move';
      }
      card.classList.add('opacity-50');
    };

    card.ondragend = () => {
      card.classList.remove('opacity-50');
      draggedMetric = null;
    };

    card.ondragover = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    };

    card.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetMetric = card.getAttribute('data-metric');
      if (!draggedMetric || !targetMetric || draggedMetric === targetMetric) return;

      const layout = loadWellnessLayout();
      // Remove dragged from wherever it was
      const wasInFocus = layout.in_focus.includes(draggedMetric);
      const isTargetInFocus = layout.in_focus.includes(targetMetric);

      layout.in_focus = layout.in_focus.filter(k => k !== draggedMetric);
      layout.at_a_glance = layout.at_a_glance.filter(k => k !== draggedMetric);

      if (isTargetInFocus) {
        const targetIdx = layout.in_focus.indexOf(targetMetric);
        layout.in_focus.splice(targetIdx, 0, draggedMetric);
      } else {
        const targetIdx = layout.at_a_glance.indexOf(targetMetric);
        layout.at_a_glance.splice(targetIdx, 0, draggedMetric);
      }

      saveWellnessLayout(layout);
      if (activeRollupCache) {
        renderWellnessDashboard(activeRollupCache);
      }
    };
  });
}

/**
 * Initializes global wellness event listeners (e.g. Edit Cards button in header).
 */
export function setupWellnessEventListeners() {
  const editBtn = document.getElementById('btn-edit-home');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const modal = document.getElementById('customize-modal');
      if (modal) {
        modal.classList.remove('hidden');
      }
    });
  }
}
