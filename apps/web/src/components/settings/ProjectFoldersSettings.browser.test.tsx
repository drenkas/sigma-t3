import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { render, stubGlobal } from "../../../test/render";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

const state = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() => async (input: unknown) => {
    state.inputs.push(input);
    return { _tag: "Success", value: undefined };
  }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "local-host") as never,
}));

import { ProjectFoldersSettings } from "./ProjectFoldersSettings";

function setup() {
  state.inputs = [];
}

const member = (environmentId: string) =>
  ({
    id: "project-web" as ProjectId,
    environmentId: environmentId as EnvironmentId,
    environmentLabel: "Host",
    physicalProjectKey: `${environmentId}:project-web`,
    title: "Web",
    workspaceRoot: "/work/web",
    additionalWorkspaceRoots: ["/work/api"],
  }) as unknown as SidebarProjectGroupMember;

describe("ProjectFoldersSettings", () => {
  it("adds picked folders once, skips the root, and removes a folder", async () => {
    setup();
    const pickFolders = vi.fn(async () => ["/work/docs", "/work/web", "/work/api", "/work/docs"]);
    using _bridge = stubGlobal("desktopBridge", { pickFolders });
    await using screen = await render(
      <ProjectFoldersSettings members={[member("local-host")]} canEdit={() => true} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Add folders" }));
    await vi.waitFor(() => expect(state.inputs).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Remove folder /work/api" }));

    expect(pickFolders).toHaveBeenCalledWith("/work/web");
    expect(state.inputs).toEqual([
      {
        environmentId: "local-host",
        input: { projectId: "project-web", additionalWorkspaceRoots: ["/work/api", "/work/docs"] },
      },
      {
        environmentId: "local-host",
        input: { projectId: "project-web", additionalWorkspaceRoots: [] },
      },
    ]);
  });

  it("lists a remote checkout's folders without offering to pick local ones", async () => {
    setup();
    await using screen = await render(
      <ProjectFoldersSettings members={[member("remote-host")]} canEdit={() => true} />,
    );

    await expect.element(screen.getByText("/work/api")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add folders" }).query()).toBeNull();
  });
});
