# Message file availability

In the web app, an inline absolute file reference retains its text while its download action is pending or unavailable. The action appears only after the authenticated, same-origin availability request confirms that the file is an accessible regular file. Changing the reference or workspace requires a new confirmation; an earlier response cannot authorize the new reference.

Availability does not grant download access: the download request validates the file again, so a file removed or made inaccessible after confirmation cannot be downloaded. Native desktop references continue to use their existing download action without a web availability request. Plain text paths are not detected as inline references.
