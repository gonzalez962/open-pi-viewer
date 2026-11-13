# Web Docker management backend

The standalone web view uses `POST /api/docker` with JSON and a live web-auth session. Authentication must be enabled; supply a same-origin Origin or Referer (the existing same-origin policy also supports `Sec-Fetch-Site: same-origin`). Responses are JSON with `Cache-Control: no-store`. This endpoint is independent of viewer projects and is not available through desktop IPC.

- `{ "action": "list" }` returns `{ "containers": [{ "id", "name", "state", "status" }] }` for all existing containers.
- `{ "action": "start" | "stop" | "restart", "containerId": "<id>" }` returns `{ "ok": true }`.
- `{ "action": "remove", "containerId": "<id>", "confirmed": true }` removes a stopped container only, without force or volume deletion. The UI must explicitly confirm before sending it.
- `{ "action": "logs", "containerId": "<id>" }` returns `{ "stdout", "stderr" }`. Logs use the last 500 lines; combined Docker output is limited to 256 KiB, with an explicit error if exceeded.

IDs must be lowercase hexadecimal Docker IDs of 12–64 characters. Use IDs returned by list, not names. No create action is supported. Docker failures return a non-200 status and `{ "error": "..." }`; do not display them as empty container lists. Requests have an 8 KiB body limit, and Docker commands time out after 30 seconds. Configuration discovery and editing are not part of this backend yet.
