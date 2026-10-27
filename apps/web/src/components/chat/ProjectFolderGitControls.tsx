import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSourceControlWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { sanitizeNewRefName } from "@t3tools/shared/git";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CloudUploadIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
} from "lucide-react";
import { useDeferredValue, useState, useTransition } from "react";

import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
} from "../../lib/sourceControlActions";
import { randomUUID } from "../../lib/utils";
import { usePaginatedBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "../BranchPicker";
import { Button } from "../ui/button";
import { ComboboxItem, ComboboxTrigger } from "../ui/combobox";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const CREATE_REF_PREFIX = "__create_new_branch__:";

function folderName(path: string) {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * Git for one of the project's extra folders. Unlike the main checkout it is not tied to the
 * thread, so it offers the plain repository actions: branch, commit, push or publish, pull.
 */
export function ProjectFolderGitControls({
  environmentId,
  folder,
}: {
  environmentId: EnvironmentId;
  folder: string;
}) {
  const scope = { environmentId, cwd: folder };
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: folder } }),
  );
  const status = statusQuery.data ?? null;
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const stacked = useGitStackedAction(scope);
  const pull = useVcsPullAction(scope);
  const init = useVcsInitAction(scope);
  const busy = useSourceControlActionRunning(scope, ["runStackedAction", "pull", "init"]);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  const runStacked = async (action: "commit" | "push", message?: string) => {
    const result = await stacked.run({
      actionId: randomUUID(),
      action,
      ...(message ? { commitMessage: message } : {}),
    });
    if (result._tag === "Failure") {
      reportFailure(action === "commit" ? "Commit failed" : "Push failed", result);
      return;
    }
    toastManager.add({
      type: "success",
      title: result.value.toast.title,
      description: result.value.toast.description,
    });
  };
  const commit = () => {
    const message = commitMessage.trim();
    setCommitOpen(false);
    setCommitMessage("");
    void runStacked("commit", message);
  };
  const runPull = async () => {
    const result = await pull.run();
    if (result._tag === "Failure") reportFailure("Pull failed", result);
  };

  const header = (
    <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-medium text-foreground/80">
      <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className="min-w-0 truncate">{folderName(folder)}</span>
    </div>
  );

  if (status && !status.isRepo) {
    return (
      <div className="mt-1 flex flex-col border-t border-border/60 pt-1">
        {header}
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          disabled={!canWrite || busy}
          onClick={() => void init.run()}
        >
          <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          Initialize Git
        </ThreadDetailsControl>
      </div>
    );
  }

  const changes = status?.workingTree.files.length ?? 0;
  const ahead = status?.aheadCount ?? 0;
  const behind = status?.behindCount ?? 0;
  // A branch without an upstream is pushed with --set-upstream, which publishes it.
  const publishes = status !== null && status.hasPrimaryRemote && !status.hasUpstream;
  const canPush =
    status !== null &&
    status.refName !== null &&
    behind === 0 &&
    (publishes || (status.hasUpstream && ahead > 0));
  const canPull = status !== null && status.hasUpstream && behind > 0;
  const disabled = !canWrite || busy || status === null;

  return (
    <div className="mt-1 flex flex-col border-t border-border/60 pt-1">
      {header}
      <FolderBranchPicker
        environmentId={environmentId}
        folder={folder}
        current={status?.refName ?? null}
        disabled={disabled}
        onChanged={statusQuery.refresh}
      />
      <div role="group" aria-label={`Git actions for ${folder}`} className="flex gap-1 px-1">
        <Popover open={commitOpen} onOpenChange={setCommitOpen}>
          <PopoverTrigger
            render={<Button size="xs" variant="ghost" />}
            disabled={disabled || changes === 0}
          >
            <GitCommitHorizontalIcon />
            Commit{changes > 0 ? ` ${changes}` : ""}
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-72">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                commit();
              }}
            >
              <Textarea
                aria-label="Commit message"
                placeholder="Leave empty to generate a message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <Button type="submit" size="sm">
                {changes === 1 ? "Commit 1 file" : `Commit ${changes} files`}
              </Button>
            </form>
          </PopoverPopup>
        </Popover>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || !canPush}
          onClick={() => void runStacked("push")}
        >
          {publishes ? <CloudUploadIcon /> : <ArrowUpIcon />}
          {publishes ? "Publish" : `Push${ahead > 0 ? ` ${ahead}` : ""}`}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || !canPull}
          onClick={() => void runPull()}
        >
          <ArrowDownIcon />
          Pull{behind > 0 ? ` ${behind}` : ""}
        </Button>
      </div>
    </div>
  );
}

function FolderBranchPicker({
  environmentId,
  folder,
  current,
  disabled,
  onChanged,
}: {
  environmentId: EnvironmentId;
  folder: string;
  current: string | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim();
  const [pending, startTransition] = useTransition();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const branches = usePaginatedBranches({
    environmentId,
    cwd: open ? folder : null,
    query: sanitizeNewRefName(deferredQuery),
  });
  const refByName = new Map(branches.refs.map((ref) => [ref.name, ref] as const));
  const newRefName = sanitizeNewRefName(query.trim());
  const createItem =
    newRefName.length > 0 && !refByName.has(newRefName)
      ? `${CREATE_REF_PREFIX}${newRefName}`
      : null;
  const items = [...branches.refs.map((ref) => ref.name), ...(createItem ? [createItem] : [])];
  const normalizedQuery = deferredQuery.toLowerCase();
  const filteredItems =
    normalizedQuery.length === 0
      ? items
      : items.filter((item) => item === createItem || item.toLowerCase().includes(normalizedQuery));
  const hasNextPage = branches.data?.nextCursor !== null && branches.data?.nextCursor !== undefined;

  const select = (item: string) => {
    setOpen(false);
    setQuery("");
    startTransition(async () => {
      if (item.startsWith(CREATE_REF_PREFIX)) {
        const result = await createRef({
          environmentId,
          input: { cwd: folder, refName: item.slice(CREATE_REF_PREFIX.length), switchRef: true },
        });
        if (result._tag === "Failure") reportFailure("Failed to create branch", result);
      } else if (item !== current) {
        const result = await switchRef({ environmentId, input: { cwd: folder, refName: item } });
        if (result._tag === "Failure") reportFailure("Failed to switch branch", result);
      }
      onChanged();
    });
  };

  return (
    <BranchPicker
      items={items}
      filteredItems={filteredItems}
      value={current}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onSelectItem={select}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={branches.isPending && branches.data === null ? "Loading branches..." : null}
      getItemType={(item) => (item === createItem ? "create-branch" : "branch")}
      popupProps={{ align: "start", side: "bottom", className: "flex w-(--anchor-width) flex-col" }}
      renderItem={(item, index) => {
        if (item === createItem) {
          return (
            <ComboboxItem
              hideIndicator
              key={item}
              index={index}
              value={item}
              onClick={() => select(item)}
            >
              <span className="truncate">Create branch &quot;{newRefName}&quot;</span>
            </ComboboxItem>
          );
        }
        const ref = refByName.get(item);
        return ref ? (
          <BranchPickerRefItem
            key={item}
            branch={ref}
            projectCwd={folder}
            index={index}
            onClick={() => select(item)}
          />
        ) : null;
      }}
    >
      <ComboboxTrigger
        render={<ThreadDetailsControl part="select" />}
        aria-label={`Branch of ${folder}`}
        className="min-w-0 max-w-full active:scale-100"
        disabled={disabled || pending}
      >
        <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <MiddleTruncate value={current ?? "Detached HEAD"} className="w-full" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
