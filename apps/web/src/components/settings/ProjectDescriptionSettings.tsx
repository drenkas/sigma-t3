import { PROJECT_DESCRIPTION_MAX_LENGTH, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The brief belongs to one project record, so each checkout saves on its own. */
export function ProjectDescriptionSettings({
  members,
  canEdit,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
  canEdit: (environmentId: EnvironmentId) => boolean;
}) {
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const saveDescription = async (member: SidebarProjectGroupMember, description: string) => {
    const result = mapAtomCommandResult(
      await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, description },
      }),
      () => undefined,
    );
    if (result._tag !== "Failure") return true;
    if (isAtomCommandInterrupted(result)) return false;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Brief not saved",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  };

  return (
    <SettingsSection id="project-description" title="Capsule brief">
      {members.map((member) => (
        <MemberDescription
          key={member.physicalProjectKey}
          member={member}
          showMachine={members.length > 1}
          disabled={!canEdit(member.environmentId)}
          onSave={(description) => saveDescription(member, description)}
        />
      ))}
    </SettingsSection>
  );
}

function MemberDescription({
  member,
  showMachine,
  disabled,
  onSave,
}: {
  member: SidebarProjectGroupMember;
  showMachine: boolean;
  disabled: boolean;
  onSave: (description: string) => Promise<boolean>;
}) {
  const saved = member.description ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const label = showMachine
    ? `${member.environmentLabel ?? "Environment"} · ${member.workspaceRoot}`
    : "Capsule brief";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const saved = await onSave(value);
    setSaving(false);
    if (saved) setDraft(null);
  };

  return (
    <SettingsRow
      title={showMachine ? label : "Brief"}
      description="Agents receive this at the start of every new chat."
    >
      <div className="flex flex-col items-start gap-2 pb-3 pt-1">
        <Textarea
          aria-label={label}
          value={value}
          maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
          disabled={disabled || saving}
          placeholder="Jira link, goal, notes"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          aria-label={`Save ${label}`}
          disabled={disabled || saving || value === saved}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save brief"}
        </Button>
      </div>
    </SettingsRow>
  );
}
