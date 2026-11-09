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
import {
  renderRouteMap,
  destroyRouteMap,
  updateScrubberMarker,
  clearScrubberMarker,
  decodePolyline,
  invalidateMapSize
} from './route_map.js';

let profileChartInstance = null;
let currentActivities = [];
let currentFilter = 'all';
let currentSearch = '';
let currentSort = 'date-desc';
let currentUnit = 'km';
let currentSelectedActivity = null;
let isDrawerExpanded = false;

export const streamVisibility = {
  elevation: true,
  hr: true,
  pace: true,
  cadence: true
};

/**
 * Resets stream visibility sensibly per activity type.
 * Indoor/zero-elevation activities suppress elevation, etc.
 * @param {object} act
 */
export function resetStreamVisibilityForActivity(act) {
  const sport = (act?.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';
  const isIndoor = isStrength || ['cardio', 'stair_stepper', 'indoor_cycling', 'elliptical'].includes(sport);
  const elevGain = Number(act?.elevation_gain_meters || 0);
  const hasElevStream = Boolean(
    act?.telemetry_stream?.elevation &&
    act.telemetry_stream.elevation.some(e => typeof e === 'number' && e > 0)
  );
  const hasGpsElev = Boolean(
    act?.gps_track?.points &&
    act.gps_track.points.some(p => typeof p[2] === 'number' && p[2] > 0)
  );
  const hasElev = !isIndoor && (elevGain > 0 || hasElevStream || hasGpsElev);

  const hasHr = Boolean(
    (act?.avg_hr && act.avg_hr > 0) ||
    (act?.telemetry_stream?.hr && act.telemetry_stream.hr.some(h => h > 0)) ||
    (Array.isArray(act?.splits) && act.splits.some(s => s.avg_hr > 0))
  );

  const hasSpeed = !isStrength && Boolean(
    (act?.distance_meters && act.distance_meters > 0) ||
    (act?.telemetry_stream?.speed && act.telemetry_stream.speed.some(s => s > 0)) ||
    (Array.isArray(act?.splits) && act.splits.some(s => s.speed_mps > 0))
  );

  const hasCadence = !isStrength && Boolean(
    (act?.avg_cadence && act.avg_cadence > 0) ||
    (act?.telemetry_stream?.cadence && act.telemetry_stream.cadence.some(c => c > 0)) ||
    (Array.isArray(act?.splits) && act.splits.some(s => s.avg_cadence > 0))
  );

  streamVisibility.elevation = Boolean(hasElev);
  streamVisibility.hr = Boolean(hasHr);
  streamVisibility.pace = Boolean(hasSpeed);
  streamVisibility.cadence = Boolean(hasCadence);
}

/**
 * Formats split duration seconds into "MM:SS" (or "H:MM:SS" if >= 1 hour).
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatSplitDuration(totalSeconds) {
  const sec = Math.round(Number(totalSeconds) || 0);
  if (sec <= 0) return '00:00';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Formats speed in km/h or mph.
 * @param {number} speedMps - Speed in meters per second
 * @param {string} unit - 'km' or 'mi'
 * @returns {string}
 */
export function formatSpeed(speedMps, unit = 'km') {
  const num = Number(speedMps);
  if (isNaN(num) || num <= 0) return '-';
  const isImperial = unit === 'mi';
  if (isImperial) {
    const mph = num * 2.236936;
    return `${mph.toFixed(1)} mph`;
  }
  const kmh = num * 3.6;
  return `${kmh.toFixed(1)} km/h`;
}

/**
 * Formats pace seconds per km/mi into "M:SS /km" or "M:SS /mi".
 * @param {number} secPerKm
 * @param {string} unit
 * @returns {string}
 */
export function formatPace(secPerKm, unit = 'km') {
  if (!secPerKm || secPerKm <= 0) return '-';
  const paceSec = unit === 'mi' ? secPerKm * 1.60934 : secPerKm;
  let mins = Math.floor(paceSec / 60);
  let secs = Math.round(paceSec % 60);
  if (secs === 60) {
    mins += 1;
    secs = 0;
  }
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
      if (target === 'hiking' || target === 'hike') {
        return sp === 'hiking' || sp === 'hike';
      }
      if (target === 'running' || target === 'run') {
        return sp === 'running' || sp === 'run';
      }
      if (target === 'walking' || target === 'walk') {
        return sp === 'walking' || sp === 'walk';
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

    let sportBadgeClass = 'badge-other';
    let sportLabel = 'OTHER';

    if (sport === 'cycling' || sport === 'cycle') {
      sportBadgeClass = 'badge-cycling';
      sportLabel = 'CYCLING';
    } else if (isStrength) {
      sportBadgeClass = 'badge-strength';
      sportLabel = 'WEIGHTS';
    } else if (sport === 'running' || sport === 'run') {
      sportBadgeClass = 'badge-running';
      sportLabel = 'RUNNING';
    } else if (sport === 'walking' || sport === 'walk') {
      sportBadgeClass = 'badge-walking';
      sportLabel = 'WALKING';
    } else if (sport === 'hiking' || sport === 'hike') {
      sportBadgeClass = 'badge-hiking';
      sportLabel = 'HIKING';
    } else if (sport) {
      sportBadgeClass = 'badge-other';
      sportLabel = sport.toUpperCase();
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
 * Toggles Activity Inspection Drawer between slide-over panel and full-window modal view.
 */
export function toggleDrawerExpand() {
  const drawer = document.getElementById('activity-drawer');
  const panel = document.getElementById('drawer-panel');
  const iconExpand = document.getElementById('icon-expand');
  const iconCollapse = document.getElementById('icon-collapse');
  const expandBtn = document.getElementById('btn-expand-drawer');
  if (!drawer || !panel) return;

  isDrawerExpanded = !isDrawerExpanded;

  if (isDrawerExpanded) {
    drawer.classList.remove('justify-end');
    drawer.classList.add('justify-center');
    panel.classList.remove('max-w-2xl', 'border-l');
    panel.classList.add('max-w-none', 'w-full', 'h-full', 'rounded-none');
    if (iconExpand) iconExpand.classList.add('hidden');
    if (iconCollapse) iconCollapse.classList.remove('hidden');
    if (expandBtn) expandBtn.title = 'Collapse to Side Drawer';
  } else {
    drawer.classList.remove('justify-center');
    drawer.classList.add('justify-end');
    panel.classList.remove('max-w-none', 'rounded-none');
    panel.classList.add('max-w-2xl', 'border-l');
    if (iconExpand) iconExpand.classList.remove('hidden');
    if (iconCollapse) iconCollapse.classList.add('hidden');
    if (expandBtn) expandBtn.title = 'Expand to Full Screen';
  }

  // Trigger map & profile canvas recalculations
  invalidateMapSize();
  if (currentSelectedActivity) {
    renderActivityProfileChart(currentSelectedActivity, currentUnit);
  }
  setTimeout(() => {
    invalidateMapSize();
    if (currentSelectedActivity) {
      renderActivityProfileChart(currentSelectedActivity, currentUnit);
    }
  }, 150);
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

  currentSelectedActivity = act;

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
      splitsTbody.innerHTML = `<tr><td colspan="7" class="py-4 text-center text-zinc-500">No split breakdown recorded.</td></tr>`;
    } else {
      splits.forEach((s, idx) => {
        const splitNum = s.split_number || s.km || (idx + 1);
        const splitSec = s.split_sec || s.duration_seconds || s.moving_time_seconds || 0;
        const splitDur = formatSplitDuration(splitSec);

        // Distance formatting
        let splitDist = '—';
        if (!isStrength) {
          if (s.distance_meters !== undefined && s.distance_meters !== null && s.distance_meters > 0) {
            splitDist = formatDistance(s.distance_meters, unit);
          } else if (s.distance_meters === 0) {
            splitDist = formatDistance(0, unit);
          } else {
            splitDist = '-';
          }
        }

        // Pace vs Speed: Cycling displays speed in km/h or mph; foot sports display pace in mm:ss/km or mm:ss/mi
        let paceOrSpeed = '-';
        if (isStrength) {
          paceOrSpeed = '—';
        } else if (isCycling) {
          let speedMps = s.speed_mps;
          if ((speedMps === undefined || speedMps === null || speedMps <= 0) && s.distance_meters > 0 && splitSec > 0) {
            speedMps = s.distance_meters / splitSec;
          }
          paceOrSpeed = formatSpeed(speedMps, unit);
        } else {
          const distM = Number(s.distance_meters);
          const secPerKm = (distM && distM > 0) ? (splitSec / (distM / 1000.0)) : splitSec;
          paceOrSpeed = formatPace(secPerKm, unit);
        }

        // Average Heart Rate
        const splitHR = s.avg_hr ? `${s.avg_hr} bpm` : '-';

        // Elevation delta (+/-m or +/-ft)
        const elevDiff = isStrength
          ? '—'
          : (s.elevation_diff !== undefined && s.elevation_diff !== null
              ? formatElevation(s.elevation_diff, unit)
              : '-');

        // Cadence: rpm for cycling, spm for running/walking, '-' if absent/zero, '—' for strength
        let splitCadence = '-';
        if (isStrength) {
          splitCadence = '—';
        } else if (s.avg_cadence && s.avg_cadence > 0) {
          splitCadence = isCycling ? `${s.avg_cadence} rpm` : `${s.avg_cadence} spm`;
        } else {
          splitCadence = '-';
        }

        const tr = document.createElement('tr');
        tr.className = 'border-b border-[#1f1f24] text-xs font-mono text-zinc-300 tabular-nums';
        tr.innerHTML = `
          <td class="py-2 px-3 text-zinc-400">#${splitNum}</td>
          <td class="py-2 px-3 text-white font-semibold">${splitDist}</td>
          <td class="py-2 px-3">${splitDur}</td>
          <td class="py-2 px-3 text-teal-400">${paceOrSpeed}</td>
          <td class="py-2 px-3 text-rose-400">${splitHR}</td>
          <td class="py-2 px-3 text-zinc-400">${elevDiff}</td>
          <td class="py-2 px-3 text-indigo-300">${splitCadence}</td>
        `;
        splitsTbody.appendChild(tr);
      });
    }
  }

  // Reset stream visibility sensibly for this activity type
  resetStreamVisibilityForActivity(act);

  // Show Drawer FIRST so container has active layout geometry
  drawer.classList.remove('hidden');

  // Render Interactive GPS Route Map (Feature F9)
  renderRouteMap(act);

  // Render Synchronized Profile Chart (Feature F10)
  renderActivityProfileChart(act, unit);

  // Allow DOM layout pass to compute exact container dimensions and redraw
  const scheduleLayout = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);

  scheduleLayout(() => {
    if (currentSelectedActivity === act) {
      renderActivityProfileChart(act, unit);
      invalidateMapSize();
    }
  });
}

/**
 * Closes the Activity Inspection Drawer.
 */
export function closeActivityDrawer() {
  const drawer = document.getElementById('activity-drawer');
  const panel = document.getElementById('drawer-panel');
  const iconExpand = document.getElementById('icon-expand');
  const iconCollapse = document.getElementById('icon-collapse');
  const expandBtn = document.getElementById('btn-expand-drawer');

  if (isDrawerExpanded && panel) {
    isDrawerExpanded = false;
    if (drawer) {
      drawer.classList.remove('justify-center');
      drawer.classList.add('justify-end');
    }
    panel.classList.remove('max-w-none', 'rounded-none');
    panel.classList.add('max-w-2xl', 'border-l');
    if (iconExpand) iconExpand.classList.remove('hidden');
    if (iconCollapse) iconCollapse.classList.add('hidden');
    if (expandBtn) expandBtn.title = 'Expand to Full Screen';
  }

  if (drawer) drawer.classList.add('hidden');
  if (profileChartInstance) {
    if (typeof profileChartInstance.destroy === 'function') {
      profileChartInstance.destroy();
    }
    profileChartInstance = null;
  }
  currentSelectedActivity = null;
  destroyRouteMap();
}

/**
 * Helper to sanitize numeric array and clean NaNs / non-numbers.
 */
function sanitizeNumericArray(arr) {
  if (!Array.isArray(arr)) return [];
  const clean = [];
  let lastGood = 0;
  for (let i = 0; i < arr.length; i++) {
    const val = Number(arr[i]);
    if (typeof val === 'number' && !isNaN(val)) {
      clean.push(val);
      lastGood = val;
    } else {
      clean.push(lastGood);
    }
  }
  let firstValid = null;
  for (let i = 0; i < arr.length; i++) {
    const val = Number(arr[i]);
    if (typeof val === 'number' && !isNaN(val)) {
      firstValid = val;
      break;
    }
  }
  if (firstValid !== null) {
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === 0 && (arr[i] === undefined || isNaN(Number(arr[i])))) {
        clean[i] = firstValid;
      } else {
        break;
      }
    }
  }
  return clean;
}

/**
 * Helper to resample/interpolate a numeric array to target length.
 */
function resampleArray(arr, targetLen) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length === targetLen) return [...arr];
  if (arr.length === 1) return Array(targetLen).fill(arr[0]);
  const res = new Array(targetLen);
  const srcLen = arr.length;
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = (i / (targetLen - 1)) * (srcLen - 1);
    const low = Math.floor(srcIdx);
    const high = Math.min(srcLen - 1, Math.ceil(srcIdx));
    const fraction = srcIdx - low;
    const vLow = (typeof arr[low] === 'number' && !isNaN(arr[low])) ? arr[low] : 0;
    const vHigh = (typeof arr[high] === 'number' && !isNaN(arr[high])) ? arr[high] : vLow;
    res[i] = vLow + (vHigh - vLow) * fraction;
  }
  return res;
}

/**
 * Helper to resample/interpolate coordinates [[lat, lon], ...] to target length.
 */
function resampleCoords(arr, targetLen) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length === targetLen) return arr.map(p => [...p]);
  if (arr.length === 1) return Array(targetLen).fill([arr[0][0], arr[0][1]]);
  const res = new Array(targetLen);
  const srcLen = arr.length;
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = (i / (targetLen - 1)) * (srcLen - 1);
    const low = Math.floor(srcIdx);
    const high = Math.min(srcLen - 1, Math.ceil(srcIdx));
    const fraction = srcIdx - low;
    const pLow = arr[low] || [0, 0];
    const pHigh = arr[high] || pLow;
    res[i] = [
      pLow[0] + (pHigh[0] - pLow[0]) * fraction,
      pLow[1] + (pHigh[1] - pLow[1]) * fraction
    ];
  }
  return res;
}

/**
 * Normalizes activity telemetry into aligned time-series streams for profile curves.
 * @param {object} act
 * @returns {object} { times, elevations, hrs, distances, coords, speeds, cadences, hasStream }
 */
export function extractActivityTelemetry(act) {
  let times = [];
  let elevations = [];
  let hrs = [];
  let distances = [];
  let coords = [];
  let speeds = [];
  let cadences = [];

  const sport = (act?.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';
  const isIndoor = isStrength || ['cardio', 'stair_stepper', 'elliptical'].includes(sport);

  const stream = (act && typeof act.telemetry_stream === 'object' && act.telemetry_stream !== null) ? act.telemetry_stream : null;
  if (stream) {
    times = Array.isArray(stream.time) ? stream.time : (Array.isArray(stream.time_s) ? stream.time_s : []);
    elevations = Array.isArray(stream.elevation) ? stream.elevation : [];
    hrs = Array.isArray(stream.hr) ? stream.hr : (Array.isArray(stream.heart_rate) ? stream.heart_rate : []);
    distances = Array.isArray(stream.distance_m) ? stream.distance_m : (Array.isArray(stream.distance) ? stream.distance : []);
    speeds = Array.isArray(stream.speed) ? stream.speed : (Array.isArray(stream.speed_mps) ? stream.speed_mps : []);
    cadences = Array.isArray(stream.cadence) ? stream.cadence : [];
  }

  // Fallback / supplement from gps_track.points ([lat, lon, elev, hr])
  if (act && act.gps_track && Array.isArray(act.gps_track.points) && act.gps_track.points.length > 0) {
    const pts = act.gps_track.points;
    if (coords.length === 0) coords = pts.map(p => (Array.isArray(p) && p.length >= 2) ? [Number(p[0]) || 0, Number(p[1]) || 0] : [0, 0]);
    if (elevations.length === 0) elevations = pts.map(p => (Array.isArray(p) && p.length >= 3) ? (Number(p[2]) || 0) : 0);
    const hasHrInStream = Array.isArray(hrs) && hrs.some(h => typeof h === 'number' && !isNaN(h) && h > 0);
    if (!hasHrInStream && pts[0] && Array.isArray(pts[0]) && pts[0].length >= 4) {
      hrs = pts.map(p => (Array.isArray(p) && p.length >= 4) ? (Number(p[3]) || 0) : 0);
    }
    if (times.length === 0) {
      const dur = act.moving_time_seconds || act.duration_seconds || 3600;
      times = pts.map((_, i) => Math.round(i * dur / Math.max(1, pts.length - 1)));
    }
  }

  if (coords.length === 0 && act && act.gps_track && typeof act.gps_track.polyline === 'string' && act.gps_track.polyline.length > 0) {
    coords = decodePolyline(act.gps_track.polyline);
  }

  // Sanitize all numeric streams to remove NaNs and invalid types
  times = sanitizeNumericArray(times);
  elevations = sanitizeNumericArray(elevations);
  hrs = sanitizeNumericArray(hrs);
  distances = sanitizeNumericArray(distances);
  speeds = sanitizeNumericArray(speeds);
  cadences = sanitizeNumericArray(cadences);
  coords = (Array.isArray(coords) ? coords : []).map(p => (Array.isArray(p) && !isNaN(p[0]) && !isNaN(p[1])) ? [Number(p[0]), Number(p[1])] : [0, 0]);

  // Genuine continuous stream presence check BEFORE dummy points are generated!
  // Synthetic dummy HR points must NOT cause indoor workouts to skip renderFallbackProfile.
  const hasRealTelemetry = Boolean(
    stream && (
      (elevations.length > 1 && elevations.some(e => e > 0)) ||
      (hrs.length > 1 && hrs.some(h => h > 0)) ||
      (speeds.length > 1 && speeds.some(s => s > 0))
    )
  );
  const hasRealGps = Boolean(
    act?.gps_track && (
      (Array.isArray(act.gps_track.points) && act.gps_track.points.length > 1) ||
      (typeof act.gps_track.polyline === 'string' && act.gps_track.polyline.length > 0)
    )
  );
  const hasStream = (hasRealTelemetry || hasRealGps) && !isStrength;

  // Fallback HR interpolation if hrs is missing or all zeros
  const hasValidHr = hrs.length > 0 && hrs.some(h => h > 0);
  if (!hasValidHr && act) {
    if (Array.isArray(act.splits) && act.splits.some(s => s && s.avg_hr > 0)) {
      const totalPts = Math.max(elevations.length, times.length, 50);
      const splitCount = act.splits.length;
      hrs = Array.from({ length: totalPts }, (_, i) => {
        const splitIdx = Math.min(splitCount - 1, Math.floor((i / totalPts) * splitCount));
        return act.splits[splitIdx]?.avg_hr || act.avg_hr || 0;
      });
    } else if (act.avg_hr && act.avg_hr > 0) {
      const totalPts = Math.max(elevations.length, times.length, 50);
      hrs = Array.from({ length: totalPts }, () => act.avg_hr);
    }
  }

  // Fallback speed interpolation if speeds is missing
  const hasValidSpeed = speeds.length > 0 && speeds.some(s => s > 0);
  if (!hasValidSpeed && act && !isStrength) {
    if (Array.isArray(act.splits) && act.splits.length > 0) {
      const totalPts = Math.max(elevations.length, times.length, hrs.length, 50);
      const splitCount = act.splits.length;
      speeds = Array.from({ length: totalPts }, (_, i) => {
        const splitIdx = Math.min(splitCount - 1, Math.floor((i / totalPts) * splitCount));
        const s = act.splits[splitIdx];
        if (s && s.speed_mps > 0) return s.speed_mps;
        const dur = s?.split_sec || s?.duration_seconds || 0;
        const dist = s?.distance_meters || 0;
        if (dur > 0 && dist > 0) return dist / dur;
        return 0;
      });
    } else if (distances.length > 1 && times.length > 1) {
      speeds = times.map((t, i) => {
        if (i === 0) return 0;
        const dt = t - times[i - 1];
        const dd = distances[i] - distances[i - 1];
        return dt > 0 && dd >= 0 ? dd / dt : 0;
      });
    }
  }

  // Fallback cadence interpolation if cadences is missing
  const hasValidCadence = cadences.length > 0 && cadences.some(c => c > 0);
  if (!hasValidCadence && act && !isStrength) {
    if (Array.isArray(act.splits) && act.splits.some(s => s && s.avg_cadence > 0)) {
      const totalPts = Math.max(elevations.length, times.length, hrs.length, 50);
      const splitCount = act.splits.length;
      cadences = Array.from({ length: totalPts }, (_, i) => {
        const splitIdx = Math.min(splitCount - 1, Math.floor((i / totalPts) * splitCount));
        return act.splits[splitIdx]?.avg_cadence || act.avg_cadence || 0;
      });
    } else if (act.avg_cadence && act.avg_cadence > 0) {
      const totalPts = Math.max(elevations.length, times.length, hrs.length, 50);
      cadences = Array.from({ length: totalPts }, () => act.avg_cadence);
    }
  }

  // Telemetry stream array length normalization:
  const lengths = [
    times.length,
    elevations.length,
    hrs.length,
    distances.length,
    coords.length,
    speeds.length,
    cadences.length
  ].filter(l => l > 0);

  const targetLen = lengths.length > 0 ? Math.max(...lengths) : 0;
  if (targetLen > 1) {
    if (times.length > 0 && times.length < targetLen) times = resampleArray(times, targetLen);
    if (elevations.length > 0 && elevations.length < targetLen) elevations = resampleArray(elevations, targetLen);
    if (hrs.length > 0 && hrs.length < targetLen) hrs = resampleArray(hrs, targetLen);
    if (distances.length > 0 && distances.length < targetLen) distances = resampleArray(distances, targetLen);
    if (speeds.length > 0 && speeds.length < targetLen) speeds = resampleArray(speeds, targetLen);
    if (cadences.length > 0 && cadences.length < targetLen) cadences = resampleArray(cadences, targetLen);
    if (coords.length > 0 && coords.length < targetLen) coords = resampleCoords(coords, targetLen);
  }

  return { times, elevations, hrs, distances, coords, speeds, cadences, hasStream };
}

/**
 * Renders fallback profile for indoor/strength or workouts without continuous streams.
 */
function renderFallbackProfile(ctx, act, width, height, isStrength, unit) {
  const padLeft = 48;
  const padRight = 52;
  const padTop = 16;
  const padBottom = 26;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  const splits = (act && Array.isArray(act.splits)) ? act.splits : [];
  if (splits.length === 0) {
    if (typeof ctx.fillRect === 'function') {
      ctx.fillStyle = '#111114';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.fillStyle = '#71717a';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (typeof ctx.fillText === 'function') {
      ctx.fillText(
        isStrength
          ? 'Weights / Strength Workout (Duration & HR Telemetry)'
          : 'No continuous telemetry stream recorded',
        width / 2,
        height / 2
      );
    }
    return;
  }

  // Draw split heart rate profile for workouts with splits
  const hrData = splits.map(s => (s && typeof s.avg_hr === 'number' && !isNaN(s.avg_hr)) ? s.avg_hr : (act?.avg_hr || 0));
  const validHRs = hrData.filter(h => typeof h === 'number' && !isNaN(h) && h > 40 && h < 225);
  let minHR = validHRs.length > 0 ? Math.min(...validHRs) : (act?.avg_hr ? Math.max(40, act.avg_hr - 20) : 60);
  let maxHR = validHRs.length > 0 ? Math.max(...validHRs) : (act?.avg_hr ? act.avg_hr + 20 : 190);
  if (isNaN(minHR)) minHR = 60;
  if (isNaN(maxHR)) maxHR = 190;
  if (minHR === maxHR) { minHR -= 10; maxHR += 10; }
  const hrPad = Math.max((maxHR - minHR) * 0.1, 5);
  minHR = Math.floor(minHR - hrPad);
  maxHR = Math.ceil(maxHR + hrPad);

  const n = hrData.length;
  const getX = (i) => padLeft + (i / Math.max(1, n - 1)) * plotW;
  const getY = (val) => padTop + (1 - (val - minHR) / Math.max(1, maxHR - minHR)) * plotH;

  // Gridlines & Right Y-Axis Heart Rate labels
  ctx.strokeStyle = '#1f1f24';
  ctx.lineWidth = 1;
  for (let s = 0; s <= 4; s++) {
    const y = padTop + (s / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();

    const hVal = Math.round(maxHR - (s / 4) * (maxHR - minHR));
    ctx.fillStyle = '#f43f5e';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${hVal} bpm`, width - padRight + 6, y);
  }

  if (n === 1) {
    // Fix single-split polygon collapse: n=1 split draws flat full-width line & fill
    const yVal = getY(hrData[0] || act?.avg_hr || 120);
    ctx.beginPath();
    ctx.moveTo(padLeft, yVal);
    ctx.lineTo(padLeft + plotW, yVal);
    ctx.lineTo(padLeft + plotW, padTop + plotH);
    ctx.lineTo(padLeft, padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(244, 63, 94, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(padLeft, yVal);
    ctx.lineTo(padLeft + plotW, yVal);
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#71717a';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText('Split #1 (Full Duration)', padLeft + plotW / 2, padTop + plotH + 5);
  } else {
    // Multi-split: stroke & fill across splits
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(hrData[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(getX(i), getY(hrData[i]));
    }
    ctx.lineTo(getX(n - 1), padTop + plotH);
    ctx.lineTo(getX(0), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(244, 63, 94, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(hrData[0]));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(getX(i), getY(hrData[i]));
    }
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#71717a';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('Split #1', padLeft, padTop + plotH + 5);
    ctx.textAlign = 'right';
    ctx.fillText(`Split #${n}`, width - padRight, padTop + plotH + 5);
  }
}

/**
 * Renders Synchronized Route Elevation and Heart Rate Profile Curves.
 * Includes interactive hover scrub cursor, live readout, and route map synchronization.
 * Supports dynamic multi-axes for Pace/Speed and Cadence with inverted pace scale.
 * @param {object} act
 * @param {string} unit - 'km' or 'mi'
 */
export function renderActivityProfileChart(act, unit = 'km') {
  const canvas = document.getElementById('activity-profile-chart');
  if (!canvas) return;

  if (profileChartInstance) {
    if (typeof profileChartInstance.destroy === 'function') {
      profileChartInstance.destroy();
    }
    profileChartInstance = null;
  }

  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;

  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const parent = canvas.parentElement;

  let measuredW = 0;
  if (parent && typeof parent.getBoundingClientRect === 'function') {
    const pr = parent.getBoundingClientRect();
    if (pr.width > 0) measuredW = pr.width;
  }
  if (!measuredW && typeof canvas.getBoundingClientRect === 'function') {
    const cr = canvas.getBoundingClientRect();
    if (cr.width > 0) measuredW = cr.width;
  }
  if (!measuredW && parent && parent.clientWidth > 0) {
    measuredW = parent.clientWidth;
  }
  if (!measuredW) {
    const winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 600;
    measuredW = Math.min(600, Math.max(280, winW - 64));
  }

  const width = measuredW;
  const height = (parent && parent.clientHeight > 0) ? parent.clientHeight : (canvas.height || 180);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  if (canvas.style) {
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.style.maxWidth = '100%';
  }

  // Attach ResizeObserver to keep canvas layout responsive across viewports
  if (typeof ResizeObserver === 'function' && parent && !canvas._hasProfileResizeObserver) {
    canvas._hasProfileResizeObserver = true;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect && entry.contentRect.width > 0) {
          if (currentSelectedActivity) {
            renderActivityProfileChart(currentSelectedActivity, currentUnit);
          }
        }
      }
    });
    ro.observe(parent);
  }

  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else if (typeof ctx.resetTransform === 'function') {
    ctx.resetTransform();
    if (typeof ctx.scale === 'function' && dpr !== 1) ctx.scale(dpr, dpr);
  }
  if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, width, height);

  const sport = (act?.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';
  const isCycling = sport === 'cycling' || sport === 'cycle';
  const isIndoor = isStrength || ['cardio', 'stair_stepper', 'elliptical'].includes(sport);
  const { times, elevations, hrs, distances, coords, speeds, cadences, hasStream } = extractActivityTelemetry(act);

  // Readout elements
  const elevEl = document.getElementById('readout-elev');
  const hrEl = document.getElementById('readout-hr');
  const distEl = document.getElementById('readout-dist');

  // Elevation data check: suppress elevation axis/ticks for indoor workouts or empty/zero elevation
  const hasElevData = !isIndoor && elevations.length > 1 && elevations.some(e => typeof e === 'number' && !isNaN(e) && e > 0) && (act?.elevation_gain_meters === undefined || act.elevation_gain_meters > 0);
  const hasHrData = hrs.length > 0 && (hrs.some(h => typeof h === 'number' && !isNaN(h) && h > 0) || Boolean(act?.avg_hr && act.avg_hr > 0));
  const hasSpeedData = speeds.length > 1 && speeds.some(s => typeof s === 'number' && !isNaN(s) && s > 0);
  const hasCadData = cadences.length > 1 && cadences.some(c => typeof c === 'number' && !isNaN(c) && c > 0);

  if (!hasElevData) {
    streamVisibility.elevation = false;
  }

  const n = Math.max(elevations.length, hrs.length, speeds.length, cadences.length, 2);
  const padLeft = 48;
  const padRight = 52;
  const padTop = 16;
  const padBottom = 26;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  // Elevation scale
  const isImperial = unit === 'mi';
  const elevValues = elevations.map(e => isImperial ? e * 3.28084 : e);
  const elevUnit = isImperial ? 'ft' : 'm';
  const validElevs = elevValues.filter(e => typeof e === 'number' && !isNaN(e));
  let minElev = (hasElevData && validElevs.length > 0) ? Math.min(...validElevs) : 0;
  let maxElev = (hasElevData && validElevs.length > 0) ? Math.max(...validElevs) : 100;
  if (isNaN(minElev)) minElev = 0;
  if (isNaN(maxElev)) maxElev = 100;
  if (minElev === maxElev) { minElev -= 10; maxElev += 10; }
  const elevPad = Math.max((maxElev - minElev) * 0.1, 5);
  minElev = Math.floor(minElev - elevPad);
  maxElev = Math.ceil(maxElev + elevPad);

  // Heart rate scale
  const validHRs = hrs.filter(h => typeof h === 'number' && !isNaN(h) && h >= 40 && h <= 225);
  let minHR = validHRs.length > 0 ? Math.min(...validHRs) : (act?.avg_hr ? Math.max(40, act.avg_hr - 20) : 60);
  let maxHR = validHRs.length > 0 ? Math.max(...validHRs) : (act?.avg_hr ? act.avg_hr + 20 : 190);
  if (isNaN(minHR)) minHR = 60;
  if (isNaN(maxHR)) maxHR = 190;
  if (minHR === maxHR) { minHR -= 10; maxHR += 10; }
  const hrPad = Math.max((maxHR - minHR) * 0.1, 5);
  minHR = Math.floor(minHR - hrPad);
  maxHR = Math.ceil(maxHR + hrPad);

  // Pace / Speed scale
  const validSpeeds = speeds.filter(s => typeof s === 'number' && !isNaN(s) && s > 0);
  let minSpeed = validSpeeds.length > 0 ? Math.min(...validSpeeds) : 0.5;
  let maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 10;
  if (isNaN(minSpeed)) minSpeed = 0.5;
  if (isNaN(maxSpeed)) maxSpeed = 10;
  if (minSpeed === maxSpeed) { minSpeed = Math.max(0.1, minSpeed - 1); maxSpeed += 1; }
  const speedPad = Math.max((maxSpeed - minSpeed) * 0.1, 0.2);
  minSpeed = Math.max(0.1, minSpeed - speedPad);
  maxSpeed = maxSpeed + speedPad;

  // Cadence scale
  const validCads = cadences.filter(c => typeof c === 'number' && !isNaN(c) && c > 0);
  let minCad = validCads.length > 0 ? Math.min(...validCads) : 40;
  let maxCad = validCads.length > 0 ? Math.max(...validCads) : 200;
  if (isNaN(minCad)) minCad = 40;
  if (isNaN(maxCad)) maxCad = 200;
  if (minCad === maxCad) { minCad -= 10; maxCad += 10; }
  const cadPad = Math.max((maxCad - minCad) * 0.1, 5);
  minCad = Math.max(0, minCad - cadPad);
  maxCad = maxCad + cadPad;

  const getX = (i) => padLeft + (i / Math.max(1, n - 1)) * plotW;
  const getYElev = (val) => padTop + (1 - (val - minElev) / Math.max(1, maxElev - minElev)) * plotH;
  const getYHR = (val) => padTop + (1 - (val - minHR) / Math.max(1, maxHR - minHR)) * plotH;
  const getYSpeed = (val) => padTop + (1 - (val - minSpeed) / Math.max(0.1, maxSpeed - minSpeed)) * plotH;
  const getYCad = (val) => padTop + (1 - (val - minCad) / Math.max(1, maxCad - minCad)) * plotH;

  let currentScrub = null;

  function drawProfile(scrubIdx = null) {
    currentScrub = scrubIdx;
    if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, width, height);

    // Calculate active streams & multi-axis assignment INSIDE drawProfile freshly!
    const elevActive = streamVisibility.elevation !== false && hasElevData;
    const hrActive = streamVisibility.hr !== false && hasHrData;
    const speedActive = streamVisibility.pace !== false && hasSpeedData;
    const cadActive = streamVisibility.cadence !== false && hasCadData;

    let leftAxis = null;
    let rightAxis = null;

    if (elevActive) {
      leftAxis = 'elevation';
    } else if (speedActive) {
      leftAxis = 'pace';
    } else if (cadActive && !hrActive) {
      leftAxis = 'cadence';
    }

    if (hrActive) {
      rightAxis = 'hr';
    } else if (cadActive && leftAxis !== 'cadence') {
      rightAxis = 'cadence';
    } else if (speedActive && leftAxis !== 'pace') {
      rightAxis = 'pace';
    }

    // 1. Gridlines & Dynamic Y-Axes labels
    ctx.strokeStyle = '#1f1f24';
    ctx.lineWidth = 1;
    for (let step = 0; step <= 4; step++) {
      const y = padTop + (step / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      // Left Y-Axis: Dynamic assignment (Elevation, Pace/Speed, or Cadence)
      if (leftAxis === 'elevation') {
        const eVal = Math.round(maxElev - (step / 4) * (maxElev - minElev));
        ctx.fillStyle = '#10b981';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${eVal} ${elevUnit}`, padLeft - 6, y);
      } else if (leftAxis === 'pace') {
        ctx.fillStyle = '#38bdf8';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const curSpd = maxSpeed - (step / 4) * (maxSpeed - minSpeed);
        if (isCycling) {
          ctx.fillText(formatSpeed(curSpd, unit), padLeft - 6, y);
        } else {
          const paceSec = curSpd > 0 ? (1000 / curSpd) : 0;
          ctx.fillText(formatPace(paceSec, unit), padLeft - 6, y);
        }
      } else if (leftAxis === 'cadence') {
        const cVal = Math.round(maxCad - (step / 4) * (maxCad - minCad));
        ctx.fillStyle = '#818cf8';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${cVal} ${isCycling ? 'rpm' : 'spm'}`, padLeft - 6, y);
      }

      // Right Y-Axis: Dynamic assignment (Heart Rate, Cadence, or Pace/Speed)
      if (rightAxis === 'hr') {
        const hVal = Math.round(maxHR - (step / 4) * (maxHR - minHR));
        ctx.fillStyle = '#f43f5e';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${hVal} bpm`, width - padRight + 6, y);
      } else if (rightAxis === 'cadence') {
        const cVal = Math.round(maxCad - (step / 4) * (maxCad - minCad));
        ctx.fillStyle = '#818cf8';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${cVal} ${isCycling ? 'rpm' : 'spm'}`, width - padRight + 6, y);
      } else if (rightAxis === 'pace') {
        ctx.fillStyle = '#38bdf8';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const curSpd = maxSpeed - (step / 4) * (maxSpeed - minSpeed);
        if (isCycling) {
          ctx.fillText(formatSpeed(curSpd, unit), width - padRight + 6, y);
        } else {
          const paceSec = curSpd > 0 ? (1000 / curSpd) : 0;
          ctx.fillText(formatPace(paceSec, unit), width - padRight + 6, y);
        }
      }
    }

    // 2. Elevation Area Curve (Emerald gradient fill + line)
    if (elevActive && elevValues.length > 1) {
      ctx.beginPath();
      ctx.moveTo(getX(0), getYElev(elevValues[0]));
      for (let i = 1; i < elevValues.length; i++) {
        ctx.lineTo(getX(i), getYElev(elevValues[i]));
      }
      ctx.lineTo(getX(elevValues.length - 1), padTop + plotH);
      ctx.lineTo(getX(0), padTop + plotH);
      ctx.closePath();

      if (typeof ctx.createLinearGradient === 'function') {
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, 'rgba(16, 185, 129, 0.22)');
        grad.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
      }
      ctx.fill();

      // Elevation Line
      ctx.beginPath();
      ctx.moveTo(getX(0), getYElev(elevValues[0]));
      for (let i = 1; i < elevValues.length; i++) {
        ctx.lineTo(getX(i), getYElev(elevValues[i]));
      }
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.75;
      ctx.stroke();
    }

    // 3. Pace / Speed Curve (Sky Blue line)
    if (speedActive && speeds.length > 1 && validSpeeds.length > 0) {
      ctx.beginPath();
      let speedStarted = false;
      for (let i = 0; i < speeds.length; i++) {
        const s = speeds[i];
        if (s && s > 0) {
          const x = getX(i);
          const y = getYSpeed(s);
          if (!speedStarted) {
            ctx.moveTo(x, y);
            speedStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      if (speedStarted) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 4. Cadence Curve (Indigo line)
    if (cadActive && cadences.length > 1 && validCads.length > 0) {
      ctx.beginPath();
      let cadStarted = false;
      for (let i = 0; i < cadences.length; i++) {
        const c = cadences[i];
        if (c && c > 0) {
          const x = getX(i);
          const y = getYCad(c);
          if (!cadStarted) {
            ctx.moveTo(x, y);
            cadStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      if (cadStarted) {
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 5. Heart Rate Line Curve (Rose line)
    if (hrActive && hrs.length > 1) {
      ctx.beginPath();
      let hrStarted = false;
      for (let i = 0; i < hrs.length; i++) {
        const h = hrs[i];
        if (h && h > 0) {
          const x = getX(i);
          const y = getYHR(h);
          if (!hrStarted) {
            ctx.moveTo(x, y);
            hrStarted = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      if (hrStarted) {
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
    }

    // 6. X-Axis labels
    ctx.fillStyle = '#71717a';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('0', padLeft, padTop + plotH + 6);
    ctx.textAlign = 'center';
    const midDist = (act?.distance_meters || 0) / 2;
    ctx.fillText(formatDistance(midDist, unit), padLeft + plotW / 2, padTop + plotH + 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatDistance(act?.distance_meters || 0, unit), width - padRight, padTop + plotH + 6);

    // 7. Hairline scrubber & highlight dots
    if (scrubIdx !== null && scrubIdx >= 0 && scrubIdx < n) {
      const xScrub = getX(scrubIdx);
      ctx.strokeStyle = '#e4e4e7';
      ctx.lineWidth = 1;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xScrub, padTop);
      ctx.lineTo(xScrub, padTop + plotH);
      ctx.stroke();
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

      if (elevActive && elevValues[scrubIdx] !== undefined) {
        ctx.beginPath();
        ctx.arc(xScrub, getYElev(elevValues[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (speedActive && speeds[scrubIdx] !== undefined && speeds[scrubIdx] > 0) {
        ctx.beginPath();
        ctx.arc(xScrub, getYSpeed(speeds[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#38bdf8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (cadActive && cadences[scrubIdx] !== undefined && cadences[scrubIdx] > 0) {
        ctx.beginPath();
        ctx.arc(xScrub, getYCad(cadences[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#818cf8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (hrActive && hrs[scrubIdx] !== undefined && hrs[scrubIdx] > 0) {
        ctx.beginPath();
        ctx.arc(xScrub, getYHR(hrs[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f43f5e';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // Interactive stream toggles UI
  function syncToggleButtons() {
    const streamToggleDefs = [
      { id: 'toggle-stream-elevation', key: 'elevation', activeCls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', available: hasElevData },
      { id: 'toggle-stream-hr', key: 'hr', activeCls: 'bg-rose-500/20 text-rose-400 border-rose-500/30', available: hasHrData },
      { id: 'toggle-stream-pace', key: 'pace', activeCls: 'bg-sky-500/20 text-sky-400 border-sky-500/30', available: hasSpeedData },
      { id: 'toggle-stream-cadence', key: 'cadence', activeCls: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30', available: hasCadData }
    ];

    streamToggleDefs.forEach(({ id, key, activeCls, available }) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (!available) {
        btn.className = 'stream-toggle-btn px-2.5 py-0.5 rounded text-xs font-semibold bg-zinc-800 text-zinc-600 border border-zinc-800/50 opacity-40 cursor-not-allowed';
        btn.disabled = true;
        btn.onclick = null;
        return;
      }
      btn.disabled = false;
      const isActive = streamVisibility[key] !== false;
      if (isActive) {
        btn.className = `stream-toggle-btn px-2.5 py-0.5 rounded text-xs font-semibold ${activeCls} border transition cursor-pointer`;
      } else {
        btn.className = 'stream-toggle-btn px-2.5 py-0.5 rounded text-xs font-semibold bg-zinc-800 text-zinc-500 border border-zinc-700/50 opacity-50 transition cursor-pointer';
      }
      btn.onclick = () => {
        streamVisibility[key] = !streamVisibility[key];
        syncToggleButtons();
        drawProfile(currentScrub);
      };
    });
  }

  // Synchronize toggle buttons immediately (even for fallback workouts)
  syncToggleButtons();

  // Handle indoor/strength or missing continuous stream
  if (!hasStream || isStrength) {
    renderFallbackProfile(ctx, act, width, height, isStrength, unit);
    if (elevEl) elevEl.textContent = 'Elev: —';
    if (hrEl) hrEl.textContent = act?.avg_hr ? `HR: ${act.avg_hr} bpm` : 'HR: —';
    if (distEl) distEl.textContent = 'Dist: —';
    return;
  }

  // Initial draw
  drawProfile(null);

  // Interactive mouse scrubbing
  canvas.onmousemove = (e) => {
    const bRect = (typeof canvas.getBoundingClientRect === 'function')
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0, width, height };
    const clientX = (e.clientX !== undefined) ? e.clientX : ((e.offsetX || 0) + bRect.left);
    const xPix = clientX - bRect.left;
    const clampedX = Math.max(padLeft, Math.min(padLeft + plotW, xPix));
    const ratio = (clampedX - padLeft) / plotW;
    const idx = Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1))));

    // Live Readout
    if (elevEl) {
      if (hasElevData && elevValues[idx] !== undefined) {
        elevEl.textContent = `Elev: ${Math.round(elevValues[idx])} ${elevUnit}`;
      } else {
        elevEl.textContent = 'Elev: —';
      }
    }
    if (hrEl) {
      if (hasHrData && hrs[idx] !== undefined && hrs[idx] > 0) {
        hrEl.textContent = `HR: ${Math.round(hrs[idx])} bpm`;
      } else {
        hrEl.textContent = 'HR: —';
      }
    }
    if (distEl) {
      const dVal = (distances && distances[idx] !== undefined && distances[idx] > 0)
        ? distances[idx]
        : ((idx / Math.max(1, n - 1)) * (act?.distance_meters || 0));
      distEl.textContent = `Dist: ${formatDistance(dVal, unit)}`;
    }

    // Synchronize Route Map Marker
    if (coords && coords[idx]) {
      updateScrubberMarker(coords[idx][0], coords[idx][1]);
    }

    drawProfile(idx);
  };

  canvas.onmouseleave = () => {
    if (elevEl) elevEl.textContent = 'Elev: —';
    if (hrEl) hrEl.textContent = 'HR: —';
    if (distEl) distEl.textContent = 'Dist: —';
    clearScrubberMarker();
    drawProfile(null);
  };

  profileChartInstance = {
    destroy: () => {
      canvas.onmousemove = null;
      canvas.onmouseleave = null;
    }
  };
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

  const expandBtn = document.getElementById('btn-expand-drawer');
  if (expandBtn) {
    expandBtn.addEventListener('click', toggleDrawerExpand);
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
