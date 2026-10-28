import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

type StackedInput = { action: string; commitMessage?: string };

const state = vi.hoisted(() => ({
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  stacked: [] as { cwd: string | null; input: StackedInput }[],
  pulls: [] as (string | null)[],
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.md", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: state.hasUpstream,
      aheadCount: state.aheadCount,
      behindCount: state.behindCount,
      pr: null,
    },
    error: null,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (original) => {
  const success = (value: unknown) => ({ _tag: "Success", value });
  return {
    ...(await original()),
    useSourceControlActionRunning: () => false,
    useGitStackedAction: ((scope: { cwd: string | null }) => ({
      run: async (input: StackedInput) => {
        state.stacked.push({ cwd: scope.cwd, input });
        return success({ toast: { title: "Done" } });
      },
    })) as never,
    useVcsPullAction: ((scope: { cwd: string | null }) => ({
      run: async () => {
        state.pulls.push(scope.cwd);
        return success({ status: "pulled" });
      },
    })) as never,
  };
});

import { ProjectFolderGitControls } from "./ProjectFolderGitControls";

function setup(remote: { hasUpstream: boolean; aheadCount: number; behindCount: number }) {
  Object.assign(state, remote);
  state.stacked = [];
  state.pulls = [];
}

const folder = (
  <ProjectFolderGitControls environmentId={EnvironmentId.make("environment")} folder="/work/docs" />
);
const button = (name: string) => page.getByRole("button", { name, exact: true });

describe("ProjectFolderGitControls", () => {
  it("publishes a branch that has no upstream yet", async () => {
    setup({ hasUpstream: false, aheadCount: 0, behindCount: 0 });
    await using _screen = await render(folder);

    await expect.element(button("Pull")).toBeDisabled();
    await userEvent.click(button("Publish"));

    expect(state.stacked).toEqual([
      { cwd: "/work/docs", input: expect.objectContaining({ action: "push" }) },
    ]);
  });

  it("pushes a tracked branch and commits with the typed message", async () => {
    setup({ hasUpstream: true, aheadCount: 2, behindCount: 0 });
    await using screen = await render(folder);

    await userEvent.click(button("Push 2"));
    await userEvent.click(button("Commit 1"));
    await userEvent.type(screen.getByRole("textbox", { name: "Commit message" }), "Fix docs");
    await userEvent.click(button("Commit 1 file"));

    await vi.waitFor(() =>
      expect(state.stacked.map(({ input }) => [input.action, input.commitMessage])).toEqual([
        ["push", undefined],
        ["commit", "Fix docs"],
      ]),
    );
    await expect.element(button("Pull")).toBeDisabled();
  });

  it("pulls when the branch is behind and blocks pushing until then", async () => {
    setup({ hasUpstream: true, aheadCount: 1, behindCount: 3 });
    await using _screen = await render(folder);

    await expect.element(button("Push 1")).toBeDisabled();
    await userEvent.click(button("Pull 3"));

    expect(state.pulls).toEqual(["/work/docs"]);
  });
});
