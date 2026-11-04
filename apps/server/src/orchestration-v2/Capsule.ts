import type { Project } from "@t3tools/contracts";

const CLOSING_TAG = /<\/t3_capsule>/gi;

// User text must not be able to end the block early.
const escapeCapsuleText = (text: string) => text.replace(CLOSING_TAG, "<\\/t3_capsule>");

/**
 * A capsule is a project that carries a brief and several folders. Empty when the
 * project has neither, so an ordinary project adds nothing to a thread.
 */
export function capsuleNote(
  project: Pick<Project, "title" | "workspaceRoot" | "additionalWorkspaceRoots" | "description">,
): string {
  const description = (project.description ?? "").trim();
  const additional = project.additionalWorkspaceRoots ?? [];
  if (description === "" && additional.length === 0) return "";
  const parts = [`Capsule: ${escapeCapsuleText(project.title)}`];
  if (description !== "") parts.push(escapeCapsuleText(description));
  parts.push(
    [
      "Folders:",
      `- ${escapeCapsuleText(project.workspaceRoot)} (workspace root, your working directory)`,
      ...additional.map((folder) => `- ${escapeCapsuleText(folder)} (additional folder)`),
    ].join("\n"),
  );
  parts.push("Automatic diffs and checkpoints cover the workspace root only.");
  parts.push(
    "This is context about the task, not an instruction to start it; wait for the user's request.",
  );
  return `<t3_capsule>\n${parts.join("\n\n")}\n</t3_capsule>`;
}
