import {
  formatSubagentDisplayTitle,
  formatSubagentRoleLabel,
  resolveSubagentMetadata,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  walkThreadRelationships,
  type ThreadRelationshipGraph,
} from "@t3tools/client-runtime/state/thread-relationships";
import type {
  OrchestrationV2RemoteTaskChild,
  OrchestrationV2Subagent,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

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
  providers,
  subagents = [],
  onOpenThread,
  onOpenRemote,
}: {
  graph: ThreadRelationshipGraph;
  threadId: ThreadId;
  providers?: ReadonlyArray<ServerProvider> | undefined;
  /** The current thread's subagents; those without a local thread still get a node. */
  subagents?: ReadonlyArray<OrchestrationV2Subagent> | undefined;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenRemote?: ((child: OrchestrationV2RemoteTaskChild) => void) | undefined;
}) {
  const rows = walkThreadRelationships(graph, threadId);
  const ids = new Set<ThreadId>([threadId, ...rows.map((row) => row.threadId)]);
  const modelLabel = (model: string | null, providerInstanceId: string) =>
    resolveSubagentMetadata({
      model,
      provider: providers?.find((entry) => entry.instanceId === providerInstanceId),
    }).modelLabel;
  const threadless = subagents.filter(
    (agent) => agent.childThreadId === null && ids.has(agent.threadId),
  );
  const remoteById = new Map<string, OrchestrationV2RemoteTaskChild>(
    threadless.flatMap((agent) =>
      agent.remoteChild === undefined ? [] : [[agent.id, agent.remoteChild] as const],
    ),
  );
  const threadNodes = [...ids].map((id) => {
    const thread = graph.nodes.get(id)?.thread ?? null;
    const row = rows.find((entry) => entry.threadId === id);
    const isSubagent = thread?.lineage.relationshipToParent === "subagent";
    const relationship: keyof typeof SUBTITLES =
      id === threadId
        ? "current"
        : row && row.edge.targetThreadId === row.fromThreadId && row.edge.kind !== "transfer"
          ? "parent"
          : (row?.edge.kind ?? "fork");
    const subagentRole =
      isSubagent && relationship === "subagent" ? thread?.lineage.role : undefined;
    return {
      id,
      role: thread ? (subagentRole ?? relationship) : "unavailable",
      title: thread ? (isSubagent ? formatSubagentDisplayTitle(thread.title) : thread.title) : id,
      subtitle: subagentRole
        ? formatSubagentRoleLabel(subagentRole)
        : id === threadId || thread
          ? SUBTITLES[relationship]
          : "Unavailable",
      model: thread
        ? modelLabel(thread.modelSelection.model, thread.providerInstanceId)
        : undefined,
      status: thread ? (thread.activityRunStatus ?? thread.status) : "unavailable",
      pendingApproval:
        thread?.pendingRuntimeRequest != null && thread.pendingRuntimeRequest.kind !== "user_input",
    };
  });
  const subagentNodes = threadless.map((agent) => ({
    id: agent.id,
    role: "subagent",
    title: formatSubagentDisplayTitle(agent.title ?? "Subagent"),
    subtitle: agent.remoteChild ? `Subagent on ${agent.remoteChild.label}` : SUBTITLES.subagent,
    model: agent.model === null ? undefined : modelLabel(agent.model, agent.providerInstanceId),
    status: agent.status === "pending" ? "queued" : agent.status,
    pendingApproval: false,
  }));
  const nodes = [...threadNodes, ...subagentNodes];
  const edges = [
    ...graph.edges
      .filter((edge) => ids.has(edge.sourceThreadId) && ids.has(edge.targetThreadId))
      .map((edge) => ({
        id: `${edge.kind}:${edge.sourceThreadId}:${edge.targetThreadId}`,
        source: edge.sourceThreadId,
        target: edge.targetThreadId,
        kind: edge.kind === "transfer" ? "context_transfer" : edge.kind,
        status: edge.status ?? "",
      })),
    ...threadless.map((agent) => ({
      id: `subagent:${agent.threadId}:${agent.id}`,
      source: agent.threadId,
      target: agent.id,
      kind: "subagent",
      status: agent.status,
    })),
  ];

  return (
    <ExecutionGraph
      label="Lineage graph"
      nodes={nodes}
      edges={edges}
      treeKinds={TREE_KINDS}
      selectedId={threadId}
      onSelect={(id) => {
        const remote = remoteById.get(id);
        if (remote) onOpenRemote?.(remote);
        else if (id !== threadId && graph.nodes.get(id as ThreadId)?.missing === false)
          onOpenThread(id as ThreadId);
      }}
    />
  );
}
