# Repository tasks

Repository tasks coordinate work across saved project groups on one connected host. They are available in the web and desktop apps; the mobile app does not include this panel.

The server data directory must be outside any Git checkout so the coordinator can use an isolated Scratch workspace. Repository tasks cannot start with an in-checkout development data directory.

Create a group with at least two projects from the same host, then save it. Start a task from a saved group, choose its member projects and workspace strategy, and select the coordinator model and any agent roles. Each task records the group membership, workspace choices, role models and starting revisions used at creation. The server prepares a separate coordinator workspace and the requested member workspaces.

To avoid picking role models for every task, set them once under **Role models** on the Repository tasks page, and give a group its own models for any role it should run differently. Choosing a group fills each role with the group's model, or the host default when the group has none. Changing these later does not affect tasks that already started, and a saved model that is no longer available still has to be replaced before a task can start.

If a selected provider model or one of its advertised options becomes unavailable before launch, the form keeps the selection visible and blocks task creation until you choose an available option. Save group edits before starting a task; task membership always comes from the saved group.

Reopen a task from its task list to follow participant states, open native sessions or diffs, and inspect the recorded execution graph. The graph shows the coordinator, repositories and nested agents as an indented tree and marks any node waiting for your approval. Select a node to open its session, steer its current turn, queue a follow-up, message a finished agent, or stop it together with the agents it started. The Stop action at the top applies to the whole task. Below the graph, the timeline numbers every prompt, steer, follow-up, result and context transfer in the order it happened, with who sent it to whom.

When an agent inside a member session worked in its own worktree, the member's result brings that work back into the member workspace before it reaches the coordinator. Only a clean three-way merge is written, and it only changes files: nothing is staged or committed, and your branch stays where it was. A merge with conflicts writes nothing; the member shows the conflicting files and keeps the task open. Open **Preview** on the merge to see each conflict with the member (root), common base and agent (worker) sides. Once you resolve it in either workspace, refresh the preview: when it plans cleanly you can apply exactly what you reviewed, and Sigma T3 refuses if either workspace changed after that preview. Applied merges keep their preview, and the execution graph shows each merge as a dashed link from the agent to its repository. If the server stopped in the middle of writing a merge, the task shows as uncertain, and acknowledging it judges the merge from the files on disk without writing it again.

If the server loses track of whether part of a task started, for example after a crash during launch, the task shows as uncertain and never retries on its own. Choose **Acknowledge observed state** to settle it from what the server recorded: launches it can confirm continue, the rest are marked abandoned and do not start again. A task whose coordinator never started is stopped instead.

Archive a finished or stopped task to hide it from the task list; the **Archived** filter shows archived tasks, and **Unarchive** brings one back. Running or uncertain tasks cannot be archived.
