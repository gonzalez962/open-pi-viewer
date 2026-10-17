# Web custom provider persistence

The web viewer provides targeted IPC commands to configure, update, and remove custom model providers directly against the server's active Pi agent configuration (`models.json`).

## Architecture and commands

The web bridge exposes three primary commands for custom model providers:

| Command | Purpose | Payload | Return value |
| --- | --- | --- | --- |
| `get_custom_providers` | Reads custom model providers from active `models.json` | None / `{}` | `ModelsConfigFile` (`{ providers: { ... }, ... }`) |
| `upsert_custom_provider` | Creates or updates a single provider additively | `{ provider: { id, baseUrl, api, ... } }` or `{ providerId, provider }` | Updated `ModelsConfigFile` |
| `delete_custom_provider` | Removes a single custom provider from configuration | `{ providerId }` or `{ id }` | Updated `ModelsConfigFile` |
| `save_custom_providers` | Legacy full-map replacement handler (preserved for backwards compatibility) | `{ providers: { ... } }` | `ModelsConfigFile` |

### Additive merge semantics

When `upsert_custom_provider` is invoked:
- **Root keys**: Unrelated top-level fields (such as `modelOverrides` or custom metadata) are preserved.
- **Other providers**: All unedited providers in `providers` remain untouched.
- **Provider metadata**: Unknown custom fields on the target provider definition are preserved.
- **Model policies and patterns**: Pattern fields (`includedModels`, `excludedModels`) reflect the submitted update and do not retain stale patterns.
- **Model definitions**: Individual models in `models` are merged by `id`. Existing unknown model metadata (e.g., custom attributes or cost fields) is preserved, and existing models omitted from the update payload are retained rather than discarded.
- **Null deletion**: Setting a field to `null` deletes that field from the provider or model definition.

### Atomic writes and fail-closed safety

All configuration updates to `models.json` use atomic file replacement:
1. The destination directory is ensured.
2. The serialized JSON is written to a unique sibling temporary file (`models.json.tmp.<pid>.<timestamp>.<nonce>`).
3. The temporary file is renamed over the target file atomically.
4. Any leftover temporary files are cleaned up in a `finally` block if an error occurs.

Before any write is attempted, the bridge enforces strict fail-closed validation:
- **Provider ID**: Must be non-empty and contain only letters, digits, `-`, `_`, `.`, or `/`.
- **Payload structure**: Must be a JSON object with valid `baseUrl` (`http://` or `https://`) and `api` protocol identifier.
- **Model lists and patterns**: If provided, `models` must be an array of objects with non-empty `id` fields; `includedModels` and `excludedModels` must be arrays of strings.
- **Stored file integrity**: If the existing `models.json` contains invalid JSON syntax, a non-object root, or an invalid `providers` type, the operation immediately rejects without altering the file on disk.

## Web scope and desktop boundaries

- **Web scope**: The web bridge manages the active Pi agent home directory resolved by the server runtime (`~/.pi/agent/models.json` or dynamic override `getPiAgentDir()`).
- **Cross-home synchronization**: In the desktop Tauri application, custom provider changes can synchronize with configured Gentle Shell custom home directories (via native Rust commands in `src-tauri/src/commands/config_files.rs`). The web bridge intentionally does not replicate desktop cross-home filesystem writes. It operates exclusively within the server's effective Pi agent home.
- **Testing and isolation**: Dynamic agent directory resolution (`setPiAgentDirForTest`) allows test suites to run against isolated temporary fixtures without accessing or modifying real user configurations or environment files.
