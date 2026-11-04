import {
  appendProjectFolder,
  MAX_PROJECT_FOLDERS,
} from "@t3tools/client-runtime/operations/projects";
import { PROJECT_DESCRIPTION_MAX_LENGTH, type EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useCreateAndOpenProject } from "../hooks/useCreateAndOpenProject";
import { cn } from "../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { droppedFolderPaths } from "./settings/ProjectFoldersSettings";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** A project with a brief and several folders, made for one task. */
export function CreateCapsuleDialog({
  environmentId,
  onClose,
}: {
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const id = useId();
  const createAndOpenProject = useCreateAndOpenProject();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folders, setFolders] = useState<ReadonlyArray<string>>([]);
  const [pathInput, setPathInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // Picked and dropped paths belong to this computer, so only the local environment takes them.
  const local = environmentId === primaryEnvironmentId && window.desktopBridge != null;
  const pickFolders = local ? window.desktopBridge?.pickFolders : undefined;
  const title = name.trim();
  const canSubmit = title.length > 0 && folders.length > 0 && !submitting;

  const addFolders = (paths: ReadonlyArray<string>) => {
    let next = folders;
    for (const path of paths) {
      const result = appendProjectFolder(next, path);
      if (result.status === "full") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Too many folders",
            description: `A capsule can have up to ${MAX_PROJECT_FOLDERS} folders.`,
          }),
        );
        break;
      }
      next = result.folders;
    }
    setFolders(next);
  };

  const addTypedPath = () => {
    const path = pathInput.trim();
    if (path.length === 0) return;
    addFolders([path]);
    setPathInput("");
  };

  const submit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const [workspaceRoot = "", ...additionalWorkspaceRoots] = folders;
    const outcome = await createAndOpenProject({
      environmentId,
      workspaceRoot,
      additionalWorkspaceRoots,
      createWorkspaceRootIfMissing: false,
      title,
      ...(description.trim().length > 0 ? { description } : {}),
    });
    submittingRef.current = false;
    setSubmitting(false);
    // Once the project exists the dialog is done, even when opening it failed.
    if (outcome.status !== "not-created") onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New capsule</DialogTitle>
            <DialogDescription>
              A name, a brief and the folders one task works in
              {environments.length > 1 && environment ? ` on ${environment.label}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-brief`}>Brief</Label>
              <Textarea
                id={`${id}-brief`}
                value={description}
                maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                placeholder="Jira link, goal, notes. Agents read this at the start of every chat."
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={local ? undefined : `${id}-path`} id={`${id}-folders`}>
                Folders
              </Label>
              {folders.length > 0 ? (
                <ul aria-label="Capsule folders" className="-mx-1.5 p-0.5">
                  {folders.map((folder, index) => (
                    <li key={folder} className="flex h-7 min-w-0 items-center gap-2 px-1">
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {folder}
                      </span>
                      {index === 0 ? (
                        <span className="shrink-0 text-xs font-medium text-foreground">Root</span>
                      ) : null}
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove folder ${folder}`}
                        onClick={() => setFolders(folders.filter((entry) => entry !== folder))}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {local ? (
                <div
                  aria-labelledby={`${id}-folders`}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-accent/70 px-4 py-4 text-xs text-muted-foreground",
                    dragging && "border-primary bg-primary/5 text-foreground",
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    addFolders(droppedFolderPaths(event));
                  }}
                >
                  <span>Drop folders here</span>
                  {pickFolders ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void pickFolders(folders[0]).then(addFolders)}
                    >
                      <FolderPlusIcon />
                      Add folders
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    id={`${id}-path`}
                    value={pathInput}
                    placeholder="/path/to/folder"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setPathInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addTypedPath();
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pathInput.trim().length === 0}
                    onClick={addTypedPath}
                  >
                    Add
                  </Button>
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                The first folder is the root. Diffs and checkpoints cover the root only.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Creating…" : "Create capsule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
