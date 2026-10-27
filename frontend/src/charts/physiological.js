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
  return Number(((sec || 0) / 3600).toFixed(1));
}

/**
 * Renders 5-Zone Heart Rate Distribution Chart.
 * @param {object} rollup
 */
export function renderHeartRateZoneChart(rollup) {
  const canvas = document.getElementById('hr-zone-chart');
  if (!canvas) return;

  if (hrChartInstance) {
    hrChartInstance.destroy();
    hrChartInstance = null;
  }

  const zones = rollup?.physiological?.heart_rate_zones || [
    { zone: 'Z1', seconds: 36000 },
    { zone: 'Z2', seconds: 108000 },
    { zone: 'Z3', seconds: 60000 },
    { zone: 'Z4', seconds: 28000 },
    { zone: 'Z5', seconds: 7200 }
  ];

  const labels = zones.map(z => `${z.zone} (${secToHours(z.seconds)}h)`);
  const data = zones.map(z => secToHours(z.seconds));
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
 * Renders Coggan 7-Zone Power Distribution Chart.
 * @param {object} rollup
 */
export function renderPowerZoneChart(rollup) {
  const canvas = document.getElementById('power-zone-chart');
  if (!canvas) return;

  if (powerChartInstance) {
    powerChartInstance.destroy();
    powerChartInstance = null;
  }

  const zones = rollup?.physiological?.power_zones || [
    { zone: 'Z1 Active Recovery', seconds: 15000 },
    { zone: 'Z2 Endurance', seconds: 60000 },
    { zone: 'Z3 Tempo', seconds: 28000 },
    { zone: 'Z4 Threshold', seconds: 15000 },
    { zone: 'Z5 VO2Max', seconds: 5000 },
    { zone: 'Z6 Anaerobic', seconds: 1800 },
    { zone: 'Z7 Neuromuscular', seconds: 600 }
  ];

  const labels = zones.map(z => z.zone.split(' ')[0]);
  const data = zones.map(z => secToHours(z.seconds));

  powerChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Power Time (Hours)',
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
 * Renders Threshold Trends Chart (VO2max, FTP, LTHR).
 * @param {object} rollup
 */
export function renderThresholdTrendsChart(rollup) {
  const canvas = document.getElementById('threshold-trends-chart');
  if (!canvas) return;

  if (trendsChartInstance) {
    trendsChartInstance.destroy();
    trendsChartInstance = null;
  }

  const trends = rollup?.physiological?.threshold_trends || [
    { date: '2026-09-01', vo2max: 51, ftp: 268, lthr: 165 },
    { date: '2026-09-15', vo2max: 52, ftp: 272, lthr: 166 },
    { date: '2026-10-01', vo2max: 53, ftp: 276, lthr: 167 },
    { date: '2026-10-15', vo2max: 54, ftp: 280, lthr: 168 }
  ];

  const labels = trends.map(t => t.date);
  const vo2Data = trends.map(t => t.vo2max);
  const ftpData = trends.map(t => t.ftp);
  const lthrData = trends.map(t => t.lthr);

  trendsChartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'FTP (Watts)',
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
