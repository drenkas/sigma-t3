import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { expandRolesCommand, teamRolesNote } from "./TeamRoles.ts";

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

describe("expandRolesCommand", () => {
  it("leaves other messages alone", () => {
    expect(expandRolesCommand("fix the roles page")).toBeNull();
    expect(expandRolesCommand("/rolesx")).toBeNull();
    expect(expandRolesCommand("please run /roles")).toBeNull();
  });

  it("interviews the user when the command has no team", () => {
    expect(expandRolesCommand(" /roles ")).toContain("interview them");
  });

  it("passes an inline team through", () => {
    const expanded = expandRolesCommand("/Roles architect: opus\nreviewer: gpt-5.5 high");
    expect(expanded).toContain("<roles>\narchitect: opus\nreviewer: gpt-5.5 high\n</roles>");
    expect(expanded).not.toContain("interview them");
  });

  it("clears the team", () => {
    expect(expandRolesCommand("/roles clear")).toContain("Save an empty team");
  });
});
