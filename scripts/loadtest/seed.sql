-- Mock data for load tests. Run it with scripts/loadtest/seed.sh, which sets the
-- psql variables: users, posts, comments, votes, likes.
-- WARNING: this script deletes all rows in all app tables.
\set ON_ERROR_STOP on
\timing on

CREATE TEMP TABLE cfg AS
SELECT :users::int AS users, :posts::int AS posts, :comments::int AS comments,
       :votes::int AS votes, :likes::int AS likes;

-- Skip foreign key triggers during the bulk load. The generator only creates valid ids.
SET session_replication_role = replica;

TRUNCATE comment_likes, post_votes, comments, posts, users RESTART IDENTITY CASCADE;

-- Secondary indexes are created again at the end. A bulk insert without them is faster.
DROP INDEX IF EXISTS posts_created_at_idx, posts_score_idx, posts_user_idx,
                      comments_post_idx, comments_user_idx;

\echo 'users'
INSERT INTO users (name, created_at)
SELECT 'bot_' || lpad(g::text, 6, '0'), now() - interval '400 days' + random() * interval '30 days'
FROM generate_series(1, (SELECT users FROM cfg)) AS g;

\echo 'posts'
-- 30% are link posts with an empty body. random()^2 puts more posts in recent weeks.
INSERT INTO posts (user_id, title, body, url, created_at)
SELECT 1 + floor(random() * cfg.users)::int,
       'Post ' || g || ': ' || substr(md5(g::text), 1, 8 + (g % 40)),
       CASE WHEN g % 10 < 3 THEN ''
            ELSE repeat(md5(random()::text) || ' ', 1 + floor(random() * 30)::int) END,
       CASE WHEN g % 10 < 3 THEN 'https://example.com/article/' || g END,
       now() - random() ^ 2 * interval '365 days'
FROM cfg, generate_series(1, cfg.posts) AS g;

\echo 'comments'
-- Level 0 picks a post with random()^2, so low post ids get many comments (hot posts).
-- Levels 1 to 7 pick random parents from the level before and copy the parent post_id.
-- Each insert runs in one session, so the ids of one level are one contiguous range.
DO $$
DECLARE
  total int := (SELECT comments FROM cfg);
  n_users int := (SELECT users FROM cfg);
  n_posts int := (SELECT posts FROM cfg);
  shares numeric[] := ARRAY[0.40, 0.25, 0.15, 0.10, 0.05, 0.03, 0.015, 0.005];
  cnt int;
  lo int;
  hi int;
  added int;
BEGIN
  FOR lvl IN 0..7 LOOP
    cnt := greatest(1, round(total * shares[lvl + 1]))::int;
    IF lvl = 0 THEN
      INSERT INTO comments (post_id, parent_id, user_id, body, created_at)
      SELECT p.id, NULL, 1 + floor(random() * n_users)::int,
             'Comment ' || md5(random()::text) || repeat(' lorem ipsum', floor(random() * 20)::int),
             least(now(), p.created_at + random() * interval '3 days')
      -- The random id is computed once per row in the subquery. OFFSET 0 stops the
      -- planner from moving random() into the join condition.
      FROM (SELECT 1 + floor(n_posts * random() ^ 2)::int AS pid
            FROM generate_series(1, cnt) OFFSET 0) AS g
      JOIN posts p ON p.id = g.pid;
    ELSE
      INSERT INTO comments (post_id, parent_id, user_id, body, created_at)
      SELECT c.post_id, c.id, 1 + floor(random() * n_users)::int,
             'Reply ' || md5(random()::text) || repeat(' dolor sit', floor(random() * 10)::int),
             least(now(), c.created_at + random() * interval '1 day')
      FROM (SELECT lo + floor(random() * (hi - lo + 1))::int AS cid
            FROM generate_series(1, cnt) OFFSET 0) AS g
      JOIN comments c ON c.id = g.cid;
    END IF;
    GET DIAGNOSTICS added = ROW_COUNT;
    hi := currval('comments_id_seq');
    lo := hi - added + 1;
    RAISE NOTICE 'level %: % comments, ids % to %', lvl, added, lo, hi;
  END LOOP;
END $$;

\echo 'post votes'
-- Collisions are skipped, so the real count is a little lower than the target.
INSERT INTO post_votes (user_id, post_id, value)
SELECT 1 + floor(random() * cfg.users)::int,
       1 + floor(cfg.posts * random() ^ 2)::int,
       CASE WHEN random() < 0.7 THEN 1 ELSE -1 END
FROM cfg, generate_series(1, cfg.votes)
ON CONFLICT DO NOTHING;

\echo 'comment likes'
INSERT INTO comment_likes (user_id, comment_id)
SELECT 1 + floor(random() * cfg.users)::int,
       1 + floor(random() * (SELECT max(id) FROM comments))::int
FROM cfg, generate_series(1, cfg.likes)
ON CONFLICT DO NOTHING;

SET session_replication_role = origin;

\echo 'counters'
UPDATE posts p SET score = s.total
FROM (SELECT post_id, sum(value)::int AS total FROM post_votes GROUP BY post_id) s
WHERE p.id = s.post_id;

UPDATE posts p SET comment_count = s.total
FROM (SELECT post_id, count(*)::int AS total FROM comments GROUP BY post_id) s
WHERE p.id = s.post_id;

UPDATE comments c SET like_count = s.total
FROM (SELECT comment_id, count(*)::int AS total FROM comment_likes GROUP BY comment_id) s
WHERE c.id = s.comment_id;

\echo 'indexes'
-- Same definitions as migrations/001_init.sql.
CREATE INDEX posts_created_at_idx ON posts (created_at DESC);
CREATE INDEX posts_score_idx ON posts (score DESC, created_at DESC);
CREATE INDEX posts_user_idx ON posts (user_id);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);
CREATE INDEX comments_user_idx ON comments (user_id);

SELECT (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM posts) AS posts,
       (SELECT count(*) FROM comments) AS comments,
       (SELECT count(*) FROM post_votes) AS post_votes,
       (SELECT count(*) FROM comment_likes) AS comment_likes;
