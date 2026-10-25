/**
 * frontend/src/charts/activities.js
 * 
 * Section 3: Activity Drill-Down & Inspection
 * - Filterable & Searchable Activity Table (#activity-table)
 * - Sport toggles & sorting
 * - Interactive Split & Lap Breakdown Drawer (#activity-drawer)
 * - Multi-metric Profile Chart (#activity-profile-chart)
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
 * Formats date into readable format.
 * @param {string} isoString
 * @returns {string}
 */
export function formatDate(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch (e) {
    return isoString.split('T')[0];
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

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  let filtered = [...currentActivities];

  // Sport Filter
  if (currentFilter && currentFilter !== 'all') {
    filtered = filtered.filter(a => (a.sport || '').toLowerCase() === currentFilter.toLowerCase());
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
      <td colspan="8" class="text-center py-8 text-slate-500">
        No activities found matching criteria.
      </td>
    `;
    tbody.appendChild(emptyRow);
    return;
  }

  filtered.forEach(act => {
    const row = document.createElement('tr');
    row.className = 'hover:bg-slate-800/60 cursor-pointer border-b border-slate-800 transition-colors duration-150';

    let sportBadgeClass = 'badge-running';
    if (act.sport === 'cycling') sportBadgeClass = 'badge-cycling';
    if (act.sport === 'strength') sportBadgeClass = 'badge-strength';

    const sportLabel = act.sport ? act.sport.toUpperCase() : 'OTHER';
    const dateStr = formatDate(act.date || act.start_time);
    const distStr = formatDistance(act.distance_meters, currentUnit);
    const durStr = formatDuration(act.moving_time_seconds || act.duration_seconds || 0);
    const hrStr = act.avg_hr ? `${act.avg_hr} bpm` : '-';
    const elevStr = act.elevation_gain_meters ? `${Math.round(act.elevation_gain_meters)} m` : '-';
    const tssStr = act.tss || act.training_stress_score ? Math.round(act.tss || act.training_stress_score) : '-';

    row.innerHTML = `
      <td class="py-3 px-4 font-mono text-xs text-slate-400">${dateStr}</td>
      <td class="py-3 px-4">
        <span class="px-2 py-0.5 rounded text-xs font-semibold ${sportBadgeClass}">${sportLabel}</span>
      </td>
      <td class="py-3 px-4 font-medium text-slate-200">${act.title || 'Workout'}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-300">${distStr}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-300">${durStr}</td>
      <td class="py-3 px-4 text-right font-mono text-rose-400">${hrStr}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-400">${elevStr}</td>
      <td class="py-3 px-4 text-right font-mono text-amber-400">${tssStr}</td>
    `;

    row.addEventListener('click', () => {
      openActivityDrawer(act, currentUnit);
    });

    tbody.appendChild(row);
  });
}

/**
 * Opens detailed Activity Inspection Drawer with splits, laps, and profile chart.
 * @param {object} act - Selected Activity
 * @param {string} unit - 'km' or 'mi'
 */
export function openActivityDrawer(act, unit = 'km') {
  const drawer = document.getElementById('activity-drawer');
  if (!drawer) return;

  // Set title & metadata
  const titleEl = document.getElementById('drawer-activity-title');
  if (titleEl) titleEl.textContent = act.title || 'Workout Details';

  const dateEl = document.getElementById('drawer-activity-date');
  if (dateEl) dateEl.textContent = `${formatDate(act.date || act.start_time)} • ${act.sport?.toUpperCase() || ''}`;

  const distEl = document.getElementById('drawer-kpi-dist');
  if (distEl) distEl.textContent = formatDistance(act.distance_meters, unit);

  const durEl = document.getElementById('drawer-kpi-duration');
  if (durEl) durEl.textContent = formatDuration(act.moving_time_seconds || act.duration_seconds || 0);

  const hrEl = document.getElementById('drawer-kpi-hr');
  if (hrEl) hrEl.textContent = act.avg_hr ? `${act.avg_hr} bpm (Max: ${act.max_hr || '-'})` : '-';

  const cadEl = document.getElementById('drawer-kpi-cadence');
  if (cadEl) cadEl.textContent = act.avg_cadence ? `${act.avg_cadence} ${act.sport === 'cycling' ? 'rpm' : 'spm'}` : '-';

  const elevEl = document.getElementById('drawer-kpi-elevation');
  if (elevEl) elevEl.textContent = act.elevation_gain_meters ? `${Math.round(act.elevation_gain_meters)} m` : '-';

  const calEl = document.getElementById('drawer-kpi-calories');
  if (calEl) calEl.textContent = act.calories ? `${act.calories} kcal` : '-';

  // Render Splits Table
  const splitsTbody = document.getElementById('drawer-splits-tbody');
  if (splitsTbody) {
    splitsTbody.innerHTML = '';
    const splits = act.splits || [];
    if (splits.length === 0) {
      splitsTbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-slate-500">No split breakdown recorded.</td></tr>`;
    } else {
      splits.forEach((s, idx) => {
        const splitNum = s.split_number || s.km || (idx + 1);
        const splitSec = s.split_sec || s.moving_time_seconds || s.duration_seconds || 0;
        const paceStr = formatPace(splitSec, unit);
        const splitDur = formatDuration(splitSec);
        const splitHR = s.avg_hr ? `${s.avg_hr} bpm` : '-';
        const elevDiff = s.elevation_diff !== undefined ? `${s.elevation_diff >= 0 ? '+' : ''}${s.elevation_diff} m` : '-';

        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-800 text-xs font-mono text-slate-300';
        tr.innerHTML = `
          <td class="py-2 px-3 text-slate-400">#${splitNum}</td>
          <td class="py-2 px-3">${splitDur}</td>
          <td class="py-2 px-3 text-teal-400">${paceStr}</td>
          <td class="py-2 px-3 text-rose-400">${splitHR}</td>
          <td class="py-2 px-3 text-slate-400">${elevDiff}</td>
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

  const labels = splits.map((s, i) => `S${s.split_number || s.km || s.lap || (i + 1)}`);
  const hrData = splits.map(s => s.avg_hr || 0);
  const cadData = splits.map(s => s.avg_cadence || 0);

  profileChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Heart Rate (bpm)',
          data: hrData,
          borderColor: '#f43f5e',
          borderWidth: 2
        },
        {
          label: 'Cadence',
          data: cadData,
          borderColor: '#818cf8',
          borderWidth: 2
        }
      ]
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
 * @param {string} sport - 'all' | 'running' | 'cycling' | 'strength'
 */
export function setActivitySportFilter(sport) {
  currentFilter = sport;
  applyFiltersAndRender();
}
