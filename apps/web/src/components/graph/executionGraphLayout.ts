export type ExecutionGraphNode = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  // Picks the node's colour, so the same role reads the same everywhere.
  readonly role: string;
  readonly status: string;
  readonly pendingApproval: boolean;
};
export type ExecutionGraphEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly status: string;
};

export const NODE_W = 248;
export const NODE_H = 64;
const PAD = 12;
const INDENT = 28;
const GAP = 12;
const LANE = 14;

export const RUNNING_STATUSES = new Set(["running", "starting", "preparing", "queued"]);
export const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "rolled_back"]);

/**
 * An indented tree that fits a narrow panel: tree edges run down a trunk on the left, every
 * other link (results, transfers, merges) takes its own lane to the right of the cards.
 */
export function layoutExecutionGraph(
  nodes: ReadonlyArray<ExecutionGraphNode>,
  edges: ReadonlyArray<ExecutionGraphEdge>,
  treeKinds: ReadonlySet<string>,
) {
  const ids = new Set(nodes.map((node) => node.id));
  const parent = new Map<string, string>();
  for (const edge of edges)
    if (
      treeKinds.has(edge.kind) &&
      ids.has(edge.source) &&
      ids.has(edge.target) &&
      edge.source !== edge.target &&
      !parent.has(edge.target)
    )
      parent.set(edge.target, edge.source);
  const children = new Map<string, Array<string>>();
  for (const node of nodes) {
    const parentId = parent.get(node.id);
    if (parentId !== undefined)
      children.set(parentId, [...(children.get(parentId) ?? []), node.id]);
  }
  const order: Array<{ id: string; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push({ id, depth });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) if (!parent.has(node.id)) visit(node.id, 0);
  // Nodes only reachable through a cycle still get a row.
  for (const node of nodes) visit(node.id, 0);

  const positions = new Map(
    order.map((item, index) => [
      item.id,
      { x: PAD + item.depth * INDENT, y: PAD + index * (NODE_H + GAP) },
    ]),
  );
  const right = PAD + Math.max(0, ...order.map((item) => item.depth)) * INDENT + NODE_W;
  const drawn: Array<{ edge: ExecutionGraphEdge; tree: boolean; path: string }> = [];
  let lanes = 0;
  for (const edge of edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b || edge.source === edge.target) continue;
    if (treeKinds.has(edge.kind) && parent.get(edge.target) === edge.source) {
      const x = a.x + 16;
      const y = b.y + NODE_H / 2;
      drawn.push({
        edge,
        tree: true,
        path: `M${x} ${a.y + NODE_H} V${y - 10} Q${x} ${y} ${x + 10} ${y} H${b.x}`,
      });
      continue;
    }
    const lane = right + PAD + lanes++ * LANE;
    const sy = a.y + NODE_H / 2 + 8;
    const ty = b.y + NODE_H / 2 - 8;
    const r = Math.min(12, Math.abs(sy - ty) / 2);
    const dir = ty < sy ? -1 : 1;
    drawn.push({
      edge,
      tree: false,
      path: `M${a.x + NODE_W} ${sy} H${lane - r} Q${lane} ${sy} ${lane} ${sy + dir * r} V${ty - dir * r} Q${lane} ${ty} ${lane - r} ${ty} H${b.x + NODE_W + 3}`,
    });
  }
  return {
    order,
    positions,
    edges: drawn,
    width: right + PAD + Math.max(1, lanes) * LANE + 8,
    height: PAD * 2 + order.length * (NODE_H + GAP),
  };
}
