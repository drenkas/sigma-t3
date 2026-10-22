import * as Context from "effect/Context";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as RepositoryTaskPolicy from "../repositoryTasks/RepositoryTaskPolicy.ts";
import * as RepositoryTasks from "../repositoryTasks/RepositoryTasks.ts";
import * as RepositoryTaskAdmission from "../repositoryTasks/RepositoryTaskAdmission.ts";
import * as EventSink from "./EventSink.ts";
import { EventId, type Project, type RepositoryTaskCreateInput } from "@t3tools/contracts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChatAttachmentId,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as const;
const claudeAdapter = {
  instanceId: claudeModelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly projects?: ReadonlyArray<Project>;
  readonly databaseLayer?: typeof SqlitePersistence.layerMemory;
  readonly workspaceObserver?: Layer.Layer<never>;
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = options.databaseLayer ?? SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          options.projects !== undefined
            ? Option.fromNullishOr(options.projects.find((entry) => entry.id === id))
            : id === projectId
              ? Option.some(project)
              : id === otherProjectId
                ? Option.some(otherProject)
                : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.some(project)),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeed(Option.none()),
      }),
  );
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
    Layer.provide(
      RepositoryTaskPolicy.layer.pipe(
        Layer.provide(
          Layer.mergeAll(layerDatabase, layerExternalServices, layerRegistry, NodeServices.layer),
        ),
      ),
    ),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(options.workspaceObserver ?? Layer.empty),
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreadManagement, layerProjectedProjects, layerExternalServices),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "succeeded");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      assert.equal(result.threadId, thread!.id);
      const projection = yield* threads.getThreadProjection(thread!.id);
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find(
        (item): item is Extract<typeof item, { type: "user_message" }> =>
          item.type === "user_message",
      );
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect(
  "returns no dispatched thread when sending an automation to a missing thread fails",
  () => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const threadId = ThreadId.make("thread:missing");
      const { task } = yield* tasks.upsert({
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "failed");
      assert.isNull(result.threadId);
      assert.equal(result.task.threadId, threadId);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect("runs a thread-bound automation on the provider the thread uses now", () => {
  const harness = makeHarness({ adapters: [adapter, claudeAdapter] });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({ command: "command:switched", thread: "thread:switched" }),
    );
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make("scheduled-task:switched"),
      title: "Hourly check",
      prompt: "Check on the delegated workers.",
      enabled: false,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: launched.threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:switch-selection"),
      threadId: launched.threadId,
      modelSelection: claudeModelSelection,
    });

    const result = yield* tasks.runNow({ id: task.id });
    assert.equal(result.task.lastRunStatus, "succeeded");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.scheduledTaskId === task.id);
    const run = projection.runs.find((item) => item.id === message?.runId);
    assert.deepStrictEqual(run?.modelSelection, claudeModelSelection);
    assert.deepStrictEqual(projection.thread.modelSelection, claudeModelSelection);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
});

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("provisions independent launches concurrently instead of behind a global semaphore", () =>
  Effect.gen(function* () {
    const setupCount = yield* Ref.make(0);
    const bothEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
          ),
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const results = yield* Effect.all(
        [
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-a",
              thread: "thread:launch:concurrent-a",
              message: "First",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-b",
              thread: "thread:launch:concurrent-b",
              message: "Second",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result.projection.runs[0]?.status),
        ["preparing", "preparing"],
      );
      yield* Deferred.await(bothEntered);
      assert.equal(yield* Ref.get(setupCount), 2);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([" /COMPACT "])(
  "uses the first conversation message for a title after %s",
  (nativeCommand) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "compact-title",
            thread: "compact-title-thread",
            message: nativeCommand,
          }),
          generateTitle: true,
        });
        assert.isUndefined(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration,
        );
        assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.lastVisitedAt);
        assert.isFalse(
          (yield* outbox.listByCommandId(CommandId.make("compact-title:initial-message"))).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        const commandId = CommandId.make("compact-title-conversation");
        const messageId = MessageId.make("compact-title-conversation-message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId,
          createdBy: "user",
          creationSource: "web",
          text: "Fix the failing parser",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        assert.equal(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration
            ?.requestId,
          commandId,
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(commandId))
            .filter((effect) => effect.request.type === "thread-title.generate")
            .map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "initial", messageId } }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps native maintenance commands out of steering and restart messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const scenario of [
        {
          name: "compact-steer",
          first: "Fix the parser",
          next: " /COMPACT ",
          mode: "steer_active",
        },
        {
          name: "compact-restart",
          first: "Fix the parser",
          next: "/compact",
          mode: "restart_active",
        },
        {
          name: "logout-steer",
          first: "Fix the parser",
          next: "/logout",
          mode: "steer_active",
        },
        {
          name: "logout-restart",
          first: "Fix the parser",
          next: "/logout",
          mode: "restart_active",
        },
        {
          name: "steer-logout",
          first: "/logout",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "steer-compaction",
          first: "/compact",
          next: "Continue with the parser",
          mode: "steer_active",
        },
      ] as const) {
        const launched = yield* launches.launch(
          launchInput({
            command: `${scenario.name}:launch`,
            thread: scenario.name,
            message: scenario.first,
          }),
        );
        const before = yield* threads.getThreadProjection(launched.threadId);
        const targetRun = before.runs[0];
        if (targetRun === undefined) return yield* Effect.die("Launch must create a run");
        const commandId = CommandId.make(`${scenario.name}:message`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId: MessageId.make(`${scenario.name}:message`),
          createdBy: "user",
          creationSource: "web",
          text: scenario.next,
          attachments: [],
          dispatchMode: { type: scenario.mode, targetRunId: targetRun.id },
        });
        // A steer sent while a maintenance turn runs waits as a queued follow-up.
        if (scenario.name.startsWith("steer-")) {
          yield* dispatch;
          const queued = (yield* threads.getThreadProjection(launched.threadId)).runs[1];
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.userMessageId, MessageId.make(`${scenario.name}:message`));
          continue;
        }
        const failure = yield* dispatch.pipe(Effect.flip);
        assert.include(
          String(failure.cause).toLowerCase(),
          scenario.name.includes("logout") ? "sign" : "context compaction",
        );
        const after = yield* threads.getThreadProjection(launched.threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.thread.titleRegeneration, before.thread.titleRegeneration);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("arms durable title generation after accepting the first message", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      generateTitle: (input) =>
        Effect.succeed({
          title: input.previousTitle === undefined ? "Generated title" : "Regenerated title",
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const input = {
        ...launchInput({
          command: "command:launch:title-generation",
          thread: "thread:launch:title-generation",
          message: "Generate my title",
        }),
        title: "Generate my title",
        generateTitle: true,
      };
      const launched = yield* launches.launch(input);
      const generationCommandId = CommandId.make("command:launch:title-generation:initial-message");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.title, "Generate my title");
      assert.equal(projection.thread.titleRegeneration?.requestId, generationCommandId);
      assert.deepEqual(
        (yield* outbox.listByCommandId(generationCommandId)).map((effect) => effect.request),
        [
          {
            type: "thread-title.generate",
            kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
          },
        ],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: generationCommandId,
        kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
      });
      const generated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(generated.thread.title, "Generated title");
      assert.deepEqual(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );

      const manualRequestId = CommandId.make("command:title-generation:manual");
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: manualRequestId,
        threadId: launched.threadId,
        regenerateTitle: true,
      });
      assert.deepEqual(
        (yield* outbox.listByCommandId(manualRequestId)).map((effect) => effect.request),
        [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: manualRequestId,
        kind: { type: "regenerate" },
      });
      const regenerated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(regenerated.thread.title, "Regenerated title");
      assert.equal(
        harness.generateThreadTitle.mock.calls[1]?.[0]?.previousTitle,
        "Generated title",
      );

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:title-generation:user-rename"),
        threadId: launched.threadId,
        title: "Keep my title",
      });
      const renamed = yield* threads.getThreadProjection(launched.threadId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* threads.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("command:title-generation:stale-completion"),
        threadId: launched.threadId,
        requestId: generationCommandId,
        title: "Stale generated title",
      });
      const afterStaleCompletion = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(afterStaleCompletion.thread.title, "Keep my title");
      assert.equal(
        DateTime.toEpochMillis(afterStaleCompletion.thread.updatedAt),
        DateTime.toEpochMillis(renamed.thread.updatedAt),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not update a reused thread title when the initial message is rejected", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

// Stands `projectId` in for the Scratch project: a plain folder, not a Git
// repository, so Git fails there with the error a real one raises.
function scratchHarness() {
  const claimed: Array<ThreadId> = [];
  const scratchRoot = project.workspaceRoot;
  const notARepository = (operation: string, cwd: string) =>
    new GitCommandError({
      operation,
      command: "vcs-route",
      cwd,
      detail: "Failed to resolve the VCS driver for this Git command.",
    });
  const harness = makeHarness({
    managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (id) => Effect.succeed(id === projectId),
      folderForThread: (input) =>
        Effect.sync(() => {
          if (input.projectId !== projectId) return Option.none();
          claimed.push(input.threadId);
          return Option.some(`/scratch/folder-${claimed.length}`);
        }),
    }),
    remoteExists: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.remoteExists", input.cwd))
        : Effect.succeed(true),
    createWorktree: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.createWorktree", input.cwd))
        : Effect.succeed({
            worktree: {
              path: "/other-repo-worktrees/feature",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
  });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return {
    ...harness,
    claimed,
    layer: Layer.mergeAll(harness.layer, layerScheduledTasks),
  };
}

const worktreeStrategy = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

function scheduledTaskInput(id: string, targetProjectId: ProjectId) {
  return {
    id: ScheduledTaskId.make(id),
    title: "Daily summary",
    prompt: "Summarize the day.",
    enabled: false,
    schedule: { type: "interval" as const, everyMs: 60_000 },
    projectId: targetProjectId,
    threadId: null,
    workspaceStrategy: worktreeStrategy,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
}

it.effect("launches a worktree request for Scratch at the root, in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:scratch-worktree",
        thread: "thread:launch:scratch-worktree",
        message: "Tidy my notes",
        workspace: worktreeStrategy,
      }),
    );
    const scratch = yield* preparationSettled(launched.threadId);
    assert.equal(scratch.thread.worktreePath, "/scratch/folder-1");
    // Released past preparation; provider execution is disabled here.
    assert.equal(scratch.runs[0]?.status, "starting");
    assert.deepEqual(scratch.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    // A Git project still gets the worktree it asked for.
    const other = yield* launches.launch({
      ...launchInput({
        command: "command:launch:git-worktree",
        thread: "thread:launch:git-worktree",
        message: "Build the feature",
        workspace: worktreeStrategy,
      }),
      projectId: otherProjectId,
    });
    const git = yield* preparationSettled(other.threadId);
    assert.equal(git.runs[0]?.status, "starting");
    assert.equal(git.runs[0]?.workspacePreparation?.type, "worktree");
    assert.equal(git.thread.worktreePath, "/other-repo-worktrees/feature");
    assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.cwd, "/other-repo");
    assert.deepEqual(harness.claimed, [launched.threadId]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stores a Scratch scheduled task at the root and keeps worktrees elsewhere", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const scratch = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-upsert", projectId),
    );
    assert.deepEqual(scratch.task.workspaceStrategy, { type: "root" });
    const git = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:git-upsert", otherProjectId),
    );
    assert.deepEqual(git.task.workspaceStrategy, worktreeStrategy);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("runs a Scratch scheduled task saved with a worktree in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const { task } = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-stored", projectId),
    );
    // Tasks saved before Scratch was coerced still hold a worktree strategy.
    yield* sql`
      UPDATE scheduled_tasks
      SET workspace_strategy_json = ${JSON.stringify(worktreeStrategy)}
      WHERE task_id = ${task.id}
    `;
    const ran = yield* tasks.runNow({ id: task.id });
    assert.equal(ran.task.lastRunStatus, "succeeded");
    const [thread] = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
    assert.isDefined(thread);
    const projection = yield* preparationSettled(thread!.id);
    assert.equal(projection.runs[0]?.status, "starting");
    assert.equal(projection.thread.worktreePath, "/scratch/folder-1");
    assert.deepEqual(projection.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["stable", "upstream/release"])(
  "launches from %s with the fetched commit and remote PR base",
  (baseRef) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "launch-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      const localHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote advance"]);
      yield* command(cwd, ["push", "upstream", "stable:release"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["reset", "--hard", localHead]);
      yield* command(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);

      const setupStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        hasCommit: ({ refName }) =>
          command(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          hasRefNamed: () => Effect.succeed(false),
        },
        fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
        createWorktree: (input, options) =>
          git.createWorktree({ ...input, cwd, path: worktreePath }, options),
        runSetup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const workspace = {
          type: "worktree" as const,
          baseRef,
          branch: "feature",
          startFromOrigin: true,
        };
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:remote-base",
            thread: "thread:launch:remote-base",
            workspace,
          }),
        );
        yield* Deferred.await(setupStarted);
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.thread.worktreePath, worktreePath);
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          remoteHead,
        );
        const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
          remoteHead,
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-remote-git-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("shows the fetch diagnosis when preparing a worktree from origin fails", () => {
  const detail =
    "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.fetchRemote",
          command: "git",
          cwd: project.workspaceRoot,
          detail,
          exitCode: 128,
        }),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:fetch-failure",
        thread: "thread:launch:fetch-failure",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.messages[0]?.text, "Start from origin");
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(
      projection.turnItems.find((item) => item.type === "command_execution")?.status,
      "failed",
    );
    assert.include(
      projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
      detail,
    );
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(harness.runSetup.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["fails", "is interrupted"] as const)(
  "holds a message queued during setup when the workspace preparation %s",
  (ending) =>
    Effect.gen(function* () {
      const fetchEntered = yield* Deferred.make<void>();
      const allowFetch = yield* Deferred.make<void>();
      let fetchFailures = 1;
      const harness = makeHarness({
        fetchWorktreeBaseCommit: () =>
          fetchFailures-- <= 0
            ? Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })
            : Deferred.succeed(fetchEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowFetch)),
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.fetchRemote",
                      command: "git",
                      cwd: project.workspaceRoot,
                      detail: "Git could not reach the remote.",
                      exitCode: 128,
                    }),
                  ),
                ),
              ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: `command:launch:queued-setup-${ending}`,
            thread: `thread:launch:queued-setup-${ending}`,
            message: "First message",
            workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
          }),
        );
        yield* Deferred.await(fetchEntered);
        const queued = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make(`command:launch:queued-setup-${ending}:follow-up`),
          threadId: launched.threadId,
          messageId: MessageId.make(`message:launch:queued-setup-${ending}:follow-up`),
          text: "Sent during setup",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(queued.delivery, "queued");
        if (ending === "fails") {
          yield* Deferred.succeed(allowFetch, undefined);
        } else {
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:launch:queued-setup-interrupt"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
        }

        yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.runs.at(-1)?.status, "queued");
        assert.equal(projection.thread.worktreePath, null);

        if (ending === "fails") {
          yield* launches.retryPreparation({
            commandId: CommandId.make("command:launch:queued-setup-retry"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
          const retried = yield* threads.getThreadProjection(launched.threadId);
          assert.equal(retried.runs.at(-1)?.queueHeld, false);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["failed", "interrupted"] as const)(
  "holds a message queued during setup that arrives after the setup %s",
  (ending) => {
    let fetchEntered: Deferred.Deferred<void> | null = null;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        ending === "interrupted"
          ? Deferred.succeed(fetchEntered!, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
    });
    return Effect.gen(function* () {
      fetchEntered = yield* Deferred.make<void>();
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:late-queued-follow-up-${ending}`,
          thread: `thread:launch:late-queued-follow-up-${ending}`,
          message: "First message",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      if (ending === "interrupted") {
        yield* Deferred.await(fetchEntered);
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:launch:late-queued-follow-up:interrupt"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.updated" && stored.event.payload.status === ending,
        ),
        Stream.runHead,
      );

      const queued = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:send`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:send`),
        text: "Sent during setup",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.delivery, "queued");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      const held = projection.runs.at(-1)!;
      assert.equal(held.status, "queued");
      assert.equal(held.queueHeld, true);

      // A message the user starts does not release it: the held message would
      // run after it in the project checkout.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:start`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:start`),
        text: "Sent after setup",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      // Nor does the next one, though the run that message started is now the
      // latest and carries no workspace preparation.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:again`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:again`),
        text: "Sent after that",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(launched.threadId);
      assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const first = yield* launches.launch(rest);
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted launch after the project disables the instance", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const input = launchInput({
      command: "command:launch:retry-after-disable",
      thread: "thread:launch:retry-after-disable",
      message: "Hello",
    });
    const first = yield* launches.launch(input);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* launches.launch(input);
    assert.equal(retry.threadId, first.threadId);
    assert.isTrue(retry.resumed);

    const fresh = yield* launches
      .launch(
        launchInput({
          command: "command:launch:fresh-after-disable",
          thread: "thread:launch:fresh-after-disable",
          message: "Hello",
        }),
      )
      .pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        if (error._tag !== "ThreadLaunchError") {
          assert.fail(`expected ThreadLaunchError, got ${error._tag}`);
        }
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
                workspace: { type: "worktree", baseRef: "main" },
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("schedules an accepted preparing message exactly once across concurrent retries", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:accepted-before-fork",
        thread: "thread:launch:accepted-before-fork",
        message: "Resume preparation",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const messageId = MessageId.make("message:launch:accepted-before-fork");

      yield* threads.dispatch({
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:initial-message`),
        threadId: input.threadId,
        messageId,
        text: "Resume preparation",
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const preparing = yield* threads.getThreadProjection(input.threadId);
      assert.equal(preparing.runs[0]?.status, "preparing");

      const [first, second] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.isTrue(first.resumed);
      assert.isTrue(second.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("creates a strong provider-thread mapping for an imported native session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:imported-native-session",
        thread: "thread:launch:imported-native-session",
      }),
      importedNativeThread: {
        ref: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-session-42",
          strength: "strong" as const,
        },
        metadata: {
          title: "Native session",
          updatedAt: "2026-08-23T00:00:00Z",
        },
      },
    };

    const launched = yield* launches.launch(input);

    assert.deepInclude(launched.projection.providerThreads[0], {
      id: IdAllocator.deriveProviderThread({
        driver: input.importedNativeThread.ref.driver,
        providerInstanceId: modelSelection.instanceId,
        nativeThreadId: input.importedNativeThread.ref.nativeId,
      }),
      driver: input.importedNativeThread.ref.driver,
      providerInstanceId: modelSelection.instanceId,
      appThreadId: input.threadId,
      nativeThreadRef: input.importedNativeThread.ref,
      status: "not_loaded",
      nativeMetadata: input.importedNativeThread.metadata,
    });
    assert.equal(
      launched.projection.thread.activeProviderThreadId,
      launched.projection.providerThreads[0]?.id,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-intake-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](t3-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
        checkWorktreeBase: launches.checkWorktreeBase,
        retryPreparation: launches.retryPreparation,
        prepareRun: launches.prepareRun,
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    assert.equal(
      (stored.context?.records[0] as { attachmentId: string }).attachmentId,
      stored.attachments[0]?.id,
    );
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const replayed = yield* ThreadMessageIntake.launchThread(input);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const duplicate = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-duplicate-create"),
      initialMessage: { ...input.initialMessage, messageId: MessageId.make("intake-duplicate") },
    }).pipe(Effect.result);
    assert.ok(Result.isFailure(duplicate));
    assert.ok(duplicate.failure._tag === "ThreadLaunchError");
    assert.equal(duplicate.failure.operation, "create-thread");
    assert.propertyVal(duplicate.failure.cause, "_tag", "OrchestratorThreadAlreadyExistsError");
    assert.equal((yield* claimedFiles).length, 1);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    const dispatch = ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch;
    yield* dispatch;
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("stops an in-flight branch rename when tracked setup is cancelled", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const branchNameStarted = yield* Deferred.make<void>();
    const allowBranchName = yield* Deferred.make<void>();
    const branchNameInterrupted = yield* Deferred.make<void>();
    const renameAttempted = yield* Deferred.make<void>();
    const harness = makeHarness({
      renameBranch: (input) =>
        Deferred.succeed(renameAttempted, undefined).pipe(Effect.as({ branch: input.newBranch })),
      runSetup: () => Deferred.succeed(setupEntered, undefined).pipe(Effect.andThen(Effect.never)),
      generateBranchName: () =>
        Deferred.succeed(branchNameStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
          Effect.onInterrupt(() => Deferred.succeed(branchNameInterrupted, undefined)),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:cancel-renaming",
          thread: "thread:cancel-renaming",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* Deferred.await(setupEntered);
      yield* Deferred.await(branchNameStarted);
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      // Let a rename that survived the cancel finish, then check it never ran.
      yield* Deferred.succeed(allowBranchName, undefined);
      yield* Effect.raceFirst(
        Deferred.await(branchNameInterrupted),
        Deferred.await(renameAttempted),
      );
      assert.isTrue(
        yield* Deferred.isDone(branchNameInterrupted),
        "the cancelled setup's branch rename kept running",
      );
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([0, 1])("releases an async setup before its completion with exit %s", (exitCode) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
    const harness = makeHarness({
      runSetup: () =>
        Effect.succeed({
          status: "started" as const,
          async: true,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup",
          cwd: "/repo-worktrees/feature",
          completion: Deferred.await(completion),
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:async-${exitCode}`,
          thread: `thread:launch:async-${exitCode}`,
          message: "Start during setup",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
            true,
        ),
        Stream.runHead,
      );
      const running = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(running.runs[0]?.status, "starting");
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.equal(
        settled?.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "is missing", baseRef: "t3/renamed", startFromOrigin: false, origin: true },
  {
    name: "has no origin to come from",
    baseRef: "t3/renamed",
    startFromOrigin: true,
    origin: false,
  },
  {
    name: "is a previous checkout there never was",
    baseRef: "-",
    startFromOrigin: false,
    origin: true,
  },
])("refuses a new worktree whose base ref $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD"),
      git: {
        resolveWorktreeBaseRemote: () =>
          Effect.succeed(testCase.origin ? { remoteName: "origin", branchName: "main" } : null),
        hasRefNamed: () => Effect.succeed(false),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: testCase.baseRef,
            startFromOrigin: testCase.startFromOrigin,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBaseRefError",
        projectId,
        baseRef: testCase.baseRef,
      });
      assert.equal(
        error.message,
        `Base ref "${testCase.baseRef}" does not resolve to a commit in project "Project" (/repo).`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted send after the project disables the instance", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-send-retry-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const created = yield* launches.launch(
      launchInput({
        command: "command:send:retry-setup",
        thread: "thread:send:retry-after-disable",
      }),
    );

    const sendInput = {
      commandId: CommandId.make("command:send:retry-after-disable"),
      projectId,
      threadId: created.threadId,
      messageId: MessageId.make("message:send:retry-after-disable"),
      text: "Hello again",
      attachments: [],
      mode: "auto" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* ThreadMessageIntake.sendToThread(sendInput);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* ThreadMessageIntake.sendToThread(sendInput);
    assert.equal(retry.message.id, first.message.id);

    const fresh = yield* ThreadMessageIntake.sendToThread({
      ...sendInput,
      commandId: CommandId.make("command:send:fresh-after-disable"),
      messageId: MessageId.make("message:send:fresh-after-disable"),
    }).pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});
const makeRepositoryTaskHarness = Effect.fn("test.makeRepositoryTaskHarness")(function* (
  managedWorktree = false,
  scratchUnavailable = false,
  agentWorktrees = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "repository-tasks-" });
  const scratchId = ProjectId.make("project:task-scratch");
  const scratchRoot = `${directory}/scratch`;
  yield* fs.makeDirectory(scratchRoot);
  const testProjects: Project[] = [
    { ...project, workspaceRoot: `${directory}/first` },
    { ...otherProject, workspaceRoot: `${directory}/second` },
    { ...project, id: scratchId, workspaceRoot: scratchRoot },
  ];
  const layerGit = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(directory, { prefix: "repository-task-git-" })),
    Layer.provide(NodeServices.layer),
  );
  for (const entry of testProjects.slice(0, 2)) {
    yield* fs.makeDirectory(entry.workspaceRoot);
    yield* GitVcsDriver.GitVcsDriver.use((git) =>
      Effect.gen(function* () {
        yield* git.execute({ operation: "test.init", cwd: entry.workspaceRoot, args: ["init"] });
        yield* git.execute({
          operation: "test.commit",
          cwd: entry.workspaceRoot,
          args: [
            "-c",
            "user.name=Sigma test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
          ],
        });
      }),
    ).pipe(Effect.provide(layerGit));
  }
  const databaseLayer = SqlitePersistence.layerMemory;
  const admission = RepositoryTaskAdmission.layer.pipe(
    Layer.provide(Layer.mergeAll(databaseLayer, layerGit, NodeServices.layer)),
  );
  const provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-21T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: modelSelection.model,
        name: "Synthetic model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      },
    ],
  };
  const managedFolders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: scratchRoot,
    isScratchProject: (id) => Effect.succeed(id === scratchId),
    ensureScratchProject: scratchUnavailable
      ? Effect.fail(new ManagedProjectFolders.ScratchUnavailableError())
      : Effect.succeed({ projectId: scratchId }),
    folderForThread: ({ projectId: id, threadId }) =>
      id !== scratchId
        ? Effect.succeedNone
        : Effect.gen(function* () {
            const path = `${scratchRoot}/${threadId}`;
            yield* fs.makeDirectory(path, { recursive: true });
            return Option.some(path);
          }).pipe(Effect.orDie),
  });
  const native = makeHarness({
    projects: testProjects,
    databaseLayer,
    providers: [provider],
    managedFolders,
    ...(managedWorktree || agentWorktrees
      ? {
          createWorktree: (input) =>
            GitVcsDriver.GitVcsDriver.use((git) =>
              git.createWorktree({
                ...input,
                path: agentWorktrees
                  ? `${directory}/agent-worktrees/${input.newRefName ?? "detached"}`.replaceAll(
                      /[^\w/.-]/g,
                      "-",
                    )
                  : `${directory}/server-home/worktrees/first/feature`,
              }),
            ).pipe(Effect.provide(layerGit), Effect.orDie),
        }
      : {}),
    workspaceObserver: RepositoryTaskAdmission.layerObserver.pipe(
      Layer.provide(admission),
      Layer.orDie,
    ),
  });
  const dependencies = Layer.mergeAll(
    native.layer,
    admission,
    layerGit,
    NodeServices.layer,
    CommandReceiptStore.layer.pipe(Layer.provide(databaseLayer)),
  );
  const taskLayer = RepositoryTasks.layer.pipe(Layer.provide(dependencies));
  const policy = RepositoryTaskPolicy.layer.pipe(Layer.provide(dependencies));
  const input: RepositoryTaskCreateInput = {
    id: "two-repositories",
    groupId: "test-group",
    title: "Fix both repositories",
    prompt: "Make the bounded change in both repositories.",
    coordinatorProjectId: projectId,
    modelSelection,
    roles: [
      {
        role: "implementation",
        modelSelection: { ...modelSelection, options: [{ id: "reasoningEffort", value: "high" }] },
      },
    ],
    runtimeMode: "full-access",
    interactionMode: "default",
    members: [
      { projectId, workspaceStrategy: { type: "root" } },
      { projectId: otherProjectId, workspaceStrategy: { type: "root" } },
    ],
  };
  return {
    layer: Layer.mergeAll(dependencies, taskLayer, policy),
    input,
    testProjects,
    databaseLayer,
    directory,
  };
});

it.effect(
  "repository tasks preserve snapshots after group edits and deletion, and replay one native launch",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Original",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        assert.notEqual(task.snapshot.coordinatorWorkspaceProjectId, projectId);
        const coordinator = yield* threads.getThreadProjection(task.snapshot.coordinatorThreadId);
        assert.notEqual(coordinator.thread.worktreePath, harness.testProjects[0]!.workspaceRoot);
        const dispatch = {
          taskId: harness.input.id,
          projectId,
          role: "implementation" as const,
          prompt: "Only first repository",
        };
        const first = yield* tasks.dispatch(dispatch, task.snapshot.coordinatorThreadId);
        const replay = yield* tasks.dispatch(dispatch, task.snapshot.coordinatorThreadId);
        assert.deepEqual(
          replay.members.map((member) => member.snapshot.threadId),
          first.members.map((member) => member.snapshot.threadId),
        );
        const member = first.members.find((entry) => entry.snapshot.projectId === projectId)!;
        const native = yield* threads.getThreadProjection(member.snapshot.threadId);
        assert.equal(native.messages.length, 1);
        assert.deepEqual(native.thread.modelSelection.options, [
          { id: "reasoningEffort", value: "high" },
        ]);
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Changed",
          projectIds: [otherProjectId],
        });
        yield* tasks.deleteGroup(harness.input.groupId);
        const reopened = yield* tasks.create(harness.input);
        assert.equal(reopened.snapshot.groupTitle, "Original");
        assert.deepEqual(
          reopened.snapshot.members.map((entry) => entry.projectId),
          [projectId, otherProjectId],
        );
        assert.equal((yield* tasks.listGroups).length, 0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["model", "option", "duplicate-role"] as const)(
  "repository task model admission fails closed: %s",
  (invalid) =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const selection =
          invalid === "model"
            ? { ...modelSelection, model: "not-advertised" }
            : { ...modelSelection, options: [{ id: "reasoningEffort", value: "not-advertised" }] };
        const roles: RepositoryTaskCreateInput["roles"] =
          invalid === "duplicate-role"
            ? [harness.input.roles[0]!, harness.input.roles[0]!]
            : [{ role: "implementation", modelSelection: selection }];
        const error = yield* tasks.create({ ...harness.input, roles }).pipe(Effect.flip);
        assert.include(["invalid", "unavailable"], error.reason);
        assert.equal((yield* tasks.listTasks({ archived: false })).length, 0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task Stop fences admission, cancels owned held turns, and leaves another thread alone",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        const dispatched = yield* tasks.dispatch(
          { taskId: harness.input.id, projectId, role: "implementation", prompt: "First" },
          task.snapshot.coordinatorThreadId,
        );
        const owned = dispatched.members.find((entry) => entry.snapshot.projectId === projectId)!;
        yield* threads.sendToThread({
          projectId,
          threadId: owned.snapshot.threadId,
          commandId: CommandId.make("queue:owned"),
          messageId: MessageId.make("queue:owned"),
          text: "Follow up",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        const unrelated = yield* launches.launch(
          launchInput({
            command: "unrelated-launch",
            thread: "unrelated-thread",
            message: "Unrelated work",
          }),
        );
        yield* tasks.stop(harness.input.id);
        const stopped = yield* threads.getThreadProjection(owned.snapshot.threadId);
        assert.isFalse(stopped.runs.some((run) => run.status === "queued"));
        const independent = yield* threads.getThreadProjection(unrelated.threadId);
        assert.isTrue(
          independent.runs.some((run) => ["preparing", "queued", "starting"].includes(run.status)),
        );
        const denied = yield* tasks
          .dispatch(
            {
              taskId: harness.input.id,
              projectId: otherProjectId,
              role: "implementation",
              prompt: "Must not launch",
            },
            task.snapshot.coordinatorThreadId,
          )
          .pipe(Effect.flip);
        assert.equal(denied.reason, "conflict");
        assert.isNull(yield* threads.getThreadShell(task.snapshot.members[1]!.threadId));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task recovery preserves uncertain launch intent without dispatching work",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        yield* sql`UPDATE repository_task_members SET launch_state = 'dispatching', role = 'implementation', prompt = 'intent before process loss' WHERE task_id = ${harness.input.id} AND project_id = ${projectId}`;
        yield* tasks.recover;
        yield* tasks.recover;
        const recovered = yield* tasks.get(harness.input.id);
        assert.equal(
          recovered.members.find((member) => member.snapshot.projectId === projectId)!.launchState,
          "uncertain",
        );
        assert.isNull(yield* threads.getThreadShell(task.snapshot.members[0]!.threadId));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task results reach the coordinator once from both persisted native roots",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        for (const member of task.snapshot.members) {
          yield* tasks.dispatch(
            {
              taskId: harness.input.id,
              projectId: member.projectId,
              role: "implementation",
              prompt: `Work in ${member.projectId}`,
            },
            task.snapshot.coordinatorThreadId,
          );
          yield* threads.streamStoredEventsFrom({ threadId: member.threadId }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status !== "preparing",
            ),
            Stream.runHead,
          );
          const projection = yield* threads.getThreadProjection(member.threadId);
          const run = projection.runs[0]!;
          const now = yield* DateTime.now;
          // Synthetic provider output goes through the real event sink, never a fake receipt/store.
          yield* sink.write({
            events: [
              {
                id: EventId.make(`finished:${member.threadId}`),
                threadId: member.threadId,
                runId: run.id,
                occurredAt: now,
                type: "run.updated",
                payload: { ...run, status: "completed", completedAt: now },
              },
              {
                id: EventId.make(`answer:${member.threadId}`),
                threadId: member.threadId,
                runId: run.id,
                occurredAt: now,
                type: "message.updated",
                payload: {
                  ...projection.messages[0]!,
                  id: MessageId.make(`answer:${member.threadId}`),
                  role: "assistant",
                  text: `RESULT ${member.projectId}`,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        yield* tasks.reconcile(harness.input.id);
        yield* tasks.recover;
        yield* tasks.reconcile(harness.input.id);
        const coordinator = yield* threads.getThreadProjection(task.snapshot.coordinatorThreadId);
        assert.equal(
          coordinator.messages.filter((entry) => entry.text.includes("RESULT ")).length,
          2,
        );
        const after = yield* tasks.get(harness.input.id);
        assert.isTrue(after.members.every((member) => member.deliveryState === "delivered"));
        assert.isTrue(
          after.members.every(
            (member) => member.preparedRevision !== null && member.workspacePath !== null,
          ),
        );
        assert.equal(after.graph.edges.filter((edge) => edge.kind === "result").length, 2);
        assert.notEqual(after.status, "completed");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task finishes after the coordinator settles and releases repositories it never dispatched",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const policy = yield* RepositoryTaskPolicy.RepositoryTaskPolicy;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        const dispatched = task.snapshot.members.find((member) => member.projectId === projectId)!;
        yield* tasks.dispatch(
          { taskId: harness.input.id, projectId, role: "implementation", prompt: "Only here" },
          task.snapshot.coordinatorThreadId,
        );
        yield* threads.streamStoredEventsFrom({ threadId: dispatched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status !== "preparing",
          ),
          Stream.runHead,
        );
        const completeRuns = Effect.fn("test.completeRuns")(function* (threadId: ThreadId) {
          const projection = yield* threads.getThreadProjection(threadId);
          const now = yield* DateTime.now;
          // Synthetic provider output goes through the real event sink, never a fake receipt/store.
          yield* sink.write({
            events: projection.runs
              .filter((run) => run.completedAt === null)
              .map((run) => ({
                id: EventId.make(`finished:${run.id}`),
                threadId,
                runId: run.id,
                occurredAt: now,
                type: "run.updated" as const,
                payload: { ...run, status: "completed" as const, completedAt: now },
              })),
          });
        });
        yield* completeRuns(dispatched.threadId);
        yield* tasks.reconcile(harness.input.id);
        const memberRoot = yield* threads.getThreadProjection(dispatched.threadId);
        const unrelated = {
          ...memberRoot.thread,
          id: ThreadId.make("unrelated-second-writer"),
          projectId: otherProjectId,
          worktreePath: null,
          lineage: {
            ...memberRoot.thread.lineage,
            rootThreadId: ThreadId.make("unrelated-second-writer"),
          },
        };
        assert.equal(
          (yield* policy.assertMayStart(unrelated).pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.equal((yield* tasks.get(harness.input.id)).state, "active");

        yield* completeRuns(task.snapshot.coordinatorThreadId);
        yield* tasks.reconcile(harness.input.id);

        const finished = yield* tasks.get(harness.input.id);
        assert.equal(finished.state, "finished");
        assert.equal(finished.status, "completed");
        yield* policy.assertMayStart(unrelated);
        yield* policy.assertMayStart(memberRoot.thread);
        assert.equal((yield* tasks.stop(harness.input.id)).state, "finished");
        assert.equal(
          (yield* tasks
            .dispatch(
              {
                taskId: harness.input.id,
                projectId: otherProjectId,
                role: "implementation",
                prompt: "Too late",
              },
              task.snapshot.coordinatorThreadId,
            )
            .pipe(Effect.flip)).reason,
          "conflict",
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task acknowledgement settles uncertain launches from persisted state without launching again",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        const [launched, lost] = task.snapshot.members;
        yield* tasks.dispatch(
          { taskId: harness.input.id, projectId, role: "implementation", prompt: "First" },
          task.snapshot.coordinatorThreadId,
        );
        // One launch committed before the outcome was lost, the other never reached the engine.
        yield* sql`UPDATE repository_task_members SET launch_state = 'uncertain' WHERE task_id = ${harness.input.id} AND project_id = ${projectId}`;
        yield* sql`UPDATE repository_task_members SET launch_state = 'uncertain', role = 'implementation', prompt = 'Second' WHERE task_id = ${harness.input.id} AND project_id = ${otherProjectId}`;
        yield* sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${harness.input.id}`;

        const acknowledged = yield* tasks.acknowledge(harness.input.id);
        const replay = yield* tasks.acknowledge(harness.input.id);

        for (const view of [acknowledged, replay]) {
          assert.equal(view.state, "active");
          const launchStates = new Map(
            view.members.map((member) => [member.snapshot.projectId, member.launchState]),
          );
          assert.equal(launchStates.get(projectId), "dispatched");
          assert.equal(launchStates.get(otherProjectId), "abandoned");
        }
        assert.equal((yield* threads.getThreadProjection(launched!.threadId)).messages.length, 1);
        assert.isNull(yield* threads.getThreadShell(lost!.threadId));
        const redispatch = yield* tasks
          .dispatch(
            {
              taskId: harness.input.id,
              projectId: otherProjectId,
              role: "implementation",
              prompt: "Second",
            },
            task.snapshot.coordinatorThreadId,
          )
          .pipe(Effect.flip);
        assert.equal(redispatch.reason, "conflict");
        assert.isNull(yield* threads.getThreadShell(lost!.threadId));
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("repository task acknowledgement stops a task whose coordinator never started", () =>
  Effect.gen(function* () {
    const harness = yield* makeRepositoryTaskHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* RepositoryTasks.RepositoryTasks;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.upsertGroup({
        id: harness.input.groupId,
        title: "Group",
        projectIds: [projectId, otherProjectId],
      });
      yield* tasks.create(harness.input);
      yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${`repository-task:${harness.input.id}:coordinator`}`;
      yield* sql`UPDATE repository_tasks SET state = 'uncertain' WHERE id = ${harness.input.id}`;

      const acknowledged = yield* tasks.acknowledge(harness.input.id);

      assert.include(["stopping", "stopped"], acknowledged.state);
      assert.isTrue(acknowledged.members.every((member) => member.launchState === "pending"));
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("repository task archive hides only tasks that can no longer run, and unarchives", () =>
  Effect.gen(function* () {
    const harness = yield* makeRepositoryTaskHarness();
    yield* Effect.gen(function* () {
      const tasks = yield* RepositoryTasks.RepositoryTasks;
      const sql = yield* SqlClient.SqlClient;
      yield* tasks.upsertGroup({
        id: harness.input.groupId,
        title: "Group",
        projectIds: [projectId, otherProjectId],
      });
      yield* tasks.create(harness.input);
      assert.equal((yield* tasks.archive(harness.input.id).pipe(Effect.flip)).reason, "conflict");
      assert.isNull((yield* tasks.get(harness.input.id)).archivedAt);

      yield* sql`UPDATE repository_tasks SET state = 'stopped' WHERE id = ${harness.input.id}`;
      const archived = yield* tasks.archive(harness.input.id);
      assert.isNotNull(archived.archivedAt);
      assert.equal((yield* tasks.archive(harness.input.id)).archivedAt, archived.archivedAt);
      assert.isEmpty(yield* tasks.listTasks({ archived: false }));
      assert.deepEqual(
        (yield* tasks.listTasks({ archived: true })).map((task) => task.snapshot.id),
        [harness.input.id],
      );

      const restored = yield* tasks.unarchive(harness.input.id);
      assert.isNull(restored.archivedAt);
      assert.deepEqual(
        (yield* tasks.listTasks({ archived: false })).map((task) => task.snapshot.id),
        [harness.input.id],
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

const runRepositoryTaskWithAgentWorktree = Effect.fn("test.runRepositoryTaskWithAgentWorktree")(
  function* (
    harness: Effect.Success<ReturnType<typeof makeRepositoryTaskHarness>>,
    edit: (
      memberRoot: string,
      agentWorktree: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>,
  ) {
    const tasks = yield* RepositoryTasks.RepositoryTasks;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    yield* tasks.upsertGroup({
      id: harness.input.groupId,
      title: "Group",
      projectIds: [projectId, otherProjectId],
    });
    const task = yield* tasks.create(harness.input);
    const member = task.snapshot.members.find((entry) => entry.projectId === projectId)!;
    yield* tasks.dispatch(
      { taskId: harness.input.id, projectId, role: "implementation", prompt: "Use an agent" },
      task.snapshot.coordinatorThreadId,
    );
    const root = yield* threads.getThreadProjection(member.threadId);
    const run = root.runs.find((entry) => entry.rootNodeId !== null)!;
    const commandId = CommandId.make("agent-worktree-child");
    yield* threads.dispatch({
      type: "delegated_task.request",
      commandId,
      parentThreadId: root.thread.id,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Agent work",
      role: "implementation",
      modelSelection: harness.input.roles[0]!.modelSelection,
      runtimeMode: harness.input.runtimeMode,
      interactionMode: harness.input.interactionMode,
      workspaceStrategy: { type: "worktree", baseRef: member.startingRevision },
      createdBy: "user",
      creationSource: "web",
    });
    const agent = (yield* threads.getThreadProjection(root.thread.id)).subagents[0]!;
    const childRunId = (yield* threads.getThreadProjection(agent.childThreadId!)).runs[0]!.id;
    yield* ThreadLaunch.ThreadLaunchService.use((launches) =>
      launches.prepareRun({ commandId, threadId: agent.childThreadId!, runId: childRunId }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: agent.childThreadId! }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "thread.metadata-updated" && event.payload.worktreePath != null,
      ),
      Stream.runHead,
    );
    const child = yield* threads.getThreadProjection(agent.childThreadId!);
    yield* edit(harness.testProjects[0]!.workspaceRoot, child.thread.worktreePath!);
    const settle = Effect.fn("test.settle")(function* (threadId: ThreadId) {
      const projection = yield* threads.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      // Synthetic provider output goes through the real event sink, never a fake receipt/store.
      yield* sink.write({
        events: [
          ...projection.runs
            .filter((entry) => entry.completedAt === null)
            .map((entry) => ({
              id: EventId.make(`finished:${entry.id}`),
              threadId,
              runId: entry.id,
              occurredAt: now,
              type: "run.updated" as const,
              payload: { ...entry, status: "completed" as const, completedAt: now },
            })),
          ...projection.subagents.map((entry) => ({
            id: EventId.make(`settled:${entry.id}`),
            threadId,
            ...(entry.runId === null ? {} : { runId: entry.runId }),
            occurredAt: now,
            type: "subagent.updated" as const,
            payload: { ...entry, status: "completed" as const },
          })),
        ],
      });
    });
    yield* settle(child.thread.id);
    yield* settle(root.thread.id);
    yield* tasks.reconcile(harness.input.id);
    return { task, settle };
  },
);

it.effect.each(["clean", "conflict"] as const)(
  "repository task merges an agent worktree into the member workspace only without conflicts: %s",
  (variant) =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness(false, false, true);
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const fs = yield* FileSystem.FileSystem;
        const memberRoot = harness.testProjects[0]!.workspaceRoot;
        const { task, settle } = yield* runRepositoryTaskWithAgentWorktree(
          harness,
          (root, worktree) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${worktree}/agent.txt`, "agent result\n");
              if (variant === "conflict")
                yield* fs.writeFileString(`${root}/agent.txt`, "member result\n");
            }),
        );

        const view = yield* tasks.get(harness.input.id);
        const member = view.members.find((entry) => entry.snapshot.projectId === projectId)!;
        assert.deepEqual(
          member.merges.map((merge) => [merge.status, merge.files]),
          [[variant === "clean" ? "applied" : "conflict", ["agent.txt"]]],
        );
        assert.equal(
          yield* fs.readFileString(`${memberRoot}/agent.txt`),
          variant === "clean" ? "agent result\n" : "member result\n",
        );
        const coordinator = yield* threads.getThreadProjection(task.snapshot.coordinatorThreadId);
        assert.isTrue(
          coordinator.messages.some((entry) =>
            entry.text.includes(
              variant === "clean" ? ": applied (agent.txt)" : ": conflict (agent.txt)",
            ),
          ),
        );

        yield* settle(task.snapshot.coordinatorThreadId);
        yield* tasks.reconcile(harness.input.id);
        const after = yield* tasks.get(harness.input.id);
        if (variant === "clean") assert.equal(after.state, "finished");
        else {
          // A conflict keeps the task, and its claim on the repository, until the user resolves it.
          assert.equal(after.state, "active");
          assert.equal(
            after.members.find((entry) => entry.snapshot.projectId === projectId)!.status,
            "merge_conflict",
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("repository task applies a conflicted merge only from the reviewed preview", () =>
  Effect.gen(function* () {
    const harness = yield* makeRepositoryTaskHarness(false, false, true);
    yield* Effect.gen(function* () {
      const tasks = yield* RepositoryTasks.RepositoryTasks;
      const fs = yield* FileSystem.FileSystem;
      const memberRoot = harness.testProjects[0]!.workspaceRoot;
      const { task, settle } = yield* runRepositoryTaskWithAgentWorktree(
        harness,
        (root, worktree) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${worktree}/agent.txt`, "agent result\n");
            yield* fs.writeFileString(`${root}/agent.txt`, "member result\n");
          }),
      );
      yield* settle(task.snapshot.coordinatorThreadId);
      yield* tasks.reconcile(harness.input.id);
      const sourceThreadId = (yield* tasks.get(harness.input.id)).members.find(
        (entry) => entry.snapshot.projectId === projectId,
      )!.merges[0]!.sourceThreadId;

      const conflict = yield* tasks.previewMerge(harness.input.id, sourceThreadId);
      assert.equal(conflict.status, "conflict");
      assert.isNull(conflict.token);
      assert.include(conflict.files[0]!.text, "||||||| base");

      // The user resolves it by dropping the member's own version of the file.
      yield* fs.remove(`${memberRoot}/agent.txt`);
      const ready = yield* tasks.previewMerge(harness.input.id, sourceThreadId);
      assert.equal(ready.status, "ready");
      assert.include(ready.files[0]!.text, "+agent result");

      yield* fs.writeFileString(`${memberRoot}/other.txt`, "changed after review\n");
      const stale = yield* tasks
        .applyMerge(harness.input.id, sourceThreadId, ready.token!)
        .pipe(Effect.flip);
      assert.equal(stale.reason, "conflict");
      assert.isFalse(yield* fs.exists(`${memberRoot}/agent.txt`));

      const reviewed = yield* tasks.previewMerge(harness.input.id, sourceThreadId);
      const applied = yield* tasks.applyMerge(harness.input.id, sourceThreadId, reviewed.token!);
      assert.equal(yield* fs.readFileString(`${memberRoot}/agent.txt`), "agent result\n");
      assert.equal(applied.state, "finished");
      assert.deepInclude(
        applied.graph.edges.find((edge) => edge.kind === "merge"),
        { source: `thread:${sourceThreadId}`, status: "applied" },
      );
      assert.equal((yield* tasks.previewMerge(harness.input.id, sourceThreadId)).status, "applied");
      const again = yield* tasks
        .applyMerge(harness.input.id, sourceThreadId, reviewed.token!)
        .pipe(Effect.flip);
      assert.equal(again.reason, "conflict");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task recovery marks an interrupted merge uncertain and acknowledgement never writes it again",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness(false, false, true);
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const memberRoot = harness.testProjects[0]!.workspaceRoot;
        yield* runRepositoryTaskWithAgentWorktree(harness, (_root, worktree) =>
          fs.writeFileString(`${worktree}/agent.txt`, "agent result\n"),
        );
        // The server stopped after recording the merge and before any file was written.
        yield* sql`UPDATE repository_task_merges SET status = 'applying' WHERE task_id = ${harness.input.id}`;
        yield* fs.remove(`${memberRoot}/agent.txt`);

        yield* tasks.recover;
        const recovered = yield* tasks.get(harness.input.id);
        assert.equal(recovered.state, "uncertain");
        assert.equal(
          recovered.members.find((entry) => entry.snapshot.projectId === projectId)!.merges[0]!
            .status,
          "uncertain",
        );

        const acknowledged = yield* tasks.acknowledge(harness.input.id);
        const merge = acknowledged.members.find((entry) => entry.snapshot.projectId === projectId)!
          .merges[0]!;
        assert.equal(merge.status, "failed");
        assert.equal(merge.error, "The interrupted merge wrote nothing.");
        assert.isFalse(yield* fs.exists(`${memberRoot}/agent.txt`));
        assert.equal(acknowledged.state, "active");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task delegation binds the exact snapshot role and rejects shared workspaces, escaped roots and stopped descendants",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness();
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const policy = yield* RepositoryTaskPolicy.RepositoryTaskPolicy;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const task = yield* tasks.create(harness.input);
        yield* tasks.dispatch(
          { taskId: harness.input.id, projectId, role: "implementation", prompt: "First" },
          task.snapshot.coordinatorThreadId,
        );
        const root = yield* threads.getThreadProjection(task.snapshot.members[0]!.threadId);
        const run = root.runs.find((entry) => entry.rootNodeId !== null)!;
        const nativeRequest = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make("native-task-child"),
          parentThreadId: root.thread.id,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Bounded native child",
          role: "implementation",
          modelSelection: harness.input.roles[0]!.modelSelection,
          runtimeMode: harness.input.runtimeMode,
          interactionMode: harness.input.interactionMode,
          workspaceStrategy: {
            type: "worktree" as const,
            baseRef: task.snapshot.members[0]!.startingRevision,
          },
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        for (const [index, invalid] of [
          { ...nativeRequest, workspaceStrategy: undefined },
          { ...nativeRequest, workspaceStrategy: { type: "root" as const } },
          { ...nativeRequest, role: "unselected" },
          { ...nativeRequest, modelSelection: { ...modelSelection, model: "unselected" } },
          { ...nativeRequest, modelSelection },
        ].entries()) {
          const rejected = yield* threads
            .dispatch({ ...invalid, commandId: CommandId.make(`invalid-native:${index}`) })
            .pipe(Effect.provide(Context.empty()), Effect.flip);
          assert.equal(rejected._tag, "OrchestratorCommandRejectedError");
        }
        const coordinatorProjection = yield* threads.getThreadProjection(
          task.snapshot.coordinatorThreadId,
        );
        const coordinatorRun = coordinatorProjection.runs.find(
          (entry) => entry.rootNodeId !== null,
        )!;
        assert.equal(
          (yield* threads
            .dispatch({
              ...nativeRequest,
              commandId: CommandId.make("invalid-coordinator-native"),
              parentThreadId: coordinatorProjection.thread.id,
              parentRunId: coordinatorRun.id,
              parentNodeId: coordinatorRun.rootNodeId!,
            })
            .pipe(Effect.flip))._tag,
          "OrchestratorCommandRejectedError",
        );
        assert.isEmpty((yield* threads.getThreadProjection(root.thread.id)).subagents);
        yield* threads.dispatch(nativeRequest);
        const accepted = (yield* threads.getThreadProjection(root.thread.id)).subagents[0]!;
        assert.equal(accepted.role, "implementation");
        const preparingChild = yield* threads.getThreadProjection(accepted.childThreadId!);
        yield* ThreadLaunch.ThreadLaunchService.use((launches) =>
          launches.prepareRun({
            commandId: nativeRequest.commandId,
            threadId: accepted.childThreadId!,
            runId: preparingChild.runs[0]!.id,
          }),
        );
        yield* threads.streamStoredEventsFrom({ threadId: accepted.childThreadId! }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "thread.metadata-updated" && event.payload.worktreePath != null,
          ),
          Stream.runHead,
        );
        const child = yield* threads.getThreadProjection(accepted.childThreadId!);
        assert.deepEqual(child.thread.modelSelection, harness.input.roles[0]!.modelSelection);
        assert.notEqual(child.thread.worktreePath, root.thread.worktreePath);
        const delegated = yield* policy.prepareDelegation(root.thread, {
          task: "Bounded child work",
          role: "implementation",
        });
        assert.deepEqual(delegated.target, {
          providerInstanceId: modelSelection.instanceId,
          model: modelSelection.model,
          options: [{ id: "reasoningEffort", value: "high" }],
        });
        assert.equal(delegated.isolation, "worktree");
        for (const request of [
          {
            task: "Wrong model",
            role: "implementation" as const,
            target: { model: "not-selected" },
          },
          { task: "Wrong options", role: "implementation" as const, target: { options: [] } },
          { task: "Shared writer", role: "implementation" as const, isolation: "shared" as const },
        ])
          assert.equal(
            (yield* policy.prepareDelegation(root.thread, request).pipe(Effect.flip)).reason,
            "conflict",
          );
        const unrelated = {
          ...root.thread,
          id: ThreadId.make("unrelated-writer"),
          lineage: { ...root.thread.lineage, rootThreadId: ThreadId.make("unrelated-writer") },
        };
        assert.equal(
          (yield* policy.assertMayStart(unrelated).pipe(Effect.flip)).reason,
          "conflict",
        );
        const coordinator = yield* threads.getThreadProjection(task.snapshot.coordinatorThreadId);
        assert.equal(
          (yield* policy.assertStandaloneAllowed(coordinator.thread).pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.equal(
          (yield* policy
            .prepareDelegation(coordinator.thread, { task: "Escape ownership" })
            .pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* tasks.stop(harness.input.id);
        assert.equal(
          (yield* policy.assertMayStart(root.thread).pipe(Effect.flip)).reason,
          "conflict",
        );
        const admission = yield* RepositoryTaskAdmission.RepositoryTaskAdmission;
        let released = false;
        const deniedRelease = yield* admission
          .beforeRelease(
            root.thread.id,
            harness.testProjects[0]!.workspaceRoot,
            Effect.sync(() => {
              released = true;
            }),
          )
          .pipe(Effect.flip);
        assert.equal(deniedRelease.reason, "conflict");
        assert.isFalse(released);
        const descendant = {
          ...root.thread,
          id: ThreadId.make("owned-descendant"),
          lineage: {
            ...root.thread.lineage,
            parentThreadId: root.thread.id,
            relationshipToParent: "subagent" as const,
            rootThreadId: root.thread.id,
          },
        };
        assert.equal(
          (yield* policy.assertMayStart(descendant).pipe(Effect.flip)).reason,
          "conflict",
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "repository task provider start refuses a redirected repository before worktree restoration: %s",
  (managedWorktree) =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness(managedWorktree);
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const input = managedWorktree
          ? {
              ...harness.input,
              members: harness.input.members.map((entry) =>
                entry.projectId === projectId
                  ? { ...entry, workspaceStrategy: { type: "worktree" as const, baseRef: "HEAD" } }
                  : entry,
              ),
            }
          : harness.input;
        const task = yield* tasks.create(input);
        yield* tasks.dispatch(
          {
            taskId: task.snapshot.id,
            projectId,
            role: "implementation",
            prompt: "Stay in the snapshotted repository",
          },
          task.snapshot.coordinatorThreadId,
        );
        const threadId = task.snapshot.members[0]!.threadId;
        yield* threads.streamStoredEventsFrom({ threadId }).pipe(
          Stream.filter(
            ({ event }) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.runHead,
        );
        const initial = yield* threads.getThreadProjection(threadId);
        const runId = initial.runs[0]!.id;
        if (managedWorktree) {
          const git = yield* GitVcsDriver.GitVcsDriver;
          yield* git.execute({
            operation: "test.remove-worktree",
            cwd: harness.testProjects[0]!.workspaceRoot,
            args: ["worktree", "remove", initial.thread.worktreePath!],
          });
          yield* git.execute({
            operation: "test.same-branch-other-repo",
            cwd: harness.testProjects[1]!.workspaceRoot,
            args: ["branch", initial.thread.branch!],
          });
        }
        harness.testProjects[0] = {
          ...harness.testProjects[0]!,
          workspaceRoot: harness.testProjects[1]!.workspaceRoot,
        };
        const open = vi.fn(() => Effect.die("Redirected task must not open a provider"));
        const git = yield* GitVcsDriver.GitVcsDriver;
        const pruneWorktrees = vi.fn(() => Effect.void);
        const recreateWorktree = vi.fn((input: Parameters<typeof git.createWorktree>[0]) =>
          git.createWorktree(input),
        );
        const runtime = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: (id) =>
                  Effect.succeed(
                    Option.fromNullishOr(
                      harness.testProjects.find((entry) => entry.id === id),
                    ).pipe(
                      Option.map((entry) => ({
                        ...entry,
                        projectId: entry.id,
                        autoPull: false,
                        defaultThreadEnvMode: null,
                        faviconPath: null,
                        projectIcon: null,
                      })),
                    ),
                  ),
              }),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(undefined),
              }),
            ),
          ),
        );
        const existingServices = Layer.succeedContext(
          yield* Effect.context<Layer.Success<typeof harness.layer>>(),
        );
        const startLayer = Layer.fresh(ProviderTurnStart.layer).pipe(
          Layer.provide(
            Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees,
              createWorktree: recreateWorktree,
            }),
          ),
          Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open })),
          Layer.provide(runtime),
          Layer.provide(ProjectionStore.layer.pipe(Layer.provide(existingServices))),
          Layer.provide(
            Layer.mergeAll(
              existingServices,
              ServerConfig.layerTest(harness.directory, `${harness.directory}/server-home`).pipe(
                Layer.provide(NodeServices.layer),
              ),
              IdAllocator.layer,
              Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
              Layer.mock(ProviderAuthService.ProviderAuthService)({
                tryHandlePromptCommand: () => Effect.succeed(false),
              }),
              Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                startRootRun: () => Effect.die("Redirected task must not start a turn"),
              }),
            ),
          ),
        );
        yield* ProviderTurnStart.ProviderTurnStartServiceV2.use((starter) =>
          starter.start({ threadId, runId }).pipe(Effect.provide(Context.empty())),
        ).pipe(Effect.provide(startLayer));
        assert.equal(open.mock.calls.length, 0);
        assert.equal(pruneWorktrees.mock.calls.length, 0);
        assert.equal(recreateWorktree.mock.calls.length, 0);
        if (managedWorktree)
          assert.isFalse(
            yield* FileSystem.FileSystem.use((fs) => fs.exists(initial.thread.worktreePath!)),
          );
        assert.equal(
          (yield* threads.getThreadProjection(threadId)).runs.find((entry) => entry.id === runId)
            ?.status,
          "failed",
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "repository task reports unavailable Scratch before persisting a task or launching a provider",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRepositoryTaskHarness(false, true);
      yield* Effect.gen(function* () {
        const tasks = yield* RepositoryTasks.RepositoryTasks;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* tasks.upsertGroup({
          id: harness.input.groupId,
          title: "Group",
          projectIds: [projectId, otherProjectId],
        });
        const error = yield* tasks.create(harness.input).pipe(Effect.flip);
        assert.equal(error.reason, "scratch-unavailable");
        assert.include(error.message, "data directory outside a Git checkout");
        assert.isEmpty(yield* tasks.listTasks({ archived: false }));
        assert.isNull(
          yield* threads.getThreadShell(
            ThreadId.make(`repository-task:${harness.input.id}:coordinator`),
          ),
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
