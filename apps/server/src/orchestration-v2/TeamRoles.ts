import type { TeamRoles } from "@t3tools/contracts";

const ROLES_COMMAND = /^\/roles(?:\s+([\s\S]*))?$/i;
const ROLE_COMMAND = /^\/role(?:\s+([\s\S]*))?$/i;
const ORCA_DEMO_COMMAND = /^\/orca-demo(?:\s+([\s\S]*))?$/i;
const ORCA_COMMAND = /^\/orca(?:\s+([\s\S]*))?$/i;

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
  return `<t3_team_roles>\nThe user's agent team for this project. Do a small task yourself, ask the user before splitting a medium task or one of unclear size, and when you split a task, delegate each role's part to its model, passing the role name as delegate_task \`role\`.\n${lines.join("\n")}\n</t3_team_roles>`;
}

/**
 * `/roles`, `/role`, `/orca`, and `/orca-demo` are built-in commands on every client, so
 * the server expands them rather than letting a provider read them as its own slash
 * commands. Returns null for any other message.
 */
export function expandTeamCommand(text: string): string | null {
  const trimmed = text.trim();
  const demo = ORCA_DEMO_COMMAND.exec(trimmed);
  if (demo !== null) {
    const note = demo[1]?.trim() ?? "";
    return `<t3_orca_command>
The user ran /orca-demo: a fixed demonstration of orchestration on their team's real models. They already accepted the cost, so do not ask to split or confirm. You are the coordinator.
Call orchestrator_capabilities first and use its teamRoles. If the team is empty, stop and tell the user to set one up with /roles and then run /orca-demo again. If orchestrator_capabilities is not available, say the demo needs T3 Code's orchestration tools. If a role's provider or model is unavailable, report it; do not substitute a model or simulate a child.
Chat only, for you and every child (put this in every brief): no reading or changing project files, no scratch files or worktrees, no shell, no installs, no browsing. Children do not delegate.
First tell the user the demo uses their team's real models and that they can open the thread's Lineage → Graph on web or desktop now to watch the children appear.
Delegate exactly once to every team role, one after another, with delegate_task (even for your own provider; no native subagents), isolation "shared", mode "wait". Wait for each child's result before starting the next; if a call returns early or fails while the child still runs, follow its next instead of retrying, so no role gets a second child. Pass role = the exact saved role name and target = its providerInstanceId, model, and saved options. Order: architect, researcher, implementer, other roles, tester, reviewer (by name, case-insensitive; keep team order within a group). Carry earlier results forward. Each brief carries the full contract, examples, restrictions, and the relevant earlier output. Each reply stays under 200 words plus at most one small code block.
Scenario: a standalone TypeScript function formatDuration(seconds: number): string with no dependencies. It accepts only integers 0..3599 inclusive and returns "m:ss" with two second digits; anything else throws RangeError. Examples: 0 → "0:00", 9 → "0:09", 60 → "1:00", 61 → "1:01", 3599 → "59:59"; -1, 3600, 1.5, NaN, and Infinity → RangeError.
Role duties:
- architect: propose a minimal algorithm and one risk.
- researcher: check the contract and examples for ambiguity or missed boundaries.
- implementer: return the function with a short explanation.
- any other role: give one bounded finding from its perspective, or "no issue found".
- tester: trace the candidate by hand against every example (expected vs derived); do not claim to execute it.
- reviewer: independently give a verdict with at most two findings.
If a usual role is missing, do that small step yourself (for example, write the candidate when there is no implementer) and say when there was no independent reviewer. Add no extra children, retries, or repair rounds.
Finish every delegation or cancel it. Then report each role's actual outcome and model, with its child thread link. Show the final function, noting any correction you made separately. Say it was inspected, not executed. Reply in the user's language and end by pointing to Lineage → Graph on web or desktop.
${note === "" ? "" : `The user added this note; follow it where it does not change the scenario:\n<note>\n${note}\n</note>\n`}</t3_orca_command>`;
  }
  const orca = ORCA_COMMAND.exec(trimmed);
  if (orca !== null) {
    const task = orca[1]?.trim() ?? "";
    return `<t3_orca_command>
The user ran /orca to run a task in orchestration mode. You are the coordinator: you own the plan, the split into work units, their order, integration, and the final check. The user already chose orchestration, so do not ask whether to split the task; ask only when a requirement is missing or ambiguous, with your tool for asking the user when you have one.
Call orchestrator_capabilities first: teamRoles is this project's team, and it lists the models you can choose from.
1. Set the acceptance criteria: the outcome, the checks that prove it, and what could go wrong.
2. Split the work into bounded units, each with its own files to change. Delegate each unit to the team role that fits it, the way the orchestration instructions describe, and name the role in the brief. When no role fits, or there is no team, pick a model from the catalog: a fast one for mechanical work, a strong one for hard reasoning. Keep tiny fixes and the coordination itself to yourself.
3. Give each worker a self-contained brief: the goal, the criteria, the files it may change, and the checks to run. Workers do not start more agents. Let only one worker change a shared checkout at a time; read-only work may run in parallel.
4. After the implementation, have a fresh reviewer that did not write the code check the actual diff against the original request and the evidence. Use the team's reviewer role when there is one.
5. Check each finding against the code yourself. Fix small ones yourself; send the rest, with the findings, to the owning role as a new delegated task, and dismiss false ones with a reason. If two rounds fail to fix the same problem, re-plan.
6. Finish or cancel every delegated task, then report the result, the evidence behind it, and any open risks. Reply in the user's language.
If orchestrator_capabilities is not available, say orchestration mode needs T3 Code's tools here and do the task yourself.
${task === "" ? "The task is the one this conversation has been discussing. If there is none, ask the user for it." : `<task>\n${task}\n</task>`}
</t3_orca_command>`;
  }
  const team = ROLES_COMMAND.exec(trimmed);
  const edit = team === null ? ROLE_COMMAND.exec(trimmed) : null;
  if (team === null && edit === null) return null;
  const args = (team ?? edit)?.[1]?.trim() ?? "";
  const request =
    edit !== null
      ? args === ""
        ? `The user ran /role with nothing after it to change one role of the team this project uses, so interview them:
1. Show that team and ask which role to change, offering each role and a new role as choices. If there is no team yet, offer to add a role.
2. Ask what to change: the model, its options such as effort, the description, the name, or removing the role. For a new model, suggest two or three from the catalog that suit the role, and mark the one you recommend and why in a few words.
3. Show the whole team with the change and save it once the user confirms.`
        : `The user ran /role with this change to one role of the team this project uses:
<role>
${args}
</role>
Apply it, matching a named model to a provider instance and model from the catalog. Ask only about what is missing or ambiguous, such as a role the team does not have yet. Then show the whole team with the change and save it.`
      : args === ""
        ? `The user ran /roles with nothing after it, so interview them:
1. Show the team this project uses, saying whether it is the project's own or the default, and ask which roles they want, suggesting a few that fit how they work, such as architect, researcher (reads the codebase and searches the web), implementer, reviewer, and tester.
2. Then go through the roles one at a time. For each, suggest two or three models from the catalog that suit the role, mark the one you recommend and why in a few words, and wait for the user's answer before moving to the next role.
3. After the last role, show the whole team and save it once the user confirms.`
        : /^(clear|reset|remove|none)$/i.test(args)
          ? "The user ran /roles to clear this project's team. If the default team has roles, ask whether this project should have no team, saved as [], or follow the default team, saved by omitting roles. Otherwise omit roles. Then say which team the project uses now."
          : `The user ran /roles with this team:
<roles>
${args}
</roles>
Match each role to a provider instance and model from the catalog, saving any options they named, such as effort. Ask only about a model you cannot match or that is ambiguous. If any role has no model, suggest models for it the way an interview would. Then show the team and save it.`;
  return `<t3_roles_command>
The user is setting up their agent team: the model for each role. Conversations start with their project's team, or with the default team when the project has none.
Call orchestrator_capabilities first: teamRoles is the team this project uses, teamRolesSource says whether it is the project's own or the default, defaultTeamRoles is the default team, and it lists the models you can choose from. Search it when the user names a model the short list leaves out.
${request}
Ask each question with your tool for asking the user when you have one, offering the choices as options; otherwise ask in your reply and wait for the answer.
Save with team_roles_set, sending the whole team. Save it for this project unless the user asked to change the default team for projects without their own. A role's description is one sentence on what it does. Reply in the user's language. If team_roles_set is not available, say the team could not be saved here.
</t3_roles_command>`;
}
