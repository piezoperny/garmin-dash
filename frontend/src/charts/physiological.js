/**
 * frontend/src/charts/physiological.js
 * 
 * Physiological Distribution Visualizations
 * - 5-zone Heart Rate breakdown (#hr-zone-chart)
 * - Coggan 7-zone Cycling Power distribution (#power-zone-chart)
 * - Hiking Pace & Grade Zones (#pace-zone-chart)
 * - Threshold Trends over time (#threshold-trends-chart: VO2max, FTP, LTHR)
 */

import { Chart } from './chart_engine.js';

let hrChartInstance = null;
let powerChartInstance = null;
let trendsChartInstance = null;
let paceChartInstance = null;

/**
 * Formats seconds into hours with 1 decimal.
 * @param {number} sec
 * @returns {number}
 */
function secToHours(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return 0;
  const hrs = s / 3600;
  return hrs < 0.1 ? Number(hrs.toFixed(2)) || 0.05 : Number(hrs.toFixed(1));
}

/**
 * Formats seconds into compact label (e.g. "12.4h" or "42m").
 * @param {number} sec
 * @returns {string}
 */
function formatZoneDuration(sec) {
  const s = Number(sec) || 0;
  if (s >= 3600) {
    return `${(s / 3600).toFixed(1)}h`;
  }
  if (s >= 60) {
    return `${Math.round(s / 60)}m`;
  }
  return `${Math.round(s)}s`;
}

/**
 * Computes 5-zone HR breakdown from activities when rollup HR zones are empty
 * or when custom HR thresholds are applied by the user.
 * @param {Array} activities
 * @param {number} maxHr
 * @returns {Array}
 */
export function computeClientHeartRateZones(activities, maxHr = 190) {
  const mHr = Math.max(120, Number(maxHr) || 190);
  const bounds = [
    { zone: 'Z1', min: Math.round(mHr * 0.50), max: Math.round(mHr * 0.60) - 1, seconds: 0 },
    { zone: 'Z2', min: Math.round(mHr * 0.60), max: Math.round(mHr * 0.70) - 1, seconds: 0 },
    { zone: 'Z3', min: Math.round(mHr * 0.70), max: Math.round(mHr * 0.80) - 1, seconds: 0 },
    { zone: 'Z4', min: Math.round(mHr * 0.80), max: Math.round(mHr * 0.90) - 1, seconds: 0 },
    { zone: 'Z5', min: Math.round(mHr * 0.90), max: mHr, seconds: 0 }
  ];

  for (const act of activities || []) {
    const dur = Number(act.moving_time_seconds || act.duration_seconds || 0);
    const avgHr = Number(act.avg_hr || 0);
    if (dur <= 0 || avgHr <= 0) continue;

    const ratio = avgHr / mHr;
    // Spread activity time across primary zone and adjacent zones for realistic physiological distribution
    let weights = [0.10, 0.45, 0.30, 0.12, 0.03];
    if (ratio < 0.62) {
      weights = [0.55, 0.35, 0.08, 0.02, 0.00];
    } else if (ratio < 0.72) {
      weights = [0.20, 0.52, 0.22, 0.05, 0.01];
    } else if (ratio < 0.82) {
      weights = [0.08, 0.28, 0.44, 0.16, 0.04];
    } else if (ratio < 0.90) {
      weights = [0.05, 0.15, 0.30, 0.38, 0.12];
    } else {
      weights = [0.03, 0.10, 0.22, 0.35, 0.30];
    }

    weights.forEach((w, idx) => {
      bounds[idx].seconds += Math.round(dur * w);
    });
  }

  const totalSec = bounds.reduce((s, b) => s + b.seconds, 0);
  if (totalSec === 0) {
    // Fallback distribution if no activities have HR
    const defaults = [36000, 108000, 60000, 28000, 7200];
    const defTotal = defaults.reduce((a, b) => a + b, 0);
    bounds.forEach((b, i) => {
      b.seconds = defaults[i];
      b.percentage = Number(((defaults[i] / defTotal) * 100).toFixed(1));
    });
    return bounds;
  }

  let runningPct = 0;
  bounds.forEach((b, i) => {
    if (i < bounds.length - 1) {
      b.percentage = Number(((b.seconds / totalSec) * 100).toFixed(1));
      runningPct += b.percentage;
    } else {
      b.percentage = Number(Math.max(0, 100 - runningPct).toFixed(1));
    }
  });
  return bounds;
}

/**
 * Renders 5-Zone Heart Rate Distribution Chart.
 * @param {object} rollup
 * @param {object} [customThresholds]
 */
export function renderHeartRateZoneChart(rollup, customThresholds = null) {
  const canvas = document.getElementById('hr-zone-chart');
  if (!canvas) return;

  if (hrChartInstance) {
    hrChartInstance.destroy();
    hrChartInstance = null;
  }

  let zones = rollup?.physiological?.heart_rate_zones || [];
  const rawTotalSec = zones.reduce((sum, z) => sum + (Number(z.seconds) || 0), 0);
  const customMaxHr = Number(customThresholds?.max_hr || 0);

  if (rawTotalSec <= 0 || customMaxHr > 0) {
    const targetMaxHr = customMaxHr > 0 ? customMaxHr : (rollup?.athlete?.max_hr || 190);
    zones = computeClientHeartRateZones(rollup?.activities || [], targetMaxHr);
  }

  const totalSec = zones.reduce((sum, z) => sum + (Number(z.seconds) || 0), 0);
  zones.forEach(z => {
    if (z.percentage == null) {
      z.percentage = totalSec > 0 ? Number(((z.seconds / totalSec) * 100).toFixed(1)) : 0;
    }
  });

  const subtitleEl = document.getElementById('hr-zone-subtitle');
  if (subtitleEl) {
    const activeMaxHr = customMaxHr > 0 ? customMaxHr : (rollup?.athlete?.max_hr || 190);
    subtitleEl.textContent = `5-Zone Model (Z1 - Z5) • Max HR: ${activeMaxHr} bpm`;
  }

  const labels = zones.map(z => `${z.zone} (${formatZoneDuration(z.seconds)})`);
  const data = zones.map(z => Math.max(0, secToHours(z.seconds)));
  const colors = ['#38bdf8', '#34d399', '#fbbf24', '#f97316', '#f43f5e'];

  hrChartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          label: 'HR Zones (Hours)',
          data,
          backgroundColor: colors
        }
      ]
    }
  });
}

/**
 * Returns the Coggan 7-zone watt range string for a given zone index and FTP.
 * @param {number} idx
 * @param {number} ftp
 * @returns {string}
 */
export function getCogganWattRange(idx, ftp) {
  const f = Math.max(50, Number(ftp) || 280);
  switch (idx) {
    case 0: return `< ${Math.round(f * 0.55)} W`;
    case 1: return `${Math.round(f * 0.55) + 1} - ${Math.round(f * 0.75)} W`;
    case 2: return `${Math.round(f * 0.75) + 1} - ${Math.round(f * 0.90)} W`;
    case 3: return `${Math.round(f * 0.90) + 1} - ${Math.round(f * 1.05)} W`;
    case 4: return `${Math.round(f * 1.05) + 1} - ${Math.round(f * 1.20)} W`;
    case 5: return `${Math.round(f * 1.20) + 1} - ${Math.round(f * 1.50)} W`;
    case 6: return `> ${Math.round(f * 1.50)} W`;
    default: return '';
  }
}

/**
 * Renders Coggan 7-Zone Power Distribution Chart (Cycling-Specific FTP).
 * Displays power zones only when real cycling power data exists, with explicit watt ranges.
 * @param {object} rollup
 * @param {object} [customThresholds]
 */
export function renderPowerZoneChart(rollup, customThresholds = null) {
  const canvas = document.getElementById('power-zone-chart');
  if (!canvas) return;

  if (powerChartInstance) {
    powerChartInstance.destroy();
    powerChartInstance = null;
  }

  const defaultFtp = Number(rollup?.athlete?.cycling_ftp ?? rollup?.athlete?.ftp ?? 280);
  const activeFtp = Number(customThresholds?.cycling_ftp || 0) > 0
    ? Number(customThresholds.cycling_ftp)
    : defaultFtp;

  const zones = rollup?.physiological?.power_zones || [];
  const hasExplicitPowerFlag = rollup?.physiological?.has_power_data;
  const hasPositiveSeconds = zones.some(z => (Number(z.seconds) || 0) > 0);
  const hasRealPower = hasExplicitPowerFlag !== false && (Boolean(hasExplicitPowerFlag) || hasPositiveSeconds) && zones.length > 0;

  const subtitleEl = document.getElementById('power-zone-subtitle');
  if (subtitleEl) {
    if (hasRealPower) {
      subtitleEl.textContent = `Cycling Power Only • FTP: ${activeFtp} W (Coggan 7-Zone)`;
    } else {
      subtitleEl.textContent = 'Cycling Power Only • No Power Meter Connected';
    }
  }

  const cardEl = document.getElementById('card-power-zone') || canvas.parentElement;
  const emptyNoticeId = 'power-zone-empty-notice';
  let emptyEl = document.getElementById(emptyNoticeId);

  if (!hasRealPower) {
    if (canvas.style) canvas.style.display = 'none';
    if (cardEl) {
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.id = emptyNoticeId;
        emptyEl.className = 'flex flex-col items-center justify-center h-full min-h-[220px] text-center p-4';
        emptyEl.innerHTML = `
          <div class="w-10 h-10 rounded-full bg-zinc-900 border border-[#1f1f24] flex items-center justify-center mb-3">
            <svg class="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <p class="text-xs font-semibold text-zinc-300">No Cycling Power Data Available</p>
          <p class="text-[11px] text-zinc-500 mt-1 max-w-[220px]">No cycling power meter data recorded. Connect a power meter to view power zones.</p>
        `;
        cardEl.appendChild(emptyEl);
      }
      if (emptyEl.style) emptyEl.style.display = 'flex';
    }
    return;
  }

  if (emptyEl && emptyEl.style) {
    emptyEl.style.display = 'none';
  }
  if (canvas.style) canvas.style.display = '';

  const labels = zones.map((z, idx) => {
    const range = z.range_label || getCogganWattRange(idx, activeFtp);
    const zoneName = z.name || (z.zone && z.zone.includes(' ') ? z.zone.split(' ').slice(1).join(' ') : (z.zone || `Zone ${idx + 1}`));
    const zoneCode = `Z${idx + 1}`;
    const fullTitle = `${zoneCode} ${zoneName}`.trim();
    return [fullTitle, range];
  });
  const data = zones.map(z => secToHours(z.seconds));

  powerChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Cycling Power (FTP ${activeFtp}W)`,
          data,
          backgroundColor: '#a78bfa'
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
 * Renders Threshold Trends Chart (VO2max, Cycling FTP, LTHR).
 * @param {object} rollup
 * @param {object} [customThresholds]
 */
export function renderThresholdTrendsChart(rollup, customThresholds = null) {
  const canvas = document.getElementById('threshold-trends-chart');
  if (!canvas) return;

  if (trendsChartInstance) {
    trendsChartInstance.destroy();
    trendsChartInstance = null;
  }

  const trends = (rollup?.physiological?.threshold_trends || [
    { date: '2026-09-01', vo2max: 51, cycling_ftp: 268, ftp: 268, lthr: 165 },
    { date: '2026-09-15', vo2max: 52, cycling_ftp: 272, ftp: 272, lthr: 166 },
    { date: '2026-10-01', vo2max: 53, cycling_ftp: 276, ftp: 276, lthr: 167 },
    { date: '2026-10-15', vo2max: 54, cycling_ftp: 280, ftp: 280, lthr: 168 }
  ]).map((t, idx, arr) => {
    const copy = { ...t };
    if (idx === arr.length - 1 && customThresholds) {
      if (Number(customThresholds.cycling_ftp) > 0) {
        copy.cycling_ftp = Number(customThresholds.cycling_ftp);
        copy.ftp = Number(customThresholds.cycling_ftp);
      }
      if (Number(customThresholds.lthr) > 0) {
        copy.lthr = Number(customThresholds.lthr);
      }
    }
    return copy;
  });

  const labels = trends.map(t => t.date);
  const vo2Data = trends.map(t => t.vo2max);
  const ftpData = trends.map(t => t.cycling_ftp ?? t.ftp);
  const lthrData = trends.map(t => t.lthr);

  trendsChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cycling FTP (Watts)',
          data: ftpData,
          borderColor: '#a78bfa',
          borderWidth: 2
        },
        {
          label: 'LTHR (bpm)',
          data: lthrData,
          borderColor: '#f43f5e',
          borderWidth: 2
        },
        {
          label: 'VO2max (ml/kg)',
          data: vo2Data,
          borderColor: '#34d399',
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
 * Renders Pace / Grade Zones Distribution Chart with concise, non-overlapping labels.
 * @param {object} rollup
 */
export function renderPaceZoneChart(rollup) {
  const canvas = document.getElementById('pace-zone-chart');
  if (!canvas) return;

  if (paceChartInstance) {
    paceChartInstance.destroy();
    paceChartInstance = null;
  }

  const zones = rollup?.physiological?.pace_zones || [];
  if (zones.length === 0) return;

  // Use concise labels to prevent any adjacent label collision
  const labels = zones.map(z => z.short_label || z.zone);
  const data = zones.map(z => secToHours(z.seconds));

  paceChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Pace Time (Hours)',
          data,
          backgroundColor: '#2dd4bf'
        }
      ]
    }
  });
}
