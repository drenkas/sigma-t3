import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderOpenIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
    if (result._tag !== "Failure") return true;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Folders not saved",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    return false;
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

function MemberFolders({
  member,
  showMachine,
  disabled,
  onSave,
}: {
  member: SidebarProjectGroupMember;
  showMachine: boolean;
  disabled: boolean;
  onSave: (folders: ReadonlyArray<string>) => Promise<boolean>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const folders = member.additionalWorkspaceRoots ?? [];
  // The native picker browses this computer, so it only fits the local environment.
  const canBrowse = member.environmentId === primaryEnvironmentId && window.desktopBridge != null;

  const save = async (next: ReadonlyArray<string>) => {
    setSaving(true);
    const saved = await onSave(next);
    setSaving(false);
    return saved;
  };
  const add = async (path: string) => {
    const folder = path.trim();
    if (!folder || folders.includes(folder)) return;
    if (await save([...folders, folder])) setDraft("");
  };
  const browse = async () => {
    const picked = await readLocalApi()?.dialogs.pickFolder({ initialPath: member.workspaceRoot });
    if (picked) await add(picked);
  };

  return (
    <SettingsRow
      title={showMachine ? (member.environmentLabel ?? "Environment") : "Working folder"}
      description={
        <>
          <span className="block truncate">{member.workspaceRoot}</span>
          <span className="block">
            Agents also read and edit the folders below. Diffs, checkpoints and branches stay on the
            working folder.
          </span>
        </>
      }
    >
      <div className="space-y-2 pb-2 pt-1">
        {folders.map((folder) => (
          <div key={folder} className="flex min-w-0 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-muted-foreground">{folder}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || saving}
              aria-label={`Remove folder ${folder}`}
              onClick={() => void save(folders.filter((entry) => entry !== folder))}
            >
              Remove
            </Button>
          </div>
        ))}
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add(draft);
          }}
        >
          <Input
            size="sm"
            className="min-w-0 flex-1"
            aria-label="Folder path"
            placeholder="/path/to/another/folder"
            value={draft}
            disabled={disabled || saving}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <Button size="sm" type="submit" variant="outline" disabled={disabled || saving}>
            Add folder
          </Button>
          {canBrowse ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              aria-label="Browse for a folder"
              disabled={disabled || saving}
              onClick={() => void browse()}
            >
              <FolderOpenIcon />
            </Button>
          ) : null}
        </form>
      </div>
    </SettingsRow>
  );
}
