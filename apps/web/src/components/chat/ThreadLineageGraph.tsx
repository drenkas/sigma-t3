import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  walkThreadRelationships,
  type ThreadRelationshipGraph,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { ThreadId } from "@t3tools/contracts";

import { ExecutionGraph } from "../graph/ExecutionGraph";

const TREE_KINDS: ReadonlySet<string> = new Set(["fork", "subagent"]);
const SUBTITLES = {
  current: "This thread",
  parent: "Parent",
  fork: "Fork",
  subagent: "Subagent",
  transfer: "Context transfer",
};

/** The whole lineage of one thread on the same canvas as task graphs; a node opens its thread. */
export function ThreadLineageGraph({
  graph,
  threadId,
  onOpenThread,
}: {
  graph: ThreadRelationshipGraph;
  threadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const rows = walkThreadRelationships(graph, threadId);
  const ids = new Set<ThreadId>([threadId, ...rows.map((row) => row.threadId)]);
  const nodes = [...ids].map((id) => {
    const thread = graph.nodes.get(id)?.thread ?? null;
    const row = rows.find((entry) => entry.threadId === id);
    const isSubagent = thread?.lineage.relationshipToParent === "subagent";
    const relationship: keyof typeof SUBTITLES =
      id === threadId
        ? "current"
        : row && row.edge.targetThreadId === row.fromThreadId && row.edge.kind !== "transfer"
          ? "parent"
          : (row?.edge.kind ?? "fork");
    return {
      id,
      role: thread ? relationship : "unavailable",
      title: thread ? (isSubagent ? formatSubagentDisplayTitle(thread.title) : thread.title) : id,
      subtitle: id === threadId || thread ? SUBTITLES[relationship] : "Unavailable",
      status: thread ? (thread.activityRunStatus ?? thread.status) : "unavailable",
      pendingApproval:
        thread?.pendingRuntimeRequest != null && thread.pendingRuntimeRequest.kind !== "user_input",
    };
  });
  const edges = graph.edges
    .filter((edge) => ids.has(edge.sourceThreadId) && ids.has(edge.targetThreadId))
    .map((edge) => ({
      id: `${edge.kind}:${edge.sourceThreadId}:${edge.targetThreadId}`,
      source: edge.sourceThreadId,
      target: edge.targetThreadId,
      kind: edge.kind === "transfer" ? "context_transfer" : edge.kind,
      status: edge.status ?? "",
    }));

  return (
    <ExecutionGraph
      label="Lineage graph"
      nodes={nodes}
      edges={edges}
      treeKinds={TREE_KINDS}
      selectedId={threadId}
      onSelect={(id) => {
        if (id !== threadId && graph.nodes.get(id as ThreadId)?.missing === false)
          onOpenThread(id as ThreadId);
      }}
    />
  );
}
