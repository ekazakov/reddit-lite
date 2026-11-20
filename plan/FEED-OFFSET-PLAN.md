# Future task: make deep feed pages cheap

Status: not started. This file records a problem and the possible fixes. Nothing is changed in the code yet.

## Problem

Deep pages of the feed use almost all of the db CPU under load. The feed query in `src/routes/posts.ts` (`GET /`) uses `LIMIT ... OFFSET ...`. The `Limit` node sits above the joins in the plan. To skip the `OFFSET` rows, Postgres builds each skipped row in full and then discards it. For each skipped row it reads the post with its body, finds the author in `users`, and looks up the vote in `post_votes`.

On deep pages the planner also starts two parallel workers (`Gather Merge`). On a container with two cores, the workers make the query slower and take cores from other queries. This raises CPU pressure (the share of time that a process waits for a free core).

In the load test, the `deep_feed` action in `loadtest/k6/lib.js` causes the load. It is 5% of the actions and asks for a random page from 6 to 2000.

## Evidence

Source: the `db-pool-vary` batches of 2026-11-19 (report `loadtest/results/reports/compare-20261119-222657.html`) and `EXPLAIN (ANALYZE, BUFFERS)` on the load test database after the batch. The database had 400,000 posts and was idle. Each time is the median of 3 runs after one warm-up run.

| Variant | Page 1 | Page 1000 | Page 2000 |
|---|---|---|---|
| Current query | 0.2 ms, 183 buffers | 59 ms, 162k buffers, 2 workers | 107 ms, 303k buffers, 2 workers |
| Current query, no parallel workers | | 36 ms, 143k buffers | 68 ms, 255k buffers |
| Deferred join | | 7 ms, 25k buffers, no workers | 18 ms, 50k buffers, no workers |
| Keyset | | | 0.2 ms, 193 buffers |

A buffer is one 8 KB page in Postgres memory. All buffers were `shared hit`, so the cost is CPU only. This agrees with the report: I/O pressure is 0, and CPU pressure for the db reaches 0.8 to 0.98 at 400 to 500 req/s.

Other facts from the same work:

- `pg_stat_statements` after a pool20 run: the `sort=new` feed had 36,556 calls with a mean of 63.3 ms (2312 s in total). The `sort=top` feed, which uses pages 1 to 5 only, had 30,052 calls with a mean of 1.9 ms (58 s in total). About 6,500 deep calls caused about 97% of the `sort=new` time.
- In the report, the `sort=new` feed query used about 92% of all db time in each of the three pool runs.
- The size of the postgres.js pool (5, 10, or 20) did not change the CPU pressure. A bigger pool only moves the queue from Node into Postgres. Pool 5 had a much higher p95 at 500 req/s (about 2.9 s, against 218 ms for pool 10 and 56 ms for pool 20).
- With pool 5, `pg_stat_activity` showed up to 12 active connections. The parallel workers are the likely cause.
- postgres.js sends the query as a prepared statement. A generic plan (a plan made without the parameter values) starts workers even for page 1 and takes 6.8 ms instead of 0.2 ms. The app most likely gets custom plans, because the `sort=top` mean under load is 1.9 ms. `pg_stat_statements` 1.12 has no plan type columns, so this is not proven.

## Possible fixes

### Option A. Deferred join

Apply `OFFSET` in a subquery on `posts` only, then join `users` and `post_votes` to the 26 rows that remain:

```sql
SELECT p.id, p.title, p.body, p.url, p.score, p.comment_count, p.created_at,
       u.name AS author, COALESCE(v.value, 0)::int AS my_vote
FROM (SELECT id, created_at FROM posts ORDER BY created_at DESC LIMIT $2 OFFSET $3) page
JOIN posts p ON p.id = page.id
JOIN users u ON u.id = p.user_id
LEFT JOIN post_votes v ON v.post_id = p.id AND v.user_id = $1
ORDER BY page.created_at DESC
```

- Effect: 6 to 8 times faster on deep pages, and no parallel workers.
- URLs, the pager, and the k6 `deep_feed` action stay the same, so a new matrix run compares directly with the old reports.
- Limit: the cost still grows with the page number. `posts_created_at_idx` does not contain `id`, so each skipped entry reads the table row.
- Apply the same change to the `sort=top` branch, so both sorts have one query shape.

### Option B. Keyset pagination

Replace the page number with a cursor: the `(created_at, id)` of the last post on the page. The next page uses `WHERE (p.created_at, p.id) < ($cursor_ts, $cursor_id) ORDER BY p.created_at DESC, p.id DESC LIMIT 26`.

- Effect: about 0.2 ms at any depth.
- Use `id` as a tie breaker. The database has no duplicate `created_at` values today, but two posts in the same microsecond are possible.
- Cost: the pager links change from `?page=N` to a cursor. A visitor cannot jump to page N. The k6 `deep_feed` action needs a new design, because it cannot ask for a random deep page.
- The `sort=top` order (`score DESC, created_at DESC`) needs a cursor of `(score, created_at, id)`. A score can change between two page loads, so the order is less stable than for `sort=new`.
- This is a product decision. Decide it before you start.

### Option C. A covering index (an add-on to option A)

A new migration with an index on `posts (created_at DESC, id)` lets the subquery of option A use an index-only scan. Then a skipped entry does not need a table read. An index-only scan needs a current visibility map, so autovacuum must keep up with the writes. This option is not measured yet.

### Option D. Fewer parallel workers (separate from the query fix)

Set `max_parallel_workers_per_gather` to 0 or 1 for the db container on two cores. Add it as a variant of the load test matrix and compare. Do this after option A or B, because the fixed query does not start workers.

## Suggested order

1. Do option A for both sorts. Run the `db-pool-vary` batch again and compare with `compare-20261119-222657.html`.
2. Decide on option B as a product change.
3. If the db CPU is still the limit, measure option C and option D.

## Verification

1. Run `EXPLAIN (ANALYZE, BUFFERS)` for pages 1, 1000, and 2000 on the load test database. Make sure that the plan has no `Gather Merge` and that the times agree with the table above.
2. Point `DATABASE_URL` at a throwaway database, then run `pnpm typecheck` and `pnpm test`. The tests reset the `public` schema, so do not run them against the load test database.
3. Run the `db-pool-vary` matrix and compare db CPU, CPU pressure, and p95 at the 400 and 500 req/s steps.
