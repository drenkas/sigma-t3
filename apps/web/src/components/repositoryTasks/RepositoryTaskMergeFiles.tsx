import type { RepositoryTaskMergePreview } from "@t3tools/contracts";
import { PatchDiff, UnresolvedFile } from "@pierre/diffs/react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { DIFF_VIEW_UNSAFE_CSS } from "../diffs/StyledDiffCodeView";

// Loaded only when a preview opens, so the task page does not pull in the diff highlighter.
export default function RepositoryTaskMergeFiles({
  files,
}: {
  files: RepositoryTaskMergePreview["files"];
}) {
  const resolvedTheme = useRenderedAppearance();
  const options = {
    overflow: "scroll" as const,
    theme: resolveDiffThemeName(resolvedTheme),
    themeType: resolvedTheme,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
  };
  return (
    <DiffWorkerPoolProvider>
      <div className="flex min-w-0 flex-col gap-2">
        {files.map((file) => (
          <section
            key={file.path}
            aria-label={file.path}
            className="overflow-hidden rounded-md border border-border/60"
          >
            {file.text === null ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {file.path}: too large to show here.
              </p>
            ) : file.status === "conflict" ? (
              <UnresolvedFile
                file={{ name: file.path, contents: file.text }}
                options={{ ...options, mergeConflictActionsType: "none" }}
              />
            ) : (
              <PatchDiff
                patch={file.text}
                options={{ ...options, diffStyle: "unified", lineDiffType: "none" }}
              />
            )}
          </section>
        ))}
      </div>
    </DiffWorkerPoolProvider>
  );
}
