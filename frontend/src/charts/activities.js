/**
 * frontend/src/charts/activities.js
 * 
 * Activity Drill-Down & Inspection
 * - Filterable & Searchable Activity Table (#activity-table, #activities-table-body)
 * - Sport toggles: All · Cycling · Hiking · Weights
 * - Interactive Split & Lap Breakdown Drawer (#activity-drawer)
 *   tailored for Weights (duration & HR profile only, no distance/tonnage),
 *   Cycling (cadence in rpm, distance, elevation), and Hiking (cadence in spm, ascent, splits)
 */

import { Chart } from './chart_engine.js';
import { formatDuration } from './endurance.js';

let profileChartInstance = null;
let currentActivities = [];
let currentFilter = 'all';
let currentSearch = '';
let currentSort = 'date-desc';
let currentUnit = 'km';

/**
 * Formats pace seconds per km/mi into "M:SS /km" or "M:SS /mi".
 * @param {number} secPerKm
 * @param {string} unit
 * @returns {string}
 */
export function formatPace(secPerKm, unit = 'km') {
  if (!secPerKm || secPerKm <= 0) return '-';
  const paceSec = unit === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const mins = Math.floor(paceSec / 60);
  const secs = Math.round(paceSec % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}/${unit}`;
}

/**
 * Formats distance with unit.
 * @param {number} meters
 * @param {string} unit
 * @returns {string}
 */
export function formatDistance(meters, unit = 'km') {
  if (!meters || meters <= 0) return '-';
  const km = meters / 1000.0;
  if (unit === 'mi') {
    return `${(km * 0.621371).toFixed(2)} mi`;
  }
  return `${km.toFixed(2)} km`;
}

/**
 * Formats elevation gain / ascent with unit (meters for km, feet for mi).
 * @param {number} meters
 * @param {string} unit
 * @returns {string}
 */
export function formatElevation(meters, unit = 'km') {
  if (meters === undefined || meters === null) return '-';
  const num = Number(meters);
  if (isNaN(num)) return '-';
  const isImperial = unit === 'mi';
  const val = isImperial ? Math.round(num * 3.28084) : Math.round(num);
  const u = isImperial ? 'ft' : 'm';
  return `${val > 0 ? '+' : ''}${val} ${u}`;
}

/**
 * Formats date into readable format.
 * @param {string} isoString
 * @returns {string}
 */
export function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      return String(isoString).split('T')[0] || '-';
    }
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch (e) {
    return String(isoString).split('T')[0] || '-';
  }
}

/**
 * Renders the filterable activity table.
 * @param {Array} activities
 * @param {string} unit
 */
export function renderActivityTable(activities, unit = 'km') {
  currentActivities = activities || [];
  currentUnit = unit;
  applyFiltersAndRender();
}

/**
 * Applies active search, filter, and sorting to table rows.
 */
export function applyFiltersAndRender() {
  const table = document.getElementById('activity-table');
  if (!table) return;

  const tbody = (table ? table.querySelector('tbody') : null) || document.getElementById('activities-table-body');
  if (!tbody) return;

  let filtered = [...currentActivities];

  // Sport Filter
  if (currentFilter && currentFilter !== 'all') {
    const target = currentFilter.toLowerCase();
    filtered = filtered.filter(a => {
      const sp = (a.sport || '').toLowerCase();
      if (target === 'hiking' || target === 'running') {
        return sp === 'hiking' || sp === 'running';
      }
      if (target === 'weights' || target === 'strength') {
        return sp === 'strength' || sp === 'weights';
      }
      if (target === 'cycling' || target === 'cycle') {
        return sp === 'cycling' || sp === 'cycle';
      }
      return sp === target;
    });
  }

  // Text Search
  if (currentSearch.trim()) {
    const q = currentSearch.toLowerCase().trim();
    filtered = filtered.filter(a => {
      const title = (a.title || '').toLowerCase();
      const sport = (a.sport || '').toLowerCase();
      const date = (a.date || a.start_time || '').toLowerCase();
      return title.includes(q) || sport.includes(q) || date.includes(q);
    });
  }

  // Sorting
  filtered.sort((a, b) => {
    if (currentSort === 'date-desc') {
      return new Date(b.date || b.start_time || 0) - new Date(a.date || a.start_time || 0);
    }
    if (currentSort === 'date-asc') {
      return new Date(a.date || a.start_time || 0) - new Date(b.date || b.start_time || 0);
    }
    if (currentSort === 'dist-desc') {
      return (b.distance_meters || 0) - (a.distance_meters || 0);
    }
    if (currentSort === 'time-desc') {
      return (b.moving_time_seconds || b.duration_seconds || 0) - (a.moving_time_seconds || a.duration_seconds || 0);
    }
    return 0;
  });

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="8" class="text-center py-8 text-zinc-500">
        No activities found matching criteria.
      </td>
    `;
    tbody.appendChild(emptyRow);
    return;
  }

  filtered.forEach(act => {
    const row = document.createElement('tr');
    row.className = 'hover:bg-[#18181b]/60 cursor-pointer border-b border-[#1f1f24] transition-colors duration-150';

    const sport = (act.sport || '').toLowerCase();
    const isStrength = sport === 'strength' || sport === 'weights';

    let sportBadgeClass = 'badge-hiking';
    let sportLabel = 'HIKING';

    if (sport === 'cycling' || sport === 'cycle') {
      sportBadgeClass = 'badge-cycling';
      sportLabel = 'CYCLING';
    } else if (isStrength) {
      sportBadgeClass = 'badge-strength';
      sportLabel = 'WEIGHTS';
    } else if (sport === 'running' || sport === 'run') {
      sportBadgeClass = 'badge-running';
      sportLabel = 'RUNNING';
    }

    const dateStr = formatDate(act.date || act.start_time);
    const distStr = isStrength ? '—' : formatDistance(act.distance_meters, currentUnit);
    const durStr = formatDuration(act.moving_time_seconds || act.duration_seconds || 0);
    const hrStr = act.avg_hr ? `${act.avg_hr} bpm` : '-';
    const elevStr = isStrength ? '—' : (act.elevation_gain_meters ? formatElevation(act.elevation_gain_meters, currentUnit) : '-');
    const tssStr = act.tss || act.training_stress_score ? Math.round(act.tss || act.training_stress_score) : '-';

    row.innerHTML = `
      <td class="py-3 px-4 font-mono text-xs text-zinc-400 tabular-nums">${dateStr}</td>
      <td class="py-3 px-4">
        <span class="px-2 py-0.5 rounded text-xs font-semibold ${sportBadgeClass}">${sportLabel}</span>
      </td>
      <td class="py-3 px-4 font-medium text-zinc-200">${act.title || 'Workout'}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-300 tabular-nums">${distStr}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-300 tabular-nums">${durStr}</td>
      <td class="py-3 px-4 text-right font-mono text-rose-400 tabular-nums">${hrStr}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-400 tabular-nums">${elevStr}</td>
      <td class="py-3 px-4 text-right font-mono text-amber-400 tabular-nums">${tssStr}</td>
    `;

    row.addEventListener('click', () => {
      openActivityDrawer(act, currentUnit);
    });

    tbody.appendChild(row);
  });
}

/**
 * Opens detailed Activity Inspection Drawer with splits, laps, and profile chart.
 * Tailored for Weights (duration & HR only), Cycling (rpm), and Hiking (spm & ascent).
 * @param {object} act - Selected Activity
 * @param {string} unit - 'km' or 'mi'
 */
export function openActivityDrawer(act, unit = 'km') {
  const drawer = document.getElementById('activity-drawer');
  if (!drawer) return;

  const sport = (act.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';
  const isCycling = sport === 'cycling' || sport === 'cycle';
  const displaySport = isStrength ? 'WEIGHTS' : (act.sport ? act.sport.toUpperCase() : '');

  // Set title & metadata
  const titleEl = document.getElementById('drawer-activity-title');
  if (titleEl) titleEl.textContent = act.title || 'Workout Details';

  const dateEl = document.getElementById('drawer-activity-date');
  if (dateEl) dateEl.textContent = `${formatDate(act.date || act.start_time)} • ${displaySport}`;

  // Distance (Weights has no distance)
  const distEl = document.getElementById('drawer-kpi-dist');
  if (distEl) distEl.textContent = isStrength ? '—' : formatDistance(act.distance_meters, unit);

  // Duration
  const durEl = document.getElementById('drawer-kpi-duration');
  if (durEl) durEl.textContent = formatDuration(act.moving_time_seconds || act.duration_seconds || 0);

  // Heart Rate
  const hrEl = document.getElementById('drawer-kpi-hr');
  if (hrEl) hrEl.textContent = act.avg_hr ? `${act.avg_hr} bpm (Max: ${act.max_hr || '-'})` : '-';

  // Cadence (Weights: '-', Cycling: 'rpm', Hiking/Running: 'spm')
  const cadEl = document.getElementById('drawer-kpi-cadence');
  if (cadEl) {
    if (isStrength) {
      cadEl.textContent = '—';
    } else if (isCycling) {
      cadEl.textContent = act.avg_cadence ? `${act.avg_cadence} rpm` : '-';
    } else {
      cadEl.textContent = act.avg_cadence ? `${act.avg_cadence} spm` : '-';
    }
  }

  // Elevation Gain (Weights: '-')
  const elevEl = document.getElementById('drawer-kpi-elevation');
  if (elevEl) {
    if (isStrength) {
      elevEl.textContent = '—';
    } else {
      elevEl.textContent = act.elevation_gain_meters ? formatElevation(act.elevation_gain_meters, unit) : '-';
    }
  }

  // Calories
  const calEl = document.getElementById('drawer-kpi-calories');
  if (calEl) calEl.textContent = act.calories ? `${act.calories} kcal` : '-';

  // Render Splits Table
  const splitsTbody = document.getElementById('drawer-splits-tbody');
  if (splitsTbody) {
    splitsTbody.innerHTML = '';
    const splits = act.splits || [];
    if (splits.length === 0) {
      splitsTbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-zinc-500">No split breakdown recorded.</td></tr>`;
    } else {
      splits.forEach((s, idx) => {
        const splitNum = s.split_number || s.km || (idx + 1);
        const splitSec = s.split_sec || s.duration_seconds || s.moving_time_seconds || 0;
        const splitDur = formatDuration(splitSec);
        const paceStr = isStrength ? '—' : (isCycling ? '-' : formatPace(splitSec, unit));
        const splitHR = s.avg_hr ? `${s.avg_hr} bpm` : '-';
        const elevDiff = isStrength
          ? '—'
          : (s.elevation_diff !== undefined ? formatElevation(s.elevation_diff, unit) : '-');

        const tr = document.createElement('tr');
        tr.className = 'border-b border-[#1f1f24] text-xs font-mono text-zinc-300 tabular-nums';
        tr.innerHTML = `
          <td class="py-2 px-3 text-zinc-400">#${splitNum}</td>
          <td class="py-2 px-3">${splitDur}</td>
          <td class="py-2 px-3 text-teal-400">${paceStr}</td>
          <td class="py-2 px-3 text-rose-400">${splitHR}</td>
          <td class="py-2 px-3 text-zinc-400">${elevDiff}</td>
        `;
        splitsTbody.appendChild(tr);
      });
    }
  }

  // Render Profile Chart
  renderActivityProfileChart(act);

  // Show Drawer
  drawer.classList.remove('hidden');
}

/**
 * Closes the Activity Inspection Drawer.
 */
export function closeActivityDrawer() {
  const drawer = document.getElementById('activity-drawer');
  if (!drawer) return;
  drawer.classList.add('hidden');
  if (profileChartInstance) {
    profileChartInstance.destroy();
    profileChartInstance = null;
  }
}

/**
 * Renders Synchronized Profile Chart for Activity.
 * For Weights: renders Heart Rate curve only.
 * For Cycling / Hiking: renders Heart Rate and Cadence profile.
 * @param {object} act
 */
function renderActivityProfileChart(act) {
  const canvas = document.getElementById('activity-profile-chart');
  if (!canvas) return;

  if (profileChartInstance) {
    profileChartInstance.destroy();
    profileChartInstance = null;
  }

  const splits = act.splits || act.laps || [];
  if (splits.length === 0) return;

  const sport = (act.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';

  const labels = splits.map((s, i) => `S${s.split_number || s.km || s.lap || (i + 1)}`);
  const hrData = splits.map(s => s.avg_hr || 0);

  const datasets = [
    {
      label: 'Heart Rate (bpm)',
      data: hrData,
      borderColor: '#f43f5e',
      backgroundColor: 'rgba(244, 63, 94, 0.12)',
      fill: isStrength,
      borderWidth: 2
    }
  ];

  if (!isStrength) {
    const cadData = splits.map(s => s.avg_cadence || 0);
    datasets.push({
      label: sport === 'cycling' ? 'Cadence (rpm)' : 'Cadence (spm)',
      data: cadData,
      borderColor: '#818cf8',
      borderWidth: 2
    });
  }

  profileChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets
    },
    options: {
      scales: {
        x: { stacked: false },
        y: { stacked: false }
      }
    }
  });
}

/**
 * Setup activity filter and search event listeners.
 */
export function setupActivityEventListeners() {
  const searchInput = document.getElementById('activity-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearch = e.target.value;
      applyFiltersAndRender();
    });
  }

  const sortSelect = document.getElementById('activity-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentSort = e.target.value;
      applyFiltersAndRender();
    });
  }

  const closeBtn = document.getElementById('btn-close-drawer');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeActivityDrawer);
  }

  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeActivityDrawer);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeActivityDrawer();
  });
}

/**
 * Sets active sport filter.
 * @param {string} sport - 'all' | 'cycling' | 'hiking' | 'running' | 'strength' | 'weights'
 */
export function setActivitySportFilter(sport) {
  currentFilter = sport;
  applyFiltersAndRender();
}
