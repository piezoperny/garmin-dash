/**
 * frontend/src/charts/endurance.js
 * 
 * Section 1: Endurance & Training Load Visualizations
 * - KPI Summary Cards (#kpi-total-distance, #kpi-total-time, #kpi-weekly-load, #kpi-status)
 * - Stacked Weekly & Monthly Volume Chart (#weekly-volume-chart)
 * - Continuous Training Load Curves ATL, CTL, TSB (#training-load-chart)
 * - Sport Filter and Distance Unit (km/mi) reactivity
 */

import { Chart } from './chart_engine.js';

let volumeChartInstance = null;
let loadChartInstance = null;

/**
 * Formats seconds into "Xh Ym" string.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}

/**
 * Updates KPI Summary Cards from rollup data.
 * @param {object} rollup
 * @param {string} unit - 'km' or 'mi'
 */
export function renderKPICards(rollup, unit = 'km') {
  const kmMultiplier = unit === 'mi' ? 0.621371 : 1.0;
  const unitLabel = unit === 'mi' ? 'mi' : 'km';

  let totalDistKm = rollup?.summary?.total_distance_km;
  if (totalDistKm === undefined && rollup?.summary?.total_distance_meters) {
    totalDistKm = rollup.summary.total_distance_meters / 1000.0;
  }
  if (totalDistKm === undefined && rollup?.activities) {
    const meters = rollup.activities.reduce((acc, a) => acc + (a.distance_meters || 0), 0);
    totalDistKm = meters / 1000.0;
  }
  totalDistKm = totalDistKm || 0;

  const displayDistance = (totalDistKm * kmMultiplier).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });

  const distEl = document.getElementById('kpi-total-distance');
  if (distEl) {
    distEl.textContent = `${displayDistance} ${unitLabel}`;
  }

  let totalSeconds = 0;
  if (rollup?.summary?.total_moving_hours) {
    totalSeconds = rollup.summary.total_moving_hours * 3600;
  } else if (rollup?.summary?.total_moving_time_seconds) {
    totalSeconds = rollup.summary.total_moving_time_seconds;
  } else if (rollup?.activities) {
    totalSeconds = rollup.activities.reduce((acc, a) => acc + (a.moving_time_seconds || a.duration_seconds || 0), 0);
  }

  const timeEl = document.getElementById('kpi-total-time');
  if (timeEl) {
    timeEl.textContent = formatDuration(totalSeconds);
  }

  // Training status & ACWR
  const weekly = rollup?.training_load?.weekly || [];
  let latestATL = 60;
  let latestCTL = 55;
  let latestLoad = 0;

  if (weekly.length > 0) {
    const latest = weekly[weekly.length - 1];
    latestATL = latest.atl || 60;
    latestCTL = latest.ctl || 55;
    latestLoad = latest.load || 400;
  }

  const loadEl = document.getElementById('kpi-weekly-load');
  if (loadEl) {
    loadEl.textContent = `${Math.round(latestLoad)} TSS/wk`;
  }

  const statusEl = document.getElementById('kpi-status');
  if (statusEl) {
    const acwr = latestCTL > 0 ? (latestATL / latestCTL) : 1.0;
    let statusText = 'Optimal';
    let statusClass = 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';

    if (acwr > 1.35) {
      statusText = 'Overreaching';
      statusClass = 'text-rose-400 border-rose-500/30 bg-rose-500/10';
    } else if (acwr >= 1.05) {
      statusText = 'Productive';
      statusClass = 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10';
    } else if (acwr >= 0.85) {
      statusText = 'Optimal';
      statusClass = 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
    } else {
      statusText = 'Recovery';
      statusClass = 'text-amber-400 border-amber-500/30 bg-amber-500/10';
    }

    statusEl.textContent = statusText;
    statusEl.className = `px-3 py-1 rounded-full text-xs font-semibold border ${statusClass}`;
  }
}

/**
 * Renders the stacked weekly volume bar chart.
 * @param {object} rollup
 * @param {string} unit - 'km' or 'mi'
 * @param {string} sportFilter - 'all' | 'running' | 'cycling' | 'strength'
 */
export function renderWeeklyVolumeChart(rollup, unit = 'km', sportFilter = 'all') {
  const canvas = document.getElementById('weekly-volume-chart');
  if (!canvas) return;

  if (volumeChartInstance) {
    volumeChartInstance.destroy();
    volumeChartInstance = null;
  }

  const weeklyData = rollup?.training_load?.weekly || [];
  const kmMultiplier = unit === 'mi' ? 0.621371 : 1.0;
  const unitLabel = unit === 'mi' ? 'mi' : 'km';

  const labels = weeklyData.map(w => w.week || 'Week');
  const runData = weeklyData.map(w => Number(((w.run_km || 0) * kmMultiplier).toFixed(1)));
  const cycleData = weeklyData.map(w => Number(((w.cycle_km || 0) * kmMultiplier).toFixed(1)));
  const strengthData = weeklyData.map(w => Number((w.strength_hours || 0).toFixed(1)));

  const datasets = [];

  if (sportFilter === 'all' || sportFilter === 'running') {
    datasets.push({
      label: `Running (${unitLabel})`,
      data: runData,
      backgroundColor: '#10b981'
    });
  }
  if (sportFilter === 'all' || sportFilter === 'cycling') {
    datasets.push({
      label: `Cycling (${unitLabel})`,
      data: cycleData,
      backgroundColor: '#06b6d4'
    });
  }
  if (sportFilter === 'all' || sportFilter === 'strength') {
    datasets.push({
      label: 'Strength (hrs)',
      data: strengthData,
      backgroundColor: '#f59e0b'
    });
  }

  volumeChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets
    },
    options: {
      scales: {
        x: { stacked: true },
        y: { stacked: true }
      }
    }
  });
}

/**
 * Renders the continuous training load curves (ATL, CTL, TSB).
 * @param {object} rollup
 */
export function renderTrainingLoadChart(rollup) {
  const canvas = document.getElementById('training-load-chart');
  if (!canvas) return;

  if (loadChartInstance) {
    loadChartInstance.destroy();
    loadChartInstance = null;
  }

  const weeklyData = rollup?.training_load?.weekly || [];
  const labels = weeklyData.map(w => w.week || 'Week');
  const atlData = weeklyData.map(w => w.atl || 0);
  const ctlData = weeklyData.map(w => w.ctl || 0);
  const tsbData = weeklyData.map(w => w.tsb || 0);

  loadChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'CTL (Fitness)',
          data: ctlData,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.1)',
          fill: true,
          borderWidth: 2
        },
        {
          label: 'ATL (Fatigue)',
          data: atlData,
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.1)',
          fill: true,
          borderWidth: 2
        },
        {
          label: 'TSB (Form)',
          data: tsbData,
          borderColor: '#eab308',
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
