import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type {
  ThreadRelationshipEdge,
  ThreadRelationshipGraph,
  ThreadRelationshipNode,
} from "@t3tools/client-runtime/state/thread-relationships";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import { render } from "../../../test/render";
import { ThreadLineageGraph } from "./ThreadLineageGraph";

const shell = (
  id: string,
  relationshipToParent: string | null,
  status = "completed",
  role?: string,
) =>
  ({
    id,
    title: id,
    status,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: `${id}-model` },
    lineage: { relationshipToParent, role },
  }) as unknown as OrchestrationV2ThreadShell;
const edge = (
  source: string,
  target: string,
  kind: ThreadRelationshipEdge["kind"],
): ThreadRelationshipEdge => ({
  sourceThreadId: source as ThreadId,
  targetThreadId: target as ThreadId,
  kind,
  status: "completed",
});

// The current thread is a fork; its parent also has a missing fork, and the current thread
// started a subagent that started another one, plus a finished subagent whose thread isn't loaded.
const threads = [
  shell("root", null),
  shell("current", "fork"),
  shell("helper", "subagent", "running", "reviewer"),
  shell("nested", "subagent"),
];
const graph: ThreadRelationshipGraph = {
  nodes: new Map<ThreadId, ThreadRelationshipNode>([
    ...threads.map(
      (thread) => [thread.id, { threadId: thread.id, thread, missing: false }] as const,
    ),
    ["gone" as ThreadId, { threadId: "gone" as ThreadId, thread: null, missing: true }],
    ["done" as ThreadId, { threadId: "done" as ThreadId, thread: null, missing: true }],
  ]),
  edges: [
    edge("root", "current", "fork"),
    edge("root", "gone", "fork"),
    edge("current", "helper", "subagent"),
    edge("current", "done", "subagent"),
    edge("helper", "nested", "subagent"),
    edge("helper", "root", "transfer"),
  ],
};

// Subagents without a local thread: one running natively, one delegated to a linked environment,
// and one that finished in a thread this client hasn't loaded.
const subagents = [
  {
    id: "node:native",
    threadId: "current",
    childThreadId: null,
    title: "Native helper",
    model: "claude-haiku-5-5",
    providerInstanceId: "claudeAgent",
    status: "running",
  },
  {
    id: "node:remote",
    threadId: "current",
    childThreadId: null,
    title: "Remote helper",
    model: null,
    providerInstanceId: "codex",
    status: "pending",
    remoteChild: { environmentId: "env:laptop", threadId: "thread:remote", label: "laptop" },
  },
  // A follow-up task reuses the child thread; the latest one names it.
  {
    id: "node:done-first",
    threadId: "current",
    childThreadId: "done",
    title: "First pass",
    model: "claude-sonnet-5-5",
    providerInstanceId: "claudeAgent",
    status: "completed",
  },
  {
    id: "node:done",
    threadId: "current",
    childThreadId: "done",
    title: "Finished helper",
    model: "claude-sonnet-5-5",
    providerInstanceId: "claudeAgent",
    status: "completed",
  },
] as unknown as ReadonlyArray<OrchestrationV2Subagent>;

describe("ThreadLineageGraph", () => {
  it("draws subagents that have no thread here and opens each where it lives", async () => {
    const opened: Array<string> = [];
    const remote: Array<string> = [];
    await using screen = await render(
      <ThreadLineageGraph
        graph={graph}
        threadId={"current" as ThreadId}
        subagents={subagents}
        onOpenThread={(threadId) => opened.push(threadId)}
        onOpenRemote={(child) => remote.push(child.threadId)}
      />,
    );

    await expect.element(screen.getByText("3 running", { exact: false })).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", {
          name: /^Native helper\. Subagent\. Claude Haiku 5\.5\. running\./,
        }),
      )
      .toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: /^Remote helper\. Subagent on laptop\./ }),
    );
    expect(remote).toEqual(["thread:remote"]);

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Finished helper\. Subagent\. Claude Sonnet 5\.5\. completed\./,
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^gone\. Unavailable\./ }));
    expect(opened).toEqual(["done"]);
  });

  it("draws the whole lineage as a tree and opens only available threads", async () => {
    const opened: Array<string> = [];
    await using screen = await render(
      <ThreadLineageGraph
        graph={graph}
        threadId={"current" as ThreadId}
        onOpenThread={(threadId) => opened.push(threadId)}
      />,
    );

    await expect.element(screen.getByText("1 running", { exact: false })).toBeVisible();
    expect(
      [...screen.container.querySelectorAll("[data-node]")].map((element) =>
        element.getAttribute("data-node"),
      ),
    ).toEqual(["root", "current", "helper", "nested", "done", "gone"]);
    await expect.element(screen.getByRole("button", { name: /^root\. Parent\./ })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /^current\. This thread\./ }))
      .toHaveAttribute("aria-pressed", "true");

    await expect
      .element(screen.getByRole("button", { name: /^helper\. Reviewer\./ }))
      .toBeVisible();
    await expect.element(screen.getByText("reviewer", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("· helper-model", { exact: true })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /^gone\./ }));
    await userEvent.click(screen.getByRole("button", { name: /^current\./ }));
    await userEvent.click(screen.getByRole("button", { name: /^nested\. Subagent\./ }));
    expect(opened).toEqual(["nested"]);
    await expect.element(screen.getByText("context transfer", { exact: true })).toBeVisible();
  });

  it("names an open subagent thread the shell left out from its own projection", async () => {
    await using screen = await render(
      <ThreadLineageGraph
        graph={graph}
        threadId={"done" as ThreadId}
        currentThread={{ ...shell("done", "subagent"), title: "Finished helper" }}
        onOpenThread={() => {}}
      />,
    );

    await expect
      .element(
        screen.getByRole("button", {
          name: /^Finished helper\. This thread\. done-model\. idle\./,
        }),
      )
      .toHaveAttribute("aria-pressed", "true");
  });
});
