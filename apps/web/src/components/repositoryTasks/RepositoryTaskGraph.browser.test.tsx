import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { EnvironmentId, ProjectId, RepositoryTask, ThreadId } from "@t3tools/contracts";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  commands: [] as Array<{ atom: unknown; input: unknown }>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((atom: unknown) => async (input: unknown) => {
    state.commands.push({ atom, input });
    return { _tag: "Success", value: {} };
  }) as never,
}));

import { threadEnvironment } from "~/state/threads";
import { RepositoryTaskGraph } from "./RepositoryTaskGraph";

function setup() {
  state.commands = [];
}

const node = (id: string, kind: string, status: string, pendingApproval = false) => ({
  id: `thread:${id}`,
  threadId: id as ThreadId,
  kind,
  title: id,
  role: kind === "agent" ? "implementation" : null,
  modelSelection: null,
  status,
  pendingApproval,
});
const edge = (source: string, target: string, kind: string, sequence: number | null = null) => ({
  id: `${kind}:${source}:${target}`,
  source: source === "user" ? "user" : `thread:${source}`,
  target: `thread:${target}`,
  kind,
  status: "running",
  sequence,
  at: sequence === null ? null : `2026-10-22T10:0${sequence}:00.000Z`,
});

// A repository whose agent delegated again; only the nested agent waits on an approval.
const task = {
  snapshot: {
    id: "task-a",
    runtimeMode: "full-access",
    interactionMode: "default",
    members: [{ projectId: "project-a", threadId: "member" }],
  },
  graph: {
    nodes: [
      node("coordinator", "coordinator", "completed"),
      node("member", "repository", "waiting"),
      node("agent", "agent", "running"),
      node("nested", "agent", "running", true),
      node("done", "agent", "completed"),
    ],
    edges: [
      edge("coordinator", "member", "membership"),
      edge("member", "agent", "delegation"),
      edge("agent", "nested", "delegation"),
      edge("member", "done", "delegation"),
      edge("member", "coordinator", "result", 3),
      edge("coordinator", "member", "steer", 2),
      edge("user", "coordinator", "prompt", 1),
    ],
  },
} as unknown as RepositoryTask;

describe("RepositoryTaskGraph", () => {
  it("lays nested agents out as a tree, opens a session and stops a branch with its descendants", async () => {
    setup();
    const opened: Array<[ThreadId, boolean | undefined]> = [];
    await using screen = await render(
      <RepositoryTaskGraph
        environmentId={"env" as EnvironmentId}
        task={task}
        projectById={new Map([["project-a" as ProjectId, { title: "Project A" }]])}
        canOperate
        onOpenThread={(threadId, diff) => opened.push([threadId, diff])}
      />,
    );

    await expect.element(screen.getByText("1 waiting for approval")).toBeVisible();
    const order = [...screen.container.querySelectorAll("[data-node]")].map((element) =>
      element.getAttribute("data-node"),
    );
    expect(order).toEqual([
      "thread:coordinator",
      "thread:member",
      "thread:agent",
      "thread:nested",
      "thread:done",
    ]);

    const timeline = screen.getByRole("list", { name: "Timeline" });
    await expect.element(timeline).toBeVisible();
    expect(
      [...timeline.element().querySelectorAll("li")].map((item) =>
        // The time itself follows the viewer's locale.
        [
          item.firstElementChild!.textContent!.split(" · ")[0],
          item.lastElementChild!.textContent,
        ].join(" "),
      ),
    ).toEqual([
      "#1 You→coordinatorprompt · running",
      "#2 coordinator→Project Asteer · running",
      "#3 Project A→coordinatorresult · running",
    ]);

    await userEvent.click(screen.getByRole("button", { name: /^Project A\./ }));
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(screen.getByRole("button", { name: /^agent\./ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(opened).toEqual([["agent", undefined]]);

    await userEvent.fill(screen.getByRole("textbox", { name: "Message agent" }), "Use the cache");
    await userEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(state.commands.at(-1)).toMatchObject({
      atom: threadEnvironment.startTurn,
      input: {
        environmentId: "env",
        input: { threadId: "agent", dispatchMode: "steer", message: { text: "Use the cache" } },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Stop with descendants" }));
    expect(
      state.commands
        .filter((command) => command.atom === threadEnvironment.interruptTurn)
        .map((command) => (command.input as { input: { threadId: string } }).input.threadId),
    ).toEqual(["agent", "nested"]);

    await userEvent.click(screen.getByRole("button", { name: /^done\./ }));
    await expect.element(screen.getByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Send" })).toBeVisible();
  });
});
