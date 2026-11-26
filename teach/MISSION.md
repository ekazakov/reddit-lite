# Mission: Prometheus metrics for the reddit-lite load tests

## Why
You run load tests on reddit-lite and want to read the Grafana dashboards and `prom-summary.ts` output without guessing. The goal is to find the request rate at which the site stops keeping up, and to name the part that breaks first: the app, the database, or the connection pool.

## Success looks like
- You name the type, unit, labels, and signal of any metric in the stack from its name.
- You write correct PromQL for a counter, a gauge, and a k6 percentile.
- You read one load test run and say which resource saturated first, with the metrics as evidence.

## Constraints
- Lessons in Russian, as HTML files, with visuals and questions.
- Grounded in the metrics that this repo actually collects.

## Out of scope
- Running Prometheus in production, alerting rules, long-term storage.

Status: confirmed by the user on 2026-11-26.
