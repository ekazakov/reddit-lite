// Shared code for the k6 scripts: data, login, and the weighted bot actions.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// hono/csrf rejects a form POST unless Origin equals the site origin.
const POST_HEADERS = {
  Origin: BASE_URL,
  'Content-Type': 'application/x-www-form-urlencoded',
};

// Options that every script must use.
export const baseOptions = {
  // Keep the session cookie across iterations. By default k6 clears it each iteration.
  noCookiesReset: true,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

function csvColumn(path) {
  return open(path).trim().split('\n').slice(1);
}

const bots = new SharedArray('bots', () => csvColumn('../data/bots.csv'));
const hotPosts = new SharedArray('hot posts', () => csvColumn('../data/posts_hot.csv'));
const coldPosts = new SharedArray('cold posts', () => csvColumn('../data/posts_cold.csv'));
const commentIds = new SharedArray('comments', () => csvColumn('../data/comments.csv'));
const meta = JSON.parse(open('../data/meta.json'));
const maxPage = Math.max(1, Math.min(2000, Math.floor(meta.posts / meta.pageSize)));

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Each VU is one bot. 30% of the bots stay anonymous and only read.
let loggedIn = false;
export function isAnonymous() {
  return exec.vu.idInTest % 10 < 3;
}
function botName() {
  return bots[(exec.vu.idInTest - 1) % bots.length];
}

// The `name` tag groups URLs such as /p/1 and /p/2 into one metric series.
function get(path, action, name) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { action, name } });
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
    [`${action} status 302`]: (r) => r.status === 302,
    [`${action} not 403 (Origin)`]: (r) => r.status !== 403,
  });
  return res;
}

export function login() {
  if (loggedIn || isAnonymous()) return;
  const res = post('/login', { name: botName(), next: '/' }, 'login', 'POST /login');
  loggedIn = res.status === 302;
}

export const actions = {
  feed: () => get(`/?sort=${Math.random() < 0.5 ? 'new' : 'top'}&page=${randInt(1, 5)}`, 'feed', 'GET /'),
  deep_feed: () => get(`/?sort=new&page=${randInt(6, maxPage)}`, 'deep_feed', 'GET /?page=deep'),
  cold_post: () => get(`/p/${pick(coldPosts)}`, 'cold_post', 'GET /p/:id'),
  hot_post: () => get(`/p/${pick(hotPosts)}`, 'hot_post', 'GET /p/:id (hot)'),
  user_page: () => get(`/u/${pick(bots)}`, 'user_page', 'GET /u/:name'),
  thread: () => get(`/c/${pick(commentIds)}`, 'thread', 'GET /c/:id'),
  vote: () => post(`/p/${pick(Math.random() < 0.3 ? hotPosts : coldPosts)}/vote`,
    { value: Math.random() < 0.7 ? '1' : '-1' }, 'vote', 'POST /p/:id/vote'),
  like: () => post(`/c/${pick(commentIds)}/like`, {}, 'like', 'POST /c/:id/like'),
  comment: () => post(`/p/${pick(Math.random() < 0.3 ? hotPosts : coldPosts)}/comments`,
    { body: `k6 comment ${Date.now()} from ${botName()}` }, 'comment', 'POST /p/:id/comments'),
  submit: () => post('/submit',
    { title: `k6 post ${Date.now()}`, body: 'Created by the load test.', url: '' }, 'submit', 'POST /submit'),
};

const WRITES = new Set(['vote', 'like', 'comment', 'submit']);

// The traffic mix from the plan: about 90% reads and 10% writes.
const MIX = [
  ['feed', 40], ['deep_feed', 5], ['cold_post', 25], ['hot_post', 10],
  ['user_page', 5], ['thread', 5],
  ['vote', 4], ['like', 3], ['comment', 2.5], ['submit', 0.5],
];
const MIX_TOTAL = MIX.reduce((sum, [, weight]) => sum + weight, 0);

function pickAction() {
  let r = Math.random() * MIX_TOTAL;
  for (const [name, weight] of MIX) {
    r -= weight;
    if (r < 0) return name;
  }
  return 'feed';
}

// One bot action. Anonymous bots read the feed in place of a write.
export function botIteration() {
  login();
  let name = pickAction();
  if (WRITES.has(name) && !loggedIn) name = 'feed';
  actions[name]();
}

// Thresholds for the main tests. abortOnFail is false, so the test runs past the failure point.
export const thresholds = {
  http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: false }],
  http_req_duration: ['p(95)<500', 'p(99)<1500'],
  'http_req_duration{action:hot_post}': ['p(95)<1000'],
  checks: ['rate>0.99'],
};
