# Prometheus metrics Resources

## Knowledge

- [Prometheus: Metric types](https://prometheus.io/docs/concepts/metric_types/)
  The four types and what each one means. Use for: counter versus gauge questions.
- [Prometheus: Query functions, rate()](https://prometheus.io/docs/prometheus/latest/querying/functions/#rate)
  rate(), increase(), and counter resets. Use for: any PromQL on counters.
- [Prometheus: Histograms and summaries](https://prometheus.io/docs/practices/histograms/)
  Why precomputed quantiles do not aggregate. Use for: k6 percentiles, future native histograms.
- [Grafana k6: Prometheus remote write](https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/)
  How k6 names and types its metrics, K6_PROMETHEUS_RW_TREND_STATS. Use for: every k6_* metric.
- [PostgreSQL: The cumulative statistics system](https://www.postgresql.org/docs/current/monitoring-stats.html)
  pg_stat_database, pg_stat_activity, pg_locks columns. Use for: every pg_* metric.
- [Linux kernel: PSI](https://docs.kernel.org/accounting/psi.html)
  "some" and "full" pressure. Use for: container_pressure_* metrics.
- [Google SRE book, chapter 6](https://sre.google/sre-book/monitoring-distributed-systems/)
  The four golden signals. Use for: sorting metrics by what question they answer.
- Repo: `loadtest/HOW-IT-WORKS.md`, `scripts/loadtest/prom-summary.ts`
  The comments explain why each query exists. Use for: tying lessons to this stack.

## Wisdom (Communities)

- [Prometheus community](https://prometheus.io/community/)
  Official mailing lists and chat. Use for: PromQL and exporter questions.
- [Grafana community forum, k6 category](https://community.grafana.com/c/grafana-k6/70)
  Use for: k6 output and load test design questions.

## Gaps

- A clear source for the exact unit of `pg_stat_database_active_time_seconds_total` in postgres-exporter v0.21 (the script divides by 1000).
