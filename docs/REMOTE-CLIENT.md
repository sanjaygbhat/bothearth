# Remote client contract

A BotHearth instance belongs to one operator. Every paired device has full operator authority, including pairing or revoking other devices. This is not a tenant, team-role, or hosted-account protocol. Browser profiles, vault, provider login, task execution and SQLite stay on that instance.

## Origin and enrollment

Use one canonical HTTPS origin, configured as `remote.public_origin` or `MODELBOT_PUBLIC_ORIGIN`. Keep the daemon on loopback behind a trusted proxy which preserves `Host` and supports WebSocket upgrades. Do not trust client-supplied forwarded headers. Local development retains loopback HTTP. Existing explicit `remote.allowed_hosts` entries remain supported as exact HTTPS authorities; new deployments should set the canonical origin.

The client stores the chosen origin before enrollment and must never send credentials to a different origin or follow an enrollment redirect to one. Use the platform's normal TLS verification and cookie jar. WebView and native API requests must use the same operator session, scoped to that exact origin; native secure storage may restore it into an ephemeral WebView cookie jar. Do not disable certificate validation, copy cookies into links, or use a bootstrap token as a permanent bearer. Changing instances requires an explicit connection choice and a separate session.

| Operation | Request | Response |
| --- | --- | --- |
| Pair another device | `POST /api/v1/session/pairings`, operator cookie + CSRF | `201 {url, expires_at}` |
| Redeem invitation | `POST /api/v1/session/bootstrap`, exact `Origin`, JSON `{token, label?}` | HttpOnly session cookie and `{ok, csrf, ...readiness}` |
| Session/readiness | `GET /api/v1/session` | `{ok, csrf, origin, expires_at, ...readiness}` |
| List devices | `GET /api/v1/session/devices` | `{devices:[{id,label,created_at,expires_at,current}]}` |
| Revoke device | `DELETE /api/v1/session/devices/:id`, cookie + CSRF | `{ok:true}`; active sockets close |
| Sign out current device | `POST /api/v1/session/logout`, cookie + CSRF | Cookie cleared; sockets close |

A pairing link uses `/#bootstrap=TOKEN`, expires after ten minutes, and is single-use. At most 20 unused invitations may be active. The daemon stores only its hash. A device label is optional on **redemption**, at most 80 characters. Device IDs are non-bearer identifiers; the inventory never includes session cookies or CSRF secrets of other devices. Strip a pairing fragment before any asynchronous work, history, analytics or external navigation. Store neither the fragment nor a copy of the token after exchange. Pairing must be an explicit operator action; it never acquires HUMAN control automatically.

A session survives daemon restarts and lasts while the device is used at least once every 7 days, for at most 30 days from pairing; after that the operator must run `bothearth pair` for a new link. Remote cookies are host-only, HttpOnly, SameSite=Strict and Secure. Each new session is bound to the exact origin where it was created. Legacy sessions and unbound legacy bootstrap tokens remain local-only. A daemon restart preserves unexpired sessions and cannot reactivate a consumed invitation. Revoking a device stops future HTTP requests, WebSocket output and queued input; an already-entered operation may finish. Revocation and expiry do not release a HUMAN/PAUSED privacy gate or delete browser profiles. A lost device should also be removed from the private network's device inventory.

Host recovery does not require restarting the browser:

```sh
bothearth pair
bothearth pair --list
bothearth pair --revoke DEVICE_ID
```

Run these as the instance's host account using the same config/data directory as its service. A systemd service credential is not required for this SQLite-only recovery command. Protect the printed pairing link as an operator credential. CLI revocation is enforced on the next request/frame/input and by the existing one-second idle-session sweep.

## Tasks, results and live control

Use the existing same-origin APIs; remote access adds no parallel task engine:

- `/api/v1/tasks`: list and create. A goal-only Start resolves the saved default browser or creates one on first use. An explicit Advanced `computer_id` remains supported. A busy default produces a visible conflict, not a hidden profile switch.
- `/api/v1/tasks/:id`: durable sanitized activity and terminal result preview. Use the returned result URL for the bounded complete saved result; respect truncation/error metadata.
- Existing cancel, approval and takeover routes retain their authentication, CSRF, binding and privacy checks. Stopping a task is distinct from signing out or returning control.
- `/api/v1/events` and `/api/v1/live/:computerId`: WebSocket, exact Origin and session cookie. Preserve binary live-frame decoding and the existing input protocol. Never replace a submitted epoch with a newer server epoch.

After close, expiry, backgrounding or an instance switch, clear displayed private frames and disable input. On foreground/reconnect, obtain a fresh authenticated session and authoritative mode/epoch, then a matching newly decoded frame before enabling input. Do not replay queued clicks or text. A WebView may reuse the existing control page to preserve these rules. Reconnection is not a new HUMAN acquisition. `E_TAKEOVER_BUSY` is a real privacy state, not an error to bypass.

No mobile background execution, OS push delivery, real cellular connectivity, or app-store acceptance is implied by this API. Those require their own device acceptance. Local TLS tests exercise actual HTTPS/WSS, origin/cookie isolation, expiry, restart and device revocation; they are not an external VPS deployment claim.
