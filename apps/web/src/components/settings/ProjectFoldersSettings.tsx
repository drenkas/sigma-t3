import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon, XIcon } from "lucide-react";
import { useState, type DragEvent } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Extra folders an agent may work in, kept per checkout because paths belong to one machine. */
export function ProjectFoldersSettings({
  members,
  canEdit,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
  canEdit: (environmentId: EnvironmentId) => boolean;
}) {
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const saveFolders = async (member: SidebarProjectGroupMember, folders: ReadonlyArray<string>) => {
    const result = mapAtomCommandResult(
      await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, additionalWorkspaceRoots: folders },
      }),
      () => undefined,
    );
    if (result._tag !== "Failure") return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Folders not saved",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <SettingsSection id="project-folders" title="Folders">
      {members.map((member) => (
        <MemberFolders
          key={member.physicalProjectKey}
          member={member}
          showMachine={members.length > 1}
          disabled={!canEdit(member.environmentId)}
          onSave={(folders) => saveFolders(member, folders)}
        />
      ))}
    </SettingsSection>
  );
}

/** Folders dropped from Finder or Explorer; a browser without the desktop bridge sees no paths. */
function droppedFolderPaths(event: DragEvent): ReadonlyArray<string> {
  const getPathForFile = window.desktopBridge?.getPathForFile;
  if (!getPathForFile) return [];
  return Array.from(event.dataTransfer.items).flatMap((item) => {
    if (item.webkitGetAsEntry()?.isDirectory !== true) return [];
    const file = item.getAsFile();
    const path = file ? getPathForFile(file) : "";
    return path ? [path] : [];
  });
}

function MemberFolders({
  member,
  showMachine,
  disabled,
  onSave,
}: {
  member: SidebarProjectGroupMember;
  showMachine: boolean;
  disabled: boolean;
  onSave: (folders: ReadonlyArray<string>) => Promise<void>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const folders = member.additionalWorkspaceRoots ?? [];
  // Picked and dropped paths belong to this computer, so only the local environment takes them.
  const local = member.environmentId === primaryEnvironmentId && window.desktopBridge != null;
  const pickFolders = local ? window.desktopBridge?.pickFolders : undefined;
  const editable = local && !disabled && !saving;

  const save = async (next: ReadonlyArray<string>) => {
    setSaving(true);
    await onSave(next);
    setSaving(false);
  };
  const add = (paths: ReadonlyArray<string>) => {
    const added = paths.filter(
      (path, index) =>
        path !== member.workspaceRoot && !folders.includes(path) && paths.indexOf(path) === index,
    );
    if (added.length > 0) void save([...folders, ...added]);
  };

  return (
    <SettingsRow
      title={showMachine ? (member.environmentLabel ?? "Environment") : "Agents can work in"}
      description={
        local
          ? "Drop folders here or add them. Diffs and checkpoints cover the first folder only."
          : "Add folders from the desktop app on this machine. Diffs and checkpoints cover the first folder only."
      }
      control={
        pickFolders ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!editable}
            onClick={() => void pickFolders(member.workspaceRoot).then(add)}
          >
            <FolderPlusIcon />
            Add folders
          </Button>
        ) : null
      }
    >
      <ul
        aria-label="Project folders"
        className={cn(
          "-mx-1.5 mb-2 rounded-md border border-transparent p-0.5",
          dragging && "border-dashed border-primary bg-primary/5",
        )}
        onDragOver={(event) => {
          if (!editable) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (!editable) return;
          event.preventDefault();
          add(droppedFolderPaths(event));
        }}
      >
        {[member.workspaceRoot, ...folders].map((folder, index) => (
          <li key={folder} className="flex h-7 min-w-0 items-center gap-2 px-1">
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{folder}</span>
            {index > 0 ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={disabled || saving}
                aria-label={`Remove folder ${folder}`}
                onClick={() => void save(folders.filter((entry) => entry !== folder))}
              >
                <XIcon />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}
