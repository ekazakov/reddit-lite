import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVote } from '../src/lib/vote.ts';
import { buildTree, findNode } from '../src/lib/tree.ts';
import { safeNext } from '../src/lib/util.ts';

test('nextVote: first vote, repeat removes, opposite flips', () => {
  assert.deepEqual(nextVote(0, 1), { next: 1, delta: 1 });
  assert.deepEqual(nextVote(1, 1), { next: 0, delta: -1 });
  assert.deepEqual(nextVote(1, -1), { next: -1, delta: -2 });
  assert.deepEqual(nextVote(-1, -1), { next: 0, delta: 1 });
  assert.deepEqual(nextVote(-1, 1), { next: 1, delta: 2 });
});

test('buildTree nests three levels and keeps sibling order', () => {
  const rows = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
    { id: 3, parent_id: 2 },
    { id: 4, parent_id: 1 },
    { id: 5, parent_id: null },
  ];
  const tree = buildTree(rows);
  assert.deepEqual(tree.map((n) => n.id), [1, 5]);
  assert.deepEqual(tree[0]!.children.map((n) => n.id), [2, 4]);
  assert.equal(tree[0]!.children[0]!.children[0]!.id, 3);
  assert.equal(findNode(tree, 3)?.parent_id, 2);
  assert.equal(findNode(tree, 99), null);
});

test('safeNext blocks open redirects', () => {
  assert.equal(safeNext('/p/1'), '/p/1');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
  assert.equal(safeNext(undefined, '/x'), '/x');
});
