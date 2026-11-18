// Shared code for the k6 scripts: data, login, and the weighted bot actions.
// k6 HTTP client. It records timing metrics for every request.
import http from 'k6/http';
// Pass/fail assertions. Their rate feeds the "checks" threshold.
import { check } from 'k6';
// A read-only array that all VUs (virtual users) share, so the data uses memory once, not once per VU.
import { SharedArray } from 'k6/data';
// Test state: the VU number and the iteration counter.
import exec from 'k6/execution';

// The target address. The compose file sets BASE_URL for the k6 container.
// Remove a trailing slash, so the path joins below never make "//".
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// hono/csrf rejects a form POST unless Origin equals the site origin.
const POST_HEADERS = {
  // Send the site origin, or the app answers 403.
  Origin: BASE_URL,
  // The app reads HTML form posts, not JSON.
  'Content-Type': 'application/x-www-form-urlencoded',
};

// Options that every script must use.
export const baseOptions = {
  // Keep the session cookie across iterations. By default k6 clears it each iteration.
  noCookiesReset: true,
  // Do not keep response bodies. This saves memory and CPU in k6, and the tests only need status and timing.
  discardResponseBodies: true,
  // The statistics in the end summary. The percentiles show the slow tail that an average hides.
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// Read a CSV file and return its rows without the header line.
function csvColumn(path) {
  // open() works only in the init stage, so call this function at the top level only.
  return open(path).trim().split('\n').slice(1);
}

// Load the files that seed.sh exports. The callback runs once, and all VUs share the result.
const bots = new SharedArray('bots', () => csvColumn('../data/bots.csv'));
const hotPosts = new SharedArray('hot posts', () => csvColumn('../data/posts_hot.csv'));
const coldPosts = new SharedArray('cold posts', () => csvColumn('../data/posts_cold.csv'));
const commentIds = new SharedArray('comments', () => csvColumn('../data/comments.csv'));
// The tier, the post count, and the page size.
const meta = JSON.parse(open('../data/meta.json'));
// The last feed page to request, at most 2000. Deep pages are slow, so the cap keeps the test finite.
const maxPage = Math.max(1, Math.min(2000, Math.floor(meta.posts / meta.pageSize)));

// A random list item.
const pick = (list) => list[Math.floor(Math.random() * list.length)];
// A random whole number from min to max, both included.
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Each VU is one bot. 30% of the bots stay anonymous and only read.
let loggedIn = false;
export function isAnonymous() {
  // The VU number is stable, so a bot keeps the same role for the whole test.
  return exec.vu.idInTest % 10 < 3;
}
function botName() {
  // VU numbers start at 1, so subtract 1 for the array index. The modulo avoids a read past the end.
  return bots[(exec.vu.idInTest - 1) % bots.length];
}

// The `name` tag groups URLs such as /p/1 and /p/2 into one metric series.
// Without it, each URL makes its own series, and Prometheus gets too many.
function get(path, action, name) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { action, name } });
  // Count a response other than 200 as a failed check.
  check(res, { [`${action} status 200`]: (r) => r.status === 200 });
  return res;
}

function post(path, form, action, name) {
  // redirects: 0 measures the write alone, not the page that the redirect loads.
  const res = http.post(`${BASE_URL}${path}`, form, {
    headers: POST_HEADERS,
    redirects: 0,
    tags: { action, name },
  });
  check(res, {
    // A successful write answers with a redirect.
    [`${action} status 302`]: (r) => r.status === 302,
    // A separate check shows when the cause is the CSRF guard, not the app.
    [`${action} not 403 (Origin)`]: (r) => r.status !== 403,
  });
  return res;
}

export function login() {
  // Log in once per VU. Anonymous bots never log in.
  if (loggedIn || isAnonymous()) return;
  // The app creates the user or acts as the existing user, so no password is needed.
  const res = post('/login', { name: botName(), next: '/' }, 'login', 'POST /login');
  // Remember the result, so a failed login is tried again next iteration.
  loggedIn = res.status === 302;
}

// One function for each kind of request that a user makes.
export const actions = {
  // Pages 1 to 5 of the feed, sorted by new or top. Most readers stay on these pages.
  feed: () => get(`/?sort=${Math.random() < 0.5 ? 'new' : 'top'}&page=${randInt(1, 5)}`, 'feed', 'GET /'),
  // Deep pages cost more, because the database skips many rows first.
  deep_feed: () => get(`/?sort=new&page=${randInt(6, maxPage)}`, 'deep_feed', 'GET /?page=deep'),
  // A quiet post. The data is probably not in the database cache.
  cold_post: () => get(`/p/${pick(coldPosts)}`, 'cold_post', 'GET /p/:id'),
  // A popular post with many comments. It has the largest comment tree to build.
  hot_post: () => get(`/p/${pick(hotPosts)}`, 'hot_post', 'GET /p/:id (hot)'),
  // A user profile page.
  user_page: () => get(`/u/${pick(bots)}`, 'user_page', 'GET /u/:name'),
  // A single comment with its replies.
  thread: () => get(`/c/${pick(commentIds)}`, 'thread', 'GET /c/:id'),
  // Vote on a post. 30% of votes go to hot posts, which makes row lock contention. 70% of votes are up votes.
  vote: () => post(`/p/${pick(Math.random() < 0.3 ? hotPosts : coldPosts)}/vote`,
    { value: Math.random() < 0.7 ? '1' : '-1' }, 'vote', 'POST /p/:id/vote'),
  // Like a random comment.
  like: () => post(`/c/${pick(commentIds)}/like`, {}, 'like', 'POST /c/:id/like'),
  // Add a comment. The time stamp and the name keep each body unique.
  comment: () => post(`/p/${pick(Math.random() < 0.3 ? hotPosts : coldPosts)}/comments`,
    { body: `k6 comment ${Date.now()} from ${botName()}` }, 'comment', 'POST /p/:id/comments'),
  // Create a post. The "k6" prefix lets you find and delete the test posts later.
  submit: () => post('/submit',
    { title: `k6 post ${Date.now()}`, body: 'Created by the load test.', url: '' }, 'submit', 'POST /submit'),
};

// The actions that change data. Anonymous bots cannot do them.
const WRITES = new Set(['vote', 'like', 'comment', 'submit']);

// The traffic mix from the plan: about 90% reads and 10% writes.
// Each number is a weight, and the weights add up to 100.
const MIX = [
  ['feed', 40], ['deep_feed', 5], ['cold_post', 25], ['hot_post', 10],
  ['user_page', 5], ['thread', 5],
  ['vote', 4], ['like', 3], ['comment', 2.5], ['submit', 0.5],
];
// The sum of the weights. We compute it, so the mix works if the weights change.
const MIX_TOTAL = MIX.reduce((sum, [, weight]) => sum + weight, 0);

// Pick an action name with probability in proportion to its weight.
function pickAction() {
  // A random point on the line from 0 to the total weight.
  let r = Math.random() * MIX_TOTAL;
  // Walk the list and subtract each weight. The action where r goes below zero owns that point.
  for (const [name, weight] of MIX) {
    r -= weight;
    if (r < 0) return name;
  }
  // A fallback for rounding errors.
  return 'feed';
}

// One bot action. Anonymous bots read the feed in place of a write.
export function botIteration() {
  login();
  let name = pickAction();
  // A bot with no session cannot write, so it reads the feed. This keeps the request rate the same.
  if (WRITES.has(name) && !loggedIn) name = 'feed';
  actions[name]();
}

// Thresholds for the main tests. abortOnFail is false, so the test runs past the failure point.
export const thresholds = {
  // Fewer than 1% of requests may fail.
  http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: false }],
  // 95% of requests must finish in 500 ms, and 99% in 1.5 s.
  http_req_duration: ['p(95)<500', 'p(99)<1500'],
  // Hot posts are heavier, so they get a looser limit.
  'http_req_duration{action:hot_post}': ['p(95)<1000'],
  // More than 99% of the checks must pass.
  checks: ['rate>0.99'],
};
