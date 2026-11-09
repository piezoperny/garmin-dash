/**
 * frontend/src/charts/route_map.js
 * 
 * Interactive GPS Route Mapping Component (Features F9 & F10)
 * - Leaflet.js interactive dark-themed map
 * - Google Encoded Polyline (1e5 precision) and coordinate stream decoding
 * - Statistical GPS outlier filtering (Null Island (0,0) rejection & 3*IQR teleport pruning)
 * - Automatic bounding box calculation and viewport fitting (map.fitBounds)
 * - Start marker (emerald green circle) and Finish marker (rose red circle)
 * - Synchronized scrubber marker for elevation/HR profile cursor
 * - Clean handling and fallback for indoor/strength sessions
 * - Safe for headless Node.js runner execution (window.L safeguard)
 */

let currentMapInstance = null;
let currentPolyline = null;
let startMarker = null;
let finishMarker = null;
let scrubberMarker = null;

/**
 * Safely shows an element across standard and mock DOM environments.
 * @param {HTMLElement} el
 */
function showElement(el) {
  if (!el) return;
  if (el.classList && typeof el.classList.remove === 'function') {
    el.classList.remove('hidden');
  } else if (typeof el.removeClass === 'function') {
    el.removeClass('hidden');
  }
}

/**
 * Safely hides an element across standard and mock DOM environments.
 * @param {HTMLElement} el
 */
function hideElement(el) {
  if (!el) return;
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add('hidden');
  } else if (typeof el.addClass === 'function') {
    el.addClass('hidden');
  }
}

/**
 * Decodes Google Encoded Polyline string (precision 1e5) into array of [lat, lng] pairs.
 * @param {string} encoded
 * @returns {Array<[number, number]>}
 */
export function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;

  while (index < len) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);

    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);

    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    coords.push([lat / 1e5, lng / 1e5]);
  }

  return coords;
}

/**
 * Filters out invalid GPS points and extreme anomalies (e.g. (0,0), out-of-range lat/lon, or teleports).
 * @param {Array<[number, number]>} coords - Array of [lat, lng]
 * @returns {Array<[number, number]>} Cleaned coordinates
 */
export function filterGpsOutliers(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return [];

  // 1. Filter out obvious invalids: non-numbers, out-of-bounds, (0,0) Null Island
  const valid = coords.filter(([lat, lng]) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (isNaN(lat) || isNaN(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    if (Math.abs(lat) < 1e-4 && Math.abs(lng) < 1e-4) return false;
    return true;
  });

  if (valid.length <= 4) return valid;

  // 2. Statistical IQR-based filtering to prune teleport spikes
  const sortedLats = valid.map(p => p[0]).sort((a, b) => a - b);
  const sortedLngs = valid.map(p => p[1]).sort((a, b) => a - b);

  const q1Lat = sortedLats[Math.floor(valid.length * 0.25)];
  const q3Lat = sortedLats[Math.floor(valid.length * 0.75)];
  const iqrLat = Math.max(q3Lat - q1Lat, 0.05);

  const q1Lng = sortedLngs[Math.floor(valid.length * 0.25)];
  const q3Lng = sortedLngs[Math.floor(valid.length * 0.75)];
  const iqrLng = Math.max(q3Lng - q1Lng, 0.05);

  const minLat = q1Lat - 3.0 * iqrLat;
  const maxLat = q3Lat + 3.0 * iqrLat;
  const minLng = q1Lng - 3.0 * iqrLng;
  const maxLng = q3Lng + 3.0 * iqrLng;

  return valid.filter(([lat, lng]) => {
    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  });
}

/**
 * Calculates geographic bounding box [[minLat, minLng], [maxLat, maxLng]]
 * @param {Array<[number, number]>} coords
 * @returns {[[number, number], [number, number]] | null}
 */
export function calculateBounds(coords) {
  if (!coords || coords.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  if (minLat === maxLat) {
    minLat -= 0.005;
    maxLat += 0.005;
  }
  if (minLng === maxLng) {
    minLng -= 0.005;
    maxLng += 0.005;
  }

  return [[minLat, minLng], [maxLat, maxLng]];
}

/**
 * Extracts coordinate list from activity gps_track payload.
 * @param {object} gpsTrack
 * @returns {Array<[number, number]>}
 */
export function extractCoordinates(gpsTrack) {
  if (!gpsTrack) return [];
  if (Array.isArray(gpsTrack.points) && gpsTrack.points.length > 0) {
    return gpsTrack.points.map(p => [Number(p[0]), Number(p[1])]);
  }
  if (typeof gpsTrack.polyline === 'string' && gpsTrack.polyline.length > 0) {
    return decodePolyline(gpsTrack.polyline);
  }
  return [];
}

/**
 * Renders or updates the interactive GPS route map for the selected activity.
 * @param {object} activity
 */
export function renderRouteMap(activity) {
  const mapEl = document.getElementById('activity-route-map');
  const fallbackEl = document.getElementById('drawer-map-fallback');
  const metaEl = document.getElementById('drawer-map-meta');

  const rawCoords = activity ? extractCoordinates(activity.gps_track) : [];
  const coords = filterGpsOutliers(rawCoords);

  if (!coords || coords.length === 0) {
    hideElement(mapEl);
    showElement(fallbackEl);
    if (metaEl) metaEl.textContent = 'Indoor / No GPS';
    destroyRouteMap();
    return;
  }

  showElement(mapEl);
  hideElement(fallbackEl);
  if (metaEl) metaEl.textContent = `${coords.length} GPS Points`;

  const bounds = calculateBounds(coords);

  // Check Leaflet availability (safeguard for headless / test runner environments)
  const L = (typeof window !== 'undefined' && window.L) ? window.L : null;
  if (!L || !mapEl) {
    if (mapEl) {
      if (typeof mapEl.setAttribute === 'function') {
        mapEl.setAttribute('data-points-count', String(coords.length));
        if (bounds) mapEl.setAttribute('data-bounds', JSON.stringify(bounds));
      }
    }
    return;
  }

  // Ensure clean map instance on container
  if (!currentMapInstance) {
    currentMapInstance = L.map(mapEl, {
      zoomControl: true,
      attributionControl: true
    });

    // Esri World Dark Gray Canvas tile layer (open, free, keyless, matching obsidian aesthetic)
    const tileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{x}/{y}', {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, Garmin',
      maxZoom: 16,
      crossOrigin: true
    });
    if (typeof tileLayer.on === 'function') {
      tileLayer.on('tileerror', (error) => {
        console.warn('Map tile load warning:', error);
      });
    }
    tileLayer.addTo(currentMapInstance);
  } else {
    // Clear previous layers
    if (currentPolyline) currentMapInstance.removeLayer(currentPolyline);
    if (startMarker) currentMapInstance.removeLayer(startMarker);
    if (finishMarker) currentMapInstance.removeLayer(finishMarker);
    if (scrubberMarker) currentMapInstance.removeLayer(scrubberMarker);
  }

  // Add polyline
  currentPolyline = L.polyline(coords, {
    color: '#38bdf8', // sky-400
    weight: 4,
    opacity: 0.9,
    smoothFactor: 1.0
  }).addTo(currentMapInstance);

  // Add Start Marker (emerald green circle)
  startMarker = L.circleMarker(coords[0], {
    radius: 7,
    fillColor: '#10b981',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.95
  }).bindPopup('<b>Start</b>').addTo(currentMapInstance);

  // Add Finish Marker (rose red circle)
  finishMarker = L.circleMarker(coords[coords.length - 1], {
    radius: 7,
    fillColor: '#ef4444',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.95
  }).bindPopup('<b>Finish</b>').addTo(currentMapInstance);

  // Fit bounds with padding
  if (bounds) {
    currentMapInstance.fitBounds(bounds, { padding: [24, 24] });
  }

  // Invalidate map size after drawer slide transition
  setTimeout(() => {
    if (currentMapInstance) {
      currentMapInstance.invalidateSize();
    }
  }, 120);
}

/**
 * Updates or renders the synchronized scrubber marker along the GPS route.
 * @param {number} lat
 * @param {number} lng
 * @param {string} [label]
 */
export function updateScrubberMarker(lat, lng, label) {
  const L = (typeof window !== 'undefined' && window.L) ? window.L : null;
  if (!L || !currentMapInstance) return;

  if (lat == null || lng == null) {
    clearScrubberMarker();
    return;
  }

  if (!scrubberMarker) {
    scrubberMarker = L.circleMarker([lat, lng], {
      radius: 6,
      fillColor: '#fbbf24', // amber-400
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(currentMapInstance);
  } else {
    scrubberMarker.setLatLng([lat, lng]);
  }

  if (label) {
    scrubberMarker.bindTooltip(label, { permanent: false, direction: 'top' }).openTooltip();
  }
}

/**
 * Clears or removes the scrubber marker from the route map.
 */
export function clearScrubberMarker() {
  const L = (typeof window !== 'undefined' && window.L) ? window.L : null;
  if (!L || !currentMapInstance) return;
  if (scrubberMarker) {
    currentMapInstance.removeLayer(scrubberMarker);
    scrubberMarker = null;
  }
}

/**
 * Destroys active Leaflet map instance and cleans up references.
 */
export function destroyRouteMap() {
  if (currentMapInstance) {
    try {
      currentMapInstance.remove();
    } catch (_) {}
    currentMapInstance = null;
    currentPolyline = null;
    startMarker = null;
    finishMarker = null;
    scrubberMarker = null;
  }
}

/**
 * Invalidates and recalculates map container size.
 */
export function invalidateMapSize() {
  if (currentMapInstance && typeof currentMapInstance.invalidateSize === 'function') {
    try {
      currentMapInstance.invalidateSize();
    } catch (_) {}
  }
}

// Optional browser window hook for cross-module integration
if (typeof window !== 'undefined') {
  window.__routeMap = {
    renderRouteMap,
    destroyRouteMap,
    updateScrubberMarker,
    clearScrubberMarker,
    decodePolyline,
    filterGpsOutliers,
    calculateBounds,
    invalidateMapSize
  };
}
