import type { EnvironmentId, RepositoryTaskMerge } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { repositoryTaskEnvironment } from "../../state/repositoryTasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";

const MergeIcon = PullRequestGlyph.merged;

const RepositoryTaskMergeFiles = lazy(() => import("./RepositoryTaskMergeFiles"));

const PREVIEWABLE = new Set<RepositoryTaskMerge["status"]>(["applied", "conflict", "failed"]);
const PREVIEW_NOTE = {
  applied: "Written into the member workspace. Nothing was staged or committed.",
  ready:
    "This merge now applies cleanly. Applying writes exactly these files and is refused if either workspace changes first.",
  conflict:
    "Nothing was written. Resolve the conflict in the member workspace or the agent worktree, then refresh the preview.",
  empty: "Nothing is left to merge from this worktree.",
} as const;

export function RepositoryTaskMerges({
  environmentId,
  taskId,
  merges,
  canApply,
  onApplied,
}: {
  environmentId: EnvironmentId;
  taskId: string;
  merges: ReadonlyArray<RepositoryTaskMerge>;
  canApply: boolean;
  onApplied: () => void;
}) {
  if (merges.length === 0) return null;
  return (
    <section aria-label="Agent worktree merges" className="mt-3 space-y-2">
      <h4 className="flex items-center gap-1 text-xs font-medium">
        <MergeIcon className="size-3" />
        Agent worktree merges
      </h4>
      <ul className="space-y-2">
        {merges.map((merge) => (
          <MergeRow
            key={merge.sourceThreadId}
            environmentId={environmentId}
            taskId={taskId}
            merge={merge}
            canApply={canApply}
            onApplied={onApplied}
          />
        ))}
      </ul>
    </section>
  );
}

function MergeRow({
  environmentId,
  taskId,
  merge,
  canApply,
  onApplied,
}: {
  environmentId: EnvironmentId;
  taskId: string;
  merge: RepositoryTaskMerge;
  canApply: boolean;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = { taskId, sourceThreadId: merge.sourceThreadId };
  const preview = useEnvironmentQuery(
    open ? repositoryTaskEnvironment.mergePreview({ environmentId, input }) : null,
  );
  const applyMerge = useAtomCommand(repositoryTaskEnvironment.applyMerge, {
    reportFailure: false,
  });
  const data = preview.data?.sourceThreadId === merge.sourceThreadId ? preview.data : null;

  async function apply(token: string) {
    setBusy(true);
    setError("");
    const result = await applyMerge({ environmentId, input: { ...input, token } });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error && "reason" in failure && failure.reason === "conflict"
          ? "A workspace changed after this preview. Refresh it and review again."
          : failure instanceof Error
            ? failure.message
            : "The merge could not be applied.",
      );
      return;
    }
    preview.refresh();
    onApplied();
  }

  return (
    <li className="rounded-md bg-background/60 px-2 py-1.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all">{merge.worktreePath}</p>
          <p className="text-muted-foreground">
            {merge.status}
            {merge.files.length ? ` · ${merge.files.join(", ")}` : ""}
          </p>
          {merge.error ? <p className="text-muted-foreground">{merge.error}</p> : null}
        </div>
        {PREVIEWABLE.has(merge.status) ? (
          <Button size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide preview" : "Preview"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          {preview.error ? (
            <p role="alert" className="text-destructive">
              {preview.error}
            </p>
          ) : data === null ? (
            <p className="text-muted-foreground">Planning the merge…</p>
          ) : (
            <>
              <p role="status" className="text-muted-foreground">
                {PREVIEW_NOTE[data.status]}
              </p>
              {data.files.length ? (
                <Suspense fallback={<p className="text-muted-foreground">Loading diff…</p>}>
                  <RepositoryTaskMergeFiles files={data.files} />
                </Suspense>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            {data?.status !== "applied" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={preview.isPending}
                onClick={() => preview.refresh()}
              >
                <RefreshCwIcon />
                Refresh preview
              </Button>
            ) : null}
            {data?.status === "ready" && data.token !== null && canApply ? (
              <Button size="xs" disabled={busy} onClick={() => void apply(data.token!)}>
                <MergeIcon />
                Apply to workspace
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
