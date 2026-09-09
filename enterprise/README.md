# Enterprise service activation

The website remains static on GitHub Pages. `server.mjs` is a separate Node.js 22.18+ HTTP service with a persistent SQLite database and Resend email delivery. The local BotHearth daemon is never exposed to the public internet. No browser JavaScript, authentication framework, or payment SDK is needed.

The implemented flow is work email → one-time code → acceptance of the offer terms → a downloadable licence certificate. Later sign-ins on the same registrable domain see the same certificate. Additional-licence enquiries are stored and emailed to `sanjaygbhat@gmail.com`, with the verified work email as `reply_to`.

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
   | `ENTERPRISE_CONTACT` | Optional; defaults to `sanjaygbhat@gmail.com` |
   | `ENTERPRISE_DB` | Absolute path on the persistent disk, e.g. `/var/lib/bothearth-enterprise/licences.sqlite` |
   | `PORT` | Optional; defaults to `4180` |
   | `ENTERPRISE_BIND` | Optional; defaults to `127.0.0.1`; use `0.0.0.0` only when required by the host's private ingress |

4. Start `npm run enterprise:start` under the host's restart supervisor. Configure the HTTPS ingress to forward to that service. `/health` returns `ok`. The service does not trust forwarded client-IP headers; requests behind one proxy share its conservative request budget. Never log request bodies, cookies, or authorization headers at the proxy. Preserve the public `Origin` header.
5. Run `npm run site:test` after installing dev dependencies locally. Then verify a real code reaches an owned organisational mailbox, claim the organisation's real intended licence, download its certificate, and submit an enquiry to your inbox. This issues a real grant; use a separate staging database and sender for dummy organisations. Check delivery in Resend and the receiving inbox. No real emails were sent by the automated tests.
6. Only after the service works, set the public site's repository variable `SITE_ENTERPRISE_URL=https://enterprise.bothearth.com` (or the actual origin), rebuild, and publish the website through its existing workflow. The variable is public configuration, not a secret. Until it is set, the enterprise page says online claims are not open and offers direct email contact.

For a local run, the origin may be `http://127.0.0.1:4180`; production requires HTTPS and uses a `__Host-` Secure/HttpOnly cookie. Tests inject email delivery and never require provider credentials. There is deliberately no production switch that reveals sign-in codes.

## Licence and delivery records

The database's `licences.domain` primary key makes duplicate and simultaneous claims idempotent. Public Suffix List parsing groups `department.company.co.uk` under `company.co.uk`. Personal/disposable providers and hosted private suffixes are rejected. Update the pinned domain-data dependencies periodically. An unknown personal/disposable provider can escape a list; mailbox access alone cannot prove legal identity or authority. The claimant attests to authority and to one free grant per organisation. Different registered domains belonging to the same legal organisation require manual duplicate review.

The certificate stores the issued software version and a snapshot of accepted terms. It grants one running installation for internal business use indefinitely, with no renewal fee, subject to those terms. Future releases and support are excluded. This is a recorded legal entitlement, not DRM: there is no online activation check in the agent. Keep issued versions available and retain licence backups; do not delete a grant when a session expires. New terms require a new terms version, without rewriting existing rows.

Enquiries are persisted before sending. Successful provider acceptance is recorded; a bounce or spam-folder delivery is still possible. Failed/uncertain sends remain visible after sign-in with a retry action and a stable provider idempotency key. Automatic retries stop being available after 23 hours because [Resend keys expire after 24 hours](https://resend.com/docs/api-reference/emails/send-email); follow older failures up manually from the saved record to avoid duplicate mail. The UI never claims an email succeeded after a provider failure. Enquiries older than 90 days and expired authentication/rate-limit rows are removed on the next request. Mailbox, provider and backup retention remain separate.

Back up SQLite using its backup API or stop the service before copying the database and any WAL sidecar files. Use encrypted backups, restrict filesystem access, and test restoration. Losing or reinitialising the database would lose perpetual grant records and permit duplicate claims. A secret rotation signs users out; it does not invalidate their licence records. Review pending enquiries (`delivered IS NULL`) and Resend bounces operationally.

The SQL schema is created on startup. No paid checkout or payment-created entitlement exists yet; quotes and confirmed payment records govern additional licences separately. Additional installation licences are US$99 once, plus applicable tax, for businesses outside India. The public commercial and refund policies govern paid orders. Payment-provider approval is still required.
