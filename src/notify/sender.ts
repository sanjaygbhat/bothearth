/**
 * NotifySender interface + fan-out.
 * Channels: ntfy, generic webhook, Telegram bot sendMessage.
 */

import { capNotifyText, stripUrlsFromModelReason } from "./strip.ts";

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
): NotifySender {
  return {
    id: `webhook:${url}`,
    async send(payload) {
      const body = buildNotifyBody(payload);
      const res = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: body.kind,
          title: body.title,
          text: body.text,
          url: body.url ?? null,
          task_id: payload.task_id ?? null,
          computer_id: payload.computer_id ?? null,
        }),
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
