CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id serial PRIMARY KEY,
  name citext NOT NULL UNIQUE CHECK (name ~ '^[a-zA-Z0-9_-]{3,20}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
  url text,
  score integer NOT NULL DEFAULT 0,
  comment_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_created_at_idx ON posts (created_at DESC);
CREATE INDEX posts_score_idx ON posts (score DESC, created_at DESC);
CREATE INDEX posts_user_idx ON posts (user_id);

CREATE TABLE post_votes (
  user_id integer NOT NULL REFERENCES users(id),
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE comments (
  id serial PRIMARY KEY,
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id integer REFERENCES comments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  like_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);
CREATE INDEX comments_user_idx ON comments (user_id);

CREATE TABLE comment_likes (
  user_id integer NOT NULL REFERENCES users(id),
  comment_id integer NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, comment_id)
);
