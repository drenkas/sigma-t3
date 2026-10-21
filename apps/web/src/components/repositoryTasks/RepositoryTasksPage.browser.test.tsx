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
  useEnvironmentQuery: ((atom: unknown) => {
    state.queryInputs.push(atom);
    return {
      data: atom === null ? null : { groups: state.groups, tasks: [] },
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
  useAtomCommand: (() => async (input: unknown) => {
    state.commandRuns++;
    state.commandInputs.push(input);
    throw new Error("A disabled command must not run");
  }) as never,
}));

function replaceProviderCatalog() {
  state.providerMap = new Map([[state.environmentId, state.providers]]);
}

import { RepositoryTasksPage } from "./RepositoryTasksPage";

describe("RepositoryTasksPage capability guard", () => {
  it("keeps repository task requests and mutations disabled for older hosts", async () => {
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

  it("blocks task creation while repository group edits are unsaved", async () => {
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
});
