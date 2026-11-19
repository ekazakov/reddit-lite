// Browser code for the load test HTML report. scripts/loadtest/report.ts inlines it with uPlot and the data.
// Plain JavaScript with no bundler, like the rest of the browser code in this repository.
// Data sources per run, in order of preference:
//   ts          per-second and 10 s buckets from k6.csv.gz (exact percentiles)
//   promSeries  raw 5 s Prometheus points (k6 per push window, CPU, memory, Postgres)
//   prom        prom.json: totals, knee, whole-run stats, top queries
//   summary     k6 --summary-export: whole-run k6 numbers and checks
//   meta        what was run, and the app and db configuration
(function () {
  'use strict';

  // The data that report.ts put in the page.
  const DATA = JSON.parse(document.getElementById('data').textContent);
  const RUNS = DATA.runs;
  // The p95 limit from the thresholds in loadtest/k6/lib.js.
  const P95_LIMIT = 500;
  // prom-summary.ts pads the Prometheus window by 10 s before the first k6 push.
  const PROM_PAD = 10;
  // One color per run (or per line in a single-run report). Chosen to stay apart in light and dark mode.
  const COLORS = ['#2a6fdb', '#e8590c', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5c940d', '#a61e4d', '#364fc7'];
  // Dash patterns that tell the lines of one run apart when the color shows the run.
  const DASHES = [[], [6, 4], [2, 3], [10, 3, 2, 3], [1, 2]];

  // The user's choices. Changing one draws the page again.
  const state = {
    baseline: DATA.baseline,
    // 1 s buckets are noisy over long runs. 10 s buckets are smoother and still exact.
    res: RUNS.some((r) => r.ts) ? 's10' : 's1',
    action: null,
  };

  // ---------- small helpers ----------

  // Escapes text for HTML, because query text and labels come from files.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Formats a number with a fixed number of decimals, or "-" when it is missing.
  const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  // Short commit id.
  const short = (c) => (c ? c.slice(0, 7) : '-');
  // The color of a run.
  const runColor = (i) => COLORS[i % COLORS.length];
  // Reads a nested value without failing on a missing step, for example get(run, 'prom.overall.cpu_cores').
  const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  // The highest finite value of a list.
  const maxOf = (xs) => xs.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), -Infinity);

  // Seconds between the Unix time and the run start used for the x axis.
  // With a CSV, time 0 is the first k6 sample. Without one, it is the first k6 push to Prometheus.
  function t0(run) {
    if (run.ts) return run.ts.s1.start;
    if (run.promSeries) return run.promSeries.start + PROM_PAD;
    return null;
  }

  // The points of one Prometheus series and label, with x in seconds from t0.
  function promLine(run, name, key) {
    const s = get(run, 'promSeries.series.' + name);
    const pts = s && s.values[key];
    if (!pts) return null;
    // prom-series.json stores x as seconds from its own window start.
    const shift = run.promSeries.start - t0(run);
    return { x: pts.map((p) => p[0] + shift), y: pts.map((p) => p[1]) };
  }

  // The label keys of a Prometheus series, for example ["app", "db"] or the connection states.
  const promKeys = (run, name) => Object.keys(get(run, 'promSeries.series.' + name + '.values') || {});

  // One column of the k6 CSV buckets at the chosen resolution, with x in seconds from t0.
  function tsLine(run, pick) {
    const ts = run.ts && run.ts[state.res];
    if (!ts) return null;
    const y = pick(ts);
    if (!y) return null;
    // Put each bucket at its middle, so 10 s buckets line up with the 1 s data.
    const off = ts.start - t0(run) + (ts.step - 1) / 2;
    return { x: y.map((_, i) => off + i * ts.step), y };
  }

  // The configured limits of a run, for the dashed limit lines. sut comes from scripts/loadtest/sut-config.ts.
  function limits(run) {
    const sut = get(run, 'meta.sut') || {};
    const cpuLimit = get(run, 'prom.cpu_limit') || get(run, 'prom.cpu_limits_cores') || {};
    return {
      cores: get(sut, 'app.cores') ?? cpuLimit.cores ?? null,
      cpuset: get(sut, 'app.cpuset') ?? cpuLimit.cpuset ?? null,
      appMem: get(sut, 'app.memory_mib') ?? null,
      dbMem: get(sut, 'db.memory_mib') ?? null,
      pool: get(sut, 'app.db_pool_max') ?? null,
    };
  }

  // ---------- derived numbers ----------

  // 10 s buckets with the load, latency, and CPU of each, for the rate-vs-latency charts and the summary.
  // k6 values come from the CSV when it exists, else from the 5 s Prometheus points.
  function buckets10(run) {
    if (run._b10) return run._b10;
    const out = [];
    // Averages the Prometheus points of one series and label in [from, to).
    const promAvg = (name, key, from, to, agg = 'avg') => {
      const l = promLine(run, name, key);
      if (!l) return null;
      const ys = l.y.filter((_, i) => l.x[i] >= from && l.x[i] < to && Number.isFinite(l.y[i]));
      if (!ys.length) return null;
      return agg === 'max' ? Math.max(...ys) : ys.reduce((a, b) => a + b, 0) / ys.length;
    };
    const ts = run.ts && run.ts.s10;
    if (ts) {
      for (let i = 0; i < ts.length; i++) {
        const from = ts.start - t0(run) + i * 10;
        out.push({
          from,
          offered: ts.offered[i],
          http: ts.http[i],
          p95: ts.p95[i],
          dropped: ts.dropped[i],
          failedShare: ts.http[i] ? ts.failed[i] / ts.http[i] : 0,
          appCpu: promAvg('cpu_cores', 'app', from, from + 10),
          dbCpu: promAvg('cpu_cores', 'db', from, from + 10),
        });
      }
    } else if (run.promSeries) {
      const end = run.promSeries.end - t0(run);
      for (let from = 0; from < end; from += 10) {
        out.push({
          from,
          offered: promAvg('k6_offered_rps', 'all', from, from + 10),
          http: promAvg('k6_http_rps', 'all', from, from + 10),
          // The worst 5 s window is the closest to a 10 s p95 that the push data can give.
          p95: promAvg('k6_p95_ms_worst', 'all', from, from + 10, 'max'),
          dropped: promAvg('k6_dropped_rps', 'all', from, from + 10),
          failedShare: promAvg('k6_failed_rate', 'all', from, from + 10) ?? 0,
          appCpu: promAvg('cpu_cores', 'app', from, from + 10),
          dbCpu: promAvg('cpu_cores', 'db', from, from + 10),
        });
      }
    }
    // Keep buckets with real load. Empty buckets at the start and end would add points at rate 0.
    run._b10 = out.filter((b) => b.offered > 0.5 && b.p95 !== null);
    return run._b10;
  }

  // The highest 10 s offered rate that the app served within the limits: p95 under 500 ms, no dropped
  // iterations, and under 1% errors. It is the "capacity" number to compare between configurations.
  function maxSustained(run) {
    const good = buckets10(run).filter((b) => b.p95 <= P95_LIMIT && (b.dropped ?? 0) < 0.05 && b.failedShare < 0.01);
    return good.length ? maxOf(good.map((b) => b.offered)) : null;
  }

  // A whole-run k6 summary value, for example summaryMetric(run, 'http_req_duration', 'p(95)').
  const summaryMetric = (run, metric, field) => get(run, 'summary.metrics') && run.summary.metrics[metric] ? run.summary.metrics[metric][field] : undefined;

  // ---------- charts ----------

  // The uPlot instances on the page, so a new render can remove them.
  let plots = [];

  // Draws one chart. lines is a list of { label, x, y, color, dash, points }.
  function drawChart(el, { title, hint, unit, lines, xLabel = 'seconds from start', scatter = false, yMin }) {
    const box = document.createElement('div');
    box.className = 'chart';
    box.innerHTML = `<div class="title">${esc(title)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}`;
    el.appendChild(box);
    const usable = lines.filter((l) => l && l.x && l.x.length);
    if (!usable.length) {
      box.insertAdjacentHTML('beforeend', '<div class="empty">No data for this chart in the selected runs.</div>');
      return;
    }
    // uPlot needs one shared x column. join() merges the x values of all lines and fills gaps with undefined,
    // so a line still connects across x values that only another run has.
    const data = uPlot.join(usable.map((l) => [l.x, l.y]));
    const series = [{ label: xLabel }].concat(usable.map((l) => ({
      label: l.label,
      stroke: l.color,
      width: l.width ?? 1.5,
      dash: l.dash,
      // For the scatter charts, draw points only and no lines.
      paths: scatter ? () => null : undefined,
      points: scatter ? { show: true, size: 6, fill: l.color, stroke: l.color } : { show: false },
      spanGaps: true,
      value: (u, v) => fmt(v, Math.abs(v) < 10 ? 2 : 0),
    })));
    const opts = {
      width: Math.max(300, box.clientWidth - 16),
      height: 260,
      scales: { x: { time: false }, y: yMin === undefined ? {} : { range: (u, min, max) => [yMin, max > yMin ? max * 1.05 : yMin + 1] } },
      axes: [
        { label: xLabel, stroke: getComputedStyle(document.body).color, grid: { stroke: 'rgba(128,128,128,0.15)' } },
        { label: unit, stroke: getComputedStyle(document.body).color, grid: { stroke: 'rgba(128,128,128,0.15)' }, size: 60 },
      ],
      series,
      // Time charts share a cursor, so one point in time shows in every chart. Scatter charts have another x axis.
      cursor: scatter ? {} : { sync: { key: 'time' } },
      legend: { live: true },
    };
    plots.push(new uPlot(opts, data, box));
  }

  // Lines for one chart across all runs. pick(run) returns [{ key, x, y }] for that run.
  // One run: one color per key. Several runs: one color per run and one dash per key.
  function linesFor(pick) {
    const out = [];
    RUNS.forEach((run, ri) => {
      const parts = (pick(run) || []).filter(Boolean);
      parts.forEach((p, ki) => {
        if (!p.x) return;
        const single = RUNS.length === 1;
        out.push({
          label: single ? p.key : `${run.label} · ${p.key}`,
          x: p.x,
          y: p.y,
          color: p.limit ? (single ? '#888' : runColor(ri)) : single ? COLORS[ki % COLORS.length] : runColor(ri),
          dash: p.limit ? [4, 4] : single ? [] : DASHES[ki % DASHES.length],
          width: p.limit ? 1 : 1.5,
        });
      });
    });
    return out;
  }

  // A constant dashed line across a run, for a limit such as the pool size or the memory limit.
  function limitLine(run, key, value) {
    if (value === null || value === undefined) return null;
    const end = run.ts ? run.ts.s1.length : run.promSeries ? run.promSeries.end - t0(run) : null;
    if (end === null) return null;
    return { key, x: [0, end], y: [value, value], limit: true };
  }

  // A k6 line: from the CSV if there is one, else from Prometheus.
  const k6 = (run, key, tsPick, promName, promKey = 'all') => {
    const l = tsLine(run, tsPick) || promLine(run, promName, promKey);
    return l ? { key, ...l } : null;
  };

  // The time chart definitions. Each returns its title, unit, and the lines per run.
  function timeCharts() {
    const actions = [...new Set(RUNS.flatMap((r) => Object.keys(get(r, 'ts.s1.by_action') || get(r, 'promSeries.series.k6_p95_ms_by_action.values') || {})))].sort();
    if (!state.action || !actions.includes(state.action)) state.action = actions.includes('feed') ? 'feed' : actions[0];
    const resNote = RUNS.some((r) => r.ts) ? `k6 lines use ${state.res === 's1' ? '1 s' : '10 s'} buckets from the k6 CSV. Runs without a CSV use 5 s Prometheus points.` : 'k6 lines use 5 s Prometheus points.';
    return [
      { group: 'k6', title: 'Load: offered, done, dropped, HTTP', unit: 'per second', hint: 'Offered = done + dropped iterations. Dropped above 0 means k6 ran out of VUs because the app was slow.',
        lines: linesFor((r) => [
          k6(r, 'offered it/s', (t) => t.offered, 'k6_offered_rps'),
          k6(r, 'done it/s', (t) => t.iterations, 'k6_iterations_rps'),
          k6(r, 'dropped it/s', (t) => t.dropped, 'k6_dropped_rps'),
          k6(r, 'http req/s', (t) => t.http, 'k6_http_rps'),
        ]) },
      { group: 'k6', title: 'Latency p50 / p95 / p99', unit: 'ms', hint: `${resNote} The dashed line is the 500 ms p95 limit.`, yMin: 0,
        lines: linesFor((r) => [
          k6(r, 'p50', (t) => t.p50, 'k6_p50_ms_worst'),
          k6(r, 'p95', (t) => t.p95, 'k6_p95_ms_worst'),
          k6(r, 'p99', (t) => t.p99, 'k6_p99_ms_worst'),
          limitLine(r, 'p95 limit', P95_LIMIT),
        ]) },
      RUNS.length === 1
        ? { group: 'k6', title: 'p95 by action', unit: 'ms', hint: 'The page that gets slow first is usually the bottleneck query.', yMin: 0,
            lines: linesFor((r) => actions.map((a) => k6(r, a, (t) => t.by_action[a] && t.by_action[a].p95, 'k6_p95_ms_by_action', a))) }
        : { group: 'k6', title: `p95 of action "${state.action}"`, unit: 'ms', hint: 'Pick the action above the charts.', yMin: 0,
            lines: linesFor((r) => [k6(r, state.action, (t) => t.by_action[state.action] && t.by_action[state.action].p95, 'k6_p95_ms_by_action', state.action)]) },
      { group: 'k6', title: 'Failed requests', unit: 'share', hint: 'Timeouts and unexpected status codes, as a share of all requests.', yMin: 0,
        lines: linesFor((r) => {
          const l = tsLine(r, (t) => t.failed.map((f, i) => (t.http[i] ? f / t.http[i] : null)));
          return [l ? { key: 'failed', ...l } : k6(r, 'failed', () => null, 'k6_failed_rate')];
        }) },
      { group: 'k6', title: 'Busy VUs', unit: 'VUs', hint: 'A flat line at MAX_VUS means k6 is out of VUs and drops iterations.', yMin: 0,
        lines: linesFor((r) => [k6(r, 'vus', (t) => t.vus, 'k6_vus')]) },
      { group: 'sys', title: 'CPU use', unit: 'cores', hint: 'App and db share the cpuset. The dashed line is the number of cores in it. App + db cannot go above it.', yMin: 0,
        lines: linesFor((r) => [...promKeys(r, 'cpu_cores').map((k) => { const l = promLine(r, 'cpu_cores', k); return l && { key: k, ...l }; }), limitLine(r, 'cores', limits(r).cores)]) },
      { group: 'sys', title: 'CPU pressure', unit: 'share of time waiting', hint: 'Above 0 while CPU is at the limit means the containers wait for a core.', yMin: 0,
        lines: linesFor((r) => promKeys(r, 'cpu_pressure').map((k) => { const l = promLine(r, 'cpu_pressure', k); return l && { key: k, ...l }; })) },
      { group: 'sys', title: 'Memory working set', unit: 'MiB', hint: 'Dashed lines are the container limits. The kernel kills a container that goes over.', yMin: 0,
        lines: linesFor((r) => [...promKeys(r, 'memory_working_set_mib').map((k) => { const l = promLine(r, 'memory_working_set_mib', k); return l && { key: k, ...l }; }), limitLine(r, 'app limit', limits(r).appMem), limitLine(r, 'db limit', limits(r).dbMem)]) },
      { group: 'pg', title: 'Postgres connections by state', unit: 'connections', hint: 'The dashed line is DB_POOL_MAX. Active at the pool size means requests wait for a free connection.', yMin: 0,
        lines: linesFor((r) => [...promKeys(r, 'pg_connections').filter((k) => ['active', 'idle', 'idle in transaction'].includes(k)).map((k) => { const l = promLine(r, 'pg_connections', k); return l && { key: k, ...l }; }), limitLine(r, 'pool max', limits(r).pool)]) },
      { group: 'pg', title: 'Busy backends', unit: 'backends', hint: 'Average number of Postgres backends that run a query. Compare with the core count.', yMin: 0,
        lines: linesFor((r) => [promLine(r, 'pg_busy_backends', 'all') && { key: 'busy', ...promLine(r, 'pg_busy_backends', 'all') }]) },
      { group: 'pg', title: 'Locks by mode', unit: 'locks', hint: 'Row locks (rowexclusivelock) rise with votes and likes on hot posts.', yMin: 0,
        lines: linesFor((r) => promKeys(r, 'pg_locks').filter((k) => (maxOf(promLine(r, 'pg_locks', k).y) || 0) > 0).map((k) => { const l = promLine(r, 'pg_locks', k); return l && { key: k, ...l }; })) },
      { group: 'pg', title: 'Transactions', unit: 'per second', yMin: 0,
        lines: linesFor((r) => [['commits', 'pg_commits_per_s'], ['rollbacks', 'pg_rollbacks_per_s']].map(([k, n]) => { const l = promLine(r, n, 'all'); return l && { key: k, ...l }; })) },
      { group: 'pg', title: 'Longest open transaction', unit: 'seconds', hint: 'A long transaction holds locks and blocks writers.', yMin: 0,
        lines: linesFor((r) => [promLine(r, 'pg_max_tx_seconds', 'all') && { key: 'max tx', ...promLine(r, 'pg_max_tx_seconds', 'all') }]) },
      { group: 'pg', title: 'Cache hit ratio', unit: 'ratio', hint: 'Below 0.99 means reads go to disk. A larger DB_MEM raises shared_buffers.',
        lines: linesFor((r) => [promLine(r, 'pg_cache_hit_ratio', 'all') && { key: 'hit ratio', ...promLine(r, 'pg_cache_hit_ratio', 'all') }]) },
      { group: 'pg', title: 'Temp file writes', unit: 'bytes/s', hint: 'Sorts and hashes that did not fit in work_mem.', yMin: 0,
        lines: linesFor((r) => [promLine(r, 'pg_temp_bytes_per_s', 'all') && { key: 'temp', ...promLine(r, 'pg_temp_bytes_per_s', 'all') }]) },
    ].concat([{ actions }]);
  }

  // Scatter charts with the offered rate on x. They compare runs with different STEPS or durations.
  function rateCharts() {
    // uPlot needs unique, sorted x values per line. Average the y of buckets with the same rounded rate.
    const points = (run, yKey) => {
      const m = new Map();
      for (const b of buckets10(run)) {
        if (b[yKey] === null || b[yKey] === undefined) continue;
        const x = Math.round(b.offered * 10) / 10;
        const e = m.get(x) || { s: 0, n: 0 };
        e.s += b[yKey]; e.n += 1; m.set(x, e);
      }
      const xs = [...m.keys()].sort((a, b) => a - b);
      return { x: xs, y: xs.map((x) => m.get(x).s / m.get(x).n) };
    };
    const scatterLines = (yKey) => RUNS.map((r, i) => ({ label: r.label, color: runColor(i), ...points(r, yKey) }));
    return [
      { title: 'p95 against offered rate', unit: 'ms', hint: 'One point per 10 s bucket. The rate where the points leave the bottom is the knee of the run.', lines: scatterLines('p95'), yMin: 0 },
      { title: 'Done HTTP requests against offered rate', unit: 'req/s', hint: 'The line bends flat where the app stops keeping up.', lines: scatterLines('http'), yMin: 0 },
      { title: 'db CPU against offered rate', unit: 'cores', hint: 'A flat top at the core count means the database is CPU bound.', lines: scatterLines('dbCpu'), yMin: 0 },
      { title: 'app CPU against offered rate', unit: 'cores', hint: 'Node runs JavaScript on one core. A flat top near 1.0 means the event loop is the limit.', lines: scatterLines('appCpu'), yMin: 0 },
    ];
  }

  // ---------- tables ----------

  // Run list: what was run, when, on which commit, and the result.
  function runsTable() {
    const rows = RUNS.map((r, i) => {
      const m = r.meta || {};
      const exit = m.k6_exit_code;
      const result = exit === 0 ? '<span class="pass">pass</span>' : exit === 99 ? '<span class="fail">thresholds failed</span>' : exit === undefined || exit === null ? '-' : `<span class="fail">exit ${exit}</span>`;
      const env = Object.entries(m.k6_env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
      const dur = m.started_utc && m.ended_utc ? Math.round((Date.parse(m.ended_utc) - Date.parse(m.started_utc)) / 1000) : get(r, 'prom.window.seconds');
      return `<tr><td><span class="swatch" style="background:${runColor(i)}"></span>${esc(r.label)}${r.id === state.baseline ? ' <span class="note">(baseline)</span>' : ''}</td>
        <td class="mono text">${esc(r.id)}</td><td>${esc(m.script || r.id.split('-')[0])}</td><td class="mono text">${esc(env || '-')}</td>
        <td>${esc(m.batch || '-')}</td><td class="mono">${esc(short(get(m, 'git.commit')))}${get(m, 'git.dirty') ? ' <span class="note">dirty</span>' : ''}</td>
        <td>${esc((m.started_utc || get(r, 'prom.window.start_utc') || '-').replace('T', ' ').slice(0, 19))}</td><td>${fmt(dur)} s</td><td>${result}</td>
        <td>${r.ts ? 'CSV' : ''}${r.ts && r.promSeries ? ' + ' : ''}${r.promSeries ? 'Prom' : ''}${!r.ts && !r.promSeries ? 'summary only' : ''}</td></tr>`;
    });
    return `<div class="table-wrap"><table><tr><th>Run</th><th class="text">Test id</th><th>Script</th><th class="text">k6 env</th><th>Batch</th><th>Commit</th><th>Started (UTC)</th><th>Length</th><th>Result</th><th>Data</th></tr>${rows.join('')}</table></div>`;
  }

  // Configuration table: the app and db settings of each run. Cells that differ between runs are highlighted.
  function configTable() {
    const cols = [
      ['DB_POOL_MAX', (r) => get(r, 'meta.sut.app.db_pool_max')],
      ['cpuset', (r) => limits(r).cpuset],
      ['cores', (r) => limits(r).cores],
      ['app mem MiB', (r) => get(r, 'meta.sut.app.memory_mib')],
      ['app heap MB', (r) => get(r, 'meta.sut.app.heap_mb')],
      ['db mem MiB', (r) => get(r, 'meta.sut.db.memory_mib')],
      ['shared_buffers', (r) => get(r, 'meta.sut.db.shared_buffers')],
      ['effective_cache_size', (r) => get(r, 'meta.sut.db.effective_cache_size')],
      ['max_connections', (r) => get(r, 'meta.sut.db.max_connections')],
      // OOM kills and restarts are read again after the run. A change means that a container died during the run.
      ['OOM killed', (r) => { const a = get(r, 'meta.sut_after'); return a ? (get(a, 'app.oom_killed') || get(a, 'db.oom_killed') ? 'yes' : 'no') : undefined; }],
      ['restarts in run', (r) => { const b = get(r, 'meta.sut'); const a = get(r, 'meta.sut_after'); return b && a ? (get(a, 'app.restart_count') - get(b, 'app.restart_count')) + (get(a, 'db.restart_count') - get(b, 'db.restart_count')) : undefined; }],
    ];
    const values = cols.map(([, f]) => RUNS.map((r) => f(r)));
    const differs = values.map((vs) => new Set(vs.map((v) => String(v ?? '-'))).size > 1);
    const head = cols.map(([n]) => `<th>${esc(n)}</th>`).join('');
    const rows = RUNS.map((r, i) => `<tr><td><span class="swatch" style="background:${runColor(i)}"></span>${esc(r.label)}</td>${values.map((vs, c) => {
      const v = vs[i];
      const bad = (cols[c][0] === 'OOM killed' && v === 'yes') || (cols[c][0] === 'restarts in run' && v > 0);
      return `<td class="${differs[c] ? 'diff' : ''}${bad ? ' fail' : ''}">${esc(v ?? '-')}</td>`;
    }).join('')}</tr>`);
    const note = RUNS.some((r) => !get(r, 'meta.sut')) ? '<p class="note">"-" means the run has no recorded configuration (older or migrated run). The cpuset then comes from prom.json.</p>' : '';
    return `<div class="table-wrap"><table><tr><th>Run</th>${head}</tr>${rows.join('')}</table></div>${note}`;
  }

  // The summary rows. dir: +1 when higher is better, -1 when lower is better, 0 for no color.
  function summaryRows() {
    const actions = [...new Set(RUNS.flatMap((r) => Object.keys(get(r, 'ts.total.by_action') || {})))].sort();
    const rows = [
      ['Max sustained rate', 'it/s', 1, 1, (r) => maxSustained(r), 'Highest 10 s offered rate with p95 ≤ 500 ms, no drops, and < 1% errors.'],
      ['Knee offered rate', 'it/s', 1, 1, (r) => get(r, 'prom.knee.offered_rps.avg'), 'From prom.json: the first 30 s bucket where p95 stays over 500 ms.'],
      ['Knee time', 's', 0, 0, (r) => get(r, 'prom.knee.from_s')],
      ['Peak HTTP rate (10 s)', 'req/s', 1, 1, (r) => maxOf(buckets10(r).map((b) => b.http))],
      ['HTTP requests', '', 0, 0, (r) => summaryMetric(r, 'http_reqs', 'count')],
      ['Dropped iterations', '', -1, 0, (r) => summaryMetric(r, 'dropped_iterations', 'count') ?? 0],
      ['Failed requests', '%', -1, 3, (r) => { const v = summaryMetric(r, 'http_req_failed', 'value'); return v === undefined ? undefined : v * 100; }],
      ['p50 (whole run)', 'ms', -1, 1, (r) => summaryMetric(r, 'http_req_duration', 'p(50)')],
      ['p95 (whole run)', 'ms', -1, 1, (r) => summaryMetric(r, 'http_req_duration', 'p(95)')],
      ['p99 (whole run)', 'ms', -1, 1, (r) => summaryMetric(r, 'http_req_duration', 'p(99)')],
      ...actions.map((a) => [`p95 ${a}`, 'ms', -1, 1, (r) => get(r, `ts.total.by_action.${a}.p95.0`), a === actions[0] ? 'Per action, whole run, from the k6 CSV.' : '']),
      ['app CPU peak', 'cores', -1, 2, (r) => get(r, 'prom.overall.cpu_cores.values.app.max')],
      ['db CPU peak', 'cores', -1, 2, (r) => get(r, 'prom.overall.cpu_cores.values.db.max')],
      ['app memory peak', 'MiB', -1, 0, (r) => get(r, 'prom.overall.memory_working_set_mib.values.app.max')],
      ['db memory peak', 'MiB', -1, 0, (r) => get(r, 'prom.overall.memory_working_set_mib.values.db.max')],
      ['pg active connections peak', '', 0, 0, (r) => get(r, 'prom.overall.pg_connections.values.active.max')],
      ['pg cache hit ratio (avg)', '', 1, 4, (r) => get(r, 'prom.overall.pg_cache_hit_ratio.values.all.avg')],
      ['db CPU seconds / 1k requests', 's', -1, 2, (r) => { const s = get(r, 'prom.totals.db_cpu_seconds'); const n = get(r, 'prom.totals.k6_http_reqs'); return s && n ? (s / n) * 1000 : undefined; }, 'Database cost per request. Lower means cheaper queries.'],
      ['app CPU seconds / 1k requests', 's', -1, 2, (r) => { const s = get(r, 'prom.totals.app_cpu_seconds'); const n = get(r, 'prom.totals.k6_http_reqs'); return s && n ? (s / n) * 1000 : undefined; }],
      ['Deadlocks', '', -1, 0, (r) => get(r, 'prom.totals.pg_deadlocks')],
    ];
    return rows;
  }

  // Summary table: one column per run, with the change against the baseline run.
  function summaryTable() {
    const base = RUNS.find((r) => r.id === state.baseline) || RUNS[0];
    const head = RUNS.map((r, i) => `<th><span class="swatch" style="background:${runColor(i)}"></span>${esc(r.label)}</th>`).join('');
    const body = summaryRows().map(([name, unit, dir, d, f, help]) => {
      const bv = f(base);
      const cells = RUNS.map((r) => {
        const v = f(r);
        let delta = '';
        // Show the change in percent for every run except the baseline.
        if (r !== base && Number.isFinite(v) && Number.isFinite(bv) && bv !== 0) {
          const pct = ((v - bv) / Math.abs(bv)) * 100;
          const cls = dir === 0 || Math.abs(pct) < 1 ? '' : pct * dir > 0 ? 'better' : 'worse';
          delta = `<span class="delta ${cls}">${pct > 0 ? '+' : ''}${fmt(pct, 0)}%</span>`;
        }
        return `<td>${fmt(v, d)}${delta}</td>`;
      }).join('');
      return `<tr><td class="text" title="${esc(help || '')}">${esc(name)}${unit ? ` <span class="note">${esc(unit)}</span>` : ''}</td>${cells}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table><tr><th>Metric</th>${head}</tr>${body}</table></div>
      <p class="note">Deltas are against the baseline. Green is better, red is worse. Hover a metric name for its definition.</p>`;
  }

  // Bars that compare the capacity of each run, for batches of configurations.
  function capacityBars() {
    const items = RUNS.map((r, i) => ({ label: r.label, color: runColor(i), v: maxSustained(r) }));
    const top = maxOf(items.map((x) => x.v)) || 1;
    const p95 = RUNS.map((r, i) => ({ label: r.label, color: runColor(i), v: summaryMetric(r, 'http_req_duration', 'p(95)') }));
    const p95top = maxOf(p95.map((x) => x.v)) || 1;
    const bars = (list, max, unit, d) => `<div class="bars">${list.map((x) => `<div>${esc(x.label)}</div><div><div class="bar" style="width:${Number.isFinite(x.v) ? Math.max(1, (x.v / max) * 100) : 0}%;background:${x.color}"></div></div><div>${fmt(x.v, d)} ${unit}</div>`).join('')}</div>`;
    return `<h3>Max sustained rate</h3>${bars(items, top, 'it/s', 1)}<h3>p95 over the whole run</h3>${bars(p95, p95top, 'ms', 0)}`;
  }

  // The slowest queries of each run, from prom.json.
  function queriesSection() {
    return RUNS.map((r, i) => {
      const q = get(r, 'prom.top_queries') || [];
      if (!q.length) return '';
      const rows = q.map((x) => `<tr><td>${fmt(x.total_seconds, 1)}</td><td>${fmt(x.share * 100, 1)}%</td><td>${fmt(x.calls)}</td><td>${fmt(x.mean_ms, 2)}</td><td>${fmt(x.rows_per_call, 1)}</td><td class="query mono">${esc(x.query || x.queryid)}</td></tr>`).join('');
      return `<details ${RUNS.length === 1 ? 'open' : ''}><summary><span class="swatch" style="background:${runColor(i)}"></span>${esc(r.label)}: top ${q.length} queries by total time</summary>
        <div class="table-wrap"><table><tr><th>total s</th><th>share</th><th>calls</th><th>mean ms</th><th>rows/call</th><th class="text">query</th></tr>${rows}</table></div></details>`;
    }).join('');
  }

  // The k6 checks of each run: failures out of the total.
  function checksTable() {
    const names = [...new Set(RUNS.flatMap((r) => Object.keys(get(r, 'summary.root_group.checks') || {})))];
    if (!names.length) return '<p class="note">No k6 summary in the selected runs.</p>';
    const head = RUNS.map((r, i) => `<th><span class="swatch" style="background:${runColor(i)}"></span>${esc(r.label)}</th>`).join('');
    const rows = names.map((n) => `<tr><td class="text">${esc(n)}</td>${RUNS.map((r) => {
      const c = get(r, 'summary.root_group.checks') && r.summary.root_group.checks[n];
      if (!c) return '<td>-</td>';
      return `<td class="${c.fails ? 'fail' : ''}">${fmt(c.fails)} / ${fmt(c.passes + c.fails)}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><tr><th>Check (failed / total)</th>${head}</tr>${rows}</table></div>`;
  }

  // ---------- page ----------

  function render() {
    // Remove the old charts, so their resize handlers and canvases go away.
    plots.forEach((p) => p.destroy());
    plots = [];
    const charts = timeCharts();
    const { actions } = charts.pop();
    const app = document.getElementById('app');
    const multi = RUNS.length > 1;
    const title = multi ? (DATA.batch ? `Batch ${DATA.batch}` : `Compare ${RUNS.length} runs`) : RUNS[0].label;
    app.innerHTML = `
      <h1>Load test report: ${esc(title)}</h1>
      <p class="sub">Generated ${esc(DATA.generated_utc.replace('T', ' ').slice(0, 19))} UTC by scripts/loadtest/report.ts</p>
      <nav><a href="#runs">Runs</a><a href="#config">Configuration</a><a href="#summary">Summary</a>${multi ? '<a href="#capacity">Capacity</a>' : ''}<a href="#time">Over time</a><a href="#rate">Against rate</a><a href="#queries">Queries</a><a href="#checks">Checks</a></nav>
      <div class="controls">
        ${multi ? `<label>Baseline <select id="baseline">${RUNS.map((r) => `<option value="${esc(r.id)}" ${r.id === state.baseline ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>` : ''}
        ${RUNS.some((r) => r.ts) ? `<label>k6 resolution <select id="res"><option value="s1" ${state.res === 's1' ? 'selected' : ''}>1 s</option><option value="s10" ${state.res === 's10' ? 'selected' : ''}>10 s</option></select></label>` : ''}
        ${multi && actions.length ? `<label>Action <select id="action">${actions.map((a) => `<option ${a === state.action ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>` : ''}
      </div>
      <h2 id="runs">Runs</h2>${runsTable()}
      <h2 id="config">Configuration</h2>${configTable()}
      <h2 id="summary">Summary</h2>${summaryTable()}
      ${multi ? `<h2 id="capacity">Capacity by run</h2>${capacityBars()}` : ''}
      <h2 id="time">Over time</h2><p class="note">x is seconds from the first k6 sample of each run, so runs with the same stages line up.</p>
      <h3>k6</h3><div class="grid" id="g-k6"></div>
      <h3>App and db containers</h3><div class="grid" id="g-sys"></div>
      <h3>Postgres</h3><div class="grid" id="g-pg"></div>
      <h2 id="rate">Against offered rate</h2><p class="note">These charts ignore time, so runs with different STEPS or durations compare directly.</p>
      <div class="grid" id="g-rate"></div>
      <h2 id="queries">Slowest queries</h2>${queriesSection() || '<p class="note">No query data.</p>'}
      <h2 id="checks">Checks</h2>${checksTable()}`;
    for (const c of charts) drawChart(document.getElementById('g-' + c.group), c);
    for (const c of rateCharts()) drawChart(document.getElementById('g-rate'), { ...c, xLabel: 'offered it/s', scatter: true });
    // Draw again when a control changes.
    const on = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = () => { state[key] = el.value; render(); }; };
    on('baseline', 'baseline');
    on('res', 'res');
    on('action', 'action');
  }

  // Resize the charts with the window. The timer waits until the user stops dragging.
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => plots.forEach((p) => p.setSize({ width: Math.max(300, p.root.parentElement.clientWidth - 16), height: 260 })), 150);
  });

  render();
})();
