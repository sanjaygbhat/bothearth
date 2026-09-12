/**
 * NotifySender interface + fan-out.
 * Channels: ntfy, generic webhook, Telegram bot sendMessage.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { capNotifyText, stripUrlsFromModelReason } from "./strip.ts";

/** Replay window for signed webhook POSTs. */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const WEBHOOK_SIGNATURE_HEADER = "x-modelbot-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-modelbot-timestamp";
export const WEBHOOK_EVENT_ID_HEADER = "x-modelbot-event-id";

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function webhookEndpointAndSecret(
  url: string,
  explicitSecret?: string,
): { endpoint: string; secret: string } {
  const hashAt = url.indexOf("#");
  const endpoint = hashAt >= 0 ? url.slice(0, hashAt) : url;
  let fromHash = hashAt >= 0 ? url.slice(hashAt + 1) : "";
  try {
    fromHash = decodeURIComponent(fromHash);
  } catch {
    // keep raw fragment
  }
  const secret = explicitSecret || fromHash || process.env.MODELBOT_WEBHOOK_SECRET || "";
  return { endpoint, secret };
}

/** HMAC-SHA256 over `timestamp.event_id.body`. Prefix matches audit hashes. */
export function hmacWebhookSignature(
  secret: string,
  timestamp: string,
  eventId: string,
  body: string,
): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  return `hmac-sha256:${mac}`;
}

/**
 * Receiver helper. False when the secret is empty, the signature mismatches,
 * or the timestamp is outside the 5-minute replay window.
 */
export function verifyWebhook(opts: {
  secret: string;
  signature: string;
  timestamp: string;
  eventId: string;
  body: string;
  nowMs?: number;
}): boolean {
  if (!opts.secret) return false;
  const tsSec = Number(opts.timestamp);
  if (!Number.isFinite(tsSec) || !opts.signature || !opts.eventId) return false;
  const nowMs = opts.nowMs ?? Date.now();
  const tsMs = tsSec * 1000;
  if (nowMs - tsMs > WEBHOOK_REPLAY_WINDOW_MS) return false;
  if (tsMs - nowMs > WEBHOOK_REPLAY_WINDOW_MS) return false;
  const expected = hmacWebhookSignature(opts.secret, opts.timestamp, opts.eventId, opts.body);
  return safeEqualStr(opts.signature, expected);
}

export type NotifyEventKind =
  | "takeover"
  | "approval"
  | "task_done"
  | "task_fail"
  | "routine_fail";

export interface NotifyPayload {
  kind: NotifyEventKind;
  title: string;
  /** Model-authored or free text — URLs stripped before send. */
  reason?: string;
  /** Operator URL (takeover UI etc.) — never stripped. */
  url?: string;
  task_id?: string;
  computer_id?: string;
}

export interface NotifySender {
  readonly id: string;
  send(payload: NotifyPayload): Promise<void>;
}

export type FetchLike = typeof fetch;

export function buildNotifyBody(payload: NotifyPayload): {
  title: string;
  text: string;
  kind: NotifyEventKind;
  url?: string;
} {
  const reason = capNotifyText(
    stripUrlsFromModelReason(payload.reason ?? ""),
  );
  const parts = [reason];
  if (payload.url) parts.push(payload.url);
  if (payload.task_id) parts.push(`task=${payload.task_id}`);
  return {
    title: payload.title,
    text: parts.filter(Boolean).join("\n"),
    kind: payload.kind,
    ...(payload.url ? { url: payload.url } : {}),
  };
}

export function createNtfySender(
  target: { server: string; topic: string },
  fetchImpl: FetchLike = fetch,
): NotifySender {
  const base = target.server.replace(/\/$/, "");
  const endpoint = `${base}/${encodeURIComponent(target.topic)}`;
  return {
    id: `ntfy:${target.topic}`,
    async send(payload) {
      const body = buildNotifyBody(payload);
      const res = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Title: body.title,
          "Content-Type": "text/plain; charset=utf-8",
          Tags: payload.kind,
        },
        body: body.text,
      });
      if (!res.ok) {
        throw new Error(`ntfy send failed: HTTP ${res.status}`);
      }
    },
  };
}

export function createWebhookSender(
  url: string,
  fetchImpl: FetchLike = fetch,
  opts: { secret?: string; now?: () => number; eventId?: () => string } = {},
): NotifySender {
  const { endpoint, secret } = webhookEndpointAndSecret(url, opts.secret);
  return {
    id: `webhook:${endpoint}`,
    async send(payload) {
      const body = buildNotifyBody(payload);
      const timestamp = String(Math.floor((opts.now?.() ?? Date.now()) / 1000));
      const eventId = opts.eventId?.() ?? randomUUID();
      const raw = JSON.stringify({
        kind: body.kind,
        title: body.title,
        text: body.text,
        url: body.url ?? null,
        task_id: payload.task_id ?? null,
        computer_id: payload.computer_id ?? null,
        event_id: eventId,
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (secret) {
        headers[WEBHOOK_SIGNATURE_HEADER] = hmacWebhookSignature(secret, timestamp, eventId, raw);
        headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp;
        headers[WEBHOOK_EVENT_ID_HEADER] = eventId;
      }
      const res = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers,
        body: raw,
      });
      if (!res.ok) {
        throw new Error(`webhook send failed: HTTP ${res.status}`);
      }
    },
  };
}

export function createTelegramSender(
  opts: { botToken: string; chatId: string; apiBase?: string },
  fetchImpl: FetchLike = fetch,
): NotifySender {
  const apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(
    /\/$/,
    "",
  );
  const endpoint = `${apiBase}/bot${opts.botToken}/sendMessage`;
  return {
    id: `telegram:${opts.chatId}`,
    async send(payload) {
      const body = buildNotifyBody(payload);
      const text = `*${body.title}*\n${body.text}`.slice(0, 4000);
      const res = await fetchImpl(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: opts.chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`telegram send failed: HTTP ${res.status}`);
      }
    },
  };
}

function ntfyFromUri(uri: string, fetchImpl: FetchLike): NotifySender {
  const rest = uri.slice("ntfy://".length);
  if (rest.startsWith("http://") || rest.startsWith("https://")) {
    const parsed = new URL(rest);
    const topic = parsed.pathname.replace(/^\//, "");
    if (!topic) throw new Error(`notify: ntfy URI missing topic`);
    return createNtfySender(
      { server: `${parsed.protocol}//${parsed.host}`, topic },
      fetchImpl,
    );
  }
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return createNtfySender(
      { server: "https://ntfy.sh", topic: rest },
      fetchImpl,
    );
  }
  const host = rest.slice(0, slash);
  const topic = rest.slice(slash + 1);
  if (!topic) throw new Error(`notify: ntfy URI missing topic`);
  return createNtfySender(
    { server: host.includes("://") ? host : `https://${host}`, topic },
    fetchImpl,
  );
}

/**
 * Parse channel URIs from config:
 * - ntfy://topic  |  ntfy://host/topic  |  ntfy://https://server/topic
 * - telegram:<botToken>:<chatId>
 * - webhook:https://...
 */
export function parseNotifyTarget(
  uri: string,
  fetchImpl: FetchLike = fetch,
): NotifySender {
  const u = uri.trim();
  if (u.startsWith("webhook:")) {
    const url = u.slice("webhook:".length);
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`notify: webhook target must be http(s) URL: ${uri}`);
    }
    return createWebhookSender(url, fetchImpl);
  }
  if (u.startsWith("telegram:")) {
    const rest = u.slice("telegram:".length).replace(/^\/\//, "");
    const idx = rest.lastIndexOf(":");
    if (idx <= 0) {
      throw new Error(
        `notify: telegram URI must be telegram:<botToken>:<chatId>`,
      );
    }
    const botToken = rest.slice(0, idx);
    const chatId = rest.slice(idx + 1);
    if (!botToken || !chatId) {
      throw new Error(`notify: telegram URI missing token or chat id`);
    }
    return createTelegramSender({ botToken, chatId }, fetchImpl);
  }
  if (u.startsWith("ntfy://")) {
    return ntfyFromUri(u, fetchImpl);
  }
  throw new Error(
    `notify: unsupported URI (want ntfy:// | telegram: | webhook:): ${uri}`,
  );
}

export function createNotifyFanout(
  uris: string[],
  fetchImpl: FetchLike = fetch,
): NotifySender {
  const senders = uris.map((uri) => parseNotifyTarget(uri, fetchImpl));
  return {
    id: `fanout:${senders.map((s) => s.id).join(",")}`,
    async send(payload) {
      const errors: string[] = [];
      for (const s of senders) {
        try {
          await s.send(payload);
        } catch (e) {
          errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (errors.length) {
        throw new Error(`notify fanout partial failure: ${errors.join("; ")}`);
      }
    },
  };
}
