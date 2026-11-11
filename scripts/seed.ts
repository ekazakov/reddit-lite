import { sql } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

await migrate();

const names = ['alice', 'bob', 'carol'];
const ids: number[] = [];
for (const name of names) {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name) VALUES (${name})
    ON CONFLICT (name) DO UPDATE SET name = users.name RETURNING id`;
  ids.push(rows[0]!.id);
}

const existing = await sql`SELECT 1 FROM posts LIMIT 1`;
if (existing.length === 0) {
  const post = await sql<{ id: number }[]>`
    INSERT INTO posts (user_id, title, body) VALUES (${ids[0]!}, 'Welcome to reddit-lite', 'Say hi in the comments.')
    RETURNING id`;
  await sql`INSERT INTO posts (user_id, title, url) VALUES (${ids[1]!}, 'Hono docs', 'https://hono.dev')`;
  const postId = post[0]!.id;
  let parent: number | null = null;
  let count = 0;
  for (const [i, body] of ['Hi!', 'Hello back.', 'Threads work.', 'Deeper still.'].entries()) {
    const row: { id: number }[] = await sql`
      INSERT INTO comments (post_id, parent_id, user_id, body)
      VALUES (${postId}, ${parent}, ${ids[i % 3]!}, ${body}) RETURNING id`;
    parent = row[0]!.id;
    count++;
  }
  await sql`UPDATE posts SET comment_count = ${count} WHERE id = ${postId}`;
}
console.log('seeded');
await sql.end();
