import { createHash, randomUUID } from "node:crypto";
import { parse } from "tldts";
import {
  APPROVAL_TTL_SEC,
  type ApprovalBind,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalStatus,
  type PolicyGate,
  type ToolName,
} from "../types/contracts.ts";
import { canonicalJson } from "../audit/chain.ts";

export interface ApprovalStore {
  get(id: string): StoredApproval | undefined;
  set(id: string, value: StoredApproval): void;
}

export interface StoredApproval {
  request: ApprovalRequest;
  status: ApprovalStatus;
  decided_at?: string;
  decision?: ApprovalDecision;
}

export type ApprovalActor = "human" | "agent";

export function computeActionHash(input: {
  tool: ToolName;
  args: Record<string, unknown>;
  gate: PolicyGate;
  origin: string;
}): string {
  const payload = canonicalJson({
    args: input.args,
    gate: input.gate,
    origin: input.origin,
    tool: input.tool,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function createApproval(opts: {
  tool: ToolName;
  args: Record<string, unknown>;
  gate: PolicyGate;
  task_id: string;
  control_epoch: number;
  origin: string;
  now?: Date;
  ttl_sec?: number;
  approval_id?: string;
}): ApprovalRequest {
  const now = opts.now ?? new Date();
  const ttl = opts.ttl_sec ?? APPROVAL_TTL_SEC;
  const expires = new Date(now.getTime() + ttl * 1000).toISOString();
  const action_hash = computeActionHash({
    tool: opts.tool,
    args: opts.args,
    gate: opts.gate,
    origin: opts.origin,
  });
  const bind: ApprovalBind = {
    task_id: opts.task_id,
    control_epoch: opts.control_epoch,
    origin: opts.origin,
    action_hash,
    expires,
  };
  return {
    approval_id: opts.approval_id ?? `ap_${randomUUID()}`,
    tool: opts.tool,
    args: opts.args,
    gate: opts.gate,
    bind,
    created_at: now.toISOString(),
  };
}

/**
 * Keep historical hosting boundaries even when retired services leave the PSL.
 * The installed PSL parser below supplies current ICANN and private suffixes.
 */
const PUBLIC_SUFFIX_FLOOR = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "co.kr",
  "com.br", "com.mx", "com.ar",
  "co.za", "co.in",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev",
  "herokuapp.com", "web.app", "firebaseapp.com",
  "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "azurewebsites.net",
  "workers.dev", "repl.co", "glitch.me",
]);

/** A host someone can actually register: at least two labels, and not itself a public suffix. */
function isRegistrableDomain(host: string): boolean {
  const parsed = parse(host, { allowPrivateDomains: true });
  return Boolean(parsed.domain && (parsed.isIcann || parsed.isPrivate) && !PUBLIC_SUFFIX_FLOOR.has(host));
}

/**
 * The origins one grant covers. Someone who allows `wikipedia.org` means the
 * site, and the site answers on both the bare host and its `www` alias — the
 * redirect between the two is invisible to them, but to the origin gate it is a
 * second new origin, which is what turned a single navigation into a second
 * approval while the first was already spent. Nothing wider is implied: no
 * other subdomain, no other scheme, no other port.
 */
export function grantedOriginsFor(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
  const host = parsed.hostname.toLowerCase();
  const origins = [parsed.origin];
  // Only a named host has a `www` alias; an IP literal or a bare label has none.
  const named = host.includes(".") && !/^[\d.]+$/.test(host) && !host.startsWith("[");
  // The pair is only an alias when the non-`www` half is a domain someone owns.
  // `www.github.io` and `github.io` are different owners, as are `www.co.uk` and
  // the registry suffix `co.uk`, so neither direction may grant the other.
  const apex = host.startsWith("www.") ? host.slice(4) : host;
  if (named && isRegistrableDomain(apex)) {
    const sibling = host.startsWith("www.") ? apex : `www.${host}`;
    origins.push(`${parsed.protocol}//${sibling}${parsed.port ? `:${parsed.port}` : ""}`);
  }
  return origins;
}

/**
 * The origins one approval grants. `navigationUrl` is the destination the host
 * itself resolved — a blocked-navigation report from computer-server, recorded
 * in the approval's bind — and it wins. Otherwise only the navigation target in
 * the tool's own `url` counts. A `navigation_url` sitting beside the model's
 * arguments is the model's, never the host's, and is ignored here: a tool call
 * must not be able to name the destination its approval grants.
 *
 * `gateOrigin` is the origin the policy gate itself named, which is how a
 * grant covers a site rather than one tool on it: allowing a typed submit on
 * mail.google.com is a decision about mail.google.com, so the next keystroke
 * there is not a fresh question. It is host-observed like the rest, and the
 * gate only names it for the gates that are about a site.
 */
export function approvalGrantOrigins(
  tool: string,
  args: Record<string, unknown>,
  navigationUrl?: string,
  gateOrigin?: string,
): string[] {
  const navigational = tool === "browser_navigate" || tool === "browser_tabs";
  const url = navigationUrl ??
    (navigational && typeof args.url === "string" ? args.url : undefined) ??
    gateOrigin;
  return url ? grantedOriginsFor(url) : [];
}

/**
 * Decide an approval. Agents are never allowed to approve (T3 / split credentials).
 * Binding tuple must still match; expired → expired.
 */
export function decideApproval(
  store: ApprovalStore,
  opts: {
    approval_id: string;
    decision: ApprovalDecision;
    actor: ApprovalActor;
    task_id: string;
    control_epoch: number;
    origin: string;
    action_hash: string;
    now?: Date;
  },
):
  | { ok: true; status: ApprovalStatus }
  | { ok: false; reason: string; status?: ApprovalStatus } {
  if (opts.actor === "agent") {
    return { ok: false, reason: "agent cannot approve" };
  }
  const stored = store.get(opts.approval_id);
  if (!stored) return { ok: false, reason: "unknown approval" };
  const now = opts.now ?? new Date();
  if (Date.parse(stored.request.bind.expires) <= now.getTime()) {
    stored.status = "expired";
    return { ok: false, reason: "approval expired", status: "expired" };
  }
  const b = stored.request.bind;
  if (
    b.task_id !== opts.task_id ||
    b.control_epoch !== opts.control_epoch ||
    b.origin !== opts.origin ||
    b.action_hash !== opts.action_hash
  ) {
    return { ok: false, reason: "approval binding mismatch" };
  }
  if (stored.status !== "pending") {
    return {
      ok: false,
      reason: `approval already ${stored.status}`,
      status: stored.status,
    };
  }
  const status: ApprovalStatus =
    opts.decision === "allow_once" || opts.decision === "allow_task"
      ? "approved"
      : opts.decision === "deny"
        ? "denied"
        : "killed";
  stored.status = status;
  stored.decision = opts.decision;
  stored.decided_at = now.toISOString();
  return { ok: true, status };
}
