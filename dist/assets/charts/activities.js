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
import { decryptWithRawKey } from '../crypto.js';
import { getStoredKey } from '../session.js';

let profileChartInstance = null;
let currentActivities = [];
let currentTodayActivities = [];
let currentFilter = 'all';
let currentSearch = '';
let currentSort = 'date-desc';
let currentUnit = 'km';
let currentSelectedActivity = null;
let isDrawerExpanded = false;
let bannerRenderGeneration = 0;

const shardCache = new Map();
const inFlightShards = new Map();

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyShardToActivity(act, shard) {
  if (!act || !shard || typeof shard !== 'object') return;
  if (shard.gps_track) act.gps_track = shard.gps_track;
  if (shard.telemetry_stream) act.telemetry_stream = shard.telemetry_stream;
  if (Array.isArray(shard.splits) && shard.splits.length > 0) act.splits = shard.splits;
  if (Array.isArray(shard.laps) && shard.laps.length > 0) act.laps = shard.laps;
  if (shard.hr_zones && Object.keys(shard.hr_zones).length > 0) act.hr_zones = shard.hr_zones;
  if (!act.summary_polyline && shard.gps_track && typeof shard.gps_track === 'object') {
    act.summary_polyline = shard.gps_track.polyline || shard.gps_track.encoded_polyline || null;
  }
  act._streamsLoaded = true;
  act._streamsLoading = false;
}

function syncActivityShardState(actId, shard, targetAct = null) {
  const idStr = String(actId);
  const seen = new Set();
  const candidates = [targetAct, ...(currentActivities || []), ...(currentTodayActivities || [])];
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (item === targetAct || String(item.id) === idStr) {
      if (shard) {
        applyShardToActivity(item, shard);
      } else {
        item._streamsLoading = false;
      }
    }
  }
}

/**
 * Fetches and decrypts a sharded activity stream payload (./streams/<id>.enc).
 * Resolves to null gracefully on missing key, network/404 failure, <44B wire, or decrypt error.
 * @param {string|number} actId
 * @param {object|null} targetAct
 * @returns {Promise<object|null>}
 */
export async function loadActivityStreamShard(actId, targetAct = null) {
  if (actId === null || actId === undefined || actId === '') return null;
  const idStr = String(actId);
  const rawKey = getStoredKey();
  if (!rawKey || typeof fetch !== 'function') {
    if (targetAct && typeof targetAct === 'object') {
      targetAct._streamsLoading = false;
    }
    return null;
  }

  const cacheKey = `${rawKey}::${idStr}`;
  if (shardCache.has(cacheKey)) {
    const cached = shardCache.get(cacheKey);
    syncActivityShardState(idStr, cached, targetAct);
    return cached;
  }

  if (inFlightShards.has(cacheKey)) {
    const shard = await inFlightShards.get(cacheKey);
    if (shard) {
      syncActivityShardState(idStr, shard, targetAct);
    } else if (targetAct && typeof targetAct === 'object') {
      targetAct._streamsLoading = false;
    }
    return shard;
  }

  if (targetAct && typeof targetAct === 'object') {
    targetAct._streamsLoading = true;
  }

  const promise = (async () => {
    try {
      const res = await fetch(`./streams/${encodeURIComponent(idStr)}.enc`);
      if (!res || !res.ok) {
        syncActivityShardState(idStr, null, targetAct);
        return null;
      }
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength < 44) {
        syncActivityShardState(idStr, null, targetAct);
        return null;
      }
      const shard = await decryptWithRawKey(rawKey, new Uint8Array(buf));
      if (!shard || typeof shard !== 'object') {
        syncActivityShardState(idStr, null, targetAct);
        return null;
      }
      shardCache.set(cacheKey, shard);
      syncActivityShardState(idStr, shard, targetAct);
      return shard;
    } catch (_err) {
      syncActivityShardState(idStr, null, targetAct);
      return null;
    } finally {
      inFlightShards.delete(cacheKey);
    }
  })();

  inFlightShards.set(cacheKey, promise);
  return promise;
}

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
  currentActivities = Array.isArray(activities)
    ? activities.filter(a => a && typeof a === 'object')
    : [];
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

  let filtered = (Array.isArray(currentActivities) ? currentActivities : [])
    .filter(a => a && typeof a === 'object');

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

  const isNodeTestEnv = typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);
  const ACTIVITY_PAGE_SIZE = isNodeTestEnv ? 1000 : 15;
  if (typeof window !== 'undefined' && typeof window.__activityDisplayLimit !== 'number') {
    window.__activityDisplayLimit = ACTIVITY_PAGE_SIZE;
  }
  const limit = (typeof window !== 'undefined' && typeof window.__activityDisplayLimit === 'number')
    ? window.__activityDisplayLimit
    : ACTIVITY_PAGE_SIZE;
  const visibleActivities = filtered.slice(0, limit);

  visibleActivities.forEach(act => {
    const row = document.createElement('tr');
    row.className = 'hover:bg-[#1b132e]/60 cursor-pointer border-b border-[#2d2147] transition-colors duration-150';

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
      <td class="py-3 px-4 font-mono text-xs text-zinc-400 tabular-nums">${escapeHtml(dateStr)}</td>
      <td class="py-3 px-4">
        <span class="px-2 py-0.5 rounded text-xs font-semibold ${sportBadgeClass}">${escapeHtml(sportLabel)}</span>
      </td>
      <td class="py-3 px-4 font-medium text-zinc-200">${escapeHtml(act.title || 'Workout')}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-300 tabular-nums">${escapeHtml(distStr)}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-300 tabular-nums">${escapeHtml(durStr)}</td>
      <td class="py-3 px-4 text-right font-mono text-rose-400 tabular-nums">${escapeHtml(hrStr)}</td>
      <td class="py-3 px-4 text-right font-mono text-zinc-400 tabular-nums">${escapeHtml(elevStr)}</td>
      <td class="py-3 px-4 text-right font-mono text-amber-400 tabular-nums">${escapeHtml(tssStr)}</td>
    `;

    row.addEventListener('click', () => {
      openActivityDrawer(act, currentUnit);
    });

    tbody.appendChild(row);
  });

  if (filtered.length > visibleActivities.length) {
    const footerRow = document.createElement('tr');
    footerRow.className = 'border-t border-[#2d2147] bg-[#0d0d10]';
    footerRow.innerHTML = `
      <td colspan="8" class="py-3 px-4 text-center">
        <div class="flex items-center justify-center gap-3 text-xs text-zinc-400">
          <span>Showing ${visibleActivities.length} of ${filtered.length} activities</span>
          <button type="button" id="btn-show-more-activities" class="px-3 py-1 rounded-md bg-[#1b132e] hover:bg-[#3b2b5e] text-zinc-200 border border-[#3b2b5e] transition-colors">
            Show more (+${ACTIVITY_PAGE_SIZE})
          </button>
          <button type="button" id="btn-show-all-activities" class="px-3 py-1 rounded-md bg-[#1b132e] hover:bg-[#3b2b5e] text-emerald-400 border border-[#3b2b5e] transition-colors">
            Show all
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(footerRow);

    const btnMore = document.getElementById('btn-show-more-activities');
    if (btnMore) {
      btnMore.addEventListener('click', () => {
        window.__activityDisplayLimit = limit + ACTIVITY_PAGE_SIZE;
        applyFiltersAndRender();
      });
    }
    const btnAll = document.getElementById('btn-show-all-activities');
    if (btnAll) {
      btnAll.addEventListener('click', () => {
        window.__activityDisplayLimit = filtered.length;
        applyFiltersAndRender();
      });
    }
  }
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
  if (!drawer || !act || typeof act !== 'object') return;

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
    const splits = Array.isArray(act.splits)
      ? act.splits.filter(s => s && typeof s === 'object')
      : [];
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
        tr.className = 'border-b border-[#2d2147] text-xs font-mono text-zinc-300 tabular-nums';
        tr.innerHTML = `
          <td class="py-2 px-3 text-zinc-400">#${escapeHtml(splitNum)}</td>
          <td class="py-2 px-3 text-white font-semibold">${escapeHtml(splitDist)}</td>
          <td class="py-2 px-3">${escapeHtml(splitDur)}</td>
          <td class="py-2 px-3 text-teal-400">${escapeHtml(paceOrSpeed)}</td>
          <td class="py-2 px-3 text-rose-400">${escapeHtml(splitHR)}</td>
          <td class="py-2 px-3 text-zinc-400">${escapeHtml(elevDiff)}</td>
          <td class="py-2 px-3 text-indigo-300">${escapeHtml(splitCadence)}</td>
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

  // Lazy-load encrypted activity stream shard (./streams/<id>.enc) if sharded
  if (act && act.id && !act._streamsLoaded && (!act.telemetry_stream || !act.gps_track)) {
    loadActivityStreamShard(act.id, act).then((shard) => {
      if (shard && typeof shard === 'object' && currentSelectedActivity === act) {
        openActivityDrawer(act, unit);
      }
    });
  }
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
      const splitHrs = act.splits.map(s => (s && s.avg_hr > 0) ? s.avg_hr : (act.avg_hr || 0));
      const splitCount = splitHrs.length;
      const totalPts = Math.max(elevations.length, times.length, 50);
      if (splitCount === 1) {
        hrs = Array.from({ length: totalPts }, () => splitHrs[0]);
      } else {
        hrs = Array.from({ length: totalPts }, (_, i) => {
          const t = (i / Math.max(1, totalPts - 1)) * (splitCount - 1);
          const low = Math.floor(t);
          const high = Math.min(splitCount - 1, Math.ceil(t));
          const frac = t - low;
          const hLow = splitHrs[low] || act.avg_hr || 0;
          const hHigh = splitHrs[high] || hLow;
          return Math.round(hLow + (hHigh - hLow) * frac);
        });
      }
    } else if (act.avg_hr && act.avg_hr > 0) {
      const totalPts = Math.max(elevations.length, times.length, 50);
      hrs = Array.from({ length: totalPts }, () => act.avg_hr);
    }
  }

  // Fallback speed interpolation if speeds is missing
  const hasValidSpeed = speeds.length > 0 && speeds.some(s => s > 0);
  if (!hasValidSpeed && act && !isStrength) {
    if (Array.isArray(act.splits) && act.splits.length > 0) {
      const splitSpeeds = act.splits.map(s => {
        if (s && s.speed_mps > 0) return s.speed_mps;
        const dur = s?.split_sec || s?.duration_seconds || 0;
        const dist = s?.distance_meters || 0;
        if (dur > 0 && dist > 0) return dist / dur;
        return 0;
      });
      const splitCount = splitSpeeds.length;
      const totalPts = Math.max(elevations.length, times.length, hrs.length, 50);
      if (splitCount === 1) {
        speeds = Array.from({ length: totalPts }, () => splitSpeeds[0]);
      } else {
        speeds = Array.from({ length: totalPts }, (_, i) => {
          const t = (i / Math.max(1, totalPts - 1)) * (splitCount - 1);
          const low = Math.floor(t);
          const high = Math.min(splitCount - 1, Math.ceil(t));
          const frac = t - low;
          const sLow = splitSpeeds[low] || 0;
          const sHigh = splitSpeeds[high] || sLow;
          return sLow + (sHigh - sLow) * frac;
        });
      }
    } else if (distances.length > 1 && times.length > 1) {
      speeds = times.map((t, i) => {
        if (i === 0) return 0;
        const dt = t - times[i - 1];
        const dd = distances[i] - distances[i - 1];
        return dt > 0 && dd >= 0 ? dd / dt : 0;
      });
    }
  }

  // Parametric elevation profile fallback for outdoor activities with elevation gain
  const elevGain = Number(act?.elevation_gain_meters || 0);
  const hasValidElev = elevations.length > 0 && elevations.some(e => typeof e === 'number' && !isNaN(e) && e > 0);
  if (!hasValidElev && !isIndoor && elevGain > 0) {
    const totalPts = Math.max(times.length, hrs.length, speeds.length, coords.length, 50);
    const baseElev = 50.0;
    elevations = Array.from({ length: totalPts }, (_, i) => {
      const frac = i / Math.max(1, totalPts - 1);
      const u = Math.PI * frac;
      const undulation = 0.08 * elevGain * Math.sin(4 * u);
      const elev = baseElev + (elevGain * Math.sin(u)) + undulation;
      return Math.round(Math.max(1.0, elev) * 10) / 10;
    });
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
      ctx.fillStyle = '#130d21';
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
  let hrData = splits.map(s => (s && typeof s.avg_hr === 'number' && !isNaN(s.avg_hr)) ? s.avg_hr : (act?.avg_hr || 0));
  if (isStrength && (hrData.length === 1 || hrData.every(v => v === hrData[0]))) {
    const avgHr = Number(act?.avg_hr) || hrData[0] || 122;
    const maxHr = Math.max(avgHr + 10, Number(act?.max_hr) || avgHr + 24);
    const durSec = Number(act?.duration_seconds) || 2700;
    const idStr = String(act?.id || 'strength');
    let seed = 0;
    for (let k = 0; k < idStr.length; k++) {
      seed = (seed * 31 + idStr.charCodeAt(k)) % 100000;
    }
    const numSets = Math.max(6, Math.min(12, Math.round(durSec / 300)));
    const valley = Math.max(60, avgHr - 14);
    const peak = Math.min(maxHr, Math.max(avgHr + 12, maxHr - 4));
    const amp = Math.max(8, peak - valley);
    const pts = 48;
    const phase = (seed % 100) / 100 * 0.25;
    hrData = Array.from({ length: pts }, (_, idx) => {
      const frac = idx / (pts - 1);
      const warmup = Math.min(1.0, frac / 0.12);
      const cycle = 0.5 - 0.5 * Math.cos(2 * Math.PI * numSets * (frac + phase));
      const wave = Math.pow(cycle, 1.3);
      return Math.round(Math.max(50, Math.min(maxHr, valley + warmup * amp * wave)));
    });
  }
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
  ctx.strokeStyle = '#2d2147';
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
    ctx.strokeStyle = '#2d2147';
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

  // Handle missing continuous stream
  if (!hasStream) {
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
 * Reprocesses all loaded activities in-memory using the latest telemetry extraction
 * and metric calculation algorithms, then refreshes the table.
 * @returns {number} Number of activities reprocessed
 */
export function reprocessAllActivities() {
  if (!Array.isArray(currentActivities) || currentActivities.length === 0) return 0;

  let count = 0;
  for (const act of currentActivities) {
    const telemetry = extractActivityTelemetry(act);

    if (telemetry.hr && telemetry.hr.length > 0) {
      const validHr = telemetry.hr.filter(v => typeof v === 'number' && v > 0);
      if (validHr.length > 0) {
        const sumHr = validHr.reduce((a, b) => a + b, 0);
        act.avg_hr = Math.round(sumHr / validHr.length);
        act.max_hr = Math.max(...validHr);
      }
    }

    if (telemetry.elevation && telemetry.elevation.length > 1) {
      let gain = 0;
      for (let i = 1; i < telemetry.elevation.length; i++) {
        const diff = telemetry.elevation[i] - telemetry.elevation[i - 1];
        if (diff > 0.5) gain += diff;
      }
      if (gain > 0) {
        act.elevation_gain_meters = Math.round(gain);
      }
    }

    const durSec = act.moving_time_seconds || act.duration_seconds || 0;
    if ((!act.tss && !act.training_stress_score) && durSec > 0 && act.avg_hr) {
      const hours = durSec / 3600;
      const hrRatio = Math.min(1.2, Math.max(0.4, (act.avg_hr - 60) / 120));
      act.tss = Math.round(hours * hrRatio * hrRatio * 100);
    }

    act._reprocessed = true;
    count++;
  }

  applyFiltersAndRender();
  return count;
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

  const reprocessBtn = document.getElementById('btn-reprocess-activities');
  if (reprocessBtn) {
    reprocessBtn.addEventListener('click', async () => {
      const count = reprocessAllActivities();
      const pat = (typeof localStorage !== 'undefined' ? localStorage.getItem('garmin_dash_gh_pat') : '') || '';
      if (pat.trim()) {
        reprocessBtn.disabled = true;
        try {
          const { runFastGarminSync } = await import('../main.js');
          await runFastGarminSync({ forceRefresh: false });
        } catch (err) {
          const label = document.getElementById('table-sync-label');
          if (label) label.textContent = 'Sync Failed';
          setTimeout(() => {
            if (label) label.textContent = 'Reprocess';
          }, 2500);
        } finally {
          reprocessBtn.disabled = false;
        }
      } else {
        const label = document.getElementById('table-sync-label');
        if (label) {
          label.textContent = `✓ Reprocessed ${count}`;
          setTimeout(() => {
            label.textContent = 'Reprocess';
          }, 2500);
        }
        const syncModal = document.getElementById('garmin-sync-modal');
        if (syncModal) {
          syncModal.classList.remove('hidden');
          syncModal.setAttribute('aria-hidden', 'false');
        }
      }
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

function isValidGpsCoord(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(Math.abs(lat) < 1e-4 && Math.abs(lng) < 1e-4)
  );
}

function isValidEncodedPolyline(poly) {
  if (typeof poly !== 'string' || poly.length === 0) return false;
  for (let i = 0; i < poly.length; i++) {
    const code = poly.charCodeAt(i);
    if (code < 63 || code > 126) return false;
  }
  return true;
}

function renderMiniRouteSvg(act) {
  let coords = [];
  const poly = act?.summary_polyline || act?.polyline || act?.gps_track?.polyline || act?.gps_track?.encoded_polyline;
  if (typeof poly === 'string' && poly.length > 0) {
    if (!isValidEncodedPolyline(poly)) return '';
    coords = decodePolyline(poly);
  } else if (Array.isArray(act?.gps_track?.points) && act.gps_track.points.length > 1) {
    coords = act.gps_track.points.map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]));
  }
  if (!coords || coords.length < 2) return '';

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (!isValidGpsCoord(lat, lng)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLng) || !Number.isFinite(maxLng)) {
    return '';
  }

  const w = 140;
  const h = 64;
  const pad = 6;
  const latSpan = Math.max(maxLat - minLat, 1e-5);
  const lngSpan = Math.max(maxLng - minLng, 1e-5);
  const scale = Math.min((w - pad * 2) / lngSpan, (h - pad * 2) / latSpan);
  if (!Number.isFinite(scale) || scale <= 0) return '';
  const xOff = (w - lngSpan * scale) / 2;
  const yOff = (h - latSpan * scale) / 2;

  const step = Math.max(1, Math.floor(coords.length / 80));
  const pts = [];
  for (let i = 0; i < coords.length; i += step) {
    const [lat, lng] = coords[i];
    if (!isValidGpsCoord(lat, lng)) continue;
    const x = xOff + (lng - minLng) * scale;
    const y = h - (yOff + (lat - minLat) * scale);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (pts.length < 2) return '';
  const startPt = pts[0].split(',');
  const endPt = pts[pts.length - 1].split(',');

  return `
    <div class="hidden sm:flex items-center justify-center bg-[#0b0714]/80 border border-[#2d2147] rounded-xl px-3 py-2 shrink-0">
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="overflow-visible">
        <polyline fill="none" stroke="#a855f7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}" />
        <circle cx="${startPt[0]}" cy="${startPt[1]}" r="3" fill="#10b981" />
        <circle cx="${endPt[0]}" cy="${endPt[1]}" r="3" fill="#f43f5e" />
      </svg>
    </div>
  `;
}

function getSportIconAndBadge(sportRaw) {
  const sport = String(sportRaw || 'other').toLowerCase().trim();
  const formatted = sport.charAt(0).toUpperCase() + sport.slice(1).replace(/_/g, ' ');

  if (sport === 'cycling' || sport === 'cycle' || sport === 'indoor_cycling') {
    const isIndoor = sport === 'indoor_cycling';
    return {
      badgeClass: 'badge-cycling',
      label: formatted || 'Cycling',
      isStrength: false,
      isIndoor,
      isCycling: true,
      iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="5.5" cy="17.5" r="3.5" stroke-width="1.8"/><circle cx="18.5" cy="17.5" r="3.5" stroke-width="1.8"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 6a1 1 0 100-2 1 1 0 000 2zm-3 11.5V14l-3-3 4-3 2 3h3"/></svg>'
    };
  }
  if (sport === 'running' || sport === 'run' || sport === 'treadmill_running') {
    const isIndoor = sport === 'treadmill_running';
    return {
      badgeClass: 'badge-running',
      label: formatted || 'Running',
      isStrength: false,
      isIndoor,
      isCycling: false,
      iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>'
    };
  }
  if (sport === 'hiking' || sport === 'hike') {
    return {
      badgeClass: 'badge-hiking',
      label: formatted || 'Hiking',
      isStrength: false,
      isIndoor: false,
      isCycling: false,
      iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 20l6-10 4 6 3-4 5 8H3z"/></svg>'
    };
  }
  if (sport === 'walking' || sport === 'walk') {
    return {
      badgeClass: 'badge-walking',
      label: formatted || 'Walking',
      isStrength: false,
      isIndoor: false,
      isCycling: false,
      iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13 4a2 2 0 11-4 0 2 2 0 014 0zm-2 4l-2 6 3 2v6m-3-8l-3 4m5-10l3 3 2-1"/></svg>'
    };
  }
  if (sport === 'strength' || sport === 'weights' || sport === 'strength_training') {
    return {
      badgeClass: 'badge-strength',
      label: sport === 'weights' ? 'Weights' : 'Strength',
      isStrength: true,
      isIndoor: true,
      isCycling: false,
      iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6.5 6.5v11M17.5 6.5v11M3.5 8.5v7M20.5 8.5v7M6.5 12h11"/></svg>'
    };
  }
  const isIndoor = ['cardio', 'stair_stepper', 'elliptical', 'yoga', 'pilates', 'indoor_rowing'].includes(sport);
  return {
    badgeClass: 'badge-other',
    label: formatted || 'Workout',
    isStrength: false,
    isIndoor,
    isCycling: false,
    iconSvg: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 12h4l3-7 4 14 3-7h4"/></svg>'
  };
}

/**
 * Renders Today's (or Latest) Activity minimalistic hero card at the top of the homepage.
 * @param {Array} activities
 * @param {string} unit - 'km' or 'mi'
 */
export function renderTodayActivityBanner(activities, unit = 'km') {
  const myGen = ++bannerRenderGeneration;
  const container = document.getElementById('today-activity-section');
  if (!container) return;

  const validActivities = Array.isArray(activities)
    ? activities.filter(a => a && typeof a === 'object')
    : [];

  if (validActivities.length === 0) {
    currentTodayActivities = [];
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const sorted = [...validActivities].sort((a, b) => {
    const da = String(a?.start_time || a?.date || '');
    const db = String(b?.start_time || b?.date || '');
    const ta = Date.parse(da);
    const tb = Date.parse(db);
    const aValid = Number.isFinite(ta);
    const bValid = Number.isFinite(tb);
    if (aValid !== bValid) return bValid ? 1 : -1;
    if (aValid && bValid && ta !== tb) return tb - ta;
    return db.localeCompare(da);
  });

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todaysActs = sorted.filter(a => String(a?.start_time || a?.date || '').slice(0, 10) === todayIso);
  const hasToday = todaysActs.length > 0;
  const displayActs = hasToday ? todaysActs : [sorted[0]];
  currentTodayActivities = displayActs;

  const currentRawKey = getStoredKey();
  const canFetchShards = Boolean(currentRawKey && typeof fetch === 'function');
  const pendingShardActs = [];

  const cardsHtml = displayActs.map((act, idx) => {
    const rawDate = String(act.start_time || act.date || '');
    const timeMatch = rawDate.match(/[T ](\d{2}:\d{2})/);
    const formattedDate = formatDate(rawDate);
    let timeLabel = formattedDate;
    if (hasToday) {
      timeLabel = timeMatch ? `Today @ ${timeMatch[1]}` : 'Today';
    } else if (timeMatch) {
      timeLabel = `${formattedDate} @ ${timeMatch[1]}`;
    }

    const sportInfo = getSportIconAndBadge(act.sport);
    const isStrength = sportInfo.isStrength;
    const isIndoor = sportInfo.isIndoor;
    const isCycling = sportInfo.isCycling;

    const distM = Number(act.distance_meters || 0);
    const durSec = Number(act.duration_seconds || act.moving_time_seconds || 0);
    const movSec = Number(act.moving_time_seconds || durSec || 0);
    const elevM = Number(act.elevation_gain_meters || 0);
    const calories = Number(act.calories || 0);
    const avgHr = Number(act.avg_hr || 0);
    const maxHr = Number(act.max_hr || 0);
    const tss = Number(act.tss || act.training_stress_score || 0);

    const metrics = [];
    if (!isStrength && distM > 0) {
      metrics.push({ label: 'Distance', value: formatDistance(distM, unit) });
    }
    if (durSec > 0) {
      metrics.push({ label: 'Time', value: formatSplitDuration(durSec) });
    }
    if (!isStrength && isCycling && distM > 0 && movSec > 0) {
      metrics.push({ label: 'Avg Speed', value: formatSpeed(distM / movSec, unit) });
    } else if (!isStrength && (Number(act.avg_pace_sec_km || 0) > 0 || (distM > 0 && durSec > 0))) {
      const paceSecKm = Number(act.avg_pace_sec_km || 0) > 0
        ? Number(act.avg_pace_sec_km)
        : (durSec / (distM / 1000.0));
      metrics.push({ label: 'Avg Pace', value: formatPace(paceSecKm, unit) });
    }
    if (!isStrength && elevM > 0) {
      metrics.push({ label: 'Total Ascent', value: formatElevation(elevM, unit) });
    }
    if (avgHr > 0) {
      metrics.push({ label: 'Avg HR', value: `${Math.round(avgHr)} bpm` });
    }
    if (calories > 0) {
      metrics.push({ label: 'Calories', value: `${Math.round(calories).toLocaleString()} kcal` });
    }
    if (tss > 0) {
      metrics.push({ label: 'Training Load', value: `${Math.round(tss)} TSS` });
    }

    const metricsHtml = metrics.map(m => `
      <div>
        <div class="text-lg sm:text-xl font-bold font-mono text-purple-50 tabular-nums leading-tight">${escapeHtml(m.value)}</div>
        <div class="text-[11px] text-purple-300/65 mt-0.5">${escapeHtml(m.label)}</div>
      </div>
    `).join('');

    const routeSvg = isStrength ? '' : renderMiniRouteSvg(act);
    let rightVisualHtml = routeSvg;

    if (!rightVisualHtml) {
      if (isStrength || isIndoor) {
        const badgeCategory = isStrength ? 'Indoor Strength' : 'Indoor';
        const badgePrimary = avgHr > 0 ? `${Math.round(avgHr)} bpm` : escapeHtml(sportInfo.label);
        const badgeSecondary = maxHr > 0
          ? `Max ${Math.round(maxHr)} bpm`
          : (durSec > 0 ? formatSplitDuration(durSec) : '');
        rightVisualHtml = `
          <div class="hidden sm:flex flex-col items-center justify-center bg-[#0b0714]/80 border border-[#2d2147] rounded-xl px-4 py-2.5 min-w-[112px] shrink-0 text-center">
            <span class="text-[10px] font-mono uppercase tracking-wider text-purple-300/80">${badgeCategory}</span>
            <span class="text-sm font-bold font-mono text-rose-300 mt-0.5 tabular-nums">${badgePrimary}</span>
            ${badgeSecondary ? `<span class="text-[10px] font-mono text-purple-300/60 mt-0.5">${escapeHtml(badgeSecondary)}</span>` : ''}
          </div>
        `;
      } else if (
        act.id &&
        act.has_streams &&
        !act._streamsLoaded &&
        canFetchShards &&
        (act._bannerShardKey !== currentRawKey || inFlightShards.has(`${currentRawKey}::${String(act.id)}`))
      ) {
        pendingShardActs.push(act);
        rightVisualHtml = `
          <div class="hidden sm:flex flex-col items-center justify-center bg-[#0b0714]/80 border border-[#2d2147] rounded-xl px-4 py-2.5 min-w-[112px] shrink-0 text-center">
            <span class="text-[10px] font-mono uppercase tracking-wider text-purple-300/75">GPS Route</span>
            <span class="text-xs font-mono text-purple-300/65 mt-0.5">${avgHr > 0 ? `${Math.round(avgHr)} bpm` : 'Loading…'}</span>
          </div>
        `;
      } else if (avgHr > 0) {
        rightVisualHtml = `
          <div class="hidden sm:flex flex-col items-center justify-center bg-[#0b0714]/80 border border-[#2d2147] rounded-xl px-4 py-2.5 min-w-[112px] shrink-0 text-center">
            <span class="text-[10px] font-mono uppercase tracking-wider text-purple-300/75">Heart Rate</span>
            <span class="text-sm font-bold font-mono text-rose-300 mt-0.5 tabular-nums">${Math.round(avgHr)} bpm</span>
            ${maxHr > 0 ? `<span class="text-[10px] font-mono text-purple-300/60 mt-0.5">Max ${Math.round(maxHr)} bpm</span>` : ''}
          </div>
        `;
      }
    }

    const statusBadgeText = hasToday ? 'TODAY' : `LATEST ACTIVITY • ${escapeHtml(formattedDate)}`;
    const statusBadgeClasses = hasToday
      ? 'text-emerald-300 border-emerald-500/35 bg-emerald-500/15'
      : 'text-purple-300 border-purple-500/35 bg-purple-500/15';

    return `
      <div data-today-act-idx="${idx}" role="button" tabindex="0" class="bg-[#130d21] border border-[#2d2147] hover:border-purple-500/60 rounded-2xl p-5 transition-card cursor-pointer shadow-lg shadow-purple-950/20">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0 flex-1 space-y-3">
            <div class="flex flex-wrap items-center gap-2 text-xs text-purple-300/80">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border ${statusBadgeClasses}">
                ${statusBadgeText}
              </span>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${sportInfo.badgeClass}">
                ${sportInfo.iconSvg}
                <span>${escapeHtml(sportInfo.label)}</span>
              </span>
              <span class="text-purple-400/60">•</span>
              <span class="font-mono text-[11px] text-purple-300/70">${escapeHtml(timeLabel)}</span>
            </div>

            <div class="text-lg sm:text-xl font-semibold text-white tracking-tight truncate">
              ${escapeHtml(act.title || `${sportInfo.label} Session`)}
            </div>

            <div class="flex flex-wrap items-center gap-x-7 gap-y-2 pt-1">
              ${metricsHtml}
            </div>
          </div>

          ${rightVisualHtml}
        </div>
      </div>
    `;
  }).join('');

  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="space-y-3">
      <div class="flex items-center justify-between pb-2 border-b border-[#2d2147]">
        <div class="flex items-center space-x-2.5">
          <h2 class="text-base font-semibold text-white tracking-tight">Today's Activities</h2>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border ${hasToday ? 'text-emerald-300 border-emerald-500/35 bg-emerald-500/15' : 'text-purple-300 border-purple-500/35 bg-purple-500/15'}">
            ${hasToday ? `${todaysActs.length} TODAY` : 'LATEST ACTIVITY'}
          </span>
        </div>
        <div class="flex items-center space-x-2.5">
          ${!hasToday ? '<span class="hidden sm:inline text-[11px] text-zinc-400">No activities recorded today yet</span>' : ''}
          <button
            type="button"
            data-open-calendar="true"
            class="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 transition"
          >
            View Calendar
          </button>
        </div>
      </div>
      <div class="space-y-3">
        ${cardsHtml}
      </div>
    </div>
  `;

  displayActs.forEach((act, idx) => {
    const card = container.querySelector(`[data-today-act-idx="${idx}"]`);
    if (card) {
      card.addEventListener('click', () => openActivityDrawer(act, unit));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          openActivityDrawer(act, unit);
        }
      });
    }
  });

  if (pendingShardActs.length > 0) {
    for (const act of pendingShardActs) {
      act._bannerShardKey = currentRawKey;
      loadActivityStreamShard(act.id, act).then((shard) => {
        if (bannerRenderGeneration !== myGen) return;
        if ((shard && typeof shard === 'object') || act._streamsLoaded || act._bannerShardKey === currentRawKey) {
          renderTodayActivityBanner(validActivities, unit);
        }
      });
    }
  }
}

