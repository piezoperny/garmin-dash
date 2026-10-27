/**
 * frontend/src/charts/chart_engine.js
 * 
 * Standalone, Zero-Dependency HTML5 Canvas Chart Engine.
 * Ultra-minimalist dark aesthetic (obsidian/zinc surfaces, hairline gridlines,
 * crisp High-DPI scaling, smooth cubic bezier curves, non-clipping wrapped legends,
 * and non-colliding concise axis labels).
 */

function colorWithAlpha(color, alpha) {
  if (!color) return `rgba(56, 189, 248, ${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (color.startsWith('rgba')) {
    return color.replace(/[\d\.]+\)$/, `${alpha})`);
  }
  if (color.startsWith('rgb')) {
    return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
  }
  return `rgba(56, 189, 248, ${alpha})`;
}

export class Chart {
  static defaults = {
    color: '#a1a1aa',
    borderColor: '#1f1f24',
    font: {
      family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      size: 10
    },
    plugins: {
      legend: {
        display: true
      },
      tooltip: {
        enabled: true,
        backgroundColor: '#111114',
        borderColor: '#1f1f24',
        borderWidth: 1,
        titleColor: '#f4f4f5',
        bodyColor: '#d4d4d8'
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
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._onResize);
    }

    this.render();
  }

  destroy() {
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseleave', this._onMouseLeave);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
    }
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
    const width = rect.width > 0 ? rect.width : (this._lastDisplayWidth || this.canvas._cssWidth || (this.canvas.width ? (this._scaled ? this.canvas.width / dpr : this.canvas.width) : 600));
    const height = rect.height > 0 ? rect.height : (this._lastDisplayHeight || this.canvas._cssHeight || (this.canvas.height ? (this._scaled ? this.canvas.height / dpr : this.canvas.height) : 300));
    this._lastDisplayWidth = width;
    this._lastDisplayHeight = height;
    this._scaled = true;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    if (typeof this.ctx.resetTransform === 'function') {
      this.ctx.resetTransform();
    } else if (typeof this.ctx.setTransform === 'function') {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.ctx.scale(dpr, dpr);
    this.displayWidth = width;
    this.displayHeight = height;
  }

  render() {
    if (!this.canvas) return;
    this._setupCanvasDPI();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.displayWidth, this.displayHeight);
    this.dataPoints = [];

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

  _computeWrappedLegendRows(items, maxWidth) {
    const rows = [];
    let currentRow = [];
    let currentWidth = 0;

    for (const item of items) {
      const itemWidth = item.w;
      if (currentRow.length > 0 && currentWidth + itemWidth > maxWidth) {
        rows.push(currentRow);
        currentRow = [item];
        currentWidth = itemWidth;
      } else {
        currentRow.push(item);
        currentWidth += itemWidth;
      }
    }
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }
    return rows;
  }

  _renderCartesian(isLine) {
    const ctx = this.ctx;
    const datasets = this.data.datasets || [];
    const labels = this.data.labels || [];
    const isStacked = Boolean(this.options.scales?.x?.stacked || this.options.scales?.y?.stacked);

    // Prepare legend rows to dynamically reserve top padding
    let legendRows = [];
    let legendHeight = 0;
    if (datasets.length > 1) {
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const items = datasets.map(ds => {
        const name = ds.label || 'Series';
        const textWidth = ctx.measureText(name).width;
        const w = textWidth + 24;
        return { name, w, color: ds.borderColor || ds.backgroundColor || '#38bdf8' };
      });
      const maxLegendW = Math.max(100, this.displayWidth - 30);
      legendRows = this._computeWrappedLegendRows(items, maxLegendW);
      legendHeight = legendRows.length * 18 + 6;
    }

    const padding = {
      top: Math.max(28, legendHeight + 12),
      right: 20,
      bottom: 38,
      left: 48
    };

    const chartW = this.displayWidth - padding.left - padding.right;
    const chartH = this.displayHeight - padding.top - padding.bottom;

    if (chartW <= 0 || chartH <= 0) return;

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
    const range = maxY - minY;
    maxY = maxY + range * 0.1;
    if (minY < 0) minY = minY - range * 0.05;

    // Y Gridlines and Ticks
    const steps = 4;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let s = 0; s <= steps; s++) {
      const norm = s / steps;
      const yVal = minY + (maxY - minY) * (1 - norm);
      const y = padding.top + norm * chartH;

      ctx.strokeStyle = '#1f1f24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      ctx.fillStyle = '#71717a';
      const labelText = Math.abs(yVal) >= 100 ? Math.round(yVal) : yVal.toFixed(1);
      ctx.fillText(labelText, padding.left - 8, y);
    }

    // Zero baseline
    if (minY < 0 && maxY > 0) {
      const zeroNorm = (maxY - 0) / (maxY - minY);
      const zeroY = padding.top + zeroNorm * chartH;
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, zeroY);
      ctx.lineTo(padding.left + chartW, zeroY);
      ctx.stroke();
    }

    // X Axis Ticks and Labels (Collision Avoidance & Concise Labels)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStep = chartW / Math.max(1, labels.length);

    this.dataPoints = [];

    const conciseZoneMap = {
      recovery: 'Rec',
      aerobic: 'Aer',
      tempo: 'Tempo',
      threshold: 'Thr',
      interval: 'Int',
      moderate: 'Mod',
      steep: 'Steep',
      sustained: 'Sust',
      alpine: 'Alp',
      active: 'Act',
      endurance: 'Endur',
      anaerobic: 'Anaer',
      neuromuscular: 'Neuro'
    };

    let prevLabelRight = -Infinity;

    labels.forEach((lbl, idx) => {
      const xCenter = padding.left + (idx + 0.5) * xStep;
      let displayLbl = String(lbl);

      const lower = displayLbl.toLowerCase();
      if (conciseZoneMap[lower]) {
        displayLbl = conciseZoneMap[lower];
      } else {
        const sortedKeys = Object.keys(conciseZoneMap).sort((a, b) => b.length - a.length);
        for (const key of sortedKeys) {
          if (lower.includes(key)) {
            displayLbl = conciseZoneMap[key];
            break;
          }
        }
      }
      if (/^\d{4}-W\d{2}$/.test(displayLbl)) {
        displayLbl = displayLbl.slice(5);
      } else if (displayLbl.length > 8) {
        displayLbl = displayLbl.slice(-5);
      }

      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const textW = ctx.measureText(displayLbl).width;
      const halfW = textW / 2;

      // Clamp label to stay within canvas boundaries without clipping
      let drawX = xCenter;
      if (drawX - halfW < padding.left - 2) {
        drawX = padding.left - 2 + halfW;
      }
      if (drawX + halfW > this.displayWidth - 2) {
        drawX = this.displayWidth - 2 - halfW;
      }

      const labelLeft = drawX - halfW;
      const labelRight = drawX + halfW;

      // Ensure at least 4px clearance between adjacent labels; skip if collision occurs
      if (labelLeft < prevLabelRight + 4) {
        return;
      }

      ctx.fillStyle = '#71717a';
      ctx.fillText(displayLbl, drawX, padding.top + chartH + 8);
      prevLabelRight = labelRight;
    });

    // Render Data
    if (isLine) {
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

        if (pts.length === 0) continue;

        // Draw area gradient fill
        if (ds.fill && pts.length > 0) {
          ctx.beginPath();
          if (typeof ctx.bezierCurveTo === 'function') {
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 0; i < pts.length - 1; i++) {
              const p0 = pts[i === 0 ? 0 : i - 1];
              const p1 = pts[i];
              const p2 = pts[i + 1];
              const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
              const tension = 0.18;
              const cp1x = p1.x + (p2.x - p0.x) * tension;
              const cp1y = p1.y + (p2.y - p0.y) * tension;
              const cp2x = p2.x - (p3.x - p1.x) * tension;
              const cp2y = p2.y - (p3.y - p1.y) * tension;
              ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
            }
          } else {
            pts.forEach((p, i) => {
              if (i === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            });
          }
          ctx.lineTo(pts[pts.length - 1].x, padding.top + chartH);
          ctx.lineTo(pts[0].x, padding.top + chartH);
          ctx.closePath();

          if (typeof ctx.createLinearGradient === 'function') {
            const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
            grad.addColorStop(0, colorWithAlpha(color, 0.18));
            grad.addColorStop(1, colorWithAlpha(color, 0.01));
            ctx.fillStyle = grad;
          } else {
            ctx.fillStyle = colorWithAlpha(color, 0.12);
          }
          ctx.fill();
        }

        // Draw line with smooth cubic bezier curve
        ctx.beginPath();
        if (typeof ctx.bezierCurveTo === 'function') {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i === 0 ? 0 : i - 1];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
            const tension = 0.18;
            const cp1x = p1.x + (p2.x - p0.x) * tension;
            const cp1y = p1.y + (p2.y - p0.y) * tension;
            const cp2x = p2.x - (p3.x - p1.x) * tension;
            const cp2y = p2.y - (p3.y - p1.y) * tension;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
          }
        } else {
          pts.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = ds.borderWidth || 2;
        ctx.stroke();

        // Draw point dots
        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
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
          const color = ds.backgroundColor || '#38bdf8';
          const barWidth = Math.min(28, xStep * 0.6);

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
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(x, yTop, barWidth, h, 2);
            } else {
              ctx.rect(x, yTop, barWidth, h);
            }
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
        const groupCount = datasets.length;
        const totalBarGroupWidth = Math.min(44, xStep * 0.7);
        const singleBarWidth = totalBarGroupWidth / Math.max(1, groupCount);

        datasets.forEach((ds, dsIdx) => {
          const color = ds.backgroundColor || '#38bdf8';
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
            ctx.rect(x, y, Math.max(1, singleBarWidth - 1), h);
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

    // Render wrapped legend rows at top
    if (legendRows.length > 0) {
      let currentY = 12;
      legendRows.forEach(row => {
        const rowWidth = row.reduce((sum, item) => sum + item.w, 0);
        let startX = Math.max(10, (this.displayWidth - rowWidth) / 2);

        row.forEach(item => {
          ctx.fillStyle = item.color;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(startX, currentY - 4, 7, 7, 2);
          } else {
            ctx.rect(startX, currentY - 4, 7, 7);
          }
          ctx.fill();

          ctx.fillStyle = '#a1a1aa';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';

          // Safe non-clipping text
          let nameToDraw = item.name;
          const maxTextW = Math.max(20, this.displayWidth - startX - 16);
          if (ctx.measureText(nameToDraw).width > maxTextW) {
            while (nameToDraw.length > 3 && ctx.measureText(nameToDraw + '…').width > maxTextW) {
              nameToDraw = nameToDraw.slice(0, -1);
            }
            nameToDraw += '…';
          }
          ctx.fillText(nameToDraw, startX + 11, currentY);
          startX += item.w;
        });
        currentY += 16;
      });
    }
  }

  _renderDoughnut() {
    const ctx = this.ctx;
    const ds = this.data.datasets?.[0];
    if (!ds) return;

    const values = (ds.data || []).map(v => Math.max(0, Number(v) || 0));
    const labels = this.data.labels || [];
    const colors = Array.isArray(ds.backgroundColor)
      ? ds.backgroundColor
      : ['#38bdf8', '#34d399', '#fbbf24', '#f87171', '#a78bfa'];

    const total = values.reduce((sum, v) => sum + v, 0);
    if (total === 0) return;

    this.doughnutSlices = [];
    values.forEach((val, i) => {
      this.doughnutSlices.push({
        label: labels[i] || `Zone ${i + 1}`,
        val,
        pct: ((val / total) * 100).toFixed(1),
        color: colors[i % colors.length]
      });
    });

    // Compute wrapped legend rows
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const legendItems = this.doughnutSlices.map(s => {
      const text = `${s.label} (${s.pct}%)`;
      const textW = ctx.measureText(text).width;
      return { text, w: textW + 20, color: s.color };
    });

    const maxLegendW = Math.max(20, this.displayWidth - 20);
    const legendRows = this._computeWrappedLegendRows(legendItems, maxLegendW);
    const legendHeight = legendRows.length * 16 + 6;

    // Position doughnut centered in remaining vertical height
    const availableH = this.displayHeight - legendHeight;
    const centerY = legendHeight + availableH / 2;
    const centerX = this.displayWidth / 2;
    const outerRadius = Math.min(this.displayWidth * 0.42, availableH * 0.42);
    if (outerRadius <= 5) return;
    const innerRadius = outerRadius * 0.65;

    let startAngle = -Math.PI / 2;

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

      // Hairline separation border
      ctx.strokeStyle = '#09090b';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      startAngle = endAngle;
    });

    // Center Summary Text (rendered if hole is sufficiently sized for 78px text)
    if (innerRadius >= 36) {
      ctx.fillStyle = '#f4f4f5';
      ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(values.length) + ' Zones', centerX, centerY - 7);
      ctx.fillStyle = '#71717a';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Distribution', centerX, centerY + 10);
    }

    // Draw non-clipping wrapped legend rows at top
    let currentY = 12;
    legendRows.forEach(row => {
      const rowWidth = row.reduce((sum, item) => sum + item.w, 0);
      let startX = Math.max(8, (this.displayWidth - rowWidth) / 2);

      row.forEach(item => {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(startX, currentY - 4, 7, 7, 2);
        } else {
          ctx.rect(startX, currentY - 4, 7, 7);
        }
        ctx.fill();

        ctx.fillStyle = '#a1a1aa';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        // Safe non-clipping text
        let textToDraw = item.text;
        const maxTextW = Math.max(20, this.displayWidth - startX - 14);
        if (ctx.measureText(textToDraw).width > maxTextW) {
          while (textToDraw.length > 3 && ctx.measureText(textToDraw + '…').width > maxTextW) {
            textToDraw = textToDraw.slice(0, -1);
          }
          textToDraw += '…';
        }
        ctx.fillText(textToDraw, startX + 11, currentY);
        startX += item.w;
      });
      currentY += 16;
    });
  }

  _handleMouseMove(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;

    if (!this.dataPoints || this.dataPoints.length === 0) return;

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
    const title = pt.datasetName ? `${pt.label || ''} - ${pt.datasetName}` : (pt.label || '');
    const valText = `Value: ${pt.val}`;

    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const titleW = ctx.measureText(title).width;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const valW = ctx.measureText(valText).width;
    const boxW = Math.max(titleW, valW) + 24;
    const boxH = 42;

    let bx = pt.x - boxW / 2;
    let by = pt.y - boxH - 10;
    if (bx < 8) bx = 8;
    if (bx + boxW > this.displayWidth - 8) bx = this.displayWidth - boxW - 8;
    if (by < 8) by = pt.y + 10;

    ctx.fillStyle = '#111114';
    ctx.strokeStyle = '#1f1f24';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, by, boxW, boxH, 6);
    } else {
      ctx.rect(bx, by, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = pt.color || '#38bdf8';
    ctx.beginPath();
    ctx.arc(bx + 11, by + 14, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f4f4f5';
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, bx + 20, by + 14);

    ctx.fillStyle = '#a1a1aa';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(valText, bx + 20, by + 28);
  }
}

export default Chart;
