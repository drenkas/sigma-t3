import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environmentId: "older-host",
  otherEnvironmentId: "other-host",
  capability: false,
  queryInputs: [] as unknown[],
  commandRuns: 0,
  providers: [] as unknown[],
  providerMap: new Map<string, unknown[]>([["older-host", []]]),
  commandInputs: [] as unknown[],
  projects: [] as unknown[],
  groups: [] as unknown[],
  detail: {} as Record<string, unknown>,
  commandAtoms: [] as unknown[],
  commandSucceeds: false,
  preview: null as unknown,
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      { environmentId: state.environmentId, label: "Older host" },
      { environmentId: state.otherEnvironmentId, label: "New host" },
    ],
  })) as never,
  usePrimaryEnvironmentId: (() => state.environmentId) as never,
  useEnvironmentProviders: (() => state.providerMap) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() =>
    new Map([
      [
        state.environmentId,
        { environment: { capabilities: { repositoryTasks: state.capability } } },
      ],
    ])) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: { label?: readonly unknown[] } | null) => {
    state.queryInputs.push(atom);
    const isPreview = String(atom?.label?.[0] ?? "").includes("merge-preview");
    return {
      data:
        atom === null
          ? null
          : isPreview
            ? state.preview
            : { groups: state.groups, tasks: [], ...state.detail },
      dataUpdatedAt: 0,
      failure: null,
      isSuccess: true,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  }) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((atom: unknown) => async (input: unknown) => {
    state.commandRuns++;
    state.commandInputs.push(input);
    state.commandAtoms.push(atom);
    if (!state.commandSucceeds) throw new Error("A disabled command must not run");
    return { _tag: "Success", value: state.detail };
  }) as never,
}));

// The real file view loads the diff highlighter, which browser tests keep out.
vi.mock(import("./RepositoryTaskMergeFiles"), () => ({
  default: ({ files }) => (
    <ul>
      {files.map((file) => (
        <li key={file.path}>{`${file.path}: ${file.status}`}</li>
      ))}
    </ul>
  ),
}));

function setup() {
  state.detail = {};
  state.preview = null;
  state.commandAtoms = [];
  state.commandSucceeds = false;
}

function replaceProviderCatalog() {
  state.providerMap = new Map([[state.environmentId, state.providers]]);
}

import { repositoryTaskEnvironment } from "../../state/repositoryTasks";
import { RepositoryTasksPage } from "./RepositoryTasksPage";

function taskDetail(
  state: string,
  launchState: string,
  archivedAt: string | null = null,
  merges: unknown[] = [],
) {
  return {
    snapshot: {
      id: "task-a",
      title: "Two repositories",
      groupTitle: "Group",
      coordinatorThreadId: "repository-task:task-a:coordinator",
      coordinatorWorkspaceProjectId: "scratch",
      modelSelection: { instanceId: "codex", model: "first-model" },
      members: [],
    },
    state,
    status: state === "uncertain" ? "uncertain" : "stopped",
    coordinatorStatus: "completed",
    archivedAt,
    members: [
      {
        snapshot: {
          projectId: "project-a",
          threadId: "repository-task:task-a:member:0",
          workspaceRoot: "/work/project-a",
          workspaceStrategy: { type: "root" },
        },
        role: "implementation",
        launchState,
        status: launchState,
        runId: null,
        workspacePath: null,
        branch: null,
        preparedRevision: null,
        pendingApproval: false,
        deliveryState: "pending",
        merges,
      },
    ],
    graph: { nodes: [], edges: [] },
  };
}

describe("RepositoryTasksPage capability guard", () => {
  it("keeps repository task requests and mutations disabled for older hosts", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.capability = false;
    state.providers = [];
    replaceProviderCatalog();
    state.projects = [];
    state.groups = [];
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await expect
      .element(screen.getByText("This connected server does not support repository tasks yet."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Start a task" }))
      .not.toBeInTheDocument();
    expect(state.queryInputs).toHaveLength(4);
    expect(state.queryInputs.every((input) => input === null)).toBe(true);
    expect(state.commandRuns).toBe(0);
  });

  it("hands host selection to route state so reload and back keep the chosen destination", async () => {
    setup();
    const onTaskChange = vi.fn();
    await using screen = await render(
      <RepositoryTasksPage
        environmentId={state.environmentId as EnvironmentId}
        onTaskChange={onTaskChange}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Task host" }));
    await userEvent.click(page.getByRole("option", { name: "New host" }));
    expect(onTaskChange).toHaveBeenCalledWith(undefined, state.otherEnvironmentId);

    await screen.rerender(
      <RepositoryTasksPage
        environmentId={state.otherEnvironmentId as EnvironmentId}
        onTaskChange={onTaskChange}
      />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "Task host" }))
      .toHaveTextContent("New host");
  });

  it("keeps a removed coordinator model selection unavailable and prevents task creation", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.capability = true;
    const projectIds = ["project-a", "project-b"];
    state.projects = projectIds.map((id) => ({
      id,
      environmentId: state.environmentId,
      title: id,
      workspaceRoot: `/work/${id}`,
    }));
    state.groups = [
      {
        id: "group-a",
        title: "Two repositories",
        projectIds,
        updatedAt: "2026-10-21T10:00:00.000Z",
      },
    ];
    state.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Provider A",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-21T10:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: ["first-model", "second-model"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {},
        })),
      },
    ];
    replaceProviderCatalog();
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Two repositories" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Task name" }), "Test task");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Prompt" }),
      "Implement the requested change",
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Coordinator model" }));
    await userEvent.click(page.getByRole("option", { name: /second-model/ }));

    state.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Provider A",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-21T10:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: [{ slug: "first-model", name: "first-model", isCustom: false, capabilities: {} }],
      },
    ];
    replaceProviderCatalog();
    await screen.rerender(<RepositoryTasksPage onTaskChange={() => {}} />);

    await expect
      .element(screen.getByRole("combobox", { name: "Coordinator model" }))
      .toHaveTextContent("Unavailable: second-model (codex)");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "A selected model is no longer available. Choose an available coordinator and role model before creating the task.",
      );
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeDisabled();
    expect(state.commandRuns).toBe(0);
  });

  it("does not implicitly select a model when the catalog order changes", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.capability = true;
    const projectIds = ["project-a"];
    state.projects = projectIds.map((id) => ({
      id,
      environmentId: state.environmentId,
      title: id,
      workspaceRoot: `/work/${id}`,
    }));
    state.groups = [{ id: "group-a", title: "Saved group", projectIds }];
    const provider = (slugs: string[]) => ({
      instanceId: "codex",
      driver: "codex",
      displayName: "Provider A",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-10-21T10:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: slugs.map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {},
      })),
    });
    state.providers = [provider(["first-model", "second-model"])];
    replaceProviderCatalog();
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await expect
      .element(screen.getByRole("combobox", { name: "Coordinator model" }))
      .toHaveTextContent("Choose a model");
    await expect
      .element(screen.getByRole("combobox", { name: "implementation model" }))
      .toHaveTextContent("Choose a model");
    await userEvent.type(screen.getByRole("textbox", { name: "Task name" }), "Test task");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Implement this change");
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeDisabled();

    state.providers = [provider(["second-model"])];
    replaceProviderCatalog();
    await screen.rerender(<RepositoryTasksPage onTaskChange={() => {}} />);

    await expect
      .element(screen.getByRole("combobox", { name: "Coordinator model" }))
      .toHaveTextContent("Choose a model");
    await expect
      .element(screen.getByRole("combobox", { name: "implementation model" }))
      .toHaveTextContent("Choose a model");
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeDisabled();
    expect(state.commandRuns).toBe(0);
  });

  it("prefills role models from the group, then the host, and saves host defaults", async () => {
    setup();
    state.commandSucceeds = true;
    state.commandInputs = [];
    state.capability = true;
    const projectIds = ["project-a"];
    state.projects = projectIds.map((id) => ({
      id,
      environmentId: state.environmentId,
      title: id,
      workspaceRoot: `/work/${id}`,
    }));
    const first: ModelSelection = { instanceId: "codex" as never, model: "first-model" };
    const second: ModelSelection = { instanceId: "codex" as never, model: "second-model" };
    state.groups = [
      {
        id: "group-a",
        title: "Saved group",
        projectIds,
        roleModels: [{ role: "implementation", modelSelection: first }],
      },
    ];
    state.detail = {
      roleModels: [
        { role: "implementation", modelSelection: second },
        { role: "review", modelSelection: second },
      ],
    };
    state.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Provider A",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-21T10:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: ["first-model", "second-model"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {},
        })),
      },
    ];
    replaceProviderCatalog();
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Saved group" }));
    await expect
      .element(screen.getByRole("combobox", { name: "implementation model" }))
      .toHaveTextContent("Provider A · first-model");
    // Without the app stylesheet the checkbox box has no size, so click its label instead.
    await userEvent.click(screen.getByText("review", { exact: true }));
    await expect
      .element(screen.getByRole("combobox", { name: "review model" }))
      .toHaveTextContent("Provider A · second-model");

    await userEvent.click(screen.getByRole("combobox", { name: "Review (host default)" }));
    await userEvent.click(screen.getByRole("option", { name: "No default" }));
    expect(state.commandAtoms.at(-1)).toBe(repositoryTaskEnvironment.setRoleModels);
    expect(state.commandInputs.at(-1)).toEqual({
      environmentId: state.environmentId,
      input: { roles: [{ role: "implementation", modelSelection: second }] },
    });
  });

  it("blocks task creation while repository group edits are unsaved", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.capability = true;
    const projectIds = ["project-a", "project-b"];
    state.projects = projectIds.map((id) => ({
      id,
      environmentId: state.environmentId,
      title: id,
      workspaceRoot: `/work/${id}`,
    }));
    state.groups = [{ id: "group-a", title: "Saved group", projectIds }];
    state.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Provider A",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-21T10:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: {} }],
      },
    ];
    replaceProviderCatalog();
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Saved group" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Task name" }), "Test task");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Implement this change");
    await userEvent.click(screen.getByRole("combobox", { name: "Coordinator model" }));
    await userEvent.click(page.getByRole("option", { name: /Model A/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "implementation model" }));
    await userEvent.click(page.getByRole("option", { name: /Model A/ }));
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeEnabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Group name" }), " edited");

    await expect
      .element(
        screen.getByText(
          "Save group changes before creating a task. Tasks use the saved group membership.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeDisabled();
    expect(state.commandRuns).toBe(0);
  });

  it("clears stale options when the full provider descriptor disappears", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.capability = true;
    const projectIds = ["project-a", "project-b"];
    state.projects = projectIds.map((id) => ({
      id,
      environmentId: state.environmentId,
      title: id,
      workspaceRoot: `/work/${id}`,
    }));
    state.groups = [{ id: "group-a", title: "Saved group", projectIds }];
    const option = {
      id: "reasoningEffort",
      label: "Reasoning effort",
      type: "select",
      options: [
        { id: "low", label: "Low", isDefault: true },
        { id: "high", label: "High" },
      ],
    };
    const provider = (options: typeof option.options | null) => ({
      instanceId: "codex",
      driver: "codex",
      displayName: "Provider A",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-10-21T10:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: [
        {
          slug: "model-a",
          name: "Model A",
          isCustom: false,
          capabilities: options ? { optionDescriptors: [{ ...option, options }] } : {},
        },
      ],
    });
    state.providers = [provider(option.options)];
    replaceProviderCatalog();
    await using screen = await render(<RepositoryTasksPage onTaskChange={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Saved group" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Task name" }), "Test task");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Implement this change");
    await userEvent.click(screen.getByRole("combobox", { name: "Coordinator model" }));
    await userEvent.click(page.getByRole("option", { name: /Model A/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "implementation model" }));
    await userEvent.click(page.getByRole("option", { name: /Model A/ }));
    const traitsButton = screen.getByRole("button", { name: /Low/ }).first();
    await userEvent.click(traitsButton);
    await userEvent.click(page.getByRole("menuitemradio", { name: "High" }));

    state.providers = [provider(null)];
    replaceProviderCatalog();
    await screen.rerender(<RepositoryTasksPage onTaskChange={() => {}} />);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "A selected model option is no longer advertised. Choose an available option before creating the task.",
      );
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeDisabled();
    expect(state.commandRuns).toBe(0);

    await userEvent.click(
      screen.getByRole("button", { name: "Clear unavailable options for coordinator model" }),
    );
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: /Create and start task/ }))
      .toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Create and start task/ }));
    expect(state.commandInputs).toHaveLength(1);
    expect(state.commandInputs[0]).toMatchObject({
      input: {
        modelSelection: { instanceId: "codex", model: "model-a" },
        members: [
          { projectId: "project-a", workspaceStrategy: { type: "root" } },
          { projectId: "project-b", workspaceStrategy: { type: "root" } },
        ],
      },
    });
    expect(
      (state.commandInputs[0] as { input: { modelSelection: ModelSelection } }).input.modelSelection
        .options,
    ).toBeUndefined();
    expect(
      (state.commandInputs[0] as { input: { roles: Array<{ modelSelection: ModelSelection }> } })
        .input.roles[0]?.modelSelection.options,
    ).toBeUndefined();
  });

  it("settles an uncertain task only through acknowledgement, then offers archive instead of Stop", async () => {
    setup();
    state.queryInputs = [];
    state.commandRuns = 0;
    state.commandInputs = [];
    state.commandSucceeds = true;
    state.capability = true;
    state.providers = [];
    replaceProviderCatalog();
    state.projects = [];
    state.groups = [];
    state.detail = taskDetail("uncertain", "uncertain");
    await using screen = await render(
      <RepositoryTasksPage taskId="task-a" onTaskChange={() => {}} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Acknowledge observed state" }));
    expect(state.commandAtoms).toEqual([repositoryTaskEnvironment.acknowledgeTask]);
    expect(state.commandInputs).toEqual([
      { environmentId: state.environmentId, input: { taskId: "task-a" } },
    ]);

    state.detail = taskDetail("stopped", "abandoned");
    await screen.rerender(<RepositoryTasksPage taskId="task-a" onTaskChange={() => {}} />);
    await expect
      .element(screen.getByRole("button", { name: "Acknowledge observed state" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Stop task" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(state.commandAtoms.at(-1)).toBe(repositoryTaskEnvironment.archiveTask);

    state.detail = taskDetail("stopped", "abandoned", "2026-10-21T12:00:00.000Z");
    await screen.rerender(<RepositoryTasksPage taskId="task-a" onTaskChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(state.commandAtoms.at(-1)).toBe(repositoryTaskEnvironment.unarchiveTask);
  });

  it("applies a conflicted agent merge only from a reviewed clean preview", async () => {
    setup();
    state.commandInputs = [];
    state.commandSucceeds = true;
    state.capability = true;
    state.providers = [];
    replaceProviderCatalog();
    state.projects = [];
    state.groups = [];
    const merge = {
      sourceThreadId: "agent-thread",
      worktreePath: "/work/agent",
      status: "conflict",
      files: ["agent.txt"],
      error: null,
    };
    state.detail = taskDetail("active", "dispatched", null, [merge]);
    state.preview = {
      sourceThreadId: "agent-thread",
      status: "conflict",
      files: [{ path: "agent.txt", status: "conflict", text: "<<<<<<< root" }],
      token: null,
    };
    await using screen = await render(
      <RepositoryTasksPage taskId="task-a" onTaskChange={() => {}} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expect.element(screen.getByText("agent.txt: conflict")).toBeVisible();
    await expect.element(screen.getByText(/Nothing was written/)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Apply to workspace" }))
      .not.toBeInTheDocument();

    state.preview = {
      sourceThreadId: "agent-thread",
      status: "ready",
      files: [{ path: "agent.txt", status: "ready", text: "+agent" }],
      token: "ours:merged",
    };
    await screen.rerender(<RepositoryTasksPage taskId="task-a" onTaskChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Apply to workspace" }));
    expect(state.commandAtoms.at(-1)).toBe(repositoryTaskEnvironment.applyMerge);
    expect(state.commandInputs.at(-1)).toEqual({
      environmentId: state.environmentId,
      input: { taskId: "task-a", sourceThreadId: "agent-thread", token: "ours:merged" },
    });
  });
});
