import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { expandTeamCommand, teamRolesNote } from "./TeamRoles.ts";

describe("teamRolesNote", () => {
  it("is empty without a team", () => {
    expect(teamRolesNote([])).toBe("");
  });

  it("names each role's target as delegate_task takes it", () => {
    const note = teamRolesNote([
      {
        role: "architect",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "max" }],
        description: "Plans the change",
      },
      { role: "reviewer", providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    ]);
    expect(note).toContain(
      '- architect: Plans the change (providerInstanceId claudeAgent, model claude-opus-4-8, options {"effort":"max"})',
    );
    expect(note).toContain("- reviewer (providerInstanceId codex, model gpt-5.5)");
  });
});

describe("expandTeamCommand", () => {
  it("leaves other messages alone", () => {
    expect(expandTeamCommand("fix the roles page")).toBeNull();
    expect(expandTeamCommand("/rolesx")).toBeNull();
    expect(expandTeamCommand("please run /roles")).toBeNull();
  });

  it("interviews the user when the command has no team", () => {
    expect(expandTeamCommand(" /roles ")).toContain("interview them");
  });

  it("passes an inline team through", () => {
    const expanded = expandTeamCommand("/Roles architect: opus\nreviewer: gpt-5.5 high");
    expect(expanded).toContain("<roles>\narchitect: opus\nreviewer: gpt-5.5 high\n</roles>");
    expect(expanded).not.toContain("interview them");
  });

  it("clears this project's team", () => {
    expect(expandTeamCommand("/roles clear")).toContain("to clear this project's team");
  });

  it("interviews the user about one role", () => {
    const expanded = expandTeamCommand("/role");
    expect(expanded).toContain("ask which role to change");
    expect(expanded).toContain("tool for asking the user");
    expect(expandTeamCommand("/rolex")).toBeNull();
  });

  it("passes a change to one role through", () => {
    const expanded = expandTeamCommand("/Role reviewer: gpt-5.5 high");
    expect(expanded).toContain("<role>\nreviewer: gpt-5.5 high\n</role>");
    expect(expanded).not.toContain("ask which role to change");
    expect(expanded).not.toContain("<roles>");
  });

  it("expands /orca with its task", () => {
    const expanded = expandTeamCommand("/orca Ship the release");
    expect(expanded).toContain("<t3_orca_command>");
    expect(expanded).toContain("<task>\nShip the release\n</task>");
  });

  it("expands /orca alone to the task under discussion", () => {
    const expanded = expandTeamCommand("/orca");
    expect(expanded).toContain("The task is the one this conversation has been discussing");
    expect(expanded).not.toContain("<task>");
  });

  it("leaves lookalikes of /orca alone", () => {
    expect(expandTeamCommand("/orcax")).toBeNull();
    expect(expandTeamCommand("please /orca")).toBeNull();
  });
});
