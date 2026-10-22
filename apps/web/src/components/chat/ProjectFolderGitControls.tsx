import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { memo } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import BaseGitActionsControl from "../GitActionsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const GitActionsControl = memo(BaseGitActionsControl);

function folderName(path: string) {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

/** Git state and actions for one of the project's extra folders, next to the main checkout's. */
export function ProjectFolderGitControls({
  environmentId,
  folder,
  activeThreadRef,
  draftId,
  compact,
}: {
  environmentId: EnvironmentId;
  folder: string;
  activeThreadRef: ScopedThreadRef;
  draftId: DraftId | undefined;
  compact: boolean;
}) {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: folder } }),
  ).data;

  return (
    <div
      className="mt-1 flex flex-col border-t border-border/60 pt-1"
      aria-label={`Folder ${folder}`}
    >
      <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-medium text-foreground/80">
        <FolderIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className="shrink-0">{folderName(folder)}</span>
        {status?.isRepo && status.refName ? (
          <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
            {status.refName}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 gap-1.5 text-xs font-normal text-muted-foreground tabular-nums">
          {status?.isRepo && status.aheadCount > 0 ? <span>↑{status.aheadCount}</span> : null}
          {status?.isRepo && status.behindCount > 0 ? <span>↓{status.behindCount}</span> : null}
        </span>
      </div>
      <GitActionsControl
        displayMode="panel"
        compact={compact}
        gitCwd={folder}
        activeThreadRef={activeThreadRef}
        tracksThreadBranch={false}
        {...(draftId ? { draftId } : {})}
      />
    </div>
  );
}
