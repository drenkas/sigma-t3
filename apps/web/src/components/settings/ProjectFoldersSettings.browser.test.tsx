import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { render } from "../../../test/render";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

const state = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => async (input: unknown) => {
    state.inputs.push(input);
    return { _tag: "Success", value: undefined };
  }) as never,
}));

import { ProjectFoldersSettings } from "./ProjectFoldersSettings";

function setup() {
  state.inputs = [];
}

const member = {
  id: "project-web" as ProjectId,
  environmentId: "remote-host" as EnvironmentId,
  environmentLabel: "Remote host",
  physicalProjectKey: "remote-host:project-web",
  title: "Web",
  workspaceRoot: "/work/web",
  additionalWorkspaceRoots: ["/work/api"],
} as unknown as SidebarProjectGroupMember;

describe("ProjectFoldersSettings", () => {
  it("adds and removes a checkout's additional folders", async () => {
    setup();
    await using screen = await render(
      <ProjectFoldersSettings members={[member]} canEdit={() => true} />,
    );

    await expect.element(screen.getByText("/work/web")).toBeVisible();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Folder path" }),
      " /work/docs {Enter}",
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove folder /work/api" }));

    expect(state.inputs).toEqual([
      {
        environmentId: "remote-host",
        input: { projectId: "project-web", additionalWorkspaceRoots: ["/work/api", "/work/docs"] },
      },
      {
        environmentId: "remote-host",
        input: { projectId: "project-web", additionalWorkspaceRoots: [] },
      },
    ]);
    expect(screen.getByRole("button", { name: "Browse for a folder" }).query()).toBeNull();
  });
});
