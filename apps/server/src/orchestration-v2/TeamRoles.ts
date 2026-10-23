import type { ProjectId, ServerSettings, TeamRoles } from "@t3tools/contracts";

const ROLES_COMMAND = /^\/roles(?:\s+([\s\S]*))?$/i;

export function projectTeamRoles(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
): TeamRoles {
  return settings.projectSettingsOverrides[projectId]?.teamRoles ?? [];
}

/**
 * The saved team, in the words the base orchestration instructions use for it.
 * Empty when there is no team, so a conversation without one carries nothing.
 */
export function teamRolesNote(roles: TeamRoles): string {
  if (roles.length === 0) return "";
  const lines = roles.map((role) => {
    const options =
      role.options === undefined || role.options.length === 0
        ? ""
        : `, options ${JSON.stringify(Object.fromEntries(role.options.map((option) => [option.id, option.value])))}`;
    const description = role.description === undefined ? "" : `: ${role.description}`;
    return `- ${role.role}${description} (providerInstanceId ${role.providerInstanceId}, model ${role.model}${options})`;
  });
  return `<t3_team_roles>\nThe user's agent team. Delegate each role's work to its model.\n${lines.join("\n")}\n</t3_team_roles>`;
}

/**
 * `/roles` is a built-in command on every client, so the server expands it
 * rather than letting a provider read it as one of its own slash commands.
 * Returns null for any other message.
 */
export function expandRolesCommand(text: string): string | null {
  const match = ROLES_COMMAND.exec(text.trim());
  if (match === null) return null;
  const args = match[1]?.trim() ?? "";
  const request =
    args === ""
      ? `The user ran /roles with nothing after it, so interview them:
1. Show the current team if there is one, and ask which roles they want, suggesting a few that fit how they work, such as architect, implementer, reviewer, and tester.
2. Then go through the roles one at a time. For each, suggest two or three models from the catalog that suit the role, mark the one you recommend and why in a few words, and wait for the user's answer before moving to the next role.
3. After the last role, show the whole team and save it once the user confirms.`
      : /^(clear|reset|remove|none)$/i.test(args)
        ? "The user ran /roles to clear this project's team. Save an empty team and confirm it is gone."
        : `The user ran /roles with this team:
<roles>
${args}
</roles>
Match each role to a provider instance and model from the catalog, saving any options they named, such as effort. Ask only about a model you cannot match or that is ambiguous. If any role has no model, suggest models for it the way an interview would. Then show the team and save it.`;
  return `<t3_roles_command>
The user is setting up the agent team for this conversation's project: the model for each role, which every conversation in the project starts with. Other projects keep their own teams.
Call orchestrator_capabilities first: it lists the project's current team as teamRoles and the models you can choose from. Search it when the user names a model the short list leaves out.
${request}
Save with team_roles_set, sending the whole team. A role's description is one sentence on what it does. Reply in the user's language. If team_roles_set is not available, say the team could not be saved here.
</t3_roles_command>`;
}
