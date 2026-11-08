'use strict';

/**
 * Geometry for the rate trend chart, computed on the server and drawn as inline SVG.
 *
 * No chart library: the CSP allows no CDN, and the chart has to read without scripting.
 * Pure, so the one rule that matters is testable — a suppressed bucket (`value: null`) BREAKS
 * the line into separate segments. It is never drawn at zero and never bridged, because a
 * line through a month with too few contributors invents a figure for it.
 */

function niceCeil(value) {
  if (!(value > 0)) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * @param {Array<{period:string, value:number|null, contributors:number}>} series
 * @returns geometry in a fixed viewBox (width × height), plus axis ticks and labels.
 */
function trendGeometry(series, { width = 640, height = 260, pad = { top: 16, right: 48, bottom: 32, left: 56 }, formatLabel = (p) => p } = {}) {
  const points = series || [];
  const n = points.length;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = points.filter((p) => p.value != null).map((p) => p.value);
  const yMax = niceCeil(values.length ? Math.max(...values) * 1.1 : 0);
  // Headroom on the count axis: a bar reaching the top line sits on the €-axis top label.
  const cMax = niceCeil(Math.max(3, ...points.map((p) => p.contributors || 0)) * 1.25);
  const x = (i) => pad.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => pad.top + plotH - (v / yMax) * plotH;
  const cy = (c) => pad.top + plotH - (c / cMax) * plotH;

  const segments = [];
  let current = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: Math.round(x(i) * 10) / 10, y: Math.round(y(p.value) * 10) / 10, value: p.value, period: p.period, contributors: p.contributors });
  });
  if (current.length) segments.push(current);

  const barW = Math.max(2, Math.min(18, (plotW / Math.max(n, 1)) * 0.5));
  const bars = points.map((p, i) => ({
    x: Math.round((x(i) - barW / 2) * 10) / 10,
    y: Math.round(cy(p.contributors || 0) * 10) / 10,
    width: Math.round(barW * 10) / 10,
    height: Math.round((pad.top + plotH - cy(p.contributors || 0)) * 10) / 10,
    contributors: p.contributors || 0,
    period: p.period,
    gap: p.value == null
  }));

  // At most ~7 x labels, always including the last.
  const every = Math.max(1, Math.ceil(n / 7));
  const xLabels = points
    .map((p, i) => ({ x: Math.round(x(i) * 10) / 10, label: formatLabel(p.period), i }))
    .filter((l) => l.i % every === 0 || l.i === n - 1);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: Math.round(y(yMax * f) * 10) / 10, label: Math.round(yMax * f) }));
  const cTicks = [0, 0.5, 1].map((f) => ({ y: Math.round(cy(cMax * f) * 10) / 10, label: Math.round(cMax * f) }));

  return { width, height, pad, plot: { x: pad.left, y: pad.top, width: plotW, height: plotH }, segments, bars, xLabels, yTicks, cTicks, hasData: values.length > 0 };
}

module.exports = { trendGeometry, niceCeil };
