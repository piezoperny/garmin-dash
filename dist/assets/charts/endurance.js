/**
 * frontend/src/charts/endurance.js
 * 
 * Endurance & Training Load Visualizations
 * - KPI Summary Cards (#kpi-total-distance, #kpi-total-time, #kpi-weekly-load, #kpi-status)
 *   with dynamic sport filtering (All · Cycling · Hiking · Weights)
 * - Stacked Weekly Duration Chart (#weekly-volume-chart) plotting Weekly Duration (Hours)
 * - Continuous Training Load Curves ATL, CTL, TSB (#training-load-chart)
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
  const sec = Number(totalSeconds) || 0;
  if (sec <= 0) return '0m';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}

function filterActivitiesBySport(activities, filter) {
  if (!filter || filter === 'all') return activities || [];
  const target = filter.toLowerCase();
  return (activities || []).filter(a => {
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

/**
 * Updates KPI Summary Cards from rollup data with optional sport filter.
 * @param {object} rollup
 * @param {string} unit - 'km' or 'mi'
 * @param {string} sportFilter - 'all' | 'cycling' | 'hiking' | 'strength' | 'weights'
 */
export function renderKPICards(rollup, unit = 'km', sportFilter = 'all') {
  const kmMultiplier = unit === 'mi' ? 0.621371 : 1.0;
  const unitLabel = unit === 'mi' ? 'mi' : 'km';
  const allActivities = rollup?.activities || [];
  const filtered = filterActivitiesBySport(allActivities, sportFilter);
  const weekly = rollup?.training_load?.weekly || [];

  const isWeightsFilter = sportFilter === 'strength' || sportFilter === 'weights';

  // 1. Distance KPI
  const distEl = document.getElementById('kpi-total-distance');
  if (distEl) {
    if (isWeightsFilter) {
      // Weights workouts track duration and HR only; no distance
      distEl.textContent = '—';
    } else {
      let totalMeters = 0;
      if (sportFilter === 'all' && rollup?.summary?.total_distance_km) {
        totalMeters = rollup.summary.total_distance_km * 1000.0;
      } else {
        totalMeters = filtered.reduce((acc, a) => acc + (a.distance_meters || 0), 0);
      }
      const totalDistKm = totalMeters / 1000.0;
      const formattedDist = (totalDistKm * kmMultiplier).toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      });
      distEl.textContent = `${formattedDist} ${unitLabel}`;
    }
  }

  // 2. Moving Time KPI
  const timeEl = document.getElementById('kpi-total-time');
  if (timeEl) {
    let totalSeconds = 0;
    if (sportFilter === 'all' && rollup?.summary?.total_moving_hours) {
      totalSeconds = rollup.summary.total_moving_hours * 3600;
    } else {
      totalSeconds = filtered.reduce((acc, a) => acc + (a.moving_time_seconds || a.duration_seconds || 0), 0);
    }
    timeEl.textContent = formatDuration(totalSeconds);
  }

  // 3. Weekly Load KPI (TSS)
  const loadEl = document.getElementById('kpi-weekly-load');
  if (loadEl) {
    let weeklyLoad = 0;
    if (sportFilter === 'all' && weekly.length > 0) {
      const latest = weekly[weekly.length - 1];
      weeklyLoad = latest.load || 0;
    } else if (weekly.length > 0) {
      const latest = weekly[weekly.length - 1];
      const normFilter = (sportFilter || '').toLowerCase();
      if (latest.sport_loads && (latest.sport_loads[sportFilter] !== undefined || latest.sport_loads[normFilter] !== undefined)) {
        weeklyLoad = latest.sport_loads[sportFilter] ?? latest.sport_loads[normFilter] ?? 0;
      } else {
        const latestWeekStart = latest.week_start ? new Date(latest.week_start).getTime() : null;
        if (latestWeekStart) {
          const latestWeekEnd = latestWeekStart + 7 * 24 * 60 * 60 * 1000;
          const recentActs = filtered.filter(a => {
            const actTime = new Date(a.date || a.start_time || 0).getTime();
            return actTime >= latestWeekStart && actTime < latestWeekEnd;
          });
          weeklyLoad = recentActs.reduce((acc, a) => acc + (a.tss || a.training_stress_score || 0), 0);
        } else {
          const latestActTime = allActivities.reduce((max, a) => Math.max(max, new Date(a.date || a.start_time || 0).getTime()), 0);
          const cutoff = latestActTime - 7 * 24 * 60 * 60 * 1000;
          const recentActs = filtered.filter(a => new Date(a.date || a.start_time || 0).getTime() >= cutoff);
          weeklyLoad = recentActs.reduce((acc, a) => acc + (a.tss || a.training_stress_score || 0), 0);
        }
      }
    } else {
      weeklyLoad = 0;
    }
    loadEl.textContent = `${Math.round(weeklyLoad)} TSS/wk`;
  }

  // 4. Training Status KPI
  const statusEl = document.getElementById('kpi-status');
  if (statusEl) {
    let latestATL = 50;
    let latestCTL = 50;
    if (weekly.length > 0) {
      const latest = weekly[weekly.length - 1];
      latestATL = latest.atl || 50;
      latestCTL = latest.ctl || 50;
    }

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
    statusEl.className = `px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusClass}`;
  }
}

/**
 * Renders the stacked weekly duration (hours) bar chart.
 * Plots Weekly Duration (Hours) so Weights, Cycling, and Hiking all display meaningful bars.
 * @param {object} rollup
 * @param {string} unit - 'km' or 'mi'
 * @param {string} sportFilter - 'all' | 'cycling' | 'hiking' | 'running' | 'strength' | 'weights'
 */
export function renderWeeklyVolumeChart(rollup, unit = 'km', sportFilter = 'all') {
  const canvas = document.getElementById('weekly-volume-chart');
  if (!canvas) return;

  if (volumeChartInstance) {
    volumeChartInstance.destroy();
    volumeChartInstance = null;
  }

  const weeklyData = rollup?.training_load?.weekly || [];
  const labels = weeklyData.map(w => w.week || 'Week');

  // Compute weekly duration in hours for all distinct sports
  const runningHours = weeklyData.map(w => {
    if (w.running_hours !== undefined) return Number(w.running_hours.toFixed(1));
    return Number(((w.run_km || 0) / 10.0).toFixed(1));
  });

  const walkingHours = weeklyData.map(w => {
    if (w.walking_hours !== undefined) return Number(w.walking_hours.toFixed(1));
    return Number(((w.walk_km || 0) / 4.8).toFixed(1));
  });

  const hikingHours = weeklyData.map(w => {
    if (w.hiking_hours !== undefined) return Number(w.hiking_hours.toFixed(1));
    return Number(((w.hiking_km || 0) / 4.2).toFixed(1));
  });

  const cyclingHours = weeklyData.map(w => {
    if (w.cycling_hours !== undefined) return Number(w.cycling_hours.toFixed(1));
    return Number(((w.cycle_km || 0) / 28.0).toFixed(1));
  });

  const strengthHours = weeklyData.map(w => Number((w.strength_hours || 0).toFixed(1)));

  const datasets = [];
  const normalizedFilter = (sportFilter || 'all').toLowerCase();
  const isAll = normalizedFilter === 'all';

  if (isAll || normalizedFilter === 'running' || normalizedFilter === 'run') {
    datasets.push({
      label: 'Running (hrs)',
      data: runningHours,
      backgroundColor: '#f97316'
    });
  }

  if (isAll || normalizedFilter === 'walking' || normalizedFilter === 'walk') {
    datasets.push({
      label: 'Walking (hrs)',
      data: walkingHours,
      backgroundColor: '#10b981'
    });
  }

  if (isAll || normalizedFilter === 'hiking' || normalizedFilter === 'hike') {
    datasets.push({
      label: 'Hiking (hrs)',
      data: hikingHours,
      backgroundColor: '#06b6d4'
    });
  }

  if (isAll || normalizedFilter === 'cycling' || normalizedFilter === 'cycle') {
    datasets.push({
      label: 'Cycling (hrs)',
      data: cyclingHours,
      backgroundColor: '#38bdf8'
    });
  }

  if (isAll || normalizedFilter === 'strength' || normalizedFilter === 'weights') {
    datasets.push({
      label: 'Weights (hrs)',
      data: strengthHours,
      backgroundColor: '#fbbf24'
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
  let atlData = weeklyData.map(w => Number(w.atl ?? 0));
  let ctlData = weeklyData.map(w => Number(w.ctl ?? 0));
  let tsbData = weeklyData.map(w => Number(w.tsb ?? 0));

  // Client-side Banister EWMA fallback if rollup has flat legacy 50/50/0 placeholders
  const isFlatPlaceholder =
    weeklyData.length > 0 &&
    ctlData.every(v => v === 50 || v === 0) &&
    atlData.every(v => v === 50 || v === 0);

  if (isFlatPlaceholder) {
    let ctl = 25.0;
    let atl = 25.0;
    ctlData = [];
    atlData = [];
    tsbData = [];
    for (const w of weeklyData) {
      const dailyAvgLoad = Number(w.load || 0) / 7.0;
      for (let d = 0; d < 7; d++) {
        const dayLoad = d === 5 || d === 6 ? dailyAvgLoad * 1.35 : dailyAvgLoad * 0.86;
        ctl = ctl + (dayLoad - ctl) / 42.0;
        atl = atl + (dayLoad - atl) / 7.0;
      }
      const cRound = Number(ctl.toFixed(1));
      const aRound = Number(atl.toFixed(1));
      ctlData.push(cRound);
      atlData.push(aRound);
      tsbData.push(Number((cRound - aRound).toFixed(1)));
    }
  }

  loadChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'CTL (Fitness)',
          data: ctlData,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.12)',
          fill: true,
          borderWidth: 2
        },
        {
          label: 'ATL (Fatigue)',
          data: atlData,
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.12)',
          fill: true,
          borderWidth: 2
        },
        {
          label: 'TSB (Form)',
          data: tsbData,
          borderColor: '#fbbf24',
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
