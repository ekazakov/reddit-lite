export type Treeable = { id: number; parent_id: number | null };
export type TreeNode<T extends Treeable> = T & { children: TreeNode<T>[] };

/** Builds a nested tree from a flat list. Input order is kept among siblings. */
export function buildTree<T extends Treeable>(rows: T[]): TreeNode<T>[] {
  const byId = new Map<number, TreeNode<T>>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });
  const roots: TreeNode<T>[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id === null ? undefined : byId.get(node.parent_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function findNode<T extends Treeable>(nodes: TreeNode<T>[], id: number): TreeNode<T> | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}
