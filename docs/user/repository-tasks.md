# Repository tasks

Repository tasks coordinate work across saved project groups on one connected host. They are available in the web and desktop apps; the mobile app does not include this panel.

The server data directory must be outside any Git checkout so the coordinator can use an isolated Scratch workspace. Repository tasks cannot start with an in-checkout development data directory.

Create a group with at least two projects from the same host, then save it. Start a task from a saved group, choose its member projects and workspace strategy, and select the coordinator model and any agent roles. Each task records the group membership, workspace choices, role models and starting revisions used at creation. The server prepares a separate coordinator workspace and the requested member workspaces.

If a selected provider model or one of its advertised options becomes unavailable before launch, the form keeps the selection visible and blocks task creation until you choose an available option. Save group edits before starting a task; task membership always comes from the saved group.

Reopen a task from its task list to follow participant states, open native sessions or diffs, and inspect the recorded execution graph. The Stop action applies to the whole task.

If the server loses track of whether part of a task started, for example after a crash during launch, the task shows as uncertain and never retries on its own. Choose **Acknowledge observed state** to settle it from what the server recorded: launches it can confirm continue, the rest are marked abandoned and do not start again. A task whose coordinator never started is stopped instead.

Archive a finished or stopped task to hide it from the task list; the **Archived** filter shows archived tasks, and **Unarchive** brings one back. Running or uncertain tasks cannot be archived.
