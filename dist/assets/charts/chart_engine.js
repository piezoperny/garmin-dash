/**
 * frontend/src/charts/chart_engine.js
 * 
 * Standalone, Zero-Dependency HTML5 Canvas Chart Engine.
 * Provides Chart.js v4.x compatible API for offline, high-performance dark-mode rendering.
 */

export class Chart {
  static defaults = {
    color: '#94a3b8',
    borderColor: '#334155',
    font: {
      family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      size: 11
    },
    plugins: {
      legend: {
        display: true
      },
      tooltip: {
        enabled: true,
        backgroundColor: '#0f172a',
        borderColor: '#475569',
        borderWidth: 1,
        titleColor: '#f8fafc',
        bodyColor: '#cbd5e1'
      }
    }
  };

  constructor(target, config) {
    this.canvas = typeof target === 'string' ? document.getElementById(target) : target;
    if (!this.canvas) {
      throw new Error(`Canvas element not found: ${target}`);
    }
    this.ctx = this.canvas.getContext('2d');
    this.config = config || {};
    this.type = this.config.type || 'bar';
    this.data = this.config.data || { labels: [], datasets: [] };
    this.options = this.config.options || {};
    this.activeTooltip = null;

    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseLeave = this._handleMouseLeave.bind(this);
    this._onResize = this._handleResize.bind(this);

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mouseleave', this._onMouseLeave);
    window.addEventListener('resize', this._onResize);

    this.render();
  }

  destroy() {
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseleave', this._onMouseLeave);
    window.removeEventListener('resize', this._onResize);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  update() {
    this.render();
  }

  _handleResize() {
    this.render();
  }

  _setupCanvasDPI() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width > 0 ? rect.width : (this.canvas.width || 600);
    const height = rect.height > 0 ? rect.height : (this.canvas.height || 300);

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);
    this.displayWidth = width;
    this.displayHeight = height;
  }

  render() {
    if (!this.canvas) return;
    this._setupCanvasDPI();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.displayWidth, this.displayHeight);

    if (this.type === 'doughnut' || this.type === 'pie') {
      this._renderDoughnut();
    } else if (this.type === 'line') {
      this._renderCartesian(true);
    } else {
      this._renderCartesian(false);
    }

    if (this.activeTooltip) {
      this._drawTooltip();
    }
  }

  _renderCartesian(isLine) {
    const ctx = this.ctx;
    const padding = { top: 35, right: 25, bottom: 40, left: 55 };
    const chartW = this.displayWidth - padding.left - padding.right;
    const chartH = this.displayHeight - padding.top - padding.bottom;

    if (chartW <= 0 || chartH <= 0) return;

    const datasets = this.data.datasets || [];
    const labels = this.data.labels || [];
    const isStacked = Boolean(this.options.scales?.x?.stacked || this.options.scales?.y?.stacked);

    // Calculate Y range
    let minY = 0;
    let maxY = 0;

    if (isStacked && !isLine) {
      for (let i = 0; i < labels.length; i++) {
        let posSum = 0;
        let negSum = 0;
        for (const ds of datasets) {
          const val = Number(ds.data?.[i]) || 0;
          if (val >= 0) posSum += val;
          else negSum += val;
        }
        if (posSum > maxY) maxY = posSum;
        if (negSum < minY) minY = negSum;
      }
    } else {
      for (const ds of datasets) {
        for (const val of ds.data || []) {
          const v = Number(val) || 0;
          if (v > maxY) maxY = v;
          if (v < minY) minY = v;
        }
      }
    }

    if (maxY === minY) {
      maxY += 10;
      minY = Math.min(0, minY);
    }
    // Add margin
    const range = maxY - minY;
    maxY = maxY + range * 0.1;
    if (minY < 0) minY = minY - range * 0.05;

    // Y Gridlines and Ticks
    const steps = 4;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let s = 0; s <= steps; s++) {
      const norm = s / steps;
      const yVal = minY + (maxY - minY) * (1 - norm);
      const y = padding.top + norm * chartH;

      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      const labelText = Math.abs(yVal) >= 100 ? Math.round(yVal) : yVal.toFixed(1);
      ctx.fillText(labelText, padding.left - 10, y);
    }

    // Zero-line if minY < 0
    if (minY < 0 && maxY > 0) {
      const zeroNorm = (maxY - 0) / (maxY - minY);
      const zeroY = padding.top + zeroNorm * chartH;
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, zeroY);
      ctx.lineTo(padding.left + chartW, zeroY);
      ctx.stroke();
    }

    // X Axis Ticks and Labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = chartW / Math.max(1, labels.length);

    this.dataPoints = []; // for hover hit testing

    labels.forEach((lbl, idx) => {
      const xCenter = padding.left + (idx + 0.5) * xStep;
      ctx.fillStyle = '#94a3b8';
      // Abbreviate if label is long
      const displayLbl = String(lbl).length > 8 ? String(lbl).slice(-5) : String(lbl);
      ctx.fillText(displayLbl, xCenter, padding.top + chartH + 8);
    });

    // Render Data
    if (isLine) {
      // Line Datasets
      for (const ds of datasets) {
        const color = ds.borderColor || ds.backgroundColor || '#38bdf8';
        const pts = [];

        for (let i = 0; i < labels.length; i++) {
          const val = Number(ds.data?.[i]) ?? 0;
          const x = padding.left + (i + 0.5) * xStep;
          const normY = (maxY - val) / (maxY - minY);
          const y = padding.top + normY * chartH;
          pts.push({ x, y, val, label: labels[i], datasetName: ds.label, color });
        }

        // Draw fill if requested
        if (ds.fill && pts.length > 0) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, padding.top + chartH);
          pts.forEach(p => ctx.lineTo(p.x, p.y));
          ctx.lineTo(pts[pts.length - 1].x, padding.top + chartH);
          ctx.closePath();
          ctx.fillStyle = ds.backgroundColor || 'rgba(56, 189, 248, 0.15)';
          ctx.fill();
        }

        // Draw line
        ctx.beginPath();
        pts.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = ds.borderWidth || 2;
        ctx.stroke();

        // Draw point dots
        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          this.dataPoints.push({ ...p, radius: 8 });
        });
      }
    } else {
      // Bar Datasets
      if (isStacked) {
        const stackAccum = new Array(labels.length).fill(0);
        for (const ds of datasets) {
          const color = ds.backgroundColor || '#10b981';
          const barWidth = Math.min(32, xStep * 0.65);

          for (let i = 0; i < labels.length; i++) {
            const val = Number(ds.data?.[i]) || 0;
            if (val <= 0) continue;

            const bottomVal = stackAccum[i];
            const topVal = bottomVal + val;
            stackAccum[i] = topVal;

            const x = padding.left + (i + 0.5) * xStep - barWidth / 2;
            const normTop = (maxY - topVal) / (maxY - minY);
            const normBottom = (maxY - bottomVal) / (maxY - minY);
            const yTop = padding.top + normTop * chartH;
            const yBottom = padding.top + normBottom * chartH;
            const h = yBottom - yTop;

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(x, yTop, barWidth, h, 2) : ctx.rect(x, yTop, barWidth, h);
            ctx.fill();

            this.dataPoints.push({
              x: x + barWidth / 2,
              y: yTop + h / 2,
              w: barWidth,
              h,
              val,
              label: labels[i],
              datasetName: ds.label,
              color
            });
          }
        }
      } else {
        // Grouped bars
        const groupCount = datasets.length;
        const totalBarGroupWidth = Math.min(48, xStep * 0.75);
        const singleBarWidth = totalBarGroupWidth / Math.max(1, groupCount);

        datasets.forEach((ds, dsIdx) => {
          const color = ds.backgroundColor || '#06b6d4';
          for (let i = 0; i < labels.length; i++) {
            const val = Number(ds.data?.[i]) || 0;
            const groupStartX = padding.left + (i + 0.5) * xStep - totalBarGroupWidth / 2;
            const x = groupStartX + dsIdx * singleBarWidth;
            const normVal = (maxY - val) / (maxY - minY);
            const y = padding.top + normVal * chartH;
            const zeroNorm = (maxY - 0) / (maxY - minY);
            const zeroY = padding.top + zeroNorm * chartH;
            const h = zeroY - y;

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.rect(x, y, singleBarWidth - 1, h);
            ctx.fill();

            this.dataPoints.push({
              x: x + singleBarWidth / 2,
              y: y + h / 2,
              val,
              label: labels[i],
              datasetName: ds.label,
              color
            });
          }
        });
      }
    }

    // Legend
    this._renderLegend(datasets);
  }

  _renderDoughnut() {
    const ctx = this.ctx;
    const centerX = this.displayWidth / 2;
    const centerY = this.displayHeight / 2 + 10;
    const outerRadius = Math.min(this.displayWidth, this.displayHeight) * 0.38;
    const innerRadius = outerRadius * 0.62;

    const ds = this.data.datasets?.[0];
    if (!ds) return;

    const values = (ds.data || []).map(v => Number(v) || 0);
    const labels = this.data.labels || [];
    const colors = Array.isArray(ds.backgroundColor)
      ? ds.backgroundColor
      : ['#38bdf8', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6'];

    const total = values.reduce((sum, v) => sum + v, 0);
    if (total === 0) return;

    let startAngle = -Math.PI / 2;
    this.doughnutSlices = [];

    values.forEach((val, i) => {
      const sliceAngle = (val / total) * (Math.PI * 2);
      const endAngle = startAngle + sliceAngle;
      const color = colors[i % colors.length];

      ctx.beginPath();
      ctx.arc(centerX, centerY, outerRadius, startAngle, endAngle);
      ctx.arc(centerX, centerY, innerRadius, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Border between slices
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.stroke();

      this.doughnutSlices.push({
        label: labels[i] || `Item ${i + 1}`,
        val,
        pct: ((val / total) * 100).toFixed(1),
        color
      });

      startAngle = endAngle;
    });

    // Center Text
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(values.length) + ' Zones', centerX, centerY - 8);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.fillText('Distribution', centerX, centerY + 12);

    // Legend
    this._renderDoughnutLegend(this.doughnutSlices);
  }

  _renderLegend(datasets) {
    if (!datasets || datasets.length <= 1) return;
    const ctx = this.ctx;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';

    let totalW = 0;
    const items = datasets.map(ds => {
      const name = ds.label || 'Series';
      const w = ctx.measureText(name).width + 24;
      totalW += w;
      return { name, w, color: ds.borderColor || ds.backgroundColor || '#38bdf8' };
    });

    let startX = Math.max(10, (this.displayWidth - totalW) / 2);
    const y = 14;

    items.forEach(item => {
      ctx.fillStyle = item.color;
      ctx.fillRect(startX, y - 4, 10, 10);
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'left';
      ctx.fillText(item.name, startX + 14, y + 1);
      startX += item.w;
    });
  }

  _renderDoughnutLegend(slices) {
    if (!slices || slices.length === 0) return;
    const ctx = this.ctx;
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';

    const items = slices.slice(0, 6);
    let totalW = 0;
    items.forEach(s => {
      totalW += ctx.measureText(`${s.label}: ${s.pct}%`).width + 20;
    });

    let startX = Math.max(10, (this.displayWidth - totalW) / 2);
    const y = 12;

    items.forEach(s => {
      ctx.fillStyle = s.color;
      ctx.fillRect(startX, y - 4, 8, 8);
      ctx.fillStyle = '#cbd5e1';
      ctx.textAlign = 'left';
      const text = `${s.label}: ${s.pct}%`;
      ctx.fillText(text, startX + 12, y);
      startX += ctx.measureText(text).width + 20;
    });
  }

  _handleMouseMove(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;

    if (!this.dataPoints || this.dataPoints.length === 0) return;

    // Find nearest point within distance
    let nearest = null;
    let minDist = 30;

    for (const pt of this.dataPoints) {
      const dx = pt.x - x;
      const dy = pt.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        nearest = pt;
      }
    }

    if (nearest !== this.activeTooltip) {
      this.activeTooltip = nearest;
      this.render();
    }
  }

  _handleMouseLeave() {
    if (this.activeTooltip) {
      this.activeTooltip = null;
      this.render();
    }
  }

  _drawTooltip() {
    const pt = this.activeTooltip;
    if (!pt) return;

    const ctx = this.ctx;
    const title = `${pt.label} - ${pt.datasetName || ''}`;
    const valText = `Value: ${pt.val}`;

    ctx.font = 'bold 11px sans-serif';
    const titleW = ctx.measureText(title).width;
    ctx.font = '11px sans-serif';
    const valW = ctx.measureText(valText).width;
    const boxW = Math.max(titleW, valW) + 24;
    const boxH = 46;

    let bx = pt.x - boxW / 2;
    let by = pt.y - boxH - 12;
    if (bx < 8) bx = 8;
    if (bx + boxW > this.displayWidth - 8) bx = this.displayWidth - boxW - 8;
    if (by < 8) by = pt.y + 12;

    // Background Card
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, boxW, boxH, 6) : ctx.rect(bx, by, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    // Swatch dot
    ctx.fillStyle = pt.color || '#38bdf8';
    ctx.beginPath();
    ctx.arc(bx + 12, by + 16, 4, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, bx + 22, by + 16);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px sans-serif';
    ctx.fillText(valText, bx + 22, by + 32);
  }
}

export default Chart;
