import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ModelSelection,
  type RepositoryGroup,
  type RepositoryTask,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  GitBranchIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { repositoryTaskEnvironment } from "../../state/repositoryTasks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useRightPanelStore } from "../../rightPanelStore";
import { RepositoryTaskMerges } from "./RepositoryTaskMerges";
import { randomUUID } from "../../lib/utils";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const ROLES = ["implementation", "research", "review", "design", "test", "general"] as const;
type Role = (typeof ROLES)[number];
type AvailableModel = {
  key: string;
  selection: ModelSelection;
  label: string;
  driver: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: ServerProviderModel;
};
type WorkspaceChoice = "root" | "worktree";
const EMPTY_PROJECT_IDS: ReadonlyArray<ProjectId> = [];
const needsAcknowledgement = (task: RepositoryTask) =>
  task.state === "uncertain" ||
  task.members.some(
    (member) =>
      member.launchState === "uncertain" ||
      member.merges.some((merge) => merge.status === "uncertain"),
  );
const scopedModelKey = (environmentId: EnvironmentId | null, modelKey: string) =>
  `${environmentId ?? ""}:${modelKey}`;
const optionKey = (
  environmentId: EnvironmentId | null,
  owner: "coordinator" | Role,
  modelKey: string,
) => `${scopedModelKey(environmentId, modelKey)}:${owner}`;

const pretty = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
const errText = (error: unknown) =>
  error instanceof Error ? error.message : "The repository task request failed.";
function unavailableModelLabel(key: string): string {
  try {
    const selection = JSON.parse(key) as { instanceId?: unknown; model?: unknown };
    return typeof selection.model === "string"
      ? `${selection.model} (${String(selection.instanceId ?? "provider")})`
      : "previous selection";
  } catch {
    return "previous selection";
  }
}

function availableModels(
  providers: ReturnType<typeof useEnvironmentProviders>,
  environmentId: EnvironmentId | null,
): AvailableModel[] {
  if (!environmentId) return [];
  const entries = deriveProviderInstanceEntries(providers.get(environmentId) ?? []);
  return entries.flatMap((provider) =>
    isProviderInstancePickerReady(provider) && provider.snapshot.supportsTextGeneration !== false
      ? provider.models.map((model) => {
          const selection: ModelSelection = { instanceId: provider.instanceId, model: model.slug };
          return {
            key: JSON.stringify(selection),
            selection,
            label: `${provider.displayName} · ${model.name}`,
            driver: provider.driverKind,
            models: provider.models,
            model,
          };
        })
      : [],
  );
}

function selectedOptionsUnavailable(
  model: AvailableModel | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  if (!model || !selections?.length) return false;
  const descriptors =
    getProviderModelCapabilities(model.models, model.model.slug, model.driver).optionDescriptors ??
    [];
  return selections.some((selection) => {
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (!descriptor) return true;
    if (descriptor.type === "boolean") return typeof selection.value !== "boolean";
    return (
      typeof selection.value !== "string" ||
      !descriptor.options.some((option) => option.id === selection.value)
    );
  });
}

function GraphView({
  task,
  projectById,
  onOpenThread,
}: {
  task: RepositoryTask;
  projectById: ReadonlyMap<ProjectId, { readonly title: string }>;
  onOpenThread: (threadId: ThreadId, diff?: boolean) => void;
}) {
  const nodes = task.graph.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const columnX = { coordinator: 105, repository: 365, agent: 625 } as const;
  const columnIndex = { coordinator: 0, repository: 0, agent: 0 };
  const positions = new Map(
    nodes.map((node) => {
      const index = columnIndex[node.kind]++;
      return [node.id, { x: columnX[node.kind], y: 42 + index * 98 }] as const;
    }),
  );
  const graphHeight = Math.max(120, ...[...positions.values()].map((point) => point.y + 70));
  return (
    <section aria-label="Task graph" className="space-y-4">
      <h2 className="text-base font-semibold">Execution graph</h2>
      {nodes.length ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-muted/20 p-3">
          <svg
            role="img"
            aria-label="Repository task nodes connected by recorded execution links"
            viewBox={`0 0 730 ${graphHeight}`}
            className="h-auto min-w-[730px] text-muted-foreground"
          >
            <defs>
              <marker
                id="repository-task-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            {task.graph.edges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              const fromX = source.x + 92;
              const toX = target.x - 92;
              return (
                <path
                  key={edge.id}
                  d={`M ${fromX} ${source.y + 28} C ${(fromX + toX) / 2} ${source.y + 28}, ${(fromX + toX) / 2} ${target.y + 28}, ${toX} ${target.y + 28}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={edge.kind === "merge" ? "5 4" : undefined}
                  markerEnd="url(#repository-task-arrow)"
                />
              );
            })}
            {nodes.map((node) => {
              const point = positions.get(node.id)!;
              const member =
                node.kind === "repository"
                  ? task.snapshot.members.find((member) => member.threadId === node.threadId)
                  : undefined;
              const fullTitle = node.title || pretty(node.kind);
              const label = (member && projectById.get(member.projectId)?.title) || fullTitle;
              return (
                <g key={node.id}>
                  <title>{fullTitle}</title>
                  <rect
                    x={point.x - 92}
                    y={point.y}
                    width="184"
                    height="58"
                    rx="10"
                    className="fill-card stroke-border"
                  />
                  <foreignObject x={point.x - 80} y={point.y + 10} width="160" height="38">
                    <div className="space-y-1 text-center">
                      <p aria-label={fullTitle} className="truncate text-xs text-foreground">
                        {label}
                      </p>
                      <p
                        aria-label={pretty(node.status)}
                        className="truncate text-3xs text-muted-foreground"
                      >
                        {pretty(node.status)}
                      </p>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}
      <div className="grid gap-2">
        {nodes.map((node) => (
          <article key={node.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{node.title || pretty(node.kind)}</p>
                <p className="text-xs text-muted-foreground">
                  {pretty(node.kind)}
                  {node.origin ? ` · ${pretty(node.origin)}` : ""}
                  {node.role ? ` · ${node.role}` : ""}
                  {node.modelSelection ? ` · ${node.modelSelection.model}` : ""}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                {pretty(node.status)}
              </span>
            </div>
            {node.threadId ? (
              <div className="mt-2 flex gap-2">
                <Button size="xs" variant="outline" onClick={() => onOpenThread(node.threadId!)}>
                  Open session
                </Button>
                {node.kind === "repository" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenThread(node.threadId!, true)}
                  >
                    Open diff
                  </Button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recorded links</h3>
        {task.graph.edges.length ? (
          <ul className="space-y-1 text-sm">
            {task.graph.edges.map((edge) => (
              <li key={edge.id} className="rounded-md bg-muted/50 px-3 py-2">
                <span>{byId.get(edge.source)?.title ?? "Unavailable"}</span>
                <span className="px-2 text-muted-foreground">→</span>
                <span>{byId.get(edge.target)?.title ?? "Unavailable"}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {pretty(edge.kind)} · {pretty(edge.status)}
                </span>
              </li>
            ))}
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

export function RepositoryTasksPage({
  environmentId: requestedEnvironmentId,
  taskId,
  onTaskChange,
}: {
  environmentId?: EnvironmentId;
  taskId?: string;
  onTaskChange: (taskId?: string, environmentId?: EnvironmentId) => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const serverConfigs = useServerConfigs();
  const environmentId = requestedEnvironmentId ?? primaryEnvironmentId;
  const [groupId, setGroupId] = useState("");
  const [groupTitle, setGroupTitle] = useState("");
  const [groupProjectIds, setGroupProjectIds] = useState<ProjectId[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [memberIds, setMemberIds] = useState<ProjectId[]>([]);
  const [coordinatorProjectId, setCoordinatorProjectId] = useState<ProjectId | "">("");
  const [workspaceChoices, setWorkspaceChoices] = useState<Record<string, WorkspaceChoice>>({});
  const [modelKey, setModelKey] = useState("");
  const [modelOptionsByKey, setModelOptionsByKey] = useState<
    Record<string, ReadonlyArray<ProviderOptionSelection> | undefined>
  >({});
  const [roleKeys, setRoleKeys] = useState<Record<Role, string>>({
    implementation: "",
    research: "",
    review: "",
    design: "",
    test: "",
    general: "",
  });
  const [selectedRoles, setSelectedRoles] = useState<Role[]>(["implementation"]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // This filtered list is intentionally stable because it drives member form state.
  // eslint-disable-next-line t3code/no-manual-memo -- keep effect inputs referentially stable
  const envProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const capability =
    !!environmentId &&
    serverConfigs.get(environmentId)?.environment.capabilities.repositoryTasks === true;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const groupsAtom =
    capability && environmentId
      ? repositoryTaskEnvironment.groups({ environmentId, input: {} })
      : null;
  const tasksAtom =
    capability && environmentId
      ? repositoryTaskEnvironment.tasks({ environmentId, input: { archived: showArchived } })
      : null;
  const detailAtom =
    capability && environmentId && taskId
      ? repositoryTaskEnvironment.task({ environmentId, input: { taskId } })
      : null;
  const updatesAtom =
    capability && environmentId && taskId
      ? repositoryTaskEnvironment.taskUpdates({ environmentId, input: { taskId } })
      : null;
  const groupsQuery = useEnvironmentQuery(groupsAtom);
  const tasksQuery = useEnvironmentQuery(tasksAtom);
  const detailQuery = useEnvironmentQuery(detailAtom);
  const updatesQuery = useEnvironmentQuery(updatesAtom);
  const groups = groupsQuery.data?.groups ?? [];
  const tasks = tasksQuery.data?.tasks ?? [];
  const task = updatesQuery.data?.snapshot.id === taskId ? updatesQuery.data : detailQuery.data;
  const selectedGroup = groups.find((group) => group.id === groupId);
  const savedGroupProjectIds = selectedGroup?.projectIds ?? EMPTY_PROJECT_IDS;
  const models = availableModels(providers, environmentId);
  const currentModelsByKey = new Map(models.map((model) => [model.key, model]));
  const projectById = new Map(envProjects.map((project) => [project.id, project]));
  const selectedModelKey = modelKey;
  const roleModelKey = (role: Role) => roleKeys[role];

  useLiveRefresh(groupsQuery.refresh, {
    enabled: capability,
    key: `repository-groups:${environmentId}`,
  });
  useLiveRefresh(tasksQuery.refresh, {
    enabled: capability,
    key: `repository-tasks:${environmentId}`,
  });
  const upsertGroup = useAtomCommand(repositoryTaskEnvironment.upsertGroup, {
    reportFailure: false,
  });
  const deleteGroup = useAtomCommand(repositoryTaskEnvironment.deleteGroup, {
    reportFailure: false,
  });
  const createTask = useAtomCommand(repositoryTaskEnvironment.createTask, { reportFailure: false });
  const stopTask = useAtomCommand(repositoryTaskEnvironment.stopTask, { reportFailure: false });
  const acknowledgeTask = useAtomCommand(repositoryTaskEnvironment.acknowledgeTask, {
    reportFailure: false,
  });
  const archiveTask = useAtomCommand(repositoryTaskEnvironment.archiveTask, {
    reportFailure: false,
  });
  const unarchiveTask = useAtomCommand(repositoryTaskEnvironment.unarchiveTask, {
    reportFailure: false,
  });
  const selectedModel = models.find((model) => model.key === selectedModelKey)?.selection;
  const selectedModelDetails = currentModelsByKey.get(selectedModelKey);
  const coordinatorOptionsKey = optionKey(environmentId, "coordinator", selectedModelKey);
  const selectedModelOptions = modelOptionsByKey[coordinatorOptionsKey];
  const modelSelectionWithOptions = (key: string, selectionOptionsKey: string) => {
    const model = currentModelsByKey.get(key);
    if (!model) return undefined;
    const options = modelOptionsByKey[selectionOptionsKey];
    return options?.length ? { ...model.selection, options } : model.selection;
  };
  const groupIsDirty =
    !selectedGroup ||
    selectedGroup.title !== groupTitle ||
    selectedGroup.projectIds.length !== groupProjectIds.length ||
    selectedGroup.projectIds.some((id) => !groupProjectIds.includes(id));
  const sameEnvironmentGroup =
    !!selectedGroup &&
    savedGroupProjectIds.length > 0 &&
    savedGroupProjectIds.every((id) => projectById.has(id));
  const taskMemberIds = memberIds.filter((id) => savedGroupProjectIds.includes(id));
  const coordinatorModelAvailable = !!selectedModel;
  const unselectedRoles = selectedRoles.filter((role) => !roleModelKey(role));
  const unavailableRoles = selectedRoles.filter(
    (role) => !!roleModelKey(role) && !models.some((model) => model.key === roleModelKey(role)),
  );
  const unavailableSelectedOptions =
    selectedOptionsUnavailable(selectedModelDetails, selectedModelOptions) ||
    selectedRoles.some((role) =>
      selectedOptionsUnavailable(
        currentModelsByKey.get(roleModelKey(role)),
        modelOptionsByKey[optionKey(environmentId, role, roleModelKey(role))],
      ),
    );
  const taskAllowed =
    !!environmentId &&
    capability &&
    canOperate &&
    sameEnvironmentGroup &&
    !groupIsDirty &&
    taskMemberIds.length >= 1 &&
    savedGroupProjectIds.includes(coordinatorProjectId as ProjectId) &&
    coordinatorModelAvailable &&
    selectedRoles.length > 0 &&
    unselectedRoles.length === 0 &&
    !!taskTitle.trim() &&
    !!prompt.trim() &&
    unavailableRoles.length === 0 &&
    !unavailableSelectedOptions;

  function updateModelOptions(
    key: string,
    nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) {
    setModelOptionsByKey((current) => {
      const previous = current[key];
      const unchanged =
        previous === nextOptions ||
        (!!previous &&
          !!nextOptions &&
          previous.length === nextOptions.length &&
          previous.every(
            (option, index) =>
              option.id === nextOptions[index]?.id && option.value === nextOptions[index]?.value,
          ));
      if (unchanged) return current;
      const next = { ...current };
      if (nextOptions?.length) next[key] = nextOptions;
      else delete next[key];
      return next;
    });
  }

  function selectGroup(group: RepositoryGroup | null) {
    setGroupId(group?.id ?? "");
    setGroupTitle(group?.title ?? "");
    setGroupProjectIds(group ? [...group.projectIds] : []);
    setMemberIds(group ? [...group.projectIds] : []);
    setCoordinatorProjectId(group?.projectIds[0] ?? "");
  }
  async function saveGroup() {
    if (
      !environmentId ||
      !canOperate ||
      !groupTitle.trim() ||
      groupProjectIds.length < 2 ||
      !groupProjectIds.every((id) => projectById.has(id))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await upsertGroup({
        environmentId,
        input: {
          id: groupId || randomUUID(),
          title: groupTitle.trim(),
          projectIds: groupProjectIds,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setGroupId(result.value.id);
      setMemberIds([...result.value.projectIds]);
      groupsQuery.refresh();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function removeGroup() {
    if (!environmentId || !canOperate || !groupId) return;
    setBusy(true);
    setError("");
    try {
      const result = await deleteGroup({ environmentId, input: { id: groupId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      selectGroup(null);
      groupsQuery.refresh();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function startTask() {
    if (!environmentId || !taskAllowed || !selectedModel) return;
    setBusy(true);
    setError("");
    try {
      const result = await createTask({
        environmentId,
        input: {
          id: randomUUID(),
          groupId,
          title: taskTitle.trim(),
          prompt: prompt.trim(),
          coordinatorProjectId: coordinatorProjectId as ProjectId,
          modelSelection:
            modelSelectionWithOptions(selectedModelKey, coordinatorOptionsKey) ?? selectedModel,
          roles: selectedRoles.map((role) => ({
            role,
            modelSelection: modelSelectionWithOptions(
              roleModelKey(role),
              optionKey(environmentId, role, roleModelKey(role)),
            )!,
          })),
          runtimeMode: "approval-required" satisfies RuntimeMode,
          interactionMode: "default" satisfies ProviderInteractionMode,
          members: taskMemberIds.map((projectId) => ({
            projectId,
            workspaceStrategy:
              workspaceChoices[projectId] === "worktree"
                ? { type: "worktree" as const, baseRef: "HEAD" }
                : { type: "root" as const },
          })),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setTaskTitle("");
      setPrompt("");
      tasksQuery.refresh();
      onTaskChange(result.value.snapshot.id, environmentId);
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(false);
    }
  }
  async function runSelectedTaskCommand(command: typeof stopTask) {
    if (!environmentId || !taskId || !canOperate) return;
    setBusy(true);
    setError("");
    try {
      const result = await command({ environmentId, input: { taskId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      detailQuery.refresh();
      tasksQuery.refresh();
    } catch (reason) {
      setError(errText(reason));
    } finally {
      setBusy(false);
    }
  }
  function openThread(threadId: ThreadId, diff = false) {
    if (!environmentId) return;
    const ref = scopeThreadRef(environmentId, threadId);
    if (diff) useRightPanelStore.getState().open(ref, "diff");
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  }

  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-auto p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Repository tasks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Group projects on one host, launch a coordinated task, and follow its recorded
            execution.
          </p>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            A task keeps its selected repositories, workspaces, role models, and starting revisions.
            Reopen any saved task to inspect its sessions, diffs, and execution graph; Stop applies
            to the whole task.
          </p>
        </div>
        <Select
          value={environmentId ?? ""}
          onValueChange={(value) => {
            selectGroup(null);
            onTaskChange(undefined, value ? (value as EnvironmentId) : undefined);
          }}
        >
          <SelectTrigger aria-label="Task host" className="min-w-48">
            <SelectValue>{selectedEnvironment?.label ?? "Choose a host"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {environments.map((environment) => (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </header>
      {environmentId && !capability ? (
        <div
          role="status"
          className="rounded-lg border border-border p-4 text-sm text-muted-foreground"
        >
          This connected server does not support repository tasks yet.
        </div>
      ) : null}
      {environmentId && capability && !canOperate ? (
        <div
          role="status"
          className="rounded-lg border border-border p-4 text-sm text-muted-foreground"
        >
          This connection is read-only. Ask its owner for permission to change projects and tasks.
        </div>
      ) : null}
      {capability && (groupsQuery.error || tasksQuery.error) ? (
        <p role="alert" className="text-sm text-destructive">
          {groupsQuery.error ?? tasksQuery.error}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {capability ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section className="space-y-5 rounded-xl border border-border p-4">
            <div>
              <h2 className="text-lg font-semibold">Repository groups</h2>
              <p className="text-sm text-muted-foreground">
                Each group contains projects from this host. T3’s existing checkout groups remain
                separate.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <Button
                  key={group.id}
                  size="sm"
                  variant={group.id === groupId ? "secondary" : "outline"}
                  onClick={() => selectGroup(group)}
                >
                  {group.title}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => selectGroup(null)}>
                New group
              </Button>
            </div>
            <label className="grid gap-1 text-sm font-medium">
              Group name
              <Input
                value={groupTitle}
                onChange={(event) => setGroupTitle(event.target.value)}
                maxLength={200}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Projects (choose at least two)</legend>
              {envProjects.length ? (
                envProjects.map((project) => (
                  <label key={project.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={groupProjectIds.includes(project.id)}
                      onCheckedChange={(checked) =>
                        setGroupProjectIds((ids) =>
                          checked
                            ? [...new Set([...ids, project.id])]
                            : ids.filter((id) => id !== project.id),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">{project.title}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No projects are available on this host.
                </p>
              )}
            </fieldset>
            <div className="flex gap-2">
              <Button
                onClick={() => void saveGroup()}
                disabled={!canOperate || busy || groupProjectIds.length < 2 || !groupTitle.trim()}
              >
                <CheckIcon />
                Save group
              </Button>
              {groupId ? (
                <Button
                  variant="outline"
                  onClick={() => void removeGroup()}
                  disabled={!canOperate || busy}
                >
                  <Trash2Icon />
                  Delete
                </Button>
              ) : null}
            </div>
          </section>

          <section className="space-y-5 rounded-xl border border-border p-4">
            <div>
              <h2 className="text-lg font-semibold">Start a task</h2>
              <p className="text-sm text-muted-foreground">
                The task keeps its selected repositories and starting revisions.
              </p>
            </div>
            <Select
              value={groupId}
              onValueChange={(value) =>
                selectGroup(groups.find((group) => group.id === value) ?? null)
              }
            >
              <SelectTrigger aria-label="Repository group">
                <SelectValue>
                  {groups.find((group) => group.id === groupId)?.title ?? "Choose a saved group"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <label className="grid gap-1 text-sm font-medium">
              Task name
              <Input
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                maxLength={200}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Prompt
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                maxLength={120000}
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">Repositories and workspaces</legend>
              {savedGroupProjectIds
                .filter((id) => projectById.has(id))
                .map((id) => (
                  <div
                    key={id}
                    className="grid gap-2 rounded-lg bg-muted/40 p-3 sm:grid-cols-[1fr_auto] sm:items-center"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={memberIds.includes(id)}
                        onCheckedChange={(checked) =>
                          setMemberIds((ids) =>
                            checked
                              ? [...new Set([...ids, id])]
                              : ids.filter((item) => item !== id),
                          )
                        }
                      />
                      {projectById.get(id)?.title}
                    </label>
                    <Select
                      value={workspaceChoices[id] ?? "root"}
                      onValueChange={(value) =>
                        setWorkspaceChoices((current) => ({
                          ...current,
                          [id]: value === "worktree" ? "worktree" : "root",
                        }))
                      }
                    >
                      <SelectTrigger
                        aria-label={`${projectById.get(id)?.title} workspace`}
                        size="sm"
                      >
                        <SelectValue>
                          {workspaceChoices[id] === "worktree"
                            ? "New worktree"
                            : "Project workspace"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="root">Project workspace</SelectItem>
                        <SelectItem value="worktree">New worktree</SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>
                ))}
            </fieldset>
            <Select
              value={coordinatorProjectId as string}
              onValueChange={(value) => setCoordinatorProjectId(value ? (value as ProjectId) : "")}
            >
              <SelectTrigger aria-label="Coordinator project">
                <SelectValue>
                  {coordinatorProjectId
                    ? (projectById.get(coordinatorProjectId)?.title ?? "Choose coordinator project")
                    : "Choose coordinator project"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {savedGroupProjectIds
                  .filter((id) => projectById.has(id))
                  .map((id) => (
                    <SelectItem key={id} value={id}>
                      {projectById.get(id)?.title}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
            <ModelSelect
              label="Coordinator model"
              models={models}
              value={selectedModelKey}
              onChange={(value) => setModelKey(value)}
            />
            <ModelOptionsPicker
              model={selectedModelDetails}
              options={selectedModelOptions}
              prompt={prompt}
              onPromptChange={setPrompt}
              onChange={(options) => updateModelOptions(coordinatorOptionsKey, options)}
              disabled={!currentModelsByKey.has(selectedModelKey)}
              selectionLabel="coordinator model"
            />
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-medium">Agent roles</legend>
              {ROLES.map((role) => (
                <div key={role} className="space-y-2 rounded-lg bg-muted/40 p-3">
                  <label className="flex items-center gap-2 text-sm font-medium capitalize">
                    <Checkbox
                      checked={selectedRoles.includes(role)}
                      onCheckedChange={(checked) =>
                        setSelectedRoles((current) =>
                          checked
                            ? [...new Set([...current, role])]
                            : current.filter((item) => item !== role),
                        )
                      }
                    />
                    {role}
                  </label>
                  {selectedRoles.includes(role) ? (
                    <>
                      <ModelSelect
                        label={`${role} model`}
                        models={models}
                        value={roleModelKey(role)}
                        onChange={(value) =>
                          setRoleKeys((current) => ({ ...current, [role]: value }))
                        }
                      />
                      <ModelOptionsPicker
                        model={currentModelsByKey.get(roleModelKey(role))}
                        options={
                          modelOptionsByKey[optionKey(environmentId, role, roleModelKey(role))]
                        }
                        prompt={prompt}
                        onPromptChange={setPrompt}
                        onChange={(options) =>
                          updateModelOptions(
                            optionKey(environmentId, role, roleModelKey(role)),
                            options,
                          )
                        }
                        disabled={!currentModelsByKey.has(roleModelKey(role))}
                        selectionLabel={`${role} model`}
                      />
                    </>
                  ) : null}
                </div>
              ))}
            </fieldset>
            {!coordinatorModelAvailable ||
            unselectedRoles.length > 0 ||
            unavailableRoles.length > 0 ||
            unavailableSelectedOptions ||
            selectedRoles.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                {selectedRoles.length === 0
                  ? "Select at least one agent role."
                  : unavailableSelectedOptions
                    ? "A selected model option is no longer advertised. Choose an available option before creating the task."
                    : unavailableRoles.length > 0 ||
                        (!!selectedModelKey && !coordinatorModelAvailable)
                      ? "A selected model is no longer available. Choose an available coordinator and role model before creating the task."
                      : "Choose a coordinator model and a model for each selected role."}
              </p>
            ) : null}
            {groupIsDirty ? (
              <p role="status" className="text-sm text-muted-foreground">
                Save group changes before creating a task. Tasks use the saved group membership.
              </p>
            ) : null}
            <Button onClick={() => void startTask()} disabled={!taskAllowed || busy}>
              <PlayIcon />
              Create and start task
            </Button>
          </section>

          <section className="space-y-4 rounded-xl border border-border p-4 xl:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Tasks</h2>
                <p className="text-sm text-muted-foreground">
                  Reopen a task to see current participant state.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={showArchived ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((current) => !current)}
                >
                  <ArchiveIcon />
                  Archived
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={tasksQuery.refresh}
                  disabled={tasksQuery.isPending}
                >
                  <RefreshCwIcon />
                  Refresh
                </Button>
              </div>
            </div>
            {tasksQuery.isPending && !tasks.length ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading repository tasks…
              </p>
            ) : tasks.length ? (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tasks.map((item) => (
                  <li key={item.snapshot.id}>
                    <Button
                      size="sm-multiline"
                      className="h-auto w-full justify-between whitespace-normal text-left"
                      variant={item.snapshot.id === taskId ? "secondary" : "outline"}
                      onClick={() => onTaskChange(item.snapshot.id, environmentId ?? undefined)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{item.snapshot.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {item.snapshot.groupTitle}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs capitalize">{pretty(item.status)}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {showArchived
                  ? "No archived repository tasks on this host."
                  : "No repository tasks on this host yet."}
              </p>
            )}
          </section>
          {taskId ? (
            <section
              className="space-y-6 rounded-xl border border-border p-4 xl:col-span-2"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {task?.snapshot.title ?? "Loading task…"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {task
                      ? `${task.snapshot.groupTitle} · ${pretty(task.status)} · ${pretty(task.state)}`
                      : "Loading saved task state"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {task && needsAcknowledgement(task) ? (
                    <Button
                      variant="outline"
                      onClick={() => void runSelectedTaskCommand(acknowledgeTask)}
                      disabled={!canOperate || busy}
                    >
                      <CheckIcon />
                      Acknowledge observed state
                    </Button>
                  ) : null}
                  {task && (task.state === "finished" || task.state === "stopped") ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void runSelectedTaskCommand(task.archivedAt ? unarchiveTask : archiveTask)
                      }
                      disabled={!canOperate || busy}
                    >
                      {task.archivedAt ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                      {task.archivedAt ? "Unarchive" : "Archive"}
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      onClick={() => void runSelectedTaskCommand(stopTask)}
                      disabled={
                        !canOperate ||
                        busy ||
                        !task ||
                        (task.state !== "active" && task.state !== "uncertain")
                      }
                    >
                      <SquareIcon />
                      Stop task
                    </Button>
                  )}
                </div>
              </div>
              {task && needsAcknowledgement(task) ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Sigma T3 lost track of whether part of this task started. Acknowledging records
                  what the server can confirm: confirmed launches continue, the rest are marked
                  abandoned and never start again.
                </p>
              ) : null}
              {task ? (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    <article className="rounded-lg bg-muted/40 p-3">
                      <h3 className="font-medium">
                        Coordinator ·{" "}
                        {projectById.get(task.snapshot.coordinatorWorkspaceProjectId)?.title ??
                          "workspace"}
                      </h3>
                      <p className="text-sm">{pretty(task.coordinatorStatus)}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.snapshot.modelSelection.model}
                      </p>
                      <Button
                        className="mt-2"
                        size="xs"
                        variant="outline"
                        onClick={() => openThread(task.snapshot.coordinatorThreadId)}
                      >
                        Open coordinator
                      </Button>
                    </article>
                    {task.members.map((member) => (
                      <article
                        key={member.snapshot.projectId}
                        className="rounded-lg bg-muted/40 p-3"
                      >
                        <div className="flex justify-between gap-2">
                          <h3 className="font-medium">
                            {projectById.get(member.snapshot.projectId)?.title ??
                              member.snapshot.workspaceRoot}
                          </h3>
                          <span className="text-xs capitalize">{pretty(member.status)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {pretty(member.launchState)} · {pretty(member.deliveryState)}
                          {member.role ? ` · ${member.role}` : ""}
                          {member.pendingApproval ? " · approval needed" : ""}
                        </p>
                        {member.workspacePath ? (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {member.workspacePath}
                          </p>
                        ) : null}
                        {member.branch ? (
                          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <GitBranchIcon className="size-3" />
                            {member.branch}
                          </p>
                        ) : null}
                        {member.preparedRevision ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Prepared at {member.preparedRevision.slice(0, 10)}
                          </p>
                        ) : null}
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openThread(member.snapshot.threadId)}
                          >
                            Open session
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => openThread(member.snapshot.threadId, true)}
                          >
                            Open diff
                          </Button>
                        </div>
                        {environmentId ? (
                          <RepositoryTaskMerges
                            environmentId={environmentId}
                            taskId={task.snapshot.id}
                            merges={member.merges}
                            canApply={canOperate && task.state === "active"}
                            onApplied={() => {
                              detailQuery.refresh();
                              tasksQuery.refresh();
                            }}
                          />
                        ) : null}
                      </article>
                    ))}
                  </div>
                  <GraphView task={task} projectById={projectById} onOpenThread={openThread} />
                </>
              ) : detailQuery.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {detailQuery.error}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Waiting for the server task snapshot.
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function ModelSelect({
  label,
  models,
  value,
  onChange,
}: {
  label: string;
  models: AvailableModel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = models.find((model) => model.key === value);
  const unavailable = !!value && !selected;
  return (
    <label className="grid min-w-0 gap-1 text-sm font-medium">
      {label}
      <Select value={value} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>
            {selected?.label ??
              (unavailable
                ? `Unavailable: ${unavailableModelLabel(value)}`
                : models.length
                  ? "Choose a model"
                  : "No available models")}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {unavailable ? (
            <SelectItem value={value} disabled>
              Unavailable: {unavailableModelLabel(value)}
            </SelectItem>
          ) : null}
          {models.map((model) => (
            <SelectItem key={model.key} value={model.key}>
              {model.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

function ModelOptionsPicker({
  model,
  options,
  prompt,
  onPromptChange,
  onChange,
  disabled,
  selectionLabel,
}: {
  model: AvailableModel | undefined;
  options: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  disabled: boolean;
  selectionLabel: string;
}) {
  if (!model) return null;
  const hasOptions = shouldRenderTraitsControls({
    provider: model.driver,
    models: model.models,
    model: model.selection.model,
    prompt,
    modelOptions: options,
    allowPromptInjectedEffort: false,
    planModeEnabled: true,
  });
  const hasStaleOptions = selectedOptionsUnavailable(model, options);
  if (!hasOptions && !hasStaleOptions) return null;
  return (
    <div className="flex items-center gap-2">
      {hasOptions ? (
        <>
          <span className="text-xs font-medium text-muted-foreground">Options</span>
          <TraitsPicker
            provider={model.driver}
            instanceId={model.selection.instanceId}
            models={model.models}
            model={model.selection.model}
            prompt={prompt}
            onPromptChange={onPromptChange}
            modelOptions={options}
            onModelOptionsChange={onChange}
            allowPromptInjectedEffort={false}
            planModeEnabled={true}
            disabled={disabled}
          />
        </>
      ) : null}
      {hasStaleOptions ? (
        <>
          <span role="status" className="text-xs text-destructive">
            Saved options are no longer advertised.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            Clear unavailable options for {selectionLabel}
          </Button>
        </>
      ) : null}
    </div>
  );
}
