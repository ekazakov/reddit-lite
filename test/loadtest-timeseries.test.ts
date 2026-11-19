// Unit tests for the k6 CSV bucketing in scripts/loadtest/k6-timeseries.ts. They need no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Aggregator, parseCsvLine, percentile } from '../scripts/loadtest/k6-timeseries.ts';

// The header that k6 1.x writes for --out csv.
const HEADER = 'metric_name,timestamp,metric_value,check,error,error_code,expected_response,group,method,name,proto,scenario,service,status,subproto,tls_version,url,extra_tags,metadata';

// Builds one CSV row with the fields the aggregator reads.
const row = (metric: string, t: number, v: number, extra = '') => `${metric},${t},${v},,,,,,,,,,,,,,,${extra},`;

test('percentile uses the nearest rank', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 50), 5);
  assert.equal(percentile(xs, 95), 10);
  assert.equal(percentile(xs, 0), 1);
  assert.equal(percentile([], 95), null);
});

test('parseCsvLine handles quoted commas and quotes', () => {
  assert.deepEqual(parseCsvLine('a,"b,c","say ""hi""",'), ['a', 'b,c', 'say "hi"', '']);
});

test('Aggregator builds per-second rates, percentiles, and per-action columns', () => {
  const agg = new Aggregator();
  agg.header(HEADER);
  // Second 100: two requests, one failed, one finished and one dropped iteration.
  agg.add(row('http_reqs', 100, 1));
  agg.add(row('http_reqs', 100, 1));
  agg.add(row('http_req_duration', 100, 10, 'action=feed&testid=x'));
  agg.add(row('http_req_duration', 100, 30, 'action=vote&testid=x'));
  agg.add(row('http_req_failed', 100, 0));
  agg.add(row('http_req_failed', 100, 1));
  agg.add(row('iterations', 100, 1));
  agg.add(row('dropped_iterations', 100, 1));
  agg.add(row('vus', 100, 3));
  agg.add(row('vus', 100, 5));
  // Second 102: one request. Second 101 has no data and must be a zero row.
  agg.add(row('http_reqs', 102, 1));
  agg.add(row('http_req_duration', 102, 7, 'action=feed'));
  // A metric the aggregator ignores, and a broken line.
  agg.add(row('data_received', 100, 500));
  agg.add('http_reqs,notanumber');

  const ts = agg.finish('x');
  assert.equal(ts.start, 100);
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.http, [2, 0, 1]);
  assert.deepEqual(ts.failed, [1, 0, 0]);
  assert.deepEqual(ts.offered, [2, 0, 0]);
  assert.deepEqual(ts.dropped, [1, 0, 0]);
  assert.deepEqual(ts.vus, [5, null, null]);
  assert.deepEqual(ts.p50, [10, null, 7]);
  assert.deepEqual(ts.max, [30, null, 7]);
  assert.deepEqual(Object.keys(ts.by_action), ['feed', 'vote']);
  assert.equal(ts.step, 1);
  assert.deepEqual(ts.by_action.feed.count, [1, 0, 1]);
  assert.deepEqual(ts.by_action.vote.p95, [30, null, null]);
});

test('Aggregator merges seconds into exact bucket percentiles and per-second rates', () => {
  const agg = new Aggregator();
  agg.header(HEADER);
  // Seconds 0-9: one request per second with durations 1..10 ms. Second 10: one request of 100 ms.
  for (let t = 0; t < 10; t++) {
    agg.add(row('http_reqs', t, 1));
    agg.add(row('http_req_duration', t, t + 1, 'action=feed'));
  }
  agg.add(row('http_reqs', 10, 1));
  agg.add(row('http_req_duration', 10, 100, 'action=feed'));

  const ts = agg.finish('x', 10);
  assert.equal(ts.length, 2);
  // 10 requests in 10 s, then 1 request in a 1 s partial bucket: both are 1 per second.
  assert.deepEqual(ts.http, [1, 1]);
  // The p50 of 1..10 is 5, and the p95 is 10 (from all ten values, not an average of seconds).
  assert.deepEqual(ts.p50, [5, 100]);
  assert.deepEqual(ts.p95, [10, 100]);
  assert.deepEqual(ts.by_action.feed.count, [1, 1]);
});
