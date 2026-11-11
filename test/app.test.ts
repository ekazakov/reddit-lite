import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

// Needs a Postgres reachable through DATABASE_URL. The tests reset the public schema.
const { sql } = await import('../src/db.ts');
const { migrate } = await import('../src/migrate.ts');
const { app } = await import('../src/app.ts');

const ORIGIN = 'http://localhost';

before(async () => {
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await migrate();
});
after(async () => {
  await sql.end();
});

function post(path: string, form: Record<string, string>, cookie = '', extra: Record<string, string> = {}) {
  return app.request(ORIGIN + path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie, ...extra },
    body: new URLSearchParams(form),
  });
}

async function login(name: string): Promise<string> {
  const res = await post('/login', { name });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('CSRF: cross-origin form post is rejected', async () => {
  const res = await app.request(ORIGIN + '/login', {
    method: 'POST',
    headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'mallory' }),
  });
  assert.equal(res.status, 403);
});

test('write actions redirect to login without a cookie', async () => {
  const res = await post('/submit', { title: 'x' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^\/login/);
  const enhanced = await post('/submit', { title: 'x' }, '', { 'x-requested-with': 'fetch' });
  assert.equal(enhanced.status, 401);
});

test('rejects bad usernames', async () => {
  const res = await post('/login', { name: 'a b' });
  assert.equal(res.status, 400);
});

test('post, vote toggle, comment thread, like toggle', async () => {
  const cookie = await login('alice');
  const other = await login('bob');

  const created = await post('/submit', { title: 'Hello <b>world</b>', body: 'text' }, cookie);
  assert.equal(created.status, 302);
  const postId = Number(created.headers.get('location')!.split('/').pop());

  const page = await (await app.request(ORIGIN + `/p/${postId}`)).text();
  assert.ok(page.includes('Hello &lt;b&gt;world&lt;/b&gt;'), 'title is escaped');

  const vote = async (value: string, who = cookie) =>
    (await (await post(`/p/${postId}/vote`, { value }, who, { 'x-requested-with': 'fetch' })).json()) as { score: number; myVote: number };
  assert.deepEqual(await vote('1'), { score: 1, myVote: 1 });
  assert.deepEqual(await vote('1'), { score: 0, myVote: 0 });
  assert.deepEqual(await vote('1'), { score: 1, myVote: 1 });
  assert.deepEqual(await vote('-1'), { score: -1, myVote: -1 });
  assert.deepEqual(await vote('1', other), { score: 0, myVote: 1 });
  assert.equal((await post(`/p/${postId}/vote`, { value: '5' }, cookie)).status, 400);

  // Three levels of replies.
  const ids: number[] = [];
  let parent = '';
  for (const body of ['one', 'two', 'three']) {
    const form: Record<string, string> = { body };
    if (parent) form.parent_id = parent;
    const res = await post(`/p/${postId}/comments`, form, other, { 'x-requested-with': 'fetch' });
    assert.equal(res.status, 200);
    const fragment = await res.text();
    const id = fragment.match(/id="c-(\d+)"/)![1]!;
    ids.push(Number(id));
    parent = id;
  }
  const rows = await sql`SELECT id, parent_id FROM comments ORDER BY id`;
  assert.deepEqual(rows.map((r) => r.parent_id), [null, ids[0], ids[1]]);
  const [{ comment_count }] = await sql`SELECT comment_count FROM posts WHERE id = ${postId}`;
  assert.equal(comment_count, 3);

  const thread = await (await app.request(ORIGIN + `/p/${postId}`)).text();
  assert.ok(thread.indexOf(`id="c-${ids[0]}"`) < thread.indexOf(`id="c-${ids[2]}"`));
  assert.equal((await app.request(ORIGIN + `/c/${ids[1]}`)).status, 200);

  // A parent from another post is rejected.
  const second = await post('/submit', { title: 'Second' }, cookie);
  const secondId = second.headers.get('location')!.split('/').pop()!;
  const bad = await post(`/p/${secondId}/comments`, { body: 'x', parent_id: String(ids[0]) }, cookie);
  assert.equal(bad.status, 400);

  const like = async (who: string) =>
    (await (await post(`/c/${ids[0]}/like`, {}, who, { 'x-requested-with': 'fetch' })).json()) as { liked: boolean; likeCount: number };
  assert.deepEqual(await like(cookie), { liked: true, likeCount: 1 });
  assert.deepEqual(await like(other), { liked: true, likeCount: 2 });
  assert.deepEqual(await like(cookie), { liked: false, likeCount: 1 });
});

test('list, user page, 404', async () => {
  assert.equal((await app.request(ORIGIN + '/?sort=top')).status, 200);
  assert.equal((await app.request(ORIGIN + '/u/alice')).status, 200);
  assert.equal((await app.request(ORIGIN + '/u/nobody')).status, 404);
  assert.equal((await app.request(ORIGIN + '/p/999999')).status, 404);
});
