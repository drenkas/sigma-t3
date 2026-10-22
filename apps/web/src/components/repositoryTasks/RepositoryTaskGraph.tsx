import type { EnvironmentId, ProjectId, RepositoryTask, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { ExecutionGraph } from "../graph/ExecutionGraph";
import { RUNNING_STATUSES } from "../graph/executionGraphLayout";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const TREE_KINDS: ReadonlySet<string> = new Set(["membership", "delegation"]);
const pretty = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
type GraphNode = RepositoryTask["graph"]["nodes"][number];

export function RepositoryTaskGraph({
  environmentId,
  task,
  projectById,
  canOperate,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  task: RepositoryTask;
  projectById: ReadonlyMap<ProjectId, { readonly title: string }>;
  canOperate: boolean;
  onOpenThread: (threadId: ThreadId, diff?: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const titleOf = (node: GraphNode) => {
    const member =
      node.kind === "repository"
        ? task.snapshot.members.find((entry) => entry.threadId === node.threadId)
        : undefined;
    return (member && projectById.get(member.projectId)?.title) || node.title || pretty(node.kind);
  };
  const nodes = task.graph.nodes.map((node) => ({
    id: node.id,
    title: titleOf(node),
    subtitle: [node.role ?? pretty(node.kind), node.modelSelection?.model]
      .filter(Boolean)
      .join(" · "),
    status: node.status,
    pendingApproval: node.pendingApproval,
  }));
  const byId = new Map(task.graph.nodes.map((node) => [node.id, node]));
  const selected = selectedId === null ? undefined : byId.get(selectedId);

  return (
    <section aria-label="Task graph" className="space-y-4">
      <h2 className="text-base font-semibold">Execution graph</h2>
      <ExecutionGraph
        label="Execution graph"
        nodes={nodes}
        edges={task.graph.edges}
        treeKinds={TREE_KINDS}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {selected ? (
        <NodeActions
          key={selected.id}
          environmentId={environmentId}
          task={task}
          node={selected}
          title={titleOf(selected)}
          canOperate={canOperate}
          onOpenThread={onOpenThread}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a node to open its session, message it, or stop it.
        </p>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recorded links</h3>
        {task.graph.edges.length ? (
          <ul className="space-y-1 text-sm">
            {task.graph.edges.map((edge) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              return (
                <li key={edge.id} className="rounded-md bg-muted/50 px-3 py-2">
                  <span>{source ? titleOf(source) : "Unavailable"}</span>
                  <span className="px-2 text-muted-foreground">→</span>
                  <span>{target ? titleOf(target) : "Unavailable"}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {pretty(edge.kind)} · {pretty(edge.status)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No execution links have been recorded yet.
          </p>
        )}
      </div>
    </section>
  );
}

/** Steer, follow up, message or stop one node, through the same thread commands as the chat. */
function NodeActions({
  environmentId,
  task,
  node,
  title,
  canOperate,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  task: RepositoryTask;
  node: GraphNode;
  title: string;
  canOperate: boolean;
  onOpenThread: (threadId: ThreadId, diff?: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const threadId = node.threadId;
  const active = RUNNING_STATUSES.has(node.status);
  const subtree = [node.id];
  for (let index = 0; index < subtree.length; index++)
    for (const edge of task.graph.edges)
      if (
        TREE_KINDS.has(edge.kind) &&
        edge.source === subtree[index] &&
        !subtree.includes(edge.target)
      )
        subtree.push(edge.target);
  const stoppable = subtree
    .map((id) => task.graph.nodes.find((entry) => entry.id === id))
    .filter((entry) => entry?.threadId != null && RUNNING_STATUSES.has(entry.status))
    .map((entry) => entry!.threadId!);

  async function run(action: () => Promise<{ readonly _tag: string }>) {
    setBusy(true);
    setError("");
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result as never);
      setError(failure instanceof Error ? failure.message : "The command failed.");
      return false;
    }
    return true;
  }
  const send = async (dispatchMode: "steer" | "queue" | "auto") => {
    if (threadId === null || !text.trim()) return;
    const sent = await run(() =>
      startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: text.trim(), attachments: [] },
          runtimeMode: task.snapshot.runtimeMode,
          interactionMode: task.snapshot.interactionMode,
          dispatchMode,
        },
      }),
    );
    if (sent) setText("");
  };
  const stop = () =>
    run(async () => {
      for (const target of stoppable) {
        const result = await interruptTurn({ environmentId, input: { threadId: target } });
        if (result._tag === "Failure") return result;
      }
      return { _tag: "Success" };
    });

  return (
    <article aria-label={`Selected node: ${title}`} className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            {pretty(node.kind)}
            {node.origin ? ` · ${pretty(node.origin)}` : ""}
            {node.role ? ` · ${node.role}` : ""}
            {node.modelSelection ? ` · ${node.modelSelection.model}` : ""}
            {` · ${pretty(node.status)}`}
          </p>
        </div>
      </div>
      {threadId !== null ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => onOpenThread(threadId)}>
              Open session
            </Button>
            {node.kind === "repository" ? (
              <Button size="xs" variant="ghost" onClick={() => onOpenThread(threadId, true)}>
                Open diff
              </Button>
            ) : null}
            {canOperate && stoppable.length ? (
              <Button size="xs" variant="destructive-outline" disabled={busy} onClick={stop}>
                {subtree.length > 1 ? "Stop with descendants" : "Stop"}
              </Button>
            ) : null}
          </div>
          {canOperate ? (
            <>
              <Textarea
                aria-label={`Message ${title}`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  active
                    ? "Steer this turn or queue a follow-up"
                    : "Send a new message to this node"
                }
                rows={2}
              />
              <div className="flex flex-wrap gap-2">
                {active ? (
                  <>
                    <Button
                      size="xs"
                      disabled={busy || !text.trim()}
                      onClick={() => void send("steer")}
                    >
                      Steer
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || !text.trim()}
                      onClick={() => void send("queue")}
                    >
                      Follow up
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    disabled={busy || !text.trim()}
                    onClick={() => void send("auto")}
                  >
                    Send
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This agent runs inside its provider and has no session of its own.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </article>
  );
}
