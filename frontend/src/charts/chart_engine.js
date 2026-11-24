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

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toFiniteNumber(val) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function formatTooltipDateHeader(rawLabel) {
  const s = String(rawLabel || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const dt = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  if (isNaN(dt.getTime())) return s;
  return `${SHORT_DAYS[dt.getUTCDay()]}, ${SHORT_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function isoWeekToUTCDate(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon .. 7=Sun
  const week1Monday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
}

function formatAxisDateLabel(rawLabel, spansMultipleYears, prevYearRef) {
  const s = String(rawLabel || '').trim();
  const weekMatch = s.match(/^(\d{4})-W(\d{2})$/);
  if (weekMatch) {
    const yr = parseInt(weekMatch[1], 10);
    const wk = parseInt(weekMatch[2], 10);
    const dt = isoWeekToUTCDate(yr, wk);
    const mName = SHORT_MONTHS[dt.getUTCMonth()];
    const dayNum = dt.getUTCDate();
    const dtYr = dt.getUTCFullYear();
    const showYr = spansMultipleYears && (prevYearRef.year !== dtYr || dt.getUTCMonth() === 0);
    prevYearRef.year = dtYr;
    return showYr ? `${mName} ${dayNum} '${String(dtYr).slice(-2)}` : `${mName} ${dayNum}`;
  }

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    const mo = parseInt(isoMatch[2], 10) - 1;
    const dy = parseInt(isoMatch[3], 10);
    const mName = SHORT_MONTHS[mo] || isoMatch[2];
    const showYr = spansMultipleYears && (prevYearRef.year !== yr || mo === 0);
    prevYearRef.year = yr;
    return showYr ? `${mName} ${dy} '${String(yr).slice(-2)}` : `${mName} ${dy}`;
  }

  return null;
}

export class Chart {
  static defaults = {
    color: '#c4b5fd',
    borderColor: '#2d2147',
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
        backgroundColor: '#130d21',
        borderColor: '#433269',
        borderWidth: 1,
        titleColor: '#f5f3ff',
        bodyColor: '#c4b5fd'
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
    this._view = { xZoom: 1, yZoom: 1, xPan: 0, yPan: 0 };
    this._drag = null;
    this._legendHitboxes = [];

    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseLeave = this._handleMouseLeave.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onDblClick = () => {
      this._view = { xZoom: 1, yZoom: 1, xPan: 0, yPan: 0 };
      this.render();
    };
    this._onResize = this._handleResize.bind(this);

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mouseleave', this._onMouseLeave);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    this.canvas.addEventListener('dblclick', this._onDblClick);
    if (typeof window !== 'undefined') {
      window.addEventListener('mouseup', this._onMouseUp);
      window.addEventListener('resize', this._onResize);
    }
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this._resizeObserver = new ResizeObserver(() => {
        this._handleResize();
      });
      this._resizeObserver.observe(this.canvas.parentElement);
    }

    this.render();
  }

  destroy() {
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseleave', this._onMouseLeave);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    this.canvas.removeEventListener('dblclick', this._onDblClick);
    if (typeof window !== 'undefined') {
      window.removeEventListener('mouseup', this._onMouseUp);
      window.removeEventListener('resize', this._onResize);
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
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
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement && !this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this._handleResize();
      });
      this._resizeObserver.observe(this.canvas.parentElement);
    }

    const parent = this.canvas.parentElement;
    const parentRect = (parent && typeof parent.getBoundingClientRect === 'function') ? parent.getBoundingClientRect() : null;
    const rect = typeof this.canvas.getBoundingClientRect === 'function' ? this.canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

    let width = 0;
    if (parentRect && parentRect.width > 0) {
      width = parentRect.width;
    } else if (rect.width > 0) {
      width = rect.width;
    } else {
      width = this._lastDisplayWidth || this.canvas._cssWidth || (this.canvas.width ? (this._scaled ? this.canvas.width / dpr : this.canvas.width) : 600);
    }

    let height = 0;
    if (parentRect && parentRect.height > 0) {
      height = parentRect.height;
    } else if (rect.height > 0) {
      height = rect.height;
    } else {
      height = this._lastDisplayHeight || this.canvas._cssHeight || (this.canvas.height ? (this._scaled ? this.canvas.height / dpr : this.canvas.height) : 300);
    }

    this._lastDisplayWidth = width;
    this._lastDisplayHeight = height;
    this._scaled = true;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);

    if (this.canvas.style) {
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
    }

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
    const isRangeBar = !isLine && (this.type === 'rangeBar' || datasets.some(ds => ds.type === 'rangeBar'));
    const isStacked = Boolean(this.options.scales?.x?.stacked || this.options.scales?.y?.stacked);

    // Prepare legend rows to dynamically reserve top padding
    let legendRows = [];
    let legendHeight = 0;
    const legendDisabled = this.options.plugins?.legend?.display === false;
    const customLegendItems =
      this.options.legendItems ||
      this.options.plugins?.legend?.items ||
      this.options.plugins?.legend?.customItems ||
      datasets.find(d => Array.isArray(d.legendItems))?.legendItems;

    if (!legendDisabled) {
      let items = null;
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

      if (Array.isArray(customLegendItems) && customLegendItems.length > 0) {
        items = customLegendItems.map(item => {
          const name = String(item.label ?? item.name ?? item.text ?? 'Series');
          const shape = item.shape || item.style || item.symbol || 'square';
          const color = item.color || item.fillColor || item.strokeColor || '#38bdf8';
          const fillColor = item.fillColor || (shape === 'ring' ? '#0b0714' : color);
          const strokeColor = item.strokeColor || item.borderColor || color || '#c4b5fd';
          const textWidth = ctx.measureText(name).width;
          return {
            name,
            w: textWidth + 24,
            color,
            fillColor,
            strokeColor,
            shape,
            dsIndex: typeof item.dsIndex === 'number' ? item.dsIndex : null,
            hidden: Boolean(item.hidden)
          };
        });
      } else if (isRangeBar && datasets.length > 0) {
        items = [
          { name: 'Daily High', color: '#38bdf8', fillColor: '#38bdf8', strokeColor: '#38bdf8', shape: 'dot', dsIndex: null, hidden: false },
          { name: 'Daily Low', color: '#c4b5fd', fillColor: '#0b0714', strokeColor: '#c4b5fd', shape: 'ring', dsIndex: null, hidden: false }
        ].map(it => ({ ...it, w: ctx.measureText(it.name).width + 24 }));
      } else if (datasets.length > 1) {
        items = datasets.map((ds, dsIndex) => {
          const name = ds.label || 'Series';
          const textWidth = ctx.measureText(name).width;
          const w = textWidth + 24;
          const rawColor = ds.borderColor || ds.legendColor || (Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor);
          const swatchColor = typeof rawColor === 'string' ? rawColor : '#38bdf8';
          return { name, w, color: swatchColor, fillColor: swatchColor, strokeColor: swatchColor, shape: 'square', dsIndex, hidden: Boolean(ds.hidden) };
        });
      }

      if (items && items.length > 0) {
        const maxLegendW = Math.max(100, this.displayWidth - 30);
        legendRows = this._computeWrappedLegendRows(items, maxLegendW);
        legendHeight = legendRows.length * 18 + 6;
      }
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
    const beginAtZero = this.options.scales?.y?.beginAtZero !== false;
    let minY = beginAtZero ? 0 : Infinity;
    let maxY = beginAtZero ? 0 : -Infinity;

    if (isStacked && !isLine && !isRangeBar) {
      for (let i = 0; i < labels.length; i++) {
        let posSum = 0;
        let negSum = 0;
        for (const ds of datasets) {
          if (ds.hidden) continue;
          if (ds.type === 'line') {
            const v = toFiniteNumber(ds.data?.[i]);
            if (v !== null) {
              if (v > maxY) maxY = v;
              if (v < minY) minY = v;
            }
            continue;
          }
          const val = toFiniteNumber(ds.data?.[i]) ?? 0;
          if (val >= 0) posSum += val;
          else negSum += val;
        }
        if (posSum > maxY) maxY = posSum;
        if (negSum < minY) minY = negSum;
      }
    } else {
      for (const ds of datasets) {
        if (ds.hidden) continue;
        for (const arr of [ds.data, ds.highData, ds.lowData]) {
          if (!Array.isArray(arr)) continue;
          for (const raw of arr) {
            if (raw && typeof raw === 'object') {
              const hi = toFiniteNumber(raw.high);
              const lo = toFiniteNumber(raw.low);
              const yv = toFiniteNumber(raw.y);
              if (hi !== null) { if (hi > maxY) maxY = hi; if (hi < minY) minY = hi; }
              if (lo !== null) { if (lo > maxY) maxY = lo; if (lo < minY) minY = lo; }
              if (yv !== null) { if (yv > maxY) maxY = yv; if (yv < minY) minY = yv; }
            } else {
              const v = toFiniteNumber(raw);
              if (v !== null) {
                if (v > maxY) maxY = v;
                if (v < minY) minY = v;
              }
            }
          }
        }
      }
    }

    // Include annotations in range if present
    if (this.options.annotations && Array.isArray(this.options.annotations)) {
      for (const ann of this.options.annotations) {
        if (typeof ann.y === 'number' && !isNaN(ann.y)) {
          if (ann.y > maxY) maxY = ann.y;
          if (ann.y < minY) minY = ann.y;
        }
        if (typeof ann.yMax === 'number' && !isNaN(ann.yMax) && ann.yMax > maxY) maxY = ann.yMax;
        if (typeof ann.yMin === 'number' && !isNaN(ann.yMin) && ann.yMin < minY) minY = ann.yMin;
        if (Array.isArray(ann.yMaxSeries)) {
          for (const v of ann.yMaxSeries) {
            if (typeof v === 'number' && !isNaN(v) && v > maxY) maxY = v;
          }
        }
        if (Array.isArray(ann.yMinSeries)) {
          for (const v of ann.yMinSeries) {
            if (typeof v === 'number' && !isNaN(v) && v < minY) minY = v;
          }
        }
      }
    }

    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
      minY = 0;
      maxY = 10;
    }

    if (maxY === minY) {
      if (!beginAtZero && minY > 0) {
        maxY += Math.max(2, Math.round(minY * 0.08));
        minY = Math.max(0, minY - Math.max(2, Math.round(minY * 0.08)));
      } else {
        maxY += 10;
        minY = Math.min(0, minY);
      }
    }
    const range = maxY - minY;
    maxY = maxY + range * (beginAtZero ? 0.1 : 0.14);
    if (!beginAtZero) {
      minY = minY - range * 0.14;
    } else if (minY < 0) {
      minY = minY - range * 0.05;
    }

    // Override with explicit user-defined scale bounds if provided
    if (typeof this.options.scales?.y?.min === 'number') {
      minY = this.options.scales.y.min;
    }
    if (typeof this.options.scales?.y?.max === 'number') {
      maxY = this.options.scales.y.max;
    }

    // Apply interactive Y pan and scale if active
    if (this._view && (this._view.yZoom !== 1 || this._view.yPan !== 0)) {
      const ySpan = (maxY - minY) / Math.max(0.1, this._view.yZoom);
      const yMid = (maxY + minY) / 2 + (this._view.yPan / Math.max(1, chartH)) * ySpan;
      minY = yMid - ySpan / 2;
      maxY = yMid + ySpan / 2;
    }

    const ySpanSafe = (maxY - minY) || 1;

    // Apply interactive X pan and scale if active
    const xZoom = Math.max(0.25, Math.min(10, this._view?.xZoom || 1));
    const xPan = this._view?.xPan || 0;
    const baseStep = chartW / Math.max(1, labels.length);
    const xStep = baseStep * xZoom;
    const totalZoomedW = xStep * labels.length;
    const xOrigin = padding.left + (chartW - totalZoomedW) / 2 + xPan;
    const getX = (idx) => xOrigin + (idx + 0.5) * xStep;

    // Y Gridlines and Ticks
    const steps = 4;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let s = 0; s <= steps; s++) {
      const norm = s / steps;
      const yVal = minY + (maxY - minY) * (1 - norm);
      const y = padding.top + norm * chartH;

      ctx.strokeStyle = '#2d2147';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      ctx.fillStyle = '#a79bc2';
      let labelText;
      if (this.options.scales?.y?.integerTicks) {
        labelText = String(Math.round(yVal));
      } else if (isRangeBar) {
        labelText = Math.abs(yVal - Math.round(yVal)) < 1e-6 ? String(Math.round(yVal)) : yVal.toFixed(1);
      } else {
        labelText = Math.abs(yVal) >= 100 ? Math.round(yVal) : yVal.toFixed(1);
      }
      ctx.fillText(labelText, padding.left - 8, y);
    }

    // Zero baseline
    if (minY < 0 && maxY > 0) {
      const zeroNorm = (maxY - 0) / ySpanSafe;
      const zeroY = padding.top + zeroNorm * chartH;
      ctx.strokeStyle = '#433269';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, zeroY);
      ctx.lineTo(padding.left + chartW, zeroY);
      ctx.stroke();
    }

    // X Axis Ticks and Labels (Collision Avoidance, Year-Aware Formatting, & X-Pan Clipping)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
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

    const labelYears = new Set();
    for (const lbl of labels) {
      const m = String(lbl || '').match(/^(\d{4})-/);
      if (m) labelYears.add(m[1]);
    }
    const spansMultipleYears = labelYears.size > 1;
    const prevYearRef = { year: null };

    if (typeof ctx.save === 'function') ctx.save();
    if (typeof ctx.rect === 'function' && typeof ctx.clip === 'function') {
      ctx.beginPath();
      ctx.rect(padding.left - 12, padding.top + chartH, chartW + 24, padding.bottom);
      ctx.clip();
    }

    let prevLabelRight = -Infinity;

    labels.forEach((lbl, idx) => {
      const xCenter = getX(idx);
      let displayLbl = String(lbl);

      const formattedDate = formatAxisDateLabel(displayLbl, spansMultipleYears, prevYearRef);
      if (formattedDate) {
        displayLbl = formattedDate;
      } else {
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
        if (displayLbl.length > 8) {
          displayLbl = displayLbl.slice(-5);
        }
      }

      if (xCenter < padding.left - 30 || xCenter > padding.left + chartW + 30) {
        return;
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

      ctx.fillStyle = '#a79bc2';
      ctx.fillText(displayLbl, drawX, padding.top + chartH + 8);
      prevLabelRight = labelRight;
    });
    if (typeof ctx.restore === 'function') ctx.restore();

    // Clip plot area for bands, lines, bars, and reference lines during X/Y pan & zoom
    if (typeof ctx.save === 'function') ctx.save();
    if (typeof ctx.rect === 'function' && typeof ctx.clip === 'function') {
      ctx.beginPath();
      if (isRangeBar) {
        ctx.rect(padding.left, Math.max(0, padding.top - 10), chartW, chartH + 17);
      } else {
        ctx.rect(padding.left, padding.top, chartW, chartH);
      }
      ctx.clip();
    }

    // Render Background Annotations Bands (static yMin/yMax or dynamic yMinSeries/yMaxSeries)
    if (this.options.annotations && Array.isArray(this.options.annotations)) {
      for (const ann of this.options.annotations) {
        if (ann.type === 'band' && Array.isArray(ann.yMinSeries) && Array.isArray(ann.yMaxSeries) && labels.length > 0) {
          if (typeof ctx.save === 'function') ctx.save();
          ctx.beginPath();
          for (let i = 0; i < labels.length; i++) {
            const x = getX(i);
            const vMax = Number(ann.yMaxSeries[i]);
            const yTop = padding.top + ((maxY - vMax) / ySpanSafe) * chartH;
            if (i === 0) ctx.moveTo(x, yTop);
            else ctx.lineTo(x, yTop);
          }
          for (let i = labels.length - 1; i >= 0; i--) {
            const x = getX(i);
            const vMin = Number(ann.yMinSeries[i]);
            const yBot = padding.top + ((maxY - vMin) / ySpanSafe) * chartH;
            ctx.lineTo(x, yBot);
          }
          if (typeof ctx.closePath === 'function') ctx.closePath();
          ctx.fillStyle = ann.color || 'rgba(168, 85, 247, 0.16)';
          ctx.fill();

          if (ann.borderColor) {
            ctx.strokeStyle = ann.borderColor;
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          if (Array.isArray(ann.meanSeries) && ann.meanSeries.length > 0) {
            ctx.beginPath();
            for (let i = 0; i < labels.length; i++) {
              const x = getX(i);
              const vMean = Number(ann.meanSeries[i]);
              const yMean = padding.top + ((maxY - vMean) / ySpanSafe) * chartH;
              if (i === 0) ctx.moveTo(x, yMean);
              else ctx.lineTo(x, yMean);
            }
            ctx.strokeStyle = ann.meanColor || 'rgba(196, 181, 253, 0.65)';
            ctx.lineWidth = 1.25;
            if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4, 4]);
            ctx.stroke();
            if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
          }

          if (ann.label) {
            ctx.fillStyle = ann.labelColor || '#c4b5fd';
            ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(ann.label, padding.left + 6, padding.top + 4);
          }
          if (typeof ctx.restore === 'function') ctx.restore();
        } else if (ann.type === 'band' && typeof ann.yMin === 'number' && typeof ann.yMax === 'number') {
          const normTop = (maxY - ann.yMax) / ySpanSafe;
          const normBottom = (maxY - ann.yMin) / ySpanSafe;
          const yTop = Math.max(padding.top, padding.top + normTop * chartH);
          const yBottom = Math.min(padding.top + chartH, padding.top + normBottom * chartH);
          const h = yBottom - yTop;
          if (h > 0) {
            if (typeof ctx.save === 'function') ctx.save();
            ctx.fillStyle = ann.color || 'rgba(168, 85, 247, 0.14)';
            if (typeof ctx.fillRect === 'function') {
              ctx.fillRect(padding.left, yTop, chartW, h);
            } else {
              ctx.beginPath();
              ctx.rect(padding.left, yTop, chartW, h);
              ctx.fill();
            }
            if (ann.label) {
              ctx.fillStyle = ann.labelColor || '#c4b5fd';
              ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(ann.label, padding.left + 6, yTop + 4);
            }
            if (typeof ctx.restore === 'function') ctx.restore();
          }
        }
      }
    }

    // Render Data
    if (isLine) {
      for (const ds of datasets) {
        if (ds.hidden) continue;
        const color = ds.borderColor || ds.backgroundColor || '#38bdf8';
        const segments = [];
        let currentSeg = [];

        for (let i = 0; i < labels.length; i++) {
          const val = toFiniteNumber(ds.data?.[i]);
          if (val === null) {
            if (currentSeg.length > 0) {
              segments.push(currentSeg);
              currentSeg = [];
            }
            continue;
          }
          const x = getX(i);
          const normY = (maxY - val) / ySpanSafe;
          const y = padding.top + normY * chartH;
          const ptColor = Array.isArray(ds.pointColors) && ds.pointColors[i] ? ds.pointColors[i] : color;
          currentSeg.push({
            x,
            y,
            val,
            label: labels[i],
            datasetName: ds.label,
            color: ptColor,
            ...(Array.isArray(ds.tooltipTitles) && ds.tooltipTitles[i] ? { tooltipTitle: ds.tooltipTitles[i] } : {}),
            ...(Array.isArray(ds.tooltipLines) && Array.isArray(ds.tooltipLines[i]) ? { tooltipLines: ds.tooltipLines[i] } : {})
          });
        }
        if (currentSeg.length > 0) {
          segments.push(currentSeg);
        }

        if (segments.length === 0) continue;

        for (const pts of segments) {
          // Draw area gradient fill
          if (ds.fill && pts.length > 1) {
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
            if (typeof ctx.closePath === 'function') ctx.closePath();

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
          if (pts.length > 1) {
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
          }

          // Draw point dots
          const ptRadius = typeof ds.pointRadius === 'number' ? ds.pointRadius : 2.5;
          pts.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, ptRadius, 0, Math.PI * 2);
            ctx.fillStyle = p.color || color;
            ctx.fill();
            this.dataPoints.push({ ...p, radius: 8 });
          });
        }
      }
    } else if (isRangeBar) {
      for (const ds of datasets) {
        if (ds.hidden) continue;

        const bg = ds.backgroundCurve;
        if (bg && bg.enabled !== false && Array.isArray(bg.daySamples)) {
          const curveSegments = [];
          let currentCurveSeg = [];
          for (let i = 0; i < labels.length; i++) {
            const samples = bg.daySamples[i];
            if (!Array.isArray(samples) || samples.length === 0) {
              if (currentCurveSeg.length > 0) {
                curveSegments.push(currentCurveSeg);
                currentCurveSeg = [];
              }
              continue;
            }
            for (const s of samples) {
              const frac = toFiniteNumber(s?.frac ?? s?.t);
              const val = toFiniteNumber(s?.value ?? s?.v);
              if (frac === null || val === null) continue;
              const x = getX(i) + (frac - 0.5) * xStep;
              const clampedVal = Math.max(minY, Math.min(maxY, val));
              const y = padding.top + ((maxY - clampedVal) / ySpanSafe) * chartH;
              currentCurveSeg.push({ x, y });
            }
          }
          if (currentCurveSeg.length > 0) {
            curveSegments.push(currentCurveSeg);
          }

          if (curveSegments.some(seg => seg.length >= 2)) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(padding.left, padding.top, chartW, chartH);
            if (typeof ctx.clip === 'function') {
              ctx.clip();
            }

            for (const curvePoints of curveSegments) {
              if (curvePoints.length < 2) continue;
              const traceCurve = () => {
                ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
                for (let k = 0; k < curvePoints.length - 1; k++) {
                  const p0 = curvePoints[k];
                  const p1 = curvePoints[k + 1];
                  if (typeof ctx.bezierCurveTo === 'function') {
                    const cx = (p0.x + p1.x) / 2;
                    ctx.bezierCurveTo(cx, p0.y, cx, p1.y, p1.x, p1.y);
                  } else {
                    ctx.lineTo(p1.x, p1.y);
                  }
                }
              };

              // 1. Background area fill
              ctx.beginPath();
              traceCurve();
              ctx.lineTo(curvePoints[curvePoints.length - 1].x, padding.top + chartH);
              ctx.lineTo(curvePoints[0].x, padding.top + chartH);
              ctx.closePath();
              if (typeof ctx.createLinearGradient === 'function') {
                const fillGrad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
                fillGrad.addColorStop(0, bg.fillTopColor || 'rgba(56, 189, 248, 0.16)');
                fillGrad.addColorStop(1, bg.fillBottomColor || 'rgba(168, 85, 247, 0.02)');
                ctx.fillStyle = fillGrad;
              } else {
                ctx.fillStyle = bg.fillTopColor || 'rgba(56, 189, 248, 0.12)';
              }
              ctx.fill();

              // 2. Continuous Bezier wave stroke
              ctx.beginPath();
              traceCurve();
              if (typeof ctx.createLinearGradient === 'function') {
                const strokeGrad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
                strokeGrad.addColorStop(0, bg.strokeTopColor || '#38bdf8');
                strokeGrad.addColorStop(1, bg.strokeBottomColor || '#a855f7');
                ctx.strokeStyle = strokeGrad;
              } else {
                ctx.strokeStyle = bg.fallbackColor || bg.strokeBottomColor || '#a855f7';
              }
              ctx.lineWidth = typeof bg.lineWidth === 'number' ? bg.lineWidth : 2.2;
              ctx.lineJoin = 'round';
              ctx.lineCap = 'round';
              ctx.stroke();
            }

            ctx.restore();
          }
        }

        const pillarW = typeof ds.pillarWidth === 'number'
          ? Math.max(2, ds.pillarWidth)
          : Math.max(2, Math.min(14, xStep * 0.48));
        const capR = Math.max(2, Math.min(6, pillarW * 0.45));
        const showCapLabels = Boolean(
          ds.showCapLabels || ds.showValueLabels || ds.showRangeValueLabels ||
          this.options.showCapLabels || this.options.showValueLabels
        );

        for (let i = 0; i < labels.length; i++) {
          const rawItem = ds.data?.[i];
          const objItem = (rawItem && typeof rawItem === 'object') ? rawItem : null;
          const highVal = toFiniteNumber(ds.highData?.[i] ?? objItem?.high);
          const lowVal = toFiniteNumber(ds.lowData?.[i] ?? objItem?.low);
          const chargedVal = toFiniteNumber(ds.chargedData?.[i] ?? objItem?.charged);
          const drainedVal = toFiniteNumber(ds.drainedData?.[i] ?? objItem?.drained);

          if (highVal === null && lowVal === null) continue;

          const xCenter = getX(i);
          const effHigh = highVal !== null ? highVal : lowVal;
          const effLow = lowVal !== null ? lowVal : highVal;
          const topVal = Math.max(effHigh, effLow);
          const botVal = Math.min(effHigh, effLow);
          const displayHigh = (highVal !== null && lowVal !== null) ? topVal : highVal;
          const displayLow = (highVal !== null && lowVal !== null) ? botVal : lowVal;

          const yHigh = padding.top + ((maxY - topVal) / ySpanSafe) * chartH;
          const yLow = padding.top + ((maxY - botVal) / ySpanSafe) * chartH;
          const pillarH = Math.max(0, yLow - yHigh);

          if (pillarH > 0) {
            const pillarX = xCenter - pillarW / 2;
            if (typeof ctx.createLinearGradient === 'function') {
              const grad = ctx.createLinearGradient(0, yHigh, 0, yHigh + pillarH);
              grad.addColorStop(0, ds.pillarTopColor || 'rgba(168, 85, 247, 0.28)');
              grad.addColorStop(1, ds.pillarBottomColor || '#2d2147');
              ctx.fillStyle = grad;
            } else {
              ctx.fillStyle = ds.pillarFallbackColor || ds.pillarColor || 'rgba(168, 85, 247, 0.28)';
            }
            ctx.beginPath();
            const radius = Math.min(pillarW / 2, pillarH / 2);
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(pillarX, yHigh, pillarW, pillarH, radius);
            } else {
              ctx.rect(pillarX, yHigh, pillarW, pillarH);
            }
            ctx.fill();
          }

          if (displayHigh !== null) {
            ctx.beginPath();
            ctx.arc(xCenter, yHigh, capR, 0, Math.PI * 2);
            ctx.fillStyle = ds.highColor || '#38bdf8';
            ctx.fill();
          }

          if (displayLow !== null) {
            ctx.beginPath();
            ctx.arc(xCenter, yLow, capR, 0, Math.PI * 2);
            ctx.fillStyle = ds.lowFillColor || '#0b0714';
            ctx.fill();
            ctx.strokeStyle = ds.lowStrokeColor || ds.lowColor || '#c4b5fd';
            ctx.lineWidth = 2;
            ctx.stroke();
          }

          if (showCapLabels && xCenter >= padding.left && xCenter <= padding.left + chartW) {
            ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const highFitsAbove = displayHigh !== null && (yHigh - capR - 3) >= padding.top;
            const lowFitsBelow = displayLow !== null && (yLow + capR + 13) <= (padding.top + chartH);
            const minInsideSpan = (!highFitsAbove && !lowFitsBelow) ? (capR * 2 + 28) : (capR * 2 + 18);
            const canPlaceInside = (yLow - yHigh) >= minInsideSpan;

            if (displayHigh !== null) {
              const highText = String(Math.round(displayHigh));
              ctx.fillStyle = ds.highColor || '#38bdf8';
              if (highFitsAbove) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(highText, xCenter, yHigh - capR - 3);
              } else if (canPlaceInside) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(highText, xCenter, yHigh + capR + 3);
              } else {
                const textW = ctx.measureText(highText).width;
                const placeLeft = (xCenter + capR + 4 + textW) > (padding.left + chartW);
                ctx.textBaseline = 'middle';
                ctx.textAlign = placeLeft ? 'right' : 'left';
                ctx.fillText(highText, placeLeft ? (xCenter - capR - 4) : (xCenter + capR + 4), yHigh);
              }
            }

            if (displayLow !== null) {
              const lowText = String(Math.round(displayLow));
              ctx.fillStyle = ds.lowStrokeColor || ds.lowColor || '#c4b5fd';
              if (lowFitsBelow) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(lowText, xCenter, yLow + capR + 3);
              } else if (canPlaceInside) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(lowText, xCenter, yLow - capR - 3);
              } else {
                const textW = ctx.measureText(lowText).width;
                const placeLeft = (xCenter + capR + 4 + textW) > (padding.left + chartW);
                ctx.textBaseline = 'middle';
                ctx.textAlign = placeLeft ? 'right' : 'left';
                ctx.fillText(lowText, placeLeft ? (xCenter - capR - 4) : (xCenter + capR + 4), yLow);
              }
            }
          }

          let tooltipLines;
          if (Array.isArray(ds.tooltipLines) && Array.isArray(ds.tooltipLines[i])) {
            tooltipLines = ds.tooltipLines[i];
          } else {
            tooltipLines = [];
            if (displayHigh !== null) {
              tooltipLines.push({ text: `Daily High: ${Math.round(displayHigh)} pts`, color: ds.highColor || '#38bdf8' });
            }
            if (displayLow !== null) {
              tooltipLines.push({ text: `Daily Low: ${Math.round(displayLow)} pts`, color: ds.lowStrokeColor || ds.lowColor || '#c4b5fd' });
            }
            if (chargedVal !== null || drainedVal !== null) {
              const parts = [];
              if (chargedVal !== null) parts.push(`Charged: +${Math.abs(Math.round(chargedVal))} pts`);
              if (drainedVal !== null) parts.push(`Drained: -${Math.abs(Math.round(drainedVal))} pts`);
              tooltipLines.push({ text: parts.join(' | '), color: '#a79bc2' });
            }
          }

          const topY = displayHigh !== null ? yHigh : yLow;
          const botY = displayLow !== null ? yLow : yHigh;
          const hitHalfW = Math.max(12, pillarW / 2 + 6);
          const tooltipTitle = (Array.isArray(ds.tooltipTitles) && ds.tooltipTitles[i]) ||
            ds.tooltipTitle ||
            formatTooltipDateHeader(labels[i]);

          this.dataPoints.push({
            x: xCenter,
            y: topY,
            yTop: Math.min(topY, botY),
            yBottom: Math.max(topY, botY),
            w: pillarW,
            val: displayHigh ?? displayLow,
            highVal: displayHigh,
            lowVal: displayLow,
            chargedVal,
            drainedVal,
            label: labels[i],
            tooltipTitle,
            tooltipLines,
            datasetName: ds.label,
            color: ds.highColor || '#38bdf8',
            hitRect: {
              left: xCenter - hitHalfW,
              right: xCenter + hitHalfW,
              top: Math.min(topY, botY) - capR - 6,
              bottom: Math.max(topY, botY) + capR + 6
            }
          });
        }
      }
    } else {
      // Bar Datasets
      const barDatasets = datasets.filter(ds => ds.type !== 'line' && ds.type !== 'rangeBar' && !ds.hidden);
      const lineDatasets = datasets.filter(ds => ds.type === 'line' && !ds.hidden);

      if (isStacked) {
        const stackAccum = new Array(labels.length).fill(0);
        for (const ds of barDatasets) {
          const baseColor = (typeof ds.backgroundColor === 'string' ? ds.backgroundColor : ds.backgroundColor?.[0]) || '#38bdf8';
          const barWidth = Math.max(1, Math.min(28, xStep * 0.6));

          for (let i = 0; i < labels.length; i++) {
            const val = toFiniteNumber(ds.data?.[i]) ?? 0;
            if (val <= 0) continue;

            const barColor = (Array.isArray(ds.barColors) && ds.barColors[i]) ||
              (Array.isArray(ds.backgroundColor) && ds.backgroundColor[i]) ||
              baseColor;
            const bottomVal = stackAccum[i];
            const topVal = bottomVal + val;
            stackAccum[i] = topVal;

            const x = getX(i) - barWidth / 2;
            const normTop = (maxY - topVal) / ySpanSafe;
            const normBottom = (maxY - bottomVal) / ySpanSafe;
            const yTop = padding.top + normTop * chartH;
            const yBottom = padding.top + normBottom * chartH;
            const h = Math.max(0, yBottom - yTop);

            ctx.fillStyle = barColor;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
              const radius = Math.min(2, Math.floor(barWidth / 2));
              ctx.roundRect(x, yTop, barWidth, h, radius);
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
              color: barColor,
              ...(Array.isArray(ds.tooltipTitles) && ds.tooltipTitles[i] ? { tooltipTitle: ds.tooltipTitles[i] } : {}),
              ...(Array.isArray(ds.tooltipLines) && Array.isArray(ds.tooltipLines[i]) ? { tooltipLines: ds.tooltipLines[i] } : {})
            });
          }
        }
      } else {
        const groupCount = barDatasets.length;
        const totalBarGroupWidth = Math.min(44, xStep * 0.7);
        const singleBarWidth = totalBarGroupWidth / Math.max(1, groupCount);

        barDatasets.forEach((ds, dsIdx) => {
          const baseColor = (typeof ds.backgroundColor === 'string' ? ds.backgroundColor : ds.backgroundColor?.[0]) || '#38bdf8';
          for (let i = 0; i < labels.length; i++) {
            const val = toFiniteNumber(ds.data?.[i]) ?? 0;
            const barColor = (Array.isArray(ds.barColors) && ds.barColors[i]) ||
              (Array.isArray(ds.backgroundColor) && ds.backgroundColor[i]) ||
              baseColor;
            const groupStartX = getX(i) - totalBarGroupWidth / 2;
            const x = groupStartX + dsIdx * singleBarWidth;
            const normVal = (maxY - val) / ySpanSafe;
            const y = padding.top + normVal * chartH;
            const zeroNorm = (maxY - 0) / ySpanSafe;
            const zeroY = padding.top + zeroNorm * chartH;
            const barY = Math.min(y, zeroY);
            const barH = Math.max(1, Math.abs(zeroY - y));

            ctx.fillStyle = barColor;
            ctx.beginPath();
            ctx.rect(x, barY, Math.max(1, singleBarWidth - 1), barH);
            ctx.fill();

            this.dataPoints.push({
              x: x + singleBarWidth / 2,
              y: barY + barH / 2,
              w: singleBarWidth,
              h: barH,
              val,
              label: labels[i],
              datasetName: ds.label,
              color: barColor,
              ...(Array.isArray(ds.tooltipTitles) && ds.tooltipTitles[i] ? { tooltipTitle: ds.tooltipTitles[i] } : {}),
              ...(Array.isArray(ds.tooltipLines) && Array.isArray(ds.tooltipLines[i]) ? { tooltipLines: ds.tooltipLines[i] } : {})
            });
          }
        });
      }

      // Render line datasets overlaid on bar charts
      for (const ds of lineDatasets) {
        const color = ds.borderColor || ds.backgroundColor || '#38bdf8';
        const pts = [];

        for (let i = 0; i < labels.length; i++) {
          const val = Number(ds.data?.[i]) ?? 0;
          const x = getX(i);
          const normY = (maxY - val) / ySpanSafe;
          const y = padding.top + normY * chartH;
          pts.push({ x, y, val, label: labels[i], datasetName: ds.label, color });
        }

        if (pts.length === 0) continue;

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

        pts.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          this.dataPoints.push({ ...p, radius: 8 });
        });
      }
    }

    // Render Reference Lines (e.g. Goal Lines)
    if (this.options.annotations && Array.isArray(this.options.annotations)) {
      for (const ann of this.options.annotations) {
        if (ann.type === 'line' && typeof ann.y === 'number') {
          const normY = (maxY - ann.y) / ySpanSafe;
          const y = padding.top + normY * chartH;
          if (y >= padding.top - 2 && y <= padding.top + chartH + 2) {
            if (typeof ctx.save === 'function') ctx.save();
            ctx.strokeStyle = ann.color || '#10b981';
            ctx.lineWidth = ann.lineWidth || 1.5;
            if (ann.borderDash && typeof ctx.setLineDash === 'function') {
              ctx.setLineDash(ann.borderDash);
            }
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartW, y);
            ctx.stroke();
            if (ann.label) {
              ctx.fillStyle = ann.labelColor || ann.color || '#10b981';
              ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              ctx.fillText(ann.label, padding.left + chartW - 4, y - 2);
            }
            if (typeof ctx.restore === 'function') ctx.restore();
          }
        }
      }
    }

    // Restore plot area clip
    if (typeof ctx.restore === 'function') ctx.restore();

    // Render wrapped legend rows at top
    this._legendHitboxes = [];
    if (legendRows.length > 0) {
      let currentY = 12;
      legendRows.forEach(row => {
        const rowWidth = row.reduce((sum, item) => sum + item.w, 0);
        let startX = Math.max(10, (this.displayWidth - rowWidth) / 2);

        row.forEach(item => {
          if (typeof item.dsIndex === 'number') {
            this._legendHitboxes.push({ x: startX - 2, y: currentY - 9, w: item.w, h: 18, dsIndex: item.dsIndex });
          }
          ctx.globalAlpha = item.hidden ? 0.35 : 1.0;

          if (item.shape === 'dot' || item.shape === 'circle') {
            ctx.fillStyle = item.fillColor || item.color || '#38bdf8';
            ctx.beginPath();
            ctx.arc(startX + 3.5, currentY, 3.5, 0, Math.PI * 2);
            ctx.fill();
          } else if (item.shape === 'ring') {
            ctx.fillStyle = item.fillColor || '#0b0714';
            ctx.strokeStyle = item.strokeColor || item.color || '#c4b5fd';
            ctx.lineWidth = 1.75;
            ctx.beginPath();
            ctx.arc(startX + 3.5, currentY, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else if (item.shape === 'line' || item.shape === 'wave') {
            ctx.strokeStyle = item.strokeColor || item.color || '#a855f7';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(startX, currentY);
            if (typeof ctx.bezierCurveTo === 'function') {
              ctx.bezierCurveTo(startX + 2.5, currentY - 3, startX + 5.5, currentY + 3, startX + 8, currentY);
            } else {
              ctx.lineTo(startX + 8, currentY);
            }
            ctx.stroke();
          } else {
            ctx.fillStyle = item.fillColor || item.color || '#38bdf8';
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(startX, currentY - 4, 7, 7, 2);
            } else {
              ctx.rect(startX, currentY - 4, 7, 7);
            }
            ctx.fill();
          }

          ctx.fillStyle = '#c4b5fd';
          ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
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
          ctx.globalAlpha = 1.0;
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
      if (typeof ctx.closePath === 'function') ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Hairline separation border
      ctx.strokeStyle = '#0b0714';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      startAngle = endAngle;
    });

    // Center Summary Text (rendered if hole is sufficiently sized for 78px text)
    if (innerRadius >= 36) {
      ctx.fillStyle = '#f5f3ff';
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

  _handleMouseDown(evt) {
    if (evt.button !== 0 && evt.button !== 2) return;
    const mode = evt.button === 2 ? 'scale' : 'pan';
    this._drag = {
      mode,
      startX: evt.clientX,
      startY: evt.clientY,
      startView: { ...this._view },
      moved: false
    };
  }

  _handleMouseUp(evt) {
    if (!this._drag) return;
    const wasMoved = this._drag.moved;
    const mode = this._drag.mode;
    this._drag = null;

    if (!wasMoved && mode === 'pan' && evt && evt.target === this.canvas) {
      const rect = this.canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      for (const hb of this._legendHitboxes || []) {
        if (x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
          if (typeof hb.dsIndex === 'number') {
            const ds = this.data.datasets?.[hb.dsIndex];
            if (ds) {
              ds.hidden = !ds.hidden;
              this.render();
            }
          }
          return;
        }
      }
    }
  }

  _handleMouseMove(evt) {
    if (this._drag) {
      const dx = evt.clientX - this._drag.startX;
      const dy = evt.clientY - this._drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        this._drag.moved = true;
      }
      if (this._drag.moved) {
        if (this._drag.mode === 'pan') {
          this._view.xPan = this._drag.startView.xPan + dx;
          this._view.yPan = this._drag.startView.yPan + dy;
        } else if (this._drag.mode === 'scale') {
          this._view.xZoom = Math.max(0.25, Math.min(10, this._drag.startView.xZoom * Math.exp(dx * 0.008)));
          this._view.yZoom = Math.max(0.25, Math.min(10, this._drag.startView.yZoom * Math.exp(-dy * 0.008)));
        }
        this.render();
        return;
      }
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;

    if (!this.dataPoints || this.dataPoints.length === 0) return;

    let nearest = null;
    let minDist = 30;

    for (const pt of this.dataPoints) {
      let dist;
      if (pt.hitRect) {
        const r = pt.hitRect;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          dist = Math.min(29, Math.abs(pt.x - x));
        } else {
          const clampedX = Math.max(r.left, Math.min(r.right, x));
          const clampedY = Math.max(r.top, Math.min(r.bottom, y));
          const dx = clampedX - x;
          const dy = clampedY - y;
          dist = Math.sqrt(dx * dx + dy * dy) + Math.abs(pt.x - x) * 0.001;
        }
      } else {
        const dx = pt.x - x;
        const dy = pt.y - y;
        dist = Math.sqrt(dx * dx + dy * dy);
      }
      if (dist < minDist) {
        minDist = dist;
        nearest = pt;
      }
    }

    const isSameTooltip =
      nearest === this.activeTooltip ||
      (nearest && this.activeTooltip &&
        nearest.x === this.activeTooltip.x &&
        nearest.y === this.activeTooltip.y &&
        nearest.label === this.activeTooltip.label &&
        nearest.datasetName === this.activeTooltip.datasetName &&
        nearest.val === this.activeTooltip.val);

    if (!isSameTooltip) {
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

    if (Array.isArray(pt.tooltipLines) && pt.tooltipLines.length > 0) {
      const title = pt.tooltipTitle || formatTooltipDateHeader(pt.label) || String(pt.label || '');
      const rawLines = pt.tooltipLines.map(item =>
        typeof item === 'string'
          ? { text: item, color: null }
          : { text: String(item?.text ?? ''), color: item?.color || null }
      );
      const lines = (rawLines.length > 0 && title && rawLines[0].text === title)
        ? rawLines.slice(1)
        : rawLines;

      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const titleW = ctx.measureText(title).width;
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      let maxLineW = 0;
      for (const ln of lines) {
        const w = ctx.measureText(ln.text).width + (ln.color ? 10 : 0);
        if (w > maxLineW) maxLineW = w;
      }

      const lineH = 15;
      const boxW = Math.max(titleW + 24, maxLineW + 24);
      const boxH = 26 + lines.length * lineH;

      let bx = pt.x - boxW / 2;
      let by = pt.y - boxH - 10;
      bx = Math.max(8, Math.min(Math.max(8, this.displayWidth - boxW - 8), bx));
      if (by < 8) by = pt.y + 10;
      by = Math.max(8, Math.min(Math.max(8, this.displayHeight - boxH - 8), by));

      ctx.fillStyle = '#130d21';
      ctx.strokeStyle = '#433269';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(bx, by, boxW, boxH, 6);
      } else {
        ctx.rect(bx, by, boxW, boxH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f5f3ff';
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(title, bx + 12, by + 14);

      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      lines.forEach((ln, idx) => {
        const yLine = by + 28 + idx * lineH;
        if (ln.color) {
          ctx.fillStyle = ln.color;
          ctx.beginPath();
          ctx.arc(bx + 14, yLine, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#c4b5fd';
          ctx.fillText(ln.text, bx + 22, yLine);
        } else {
          ctx.fillStyle = '#c4b5fd';
          ctx.fillText(ln.text, bx + 12, yLine);
        }
      });
      return;
    }

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
    if (bx + boxW > this.displayWidth - 8) bx = Math.max(8, this.displayWidth - boxW - 8);
    if (by < 8) by = pt.y + 10;
    if (by + boxH > this.displayHeight - 8) by = Math.max(8, this.displayHeight - boxH - 8);

    ctx.fillStyle = '#130d21';
    ctx.strokeStyle = '#433269';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, by, boxW, boxH, 6);
    } else {
      ctx.rect(bx, by, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = pt.color || '#a855f7';
    ctx.beginPath();
    ctx.arc(bx + 11, by + 14, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f5f3ff';
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, bx + 20, by + 14);

    ctx.fillStyle = '#c4b5fd';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(valText, bx + 20, by + 28);
  }
}

export default Chart;
