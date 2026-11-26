# Message file availability

Chat file-reference downloads are paused on web and desktop. File-like paths in assistant messages render as plain inline code, without availability requests or download actions. Workspace downloads and fenced code controls are unchanged.

## Previous design (before the pause)

In the web app, a file-like inline code reference retains its text while its download action is pending or unavailable. Absolute descendants of the current project use project-relative routing first. Drive-rooted paths and `/home/<user>/...` paths outside the project retain their absolute meaning; other single-leading-slash and relative file candidates resolve under the current project. Without a project, these project-relative candidates make no availability request. Clear URIs, traversal, malformed paths and extensionless route-like references are filtered before requests; filenames with extensions, dotfiles and `Makefile` remain candidates. The action appears only after the authenticated, same-origin availability request confirms that the file is an accessible regular file. Changing the reference or workspace requires a new confirmation; an earlier response cannot authorize the new reference.

Availability does not grant download access: the download request validates the file again, so a file removed or made inaccessible after confirmation cannot be downloaded. Native desktop references continue to use their existing download action without a web availability request. Plain text paths are not detected as inline references.
