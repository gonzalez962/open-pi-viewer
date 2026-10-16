# Native Pi OAuth from the web viewer

The web viewer uses the same SDK-anchored OAuth helper as desktop. Account credentials remain in Pi's effective agent home; the browser receives only projected status, prompts, and verification links.

## Setup

1. For keyless development, leave `PI_VIEWER_OAUTH_ACCESS_KEY` unset. Local and remote browsers establish their private sessions automatically; no access-key prompt is required. This is not an access authorization barrier: anyone who can reach the bridge can manage OAuth.
2. Ensure `PI_VIEWER_PI_CLI` (or the configured `piCliPath`) resolves to the installed Pi/Gentle Shell entrypoint. The server must be able to resolve that entrypoint's Pi SDK. If that runtime uses an isolated agent home, set `PI_CODING_AGENT_DIR` explicitly to the same agent directory before starting the viewer. Otherwise OAuth uses `~/.pi/agent`; choosing a Gentle Shell entrypoint alone does not select its isolated credential store.
3. Run `npm run dev`. For remote access, use a trusted private network such as Tailscale and HTTPS or an encrypted VPN connection. Do not expose the development bridge publicly.
4. Open Providers and choose the provider's sign-in action. The viewer establishes its session and reconnects its private events automatically. Follow the provider's verification link or interactive prompts.

The automatic handshake establishes an expiring, server-held session in an HttpOnly, SameSite=Strict cookie. Other browser sessions cannot answer or cancel your active login or receive its private events. Login flows are bounded and cancelled during server shutdown.

## Scope and deployment security

- These access controls protect OAuth management and its private event stream, **not every existing bridge command**. The general IPC bridge still requires a trusted deployment perimeter.
- Without a configured key, development permits local and remote same-origin clients without authentication. Same-origin checks prevent cross-origin browser requests, but do not authenticate network clients. Keep the bridge inside a trusted development environment until the planned login protects backend OAuth operations.
- Optional keyed mode remains available by configuring `PI_VIEWER_OAUTH_ACCESS_KEY`; this requires the access-key panel. Never expose the key in `VITE_*` variables, URLs or committed files.
- Account status comes from Pi's helper, not a hardcoded provider list.
- HTTPS enables Secure cookies when the Node server directly terminates TLS. The server does not trust arbitrary forwarded headers; a reverse proxy must preserve same-origin Host/Origin and protect its upstream network.
- Authentication callbacks belong to the server running Pi. For providers with a localhost callback, use the provider's manual-code/paste flow when signing in from another device, if that provider supports it. Otherwise complete sign-in from the server machine. Remote web access does not turn a provider's localhost callback into a remote callback.
- Logout changes the server's Pi credential store for that provider, so it affects sessions using that store.

## Troubleshooting

| Message or symptom | Action |
| --- | --- |
| `OAUTH_KEY_UNCONFIGURED` | Set the access key in the server environment and restart. |
| `OAUTH_UNAUTHORIZED` after server restart or session expiry | Reload the browser page (F5) to establish a new private development session. The in-app refresh button does not reset the cached session handshake. In optional keyed mode, unlock this browser again. |
| Origin validation failed | Use the viewer and API at the same origin; check proxy Host handling. |
| Private SSE connection timeout | Check that the proxy allows streaming `/api/events`; retry authorization. |
| Helper/SDK unavailable | Correct the configured Pi entrypoint; do not point it at an unrelated package. |

Tests use an isolated fake SDK and do not authenticate or log out real accounts. Live provider verification remains a separate manual check.
