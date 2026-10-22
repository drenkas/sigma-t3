import { describe, expect, it } from "vite-plus/test";

import { layoutExecutionGraph, type ExecutionGraphEdge } from "./executionGraphLayout";

const node = (id: string) => ({
  id,
  title: id,
  subtitle: "",
  role: "agent",
  status: "idle",
  pendingApproval: false,
});
const edge = (source: string, target: string, kind: string): ExecutionGraphEdge => ({
  id: `${kind}:${source}:${target}`,
  source,
  target,
  kind,
  status: "completed",
});
const TREE = new Set(["membership", "delegation"]);

describe("layoutExecutionGraph", () => {
  it("indents nested agents under their parent and keeps siblings in order", () => {
    const layout = layoutExecutionGraph(
      ["coordinator", "repo-a", "repo-b", "agent", "nested"].map(node),
      [
        edge("coordinator", "repo-a", "membership"),
        edge("coordinator", "repo-b", "membership"),
        edge("repo-a", "agent", "delegation"),
        edge("agent", "nested", "delegation"),
        edge("repo-a", "coordinator", "result"),
      ],
      TREE,
    );

    expect(layout.order).toEqual([
      { id: "coordinator", depth: 0 },
      { id: "repo-a", depth: 1 },
      { id: "agent", depth: 2 },
      { id: "nested", depth: 3 },
      { id: "repo-b", depth: 1 },
    ]);
    expect(layout.edges.filter((entry) => !entry.tree).map((entry) => entry.edge.kind)).toEqual([
      "result",
    ]);
  });

  it("gives every node a row even when delegation links form a cycle", () => {
    const layout = layoutExecutionGraph(
      ["a", "b"].map(node),
      [edge("a", "b", "delegation"), edge("b", "a", "delegation")],
      TREE,
    );

    expect(layout.order.map((item) => item.id).toSorted()).toEqual(["a", "b"]);
    expect(layout.edges).toHaveLength(2);
  });
});
