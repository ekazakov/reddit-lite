// Shared SVG helpers for lesson diagrams and interactive widgets.
// Usage: const s = Viz.svg('#id', 720, 260); Viz.line(s, pts, {color}); ...
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // Create an SVG element with attributes and append it to a parent.
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Prepare an <svg> (selector or element): set the viewBox and remove old content.
  function svg(target, w, h) {
    const s = typeof target === 'string' ? document.querySelector(target) : target;
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    while (s.firstChild) s.removeChild(s.firstChild);
    s.w = w; s.h = h;
    return s;
  }

  // Linear scale from a domain [d0, d1] to a range [r0, r1].
  function scale(d0, d1, r0, r1) {
    const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
    f.inv = (p) => d0 + ((p - r0) / (r1 - r0 || 1)) * (d1 - d0);
    return f;
  }

  // Polyline through points [[x, y], ...] already in pixels.
  function line(s, pts, o = {}) {
    return el('polyline', {
      points: pts.map((p) => p.join(',')).join(' '),
      fill: 'none', stroke: o.color || '#1d1d1f', 'stroke-width': o.width || 2,
      'stroke-dasharray': o.dash || '', 'stroke-linejoin': 'round',
    }, s);
  }

  // Step line: holds each value until the next point (how a scraped value looks).
  function steps(s, pts, o = {}) {
    const out = [];
    pts.forEach((p, i) => { if (i) out.push([p[0], pts[i - 1][1]]); out.push(p); });
    return line(s, out, o);
  }

  function dot(s, x, y, o = {}) {
    return el('circle', { cx: x, cy: y, r: o.r || 4, fill: o.color || '#1d1d1f', stroke: o.stroke || 'none', 'stroke-width': 1.5 }, s);
  }

  function rect(s, x, y, w, h, o = {}) {
    return el('rect', { x, y, width: Math.max(0, w), height: Math.max(0, h), fill: o.color || '#eee', rx: o.rx || 0, opacity: o.opacity ?? 1, stroke: o.stroke || 'none' }, s);
  }

  function text(s, x, y, str, o = {}) {
    const t = el('text', {
      x, y, 'text-anchor': o.anchor || 'start', fill: o.color || '#6b6b70',
      'font-size': o.size || 12, 'font-weight': o.weight || 400,
      'font-family': o.mono ? 'ui-monospace,Menlo,monospace' : '-apple-system,system-ui,sans-serif',
    }, s);
    t.textContent = str;
    return t;
  }

  function vline(s, x, y0, y1, o = {}) {
    return el('line', { x1: x, x2: x, y1: y0, y2: y1, stroke: o.color || '#bbb', 'stroke-width': o.width || 1, 'stroke-dasharray': o.dash || '' }, s);
  }

  function hline(s, y, x0, x1, o = {}) {
    return el('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: o.color || '#bbb', 'stroke-width': o.width || 1, 'stroke-dasharray': o.dash || '' }, s);
  }

  // Format a number with a fixed count of decimals and a comma, as Russian text does.
  function fmt(v, d = 2) { return Number(v).toFixed(d).replace('.', ','); }

  // k6 TrendSink.P: sort, index i = p * (n - 1), linear interpolation between neighbors.
  function k6Percentile(values, p) {
    const v = [...values].sort((a, b) => a - b);
    if (v.length === 0) return { value: 0, i: 0 };
    if (v.length === 1) return { value: v[0], i: 0 };
    const i = p * (v.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return { value: v[lo] + (v[hi] - v[lo]) * (i - lo), i, lo, hi, sorted: v };
  }

  window.Viz = { el, svg, scale, line, steps, dot, rect, text, vline, hline, fmt, k6Percentile };
})();
