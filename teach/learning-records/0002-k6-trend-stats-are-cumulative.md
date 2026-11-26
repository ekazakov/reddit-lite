# k6 trend stats in Prometheus cover the whole run

Lesson 1 said that k6 computes p95 over each 5 second push window. That was wrong. The k6 remote write output keeps one TrendSink per series and never resets it. So p95, p99, and max cover all requests since the test started. Live data confirms it: no `k6_http_req_duration_max` series decreased in the smoke run.

Implications: this is a teaching anchor for lesson 5 and for the mission. A cumulative p95 lags the breaking point in a ramp test. The comments in `scripts/loadtest/prom-summary.ts` and `scripts/loadtest/k6-timeseries.ts` describe a 5 second window, which repeats the same mistake.

Evidence: k6 source `internal/output/prometheusrw/remotewrite/remotewrite.go` and `metrics/sink.go`. Data from `stairs-20261119-232753`: at 340 s the 20 s window p95 was 6300 ms and the cumulative p95 was 2957 ms.
