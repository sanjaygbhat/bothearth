# Enterprise service activation

The website remains static on GitHub Pages. `server.mjs` is a separate Node.js 22.18+ HTTP service with a persistent SQLite database and Resend email delivery. The local BotHearth daemon is never exposed to the public internet. The legacy service needs no browser JavaScript or payment SDK. The optional new account path uses the existing `jose` library for Google ID-token validation and a small script for copying a revealed key.

The implemented flow is work email → one-time code → acceptance of the offer terms → a downloadable licence certificate. Later sign-ins on the same registrable domain see the same certificate. Additional-licence enquiries are stored and emailed to the private `ENTERPRISE_CONTACT` recipient, with the verified work email as `reply_to`.

## Activate

1. Use an always-on Node host with a persistent disk and HTTPS, or a VM with a process supervisor and reverse proxy. Run **one service instance against one persistent database**, not independent databases on multiple replicas. GitHub Pages and an ordinary Cloudflare Worker cannot run this Node/SQLite service. This change does not provision hosting or modify DNS.
2. In Resend, verify a sending domain you own, using the DNS records Resend supplies. Create a sending-only API key. Set `ENTERPRISE_FROM` to an address on that verified domain, for example `BotHearth <licences@bothearth.com>`. Do not use a Gmail address as the sender. The enquiry recipient can remain Gmail. See [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction) and [email API](https://resend.com/docs/api-reference/emails/send-email).
3. Install from this checkout with `npm ci --omit=dev`. Configure these values in the host's secret/environment settings; never put secrets in Git, public HTML, command arguments, or chat:

   | Variable | Value |
   |---|---|
   | `ENTERPRISE_ORIGIN` | Exact public HTTPS origin, e.g. `https://enterprise.bothearth.com`, without trailing slash |
   | `ENTERPRISE_SECRET` | A random secret of at least 32 characters; keep it stable across restarts |
   | `RESEND_API_KEY` | Sending-only Resend API key |
   | `ENTERPRISE_FROM` | Verified sender address |
   | `ENTERPRISE_CONTACT` | Required private recipient address; never rendered into public pages |
   | `ENTERPRISE_DB` | Absolute path on the persistent disk, e.g. `/var/lib/bothearth-enterprise/licences.sqlite` |
   | `PORT` | Optional; defaults to `4180` |
   | `ENTERPRISE_BIND` | Optional; defaults to `127.0.0.1`; use `0.0.0.0` only when required by the host's private ingress |

4. Start `npm run enterprise:start` under the host's restart supervisor. Configure the HTTPS ingress to forward to that service. `/health` returns `ok`. The service does not trust forwarded client-IP headers; requests behind one proxy share its conservative request budget. Never log request bodies, cookies, or authorization headers at the proxy. Preserve the public `Origin` header.
5. Run `npm run site:test` after installing dev dependencies locally. Then verify a real code reaches an owned organisational mailbox, claim the organisation's real intended licence, download its certificate, and submit an enquiry to your inbox. This issues a real grant; use a separate staging database and sender for dummy organisations. Check delivery in Resend and the receiving inbox. No real emails were sent by the automated tests.
6. Only after the service works, set the public site's repository variable `SITE_ENTERPRISE_URL=https://enterprise.bothearth.com` (or the actual origin), rebuild, and publish the website through its existing workflow. The variable is public configuration, not a secret. Until it is set, the enterprise page says online claims are not open and offers direct email contact.

For a local run, the origin may be `http://127.0.0.1:4180`; production requires HTTPS and uses a `__Host-` Secure/HttpOnly cookie. Tests inject email delivery and never require provider credentials. There is deliberately no production switch that reveals sign-in codes.

## Licence and delivery records

The database's `licences.domain` primary key makes duplicate and simultaneous claims idempotent. Public Suffix List parsing groups `department.company.co.uk` under `company.co.uk`. Personal/disposable providers and hosted private suffixes are rejected. Update the pinned domain-data dependencies periodically. An unknown personal/disposable provider can escape a list; mailbox access alone cannot prove legal identity or authority. The claimant attests to authority and to one free grant per organisation. Different registered domains belonging to the same legal organisation require manual duplicate review.

The certificate stores the issued software version and a snapshot of accepted terms. The current certificate records the published free allowance for one running business bot, including client deliverables, indefinitely. It does not stack with that allowance or grant resale/hosting rights. Outputs may be sold. Future releases and support are excluded. This is a recorded legal entitlement, not DRM: there is no online activation check in the agent. Keep issued versions available and retain licence backups; do not delete a grant when a session expires. New terms require a new terms version, without rewriting existing rows.

Enquiries are persisted before sending. Successful provider acceptance is recorded; a bounce or spam-folder delivery is still possible. Failed/uncertain sends remain visible after sign-in with a retry action and a stable provider idempotency key. Automatic retries stop being available after 23 hours because [Resend keys expire after 24 hours](https://resend.com/docs/api-reference/emails/send-email); follow older failures up manually from the saved record to avoid duplicate mail. The UI never claims an email succeeded after a provider failure. Enquiries older than 90 days and expired authentication/rate-limit rows are removed on the next request. Mailbox, provider and backup retention remain separate.

Back up SQLite using its backup API or stop the service before copying the database and any WAL sidecar files. Use encrypted backups, restrict filesystem access, and test restoration. Losing or reinitialising the database would lose perpetual grant records and permit duplicate claims. A secret rotation signs users out; it does not invalidate their licence records. Review pending enquiries (`delivered IS NULL`) and Resend bounces operationally.

The SQL schema is created on startup. No paid checkout or payment-created entitlement exists yet; quotes and confirmed payment records govern additional licences separately. Additional business bot licences are US$49 once, plus applicable tax, for businesses outside India. The public commercial and refund policies govern paid orders. Payment-provider approval is still required.

## Public contact form

`contact.mjs` is a separate, stateless Node service for the public contact form. It requires `ENTERPRISE_CONTACT`, `ENTERPRISE_FROM`, and `RESEND_API_KEY` only. Run one instance (including Cloud Run with maximum instances 1), listening on `PORT` or 8080. `/health` checks availability; `/enquiry` accepts native form POSTs only from `https://bothearth.com`. It validates fields, applies a honeypot and conservative rate limits, forwards enquiries with an unverified reply-to address, and never renders the recipient. No customer database or local agent is exposed. Set the website repository variable `SITE_CONTACT_URL` to the deployed HTTPS `/enquiry` URL after verifying real delivery. Provider failures return an explicit error, never a success receipt.

## Optional versioned Google account service

The new `/account` path is **disabled by default**. Enabling it adds separate account, consent and signed-certificate tables in the same SQLite database; it never changes legacy work-email routes, certificates, prices or published no-activation rights. No release boundary or replacement legal terms are selected automatically. Keep using the full source checkout for this service; its verifier is `src/licensing/certificate.ts`, loaded using Node's native type stripping.

Implemented: Google sign-in → explicit account/licence terms acceptance → one noncommercial certificate per account, covered release and terms → Reveal/Copy/Download. Repeated requests and restarts return the exact original certificate. The account page includes installation instructions, account/licence/accepted-terms JSON export, and a separate optional newsletter preference. Google sign-in does not authorise access to a local BotHearth daemon.

Configure the existing service variables above, plus these external secrets/configuration:

| Variable | Required value |
|---|---|
| `ENTERPRISE_ACCOUNT_CONFIG` | Absolute path to the JSON configuration described below; omit to disable the new path |
| `GOOGLE_CLIENT_ID` | Google web OAuth client ID for this account service |
| `GOOGLE_CLIENT_SECRET` | That client's secret, supplied by the host's secret manager/environment |
| `ENTERPRISE_LICENCE_KEY_FILE` | Absolute path to an owner/root-owned regular Ed25519 PKCS#8 PEM private key file, mode `0600`; symlinks are rejected |
| `ENTERPRISE_ACCOUNT_DATA_KEY` | A separate stable random 32-byte key, base64-encoded, for encrypting stored certificates and email-link/PKCE secrets |

The configuration file contains no credentials. All three terms files are complete, approved plain text; paths resolve relative to the configuration file. These identifiers are examples of the required shape, **not an adopted release or licence**:

```json
{
  "model": "google-offline-v1",
  "coveredRelease": "EXACT_OWNER_SELECTED_RELEASE_OR_COMMIT",
  "keyId": "issuer-key-01",
  "terms": {
    "account": { "id": "APPROVED_ACCOUNT_TERMS_ID", "file": "account-terms.txt" },
    "noncommercial": { "id": "APPROVED_NONCOMMERCIAL_TERMS_ID", "file": "noncommercial-terms.txt" },
    "privacy": { "id": "APPROVED_ACCOUNT_PRIVACY_ID", "file": "account-privacy.txt" }
  }
}
```

Use separate production and staging Google clients, databases and keys. The exact authorised Google redirect URI is `ENTERPRISE_ORIGIN/account/auth/google/callback`; production requires HTTPS. Open signup in the person's normal browser. Google receives only the requested `openid email` scopes, with state, nonce and S256 PKCE. `jose` validates Google's RS256 signature, issuer, audience, token age and expiry against Google's fixed JWKS endpoint. Only the stable subject and email are retained; names, avatars, access tokens and refresh tokens are discarded. Do not infer organisation authority from an email domain. See [Google's OIDC flow](https://developers.google.com/identity/openid-connect/openid-connect) and [ID-token validation](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

Sessions last 24 hours, with a fresh sign-in required after 15 minutes before key reveal/download/export or new certificate issuance. Necessary Secure/HttpOnly/SameSite cookies are separate from legacy enterprise and local daemon sessions. Expired authentication challenges and sessions are removed at least once per minute while the process runs, as well as on account requests. No authentication tokens, key bodies or email contents are logged by the service; configure the reverse proxy to omit sensitive query strings and headers too.

Certificates use compact JWS with fixed `Ed25519`, `bothearth-license+jws` and a pinned issuer key ID. Verification is entirely local and accepts only the exact `covered_release`. There is no expiry, heartbeat, fingerprint or installation registry. Noncommercial certificates have no invented concurrent-installation cap. Commercial certificates, once a real fulfilment integration exists, represent one concurrent daemon each. A certificate is private entitlement evidence, not an account password or remote-control credential. Its payload has opaque holder/licence IDs, coverage and a terms hash; it is readable, not encrypted. Exact signed certificates are encrypted in SQLite using AES-256-GCM. No private signing key ships in the app.

Pin the public verification key in the applicable app release through its separate release configuration. Do not let a pasted licence supply its own trusted public key. On signer rotation, use a new `keyId`, preserve old public verification keys and keep historic signed certificates; older builds must already trust a key before receiving its new certificates. The service rejects changing a public key under an existing ID, rewriting an existing terms ID, or using the wrong account-data encryption key. Back up the encryption key separately from encrypted database backups; rotating the session secret signs users out but leaves certificates readable. Offline key copies cannot be remotely invalidated everywhere, and offline licence verification does not remove a task's need for model/network services.

Newsletter consent is unchecked and separate. Requests record the exact consent text/version, source and time, then send a 24-hour confirmation link. GET visits do not subscribe or unsubscribe. Confirmation and unsubscribe POSTs use independent opaque capabilities; unsubscribe requires no login and supports one-click email POSTs. Withdrawal suppresses all records for the destination immediately, including pending confirmation, and never changes a licence. A changed Google email does not transfer newsletter consent. `newsletterRecipients(db)` applies suppression at send time; any future campaign sender must call it again for retries and must restore/reapply suppression changes after restoring backups. No newsletter campaign sender, analytics or tracking pixels are implemented. Service/provider/mailbox and statutory record-retention policies still need deployment-specific configuration.

The account page also supports recovery and closure after a fresh Google sign-in. A recovery code is shown once; only its SHA-256 digest is stored, and generating another replaces it. Sign into a different Google identity without an existing BotHearth profile to redeem it once. Recovery preserves the original holder and exact certificates, revokes the old identity’s sessions and withdraws its newsletter consent. Existing accounts cannot be merged. Account closure requires an explicit confirmation, revokes sessions, removes the Google identity, email and recovery code, and suppresses newsletter delivery. Opaque certificate and accepted-terms evidence remain for existing perpetual rights. Backup and legally required retention need deployment-specific policies; closure does not invalidate offline certificates.

`GET /account/status` reports whether signup is enabled and always reports checkout unavailable. The commercial page shows **US$60 once per bot**, **planned future US$199** (not a former price), quantities **1–50**, and the existing Contact us form for larger orders. `POST /account/orders` validates the quantity and returns `503` without creating an order, collecting money or issuing paid certificates. No payment provider has been configured or verified; there is no fake webhook, success redirect or manual payment switch. Add fulfilment only against the actual approved provider, with server-verified payment events, one certificate per seat, durable idempotency, recoverable signing/delivery and reconciliation. Existing seller and refund decisions remain unchanged.

Before public activation, supply the approved release boundary and legal/privacy texts, Google domain/branding/client configuration, verified sender and real delivery evidence, public verification-key packaging, encrypted-backup/restore ownership, and the applicable privacy/retention/contact arrangements. Paid checkout/receipts and payment dispute handling are not implemented. Google account loss leaves exported certificates usable; the unauthenticated Contact us route remains available for account help. Do not describe this local implementation as deployed or payment-ready.

Run `node --test tests/unit/licensing/certificate.test.ts tests/unit/website/accounts.test.ts tests/unit/website/enterprise.test.ts tests/unit/website/contact.test.ts`. These tests use generated test keys, a synthetic Google provider and intercepted mail, never a real login, email or purchase.
