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

  // Render Interactive GPS Route Map (Feature F9)
  renderRouteMap(act);

  // Render Synchronized Profile Chart (Feature F10)
  renderActivityProfileChart(act, unit);

  // Show Drawer
  drawer.classList.remove('hidden');
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
 * Normalizes activity telemetry into aligned time-series streams for profile curves.
 * @param {object} act
 * @returns {object} { times, elevations, hrs, distances, coords, hasStream }
 */
export function extractActivityTelemetry(act) {
  let times = [];
  let elevations = [];
  let hrs = [];
  let distances = [];
  let coords = [];
  let speeds = [];
  let cadences = [];

  const stream = act ? act.telemetry_stream : null;
  if (stream) {
    times = stream.time || stream.time_s || [];
    elevations = stream.elevation || [];
    hrs = stream.hr || stream.heart_rate || [];
    distances = stream.distance_m || stream.distance || [];
    speeds = stream.speed || stream.speed_mps || [];
    cadences = stream.cadence || [];
  }

  // Fallback / supplement from gps_track.points ([lat, lon, elev, hr])
  if (act && act.gps_track && Array.isArray(act.gps_track.points) && act.gps_track.points.length > 0) {
    const pts = act.gps_track.points;
    if (coords.length === 0) coords = pts.map(p => [Number(p[0]), Number(p[1])]);
    if (elevations.length === 0) elevations = pts.map(p => Number(p[2]) || 0);
    const hasHrInStream = hrs.some(h => typeof h === 'number' && h > 0);
    if (!hasHrInStream && pts[0] && pts[0].length >= 4) {
      hrs = pts.map(p => Number(p[3]) || 0);
    }
    if (times.length === 0) {
      const dur = act.moving_time_seconds || act.duration_seconds || 3600;
      times = pts.map((_, i) => Math.round(i * dur / Math.max(1, pts.length - 1)));
    }
  }

  if (coords.length === 0 && act && act.gps_track && typeof act.gps_track.polyline === 'string') {
    coords = decodePolyline(act.gps_track.polyline);
  }

  // Fallback HR interpolation if hrs is missing or all zeros
  const hasValidHr = hrs.some(h => typeof h === 'number' && h > 0);
  if (!hasValidHr && act) {
    if (Array.isArray(act.splits) && act.splits.some(s => s.avg_hr > 0)) {
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
  const hasValidSpeed = speeds.some(s => typeof s === 'number' && s > 0);
  if (!hasValidSpeed && act) {
    if (Array.isArray(act.splits) && act.splits.length > 0) {
      const totalPts = Math.max(elevations.length, times.length, hrs.length, 50);
      const splitCount = act.splits.length;
      speeds = Array.from({ length: totalPts }, (_, i) => {
        const splitIdx = Math.min(splitCount - 1, Math.floor((i / totalPts) * splitCount));
        const s = act.splits[splitIdx];
        if (s?.speed_mps > 0) return s.speed_mps;
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
  const hasValidCadence = cadences.some(c => typeof c === 'number' && c > 0);
  if (!hasValidCadence && act) {
    if (Array.isArray(act.splits) && act.splits.some(s => s.avg_cadence > 0)) {
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

  const hasStream = (elevations.length > 1 && elevations.some(e => e !== 0)) ||
                    (hrs.length > 1 && hrs.some(h => h !== 0));
  return { times, elevations, hrs, distances, coords, speeds, cadences, hasStream };
}

/**
 * Renders fallback profile for indoor/strength or workouts without continuous streams.
 */
function renderFallbackProfile(ctx, act, width, height, isStrength, unit) {
  const padLeft = 40;
  const padRight = 40;
  const padTop = 15;
  const padBottom = 25;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  const splits = act.splits || [];
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
  const hrData = splits.map(s => s.avg_hr || 0);
  const validHRs = hrData.filter(h => typeof h === 'number' && h > 40 && h < 225);
  let minHR = validHRs.length > 0 ? Math.min(...validHRs) : 60;
  let maxHR = validHRs.length > 0 ? Math.max(...validHRs) : 190;
  if (minHR === maxHR) { minHR -= 10; maxHR += 10; }
  const hrPad = (maxHR - minHR) * 0.1;
  minHR = Math.floor(minHR - hrPad);
  maxHR = Math.ceil(maxHR + hrPad);

  const n = hrData.length;
  const getX = (i) => padLeft + (i / Math.max(1, n - 1)) * plotW;
  const getY = (val) => padTop + (1 - (val - minHR) / Math.max(1, maxHR - minHR)) * plotH;

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

/**
 * Renders Synchronized Route Elevation and Heart Rate Profile Curves.
 * Includes interactive hover scrub cursor, live readout, and route map synchronization.
 * For indoor/strength workouts, gracefully falls back to split HR profile or informational display.
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
  const rect = (typeof canvas.getBoundingClientRect === 'function')
    ? canvas.getBoundingClientRect()
    : { width: canvas.width || 600, height: canvas.height || 180 };
  const width = rect.width > 0 ? rect.width : (canvas.width || 600);
  const height = rect.height > 0 ? rect.height : (canvas.height || 180);

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  if (canvas.style) {
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }

  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else if (typeof ctx.resetTransform === 'function') {
    ctx.resetTransform();
    if (typeof ctx.scale === 'function' && dpr !== 1) ctx.scale(dpr, dpr);
  }
  if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, width, height);

  const sport = (act.sport || '').toLowerCase();
  const isStrength = sport === 'strength' || sport === 'weights';
  const isCycling = sport === 'cycling' || sport === 'cycle';
  const { times, elevations, hrs, distances, coords, speeds, cadences, hasStream } = extractActivityTelemetry(act);

  // Readout elements
  const elevEl = document.getElementById('readout-elev');
  const hrEl = document.getElementById('readout-hr');
  const distEl = document.getElementById('readout-dist');

  // Handle indoor/strength or missing continuous stream
  if (!hasStream || isStrength) {
    renderFallbackProfile(ctx, act, width, height, isStrength, unit);
    if (elevEl) elevEl.textContent = 'Elev: —';
    if (hrEl) hrEl.textContent = isStrength && act.avg_hr ? `HR: ${act.avg_hr} bpm` : 'HR: —';
    if (distEl) distEl.textContent = 'Dist: —';
    return;
  }

  const n = Math.max(elevations.length, hrs.length, speeds.length, cadences.length);
  const padLeft = 45;
  const padRight = 45;
  const padTop = 15;
  const padBottom = 25;
  const plotW = Math.max(10, width - padLeft - padRight);
  const plotH = Math.max(10, height - padTop - padBottom);

  // Elevation scale
  const isImperial = unit === 'mi';
  const elevValues = elevations.map(e => isImperial ? e * 3.28084 : e);
  const elevUnit = isImperial ? 'ft' : 'm';
  let minElev = elevValues.length > 0 ? Math.min(...elevValues) : 0;
  let maxElev = elevValues.length > 0 ? Math.max(...elevValues) : 100;
  if (minElev === maxElev) { minElev -= 10; maxElev += 10; }
  const elevPad = Math.max((maxElev - minElev) * 0.1, 5);
  minElev = Math.floor(minElev - elevPad);
  maxElev = Math.ceil(maxElev + elevPad);

  // Heart rate scale
  const validHRs = hrs.filter(h => typeof h === 'number' && h >= 40 && h <= 225);
  let minHR = validHRs.length > 0 ? Math.min(...validHRs) : 60;
  let maxHR = validHRs.length > 0 ? Math.max(...validHRs) : 190;
  if (minHR === maxHR) { minHR -= 10; maxHR += 10; }
  const hrPad = Math.max((maxHR - minHR) * 0.1, 5);
  minHR = Math.floor(minHR - hrPad);
  maxHR = Math.ceil(maxHR + hrPad);

  // Pace / Speed scale
  const validSpeeds = speeds.filter(s => typeof s === 'number' && s > 0);
  let minSpeed = validSpeeds.length > 0 ? Math.min(...validSpeeds) : 0;
  let maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 10;
  if (minSpeed === maxSpeed) { minSpeed = Math.max(0, minSpeed - 2); maxSpeed += 2; }
  const speedPad = Math.max((maxSpeed - minSpeed) * 0.1, 0.5);
  minSpeed = Math.max(0, minSpeed - speedPad);
  maxSpeed = maxSpeed + speedPad;

  // Cadence scale
  const validCads = cadences.filter(c => typeof c === 'number' && c > 0);
  let minCad = validCads.length > 0 ? Math.min(...validCads) : 40;
  let maxCad = validCads.length > 0 ? Math.max(...validCads) : 200;
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

    // 1. Gridlines & Y-Axis labels
    ctx.strokeStyle = '#1f1f24';
    ctx.lineWidth = 1;
    for (let step = 0; step <= 4; step++) {
      const y = padTop + (step / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();

      // Left Y-Axis: Elevation (if enabled)
      if (streamVisibility.elevation !== false) {
        const eVal = Math.round(maxElev - (step / 4) * (maxElev - minElev));
        ctx.fillStyle = '#10b981';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${eVal}`, padLeft - 6, y);
      }

      // Right Y-Axis: Heart Rate (if enabled)
      if (streamVisibility.hr !== false) {
        const hVal = Math.round(maxHR - (step / 4) * (maxHR - minHR));
        ctx.fillStyle = '#f43f5e';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${hVal}`, width - padRight + 6, y);
      }
    }

    // 2. Elevation Area Curve (Emerald gradient fill + line)
    if (streamVisibility.elevation !== false && elevValues.length > 1) {
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
    if (streamVisibility.pace !== false && speeds.length > 1 && validSpeeds.length > 0) {
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
    if (streamVisibility.cadence !== false && cadences.length > 1 && validCads.length > 0) {
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
    if (streamVisibility.hr !== false && hrs.length > 1) {
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
    const midDist = (act.distance_meters || 0) / 2;
    ctx.fillText(formatDistance(midDist, unit), padLeft + plotW / 2, padTop + plotH + 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatDistance(act.distance_meters || 0, unit), width - padRight, padTop + plotH + 6);

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

      if (streamVisibility.elevation !== false && elevValues[scrubIdx] !== undefined) {
        ctx.beginPath();
        ctx.arc(xScrub, getYElev(elevValues[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (streamVisibility.pace !== false && speeds[scrubIdx] !== undefined && speeds[scrubIdx] > 0) {
        ctx.beginPath();
        ctx.arc(xScrub, getYSpeed(speeds[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#38bdf8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (streamVisibility.cadence !== false && cadences[scrubIdx] !== undefined && cadences[scrubIdx] > 0) {
        ctx.beginPath();
        ctx.arc(xScrub, getYCad(cadences[scrubIdx]), 4, 0, Math.PI * 2);
        ctx.fillStyle = '#818cf8';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (streamVisibility.hr !== false && hrs[scrubIdx] !== undefined && hrs[scrubIdx] > 0) {
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
  const streamToggleDefs = [
    { id: 'toggle-stream-elevation', key: 'elevation', activeCls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
    { id: 'toggle-stream-hr', key: 'hr', activeCls: 'bg-rose-500/20 text-rose-400 border-rose-500/30' },
    { id: 'toggle-stream-pace', key: 'pace', activeCls: 'bg-sky-500/20 text-sky-400 border-sky-500/30' },
    { id: 'toggle-stream-cadence', key: 'cadence', activeCls: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' }
  ];

  function syncToggleButtons() {
    streamToggleDefs.forEach(({ id, key, activeCls }) => {
      const btn = document.getElementById(id);
      if (!btn) return;
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
  syncToggleButtons();

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
    if (elevEl && elevValues[idx] !== undefined) {
      elevEl.textContent = `Elev: ${Math.round(elevValues[idx])} ${elevUnit}`;
    }
    if (hrEl && hrs[idx] !== undefined) {
      hrEl.textContent = `HR: ${hrs[idx]} bpm`;
    }
    if (distEl) {
      const dVal = (distances && distances[idx] !== undefined)
        ? distances[idx]
        : ((idx / Math.max(1, n - 1)) * (act.distance_meters || 0));
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
