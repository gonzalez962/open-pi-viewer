# Subagent activity and Pi default model
Trigger: multi-session delivery; settings persistence also has data-loss and environment-routing risk. Scope: mobile trigger, activity scrolling, and Pi default-model configuration; no unrelated UI or profile changes.
Rollback: revert the affected work unit. Success: the scenarios below pass through their observable interfaces.

## Specs

### S1 — Open subagent activity on mobile [behavior]
> "tambien hay otro fallo que debemos arreglar en movil cuando se da click en class=\"working-subagent-trigger\" no se abre el modal de subagentes solo en desktop se abre."
- **S1.1** Given busy chat with a running subagent and the mobile drawer closed, when the user taps the subagent trigger, the dialog MUST open on that task.
- **S1.2** Given desktop chat in the same state, clicking the trigger MUST still open the task dialog (existing behavior).
- **S1.3** Given a competing active dialog, subagent activity MUST still defer to it (existing behavior).

### S2 — Follow incoming actions only at the bottom [behavior]
> "el listado de acciones de los subagentes no tiene autoscroll cuando el usuario este en bottom que haga autoscroll pero si se hace scroll para arriba no debe hacerlo y al regresar al bottom debe reactivar el autoscroll lo entiendes?"
- **S2.1** Given an overflowing history at the bottom, when new actions render, the list MUST follow to the bottom.
- **S2.2** Given the user scrolls up, when new actions render, the list MUST keep the user's position.
- **S2.3** Given the user scrolls back to the bottom, when new actions render, the list MUST follow again.

### S3 — Save the global default in Pi's active environment [behavior]
> "luego vamos a ajustar el modelo global por defecto actualimente en la interfaz tenemos esa accion?"
> "En Pi, para toda la configuración activa"
- **S3.1** Given an available model, when the user explicitly sets it as the Pi default, the selected provider and model ID MUST be persisted in the active Pi environment and usable by a new Pi session there. The action MUST be separate from changing the current session model.
- **S3.2** Given a different Pi home or existing unrelated settings, saving MUST leave them untouched. If target resolution or persistence fails, the UI MUST NOT report success.

## Tasks
- T1 — S1 — bounded worker and browser verification — RED `efe0e02`; implementation in progress.
- T2 — S2 — bounded worker and browser verification — commit pending (RED checkpoint first).
- T3 — S3 — bound persistence and UI surfaces after validating active agent-home parity — commit pending (RED checkpoint first).

## Expected files
- T1: `src/app/App.tsx`; `tests/browser/optional-activity.mjs`.
- T2: `src/features/chat/SubagentActivityModal.tsx`; `tests/browser/optional-activity.mjs`.
- T3: exact file list pending launcher and transport evidence; no worker write scope yet.

## Log
- L1: "vale crea commit y continua con los demas"
- L2: Prior profile badge removal committed as `306bbfa`; independent from this feature.
- L3: T1 choice: preserve existing controller and exclude inactive dialog DOM from the App guard. Alternative: omit the mobile drawer selector explicitly. Rationale: the closed drawer is mounted with `aria-hidden` and `inert`; visible competing dialogs must retain priority.
- L4: T2 choice: follow the actual `.subagent-thread` scroll position, not an item count or thread version. Rationale: activity arrives as complete snapshots that can replace or truncate entries.
- L5: T3 constraint: persist to the actual effective Pi agent home, never an assumed default home, project profile, or Viewer preference; prove direct/custom launch resolution before authorizing writes.
- L6: T1 RED `efe0e02`: `node --test-reporter=junit tests/browser/optional-activity.mjs --subagent-trigger` exit 1; S1.1 failed after a real tap reached the trigger, S1.2 and S1.3 passed.
- L7: Review slices: previous miscellaneous changes end at `306bbfa`. Subagent trigger starts at `efe0e02`; keep its RED + fix together for review, and review scrolling and model persistence as separate subsequent units. No remote delivery authorized.
- L8: Worker candidate: S1.1–S1.3 pass in Chromium and 27 focused unit tests pass. First gate invocation exited 2 before running tests: `--spec` must exist in a committed ref, while `odd/tasks/` is ignored by this repository.
