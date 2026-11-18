-- Mock data for load tests. Run it with scripts/loadtest/seed.sh, which sets the
-- psql variables: users, posts, comments, votes, likes.
-- WARNING: this script deletes all rows in all app tables.
-- Stop at the first error, so a half-loaded database never looks complete.
\set ON_ERROR_STOP on
-- Print the run time of each statement, so you can see which step is slow.
\timing on

-- Keep the row counts in a temp table, so later queries can read them with a join or a subquery.
-- The ::int casts turn the psql text variables into numbers.
CREATE TEMP TABLE cfg AS
SELECT :users::int AS users, :posts::int AS posts, :comments::int AS comments,
       :votes::int AS votes, :likes::int AS likes;

-- Skip foreign key triggers during the bulk load. The generator only creates valid ids.
-- This is much faster, and it needs the superuser role, which the postgres user has.
SET session_replication_role = replica;

-- Remove old data. RESTART IDENTITY resets the id counters, so ids start at 1 again.
-- The generator below relies on ids 1..N. CASCADE also truncates the tables that refer to these.
TRUNCATE comment_likes, post_votes, comments, posts, users RESTART IDENTITY CASCADE;

-- Secondary indexes are created again at the end. A bulk insert without them is faster.
DROP INDEX IF EXISTS posts_created_at_idx, posts_score_idx, posts_user_idx,
                      comments_post_idx, comments_user_idx;

-- Print a progress label.
\echo 'users'
-- Make bot_000001, bot_000002, and so on. The names are the same on each run.
-- Spread the creation dates over 30 days, about 400 days ago.
INSERT INTO users (name, created_at)
SELECT 'bot_' || lpad(g::text, 6, '0'), now() - interval '400 days' + random() * interval '30 days'
FROM generate_series(1, (SELECT users FROM cfg)) AS g;

\echo 'posts'
-- 30% are link posts with an empty body. random()^2 puts more posts in recent weeks.
INSERT INTO posts (user_id, title, body, url, created_at)
-- A random author.
SELECT 1 + floor(random() * cfg.users)::int,
       -- A unique title with a variable length, so rows differ in size like real data.
       'Post ' || g || ': ' || substr(md5(g::text), 1, 8 + (g % 40)),
       -- Link posts have no body. Text posts get 1 to 30 random chunks.
       CASE WHEN g % 10 < 3 THEN ''
            ELSE repeat(md5(random()::text) || ' ', 1 + floor(random() * 30)::int) END,
       -- Link posts get a URL. Text posts get NULL.
       CASE WHEN g % 10 < 3 THEN 'https://example.com/article/' || g END,
       -- Squaring a random number in 0..1 moves values toward 0, so most posts are recent.
       now() - random() ^ 2 * interval '365 days'
FROM cfg, generate_series(1, cfg.posts) AS g;

\echo 'comments'
-- Level 0 picks a post with random()^2, so low post ids get many comments (hot posts).
-- Levels 1 to 7 pick random parents from the level before and copy the parent post_id.
-- Each insert runs in one session, so the ids of one level are one contiguous range.
-- A DO block lets us loop over the levels in plain SQL.
DO $$
DECLARE
  -- Read the counts from the temp table.
  total int := (SELECT comments FROM cfg);
  n_users int := (SELECT users FROM cfg);
  n_posts int := (SELECT posts FROM cfg);
  -- The share of all comments at each depth. Most comments are top level, and deep replies are rare, as on real sites.
  shares numeric[] := ARRAY[0.40, 0.25, 0.15, 0.10, 0.05, 0.03, 0.015, 0.005];
  -- Comments to create at this level.
  cnt int;
  -- The first and last comment id of the level before.
  lo int;
  hi int;
  -- Rows that the last insert created.
  added int;
BEGIN
  FOR lvl IN 0..7 LOOP
    -- The level share of the total. Always make at least 1 row. SQL arrays start at 1, so add 1 to the index.
    cnt := greatest(1, round(total * shares[lvl + 1]))::int;
    IF lvl = 0 THEN
      -- Top level comments: they belong to a post and have no parent.
      INSERT INTO comments (post_id, parent_id, user_id, body, created_at)
      SELECT p.id, NULL, 1 + floor(random() * n_users)::int,
             'Comment ' || md5(random()::text) || repeat(' lorem ipsum', floor(random() * 20)::int),
             -- Up to 3 days after the post, but never in the future.
             least(now(), p.created_at + random() * interval '3 days')
      -- The random id is computed once per row in the subquery. OFFSET 0 stops the
      -- planner from moving random() into the join condition.
      FROM (SELECT 1 + floor(n_posts * random() ^ 2)::int AS pid
            FROM generate_series(1, cnt) OFFSET 0) AS g
      JOIN posts p ON p.id = g.pid;
    ELSE
      -- Replies: pick a random parent from the level before, and use the same post.
      INSERT INTO comments (post_id, parent_id, user_id, body, created_at)
      SELECT c.post_id, c.id, 1 + floor(random() * n_users)::int,
             'Reply ' || md5(random()::text) || repeat(' dolor sit', floor(random() * 10)::int),
             -- Up to 1 day after the parent, but never in the future.
             least(now(), c.created_at + random() * interval '1 day')
      -- Pick a random id in the range of the previous level. OFFSET 0 has the same purpose as above.
      FROM (SELECT lo + floor(random() * (hi - lo + 1))::int AS cid
            FROM generate_series(1, cnt) OFFSET 0) AS g
      JOIN comments c ON c.id = g.cid;
    END IF;
    -- Read how many rows the insert made.
    GET DIAGNOSTICS added = ROW_COUNT;
    -- The last id that the sequence gave out is the end of this level.
    hi := currval('comments_id_seq');
    -- The level is a contiguous range, so the start is the end minus the count.
    lo := hi - added + 1;
    -- Show the level and its id range in the output.
    RAISE NOTICE 'level %: % comments, ids % to %', lvl, added, lo, hi;
  END LOOP;
END $$;

\echo 'post votes'
-- Collisions are skipped, so the real count is a little lower than the target.
INSERT INTO post_votes (user_id, post_id, value)
-- A random voter.
SELECT 1 + floor(random() * cfg.users)::int,
       -- The squared random number again: popular posts get more votes.
       1 + floor(cfg.posts * random() ^ 2)::int,
       -- 70% up votes and 30% down votes.
       CASE WHEN random() < 0.7 THEN 1 ELSE -1 END
FROM cfg, generate_series(1, cfg.votes)
-- A user can vote once for a post. Skip a repeat pair and do not fail.
ON CONFLICT DO NOTHING;

\echo 'comment likes'
INSERT INTO comment_likes (user_id, comment_id)
-- A random user likes a random comment.
SELECT 1 + floor(random() * cfg.users)::int,
       1 + floor(random() * (SELECT max(id) FROM comments))::int
FROM cfg, generate_series(1, cfg.likes)
-- Skip a repeat pair.
ON CONFLICT DO NOTHING;

-- Turn the foreign key triggers on again.
SET session_replication_role = origin;

-- The app keeps counters on the rows for fast reads. The bulk insert did not update them, so compute them now.
\echo 'counters'
-- The post score is the sum of its votes.
UPDATE posts p SET score = s.total
FROM (SELECT post_id, sum(value)::int AS total FROM post_votes GROUP BY post_id) s
WHERE p.id = s.post_id;

-- The post comment count.
UPDATE posts p SET comment_count = s.total
FROM (SELECT post_id, count(*)::int AS total FROM comments GROUP BY post_id) s
WHERE p.id = s.post_id;

-- The comment like count.
UPDATE comments c SET like_count = s.total
FROM (SELECT comment_id, count(*)::int AS total FROM comment_likes GROUP BY comment_id) s
WHERE c.id = s.comment_id;

\echo 'indexes'
-- Same definitions as migrations/001_init.sql.
-- The feed sorted by new.
CREATE INDEX posts_created_at_idx ON posts (created_at DESC);
-- The feed sorted by top. The date breaks ties.
CREATE INDEX posts_score_idx ON posts (score DESC, created_at DESC);
-- The posts of one user.
CREATE INDEX posts_user_idx ON posts (user_id);
-- The comments of one post, in time order.
CREATE INDEX comments_post_idx ON comments (post_id, created_at);
-- The comments of one user.
CREATE INDEX comments_user_idx ON comments (user_id);

-- Print the final row counts, as a check that the load worked.
SELECT (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM posts) AS posts,
       (SELECT count(*) FROM comments) AS comments,
       (SELECT count(*) FROM post_votes) AS post_votes,
       (SELECT count(*) FROM comment_likes) AS comment_likes;
