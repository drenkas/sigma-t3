import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../test/render";

type CreateResult = AsyncResult.AsyncResult<void, Error>;
const state = vi.hoisted(() => ({
  create: vi.fn<(request: { environmentId: string; input: object }) => Promise<unknown>>(),
  openThread: vi.fn<(ref: { environmentId: string; projectId: string }) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.create) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
  usePrimaryEnvironmentId: () => "primary" as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => state.openThread) as never,
}));
// No toaster is mounted in these tests; failures are read at this seam.
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { CreateCapsuleDialog } from "./CreateCapsuleDialog";

const environmentId = EnvironmentId.make("remote");
const created: CreateResult = AsyncResult.success(undefined);
const failed: CreateResult = AsyncResult.failure(Cause.fail(new Error("Folder is missing.")));

function setup() {
  vi.clearAllMocks();
  state.create.mockResolvedValue(created);
  state.openThread.mockResolvedValue(null);
}

// The footer button sits under the dialog's inert guard in the test viewport, so submit as a user
// would from the keyboard.
async function submitFromName(screen: Screen) {
  await userEvent.click(screen.getByRole("textbox", { name: "Name" }));
  await userEvent.keyboard("{Enter}");
}

async function fillCapsule(screen: Screen) {
  await userEvent.fill(screen.getByRole("textbox", { name: "Name" }), "  Fix login ");
  await userEvent.fill(screen.getByRole("textbox", { name: "Brief" }), "PROJ-1\n  notes");
  for (const folder of ["/a", "/b", "/a", "/c"]) {
    await userEvent.fill(screen.getByRole("textbox", { name: "Folders" }), folder);
    await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
  }
}

const folderRows = (screen: Screen) =>
  [...screen.container.ownerDocument.querySelectorAll('[aria-label="Capsule folders"] li')].map(
    (row) => row.textContent,
  );

describe("CreateCapsuleDialog", () => {
  it("creates one project with the first folder as root, the rest in order, and the brief", async () => {
    setup();
    const onClose = vi.fn();
    await using screen = await render(
      <CreateCapsuleDialog environmentId={environmentId} onClose={onClose} />,
    );

    await fillCapsule(screen);
    expect(folderRows(screen)).toEqual(["/aRoot", "/b", "/c"]);
    await submitFromName(screen);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        projectId: expect.any(String),
        title: "Fix login",
        workspaceRoot: "/a",
        createWorkspaceRootIfMissing: false,
        additionalWorkspaceRoots: ["/b", "/c"],
        description: "PROJ-1\n  notes",
        defaultModelSelection: null,
      },
    });
    expect(state.openThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId }),
    );
  });

  it("keeps the values after a failed create and ignores a second submit while one is pending", async () => {
    setup();
    let finish!: (result: CreateResult) => void;
    state.create.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onClose = vi.fn();
    await using screen = await render(
      <CreateCapsuleDialog environmentId={environmentId} onClose={onClose} />,
    );
    await fillCapsule(screen);

    await submitFromName(screen);
    await expect.element(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    finish(failed);

    await vi.waitFor(() =>
      expect(state.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Folder is missing." }),
      ),
    );
    expect(state.create).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(state.openThread).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("  Fix login ");
    expect(folderRows(screen)).toEqual(["/aRoot", "/b", "/c"]);
    await expect.element(screen.getByRole("button", { name: "Create capsule" })).toBeEnabled();
  });

  it("does not create again when the project was created but could not be opened", async () => {
    setup();
    state.openThread.mockRejectedValue(new Error("Navigation failed."));
    const onClose = vi.fn();
    await using screen = await render(
      <CreateCapsuleDialog environmentId={environmentId} onClose={onClose} />,
    );
    await fillCapsule(screen);

    await submitFromName(screen);

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project added, but it did not open" }),
    );
  });
});
