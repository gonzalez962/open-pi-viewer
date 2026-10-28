# Project Kanban

Use **Kanban** in the application header to open the active project's board, even when no Pi session is connected. The web and desktop clients use the same three columns: Pending, In progress and Done.

- Expand **Add card** to reveal the form, enter a title and optional description, then choose **Add card**.
- Cards display only their title and description directly; expand **Actions** on a card to access card controls.
- Choose **Edit** to update both fields (automatically expands the form); **Cancel** discards the draft.
- Use **Move to** on a card to change its column.
- Choose **Delete** to show inline confirmation controls, then choose **Confirm** to remove the card or **Cancel** to abort.
- Changes are saved immediately. Closing and reopening the board or reloading the application restores saved cards.

## Storage and Git

Cards live in `<project>/.pi/kanban.json`, independently for each project. Opening an empty board does not create files. The first save creates the directory as needed and, unless Git already ignores the board, appends `/.pi/kanban.json` to the project's `.gitignore` without replacing its existing rules. The `.gitignore` change is visible and can be committed; the board itself stays local. Previously tracked files cannot be untracked by an ignore rule; remove a previously tracked board from the index manually if necessary.

Writes validate card IDs, titles, descriptions and column names before replacing the file. Titles are limited to 200 characters, descriptions to 10,000 and boards to 2,000 cards. Writes use a same-directory temporary file and rename; failed writes leave an error visible in the board. The UI does not display unconfirmed saves as persisted.

Malformed board data is reported rather than silently reset or overwritten. Back up and repair the JSON manually to recover. Symlink/junction storage paths are rejected, including links for `.pi`, `kanban.json` and `.gitignore`. No arbitrary file-write command is exposed.

This is a local board, not a collaborative document. Simultaneous saves from separate application instances or tabs use last-successful-save semantics; refresh before editing changes made elsewhere. Custom columns, drag-and-drop ordering and session links are not part of this version.

## Focused checks

```sh
npx tsx --tsconfig tsconfig.app.json --test tests/server/kanban.test.ts tests/server/workspace-files.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib kanban
npm run build
node tests/browser/kanban.mjs
```

The browser check starts an isolated production server and uses disposable project directories. Build the production assets first. Existing tests-only RED evidence is retained in commit `f6fcd71`; the local implementation log is under `odd/tasks/project-kanban.md`.
