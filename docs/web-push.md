# Receive project notifications with the page closed

Web Push delivers task-completion and waiting-for-input notifications to each browser or mobile device that enables the existing **Enable system notifications** switch. The Pi Viewer server and its Pi process must remain running. Notifications identify the custom project name, Git repository, or working folder, in that order; directory paths and conversation contents are not included.

## Server setup

1. Generate a VAPID key pair on your deployment host using the installed `web-push` CLI: `npx web-push generate-vapid-keys`. Keep the private key secret; do not commit it.
2. Configure these environment variables before starting the server:

   | Variable | Value |
   |---|---|
   | `PI_VIEWER_VAPID_PUBLIC_KEY` | Public VAPID key from the generated pair |
   | `PI_VIEWER_VAPID_PRIVATE_KEY` | Private VAPID key; server only |
   | `PI_VIEWER_VAPID_SUBJECT` | Operator contact, such as `mailto:admin@example.com` |

3. For local use, open `http://localhost` with authentication disabled: Web Push uses a separate, per-browser HttpOnly cookie valid for 24 hours. Both the Host and the actual connection must be loopback; LAN access and forwarded headers do not enable this mode. For remote access, enable `PI_VIEWER_AUTH_ENABLED=true` with a configured `PI_VIEWER_AUTH_KEY` and HTTPS. Preserve same-origin and reverse-proxy rules.
4. Build and start with the existing `npm run build` and `npm run start` commands. Do not use the frontend-only preview as the backend. For development, `npm run dev` loads the server-only VAPID variables from Vite's `.env` files; production `npm run start` loads `.env` from its working directory. Restart the server after changing keys or authentication configuration. Process environment overrides `.env` values. VAPID private keys are never exposed through `VITE_` variables or frontend build definitions.

When Web Push is unconfigured or unsupported, existing notifications while the page is open remain available. Do not expose the service publicly with authentication disabled.

## Device setup

1. Open Pi Viewer and sign in if authentication is enabled.
2. In **Settings → Notifications**, select **Register this browser**, review the device-enrollment modal, and confirm. Allow browser notifications when prompted. The button works even if **Enable system notifications** is already on; turning the switch on for an unregistered browser also opens the modal.
3. Keep a Pi task running, close the viewer page, and verify a notification arrives when the task finishes or requests input.

Each device is independent: turning off its switch removes its subscription without disabling other devices. A persisted enabled preference does not create a new subscription or show a permission prompt on page load; use **Register this browser** and confirm explicitly to register a new device. Existing browser subscriptions are synchronized after authentication and when settings or project names change.

## Authorization and delivery boundaries

- With web authentication enabled, delivery pauses when the device's login session expires and stops after logout. Open Pi Viewer and sign in again to renew the subscription authorization.
- Subscription records follow in-memory authorization leases. Local browser identities also expire after 24 hours; reopen Pi Viewer to renew. After a server restart, reopen Pi Viewer to synchronize the existing browser subscription. Authentication-enabled deployments continue using login leases, not local identities.
- The server avoids sending push to a device's login session while it has an active, authorized viewer event connection; existing in-page alerts handle that session. Other subscribed devices with no active connection still receive push.
- Every valid push received by the service worker is displayed, even if a viewer page opens while it is in transit. A connection transition can produce a duplicate, but pushes are never silently discarded based on open windows.
- Clicking a notification focuses an existing viewer window or opens the viewer root. It does not navigate to a filesystem path.
- Browser push services and operating-system policies may delay or suppress delivery. This feature does not keep the server or Pi running after server shutdown.
- iOS/iPadOS Web Push requires a compatible version and the web app installed on the Home Screen; ordinary browser tabs may not support it. Browser support must be checked on the target device.
- Delivery supports recognized browser push-service endpoints only. Custom/self-hosted push gateways are not supported.

## Verification

Automated tests exercise subscription validation, session expiry/revocation, event payloads, client registration and disable behavior, and service-worker notification handling with isolated mocks. They do not prove a browser vendor accepted an encrypted message or an operating system displayed a banner. Verify the closed-page flow above on your HTTPS deployment before relying on delivery.
