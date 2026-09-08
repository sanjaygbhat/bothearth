import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessLogFilePath,
  accessLogMaxBytes,
  createAccessLogger,
  isVerboseAccessLog,
  type AccessLine,
} from "./access-log.ts";
import { startDnsSinkhole, type DnsSinkhole } from "./dns.ts";
import {
  evaluateDestination,
  loadPolicyFromEnv,
  parseHostPort,
  type PolicyConfig,
} from "./policy.ts";

type ProxyOptions = {
  proxyPort?: number;
  healthPort?: number;
  maxConcurrent?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  policy?: PolicyConfig;
  listenHost?: string;
  dnsPort?: number;
};

export type { AccessLine };

const DNSZ_TRUTHY = new Set(["1", "true", "yes"]);

/** `/dnsz` is off unless PROXY_DNSZ=1/true/yes (egress suite only). */
export function isDnszEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PROXY_DNSZ?.trim().toLowerCase();
  return v !== undefined && DNSZ_TRUTHY.has(v);
}

function isLoopbackAddr(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function deny(
  res: http.ServerResponse | net.Socket,
  status: number,
  reason: string,
): void {
  const body = reason + "\n";
  if (res instanceof http.ServerResponse) {
    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    res.end(body);
    return;
  }
  res.write(
    `HTTP/1.1 ${status} Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  res.end();
}

const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamHeaders(
  headers: http.IncomingHttpHeaders,
  host: string,
): http.OutgoingHttpHeaders {
  const blocked = new Set(HOP_BY_HOP);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  }
  const out: http.OutgoingHttpHeaders = { host };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "connection" || blocked.has(lower)) continue;
    if (value !== undefined) out[lower] = value;
  }
  out.connection = "close";
  return out;
}

export function startProxy(opts: ProxyOptions = {}): {
  proxyServer: http.Server;
  healthServer: http.Server;
  close: () => Promise<void>;
  dnsReady: Promise<DnsSinkhole | null>;
} {
  const proxyPort = opts.proxyPort ?? Number(process.env.PROXY_PORT ?? 3128);
  const healthPort = opts.healthPort ?? Number(process.env.HEALTH_PORT ?? 3129);
  const maxConcurrent =
    opts.maxConcurrent ?? Number(process.env.MAX_CONCURRENT ?? 256);
  const connectTimeoutMs =
    opts.connectTimeoutMs ?? Number(process.env.CONNECT_TIMEOUT_MS ?? 10_000);
  const idleTimeoutMs =
    opts.idleTimeoutMs ?? Number(process.env.IDLE_TIMEOUT_MS ?? 60_000);
  const listenHost = opts.listenHost ?? "0.0.0.0";
  const policy = opts.policy ?? loadPolicyFromEnv();
  const dnsPort = opts.dnsPort ?? Number(process.env.DNS_PORT ?? 53);
  let dns: DnsSinkhole | null = null;
  const access = createAccessLogger();

  let active = 0;

  const healthServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    if (req.method === "GET" && (req.url === "/dnsz" || req.url?.startsWith("/dnsz?"))) {
      // Flag default-off; loopback-only so the shell on the internal net cannot scrape names.
      if (!isDnszEnabled() || !isLoopbackAddr(req.socket.remoteAddress)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const st = dns?.stats() ?? { queries: 0, forwarded: 0, names: [] as string[] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(st) + "\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const proxyServer = http.createServer();

  proxyServer.on("request", (req, res) => {
    void handleHttp(req, res);
  });

  proxyServer.on("connect", (req, clientSocket, head) => {
    void handleConnect(req, clientSocket as net.Socket, head);
  });

  async function handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";

    // Absolute-form URL required for forward proxy
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      access.write({
        ts: new Date().toISOString(),
        method,
        host: "",
        port: 0,
        allowed: false,
        reason: "denied-url:invalid",
        bytes: 0,
      });
      deny(res, 400, "denied-url:invalid");
      return;
    }

    if (target.protocol !== "http:") {
      access.write({
        ts: new Date().toISOString(),
        method,
        host: target.hostname,
        port: Number(target.port || 80),
        allowed: false,
        reason: "denied-scheme",
        bytes: 0,
        path: target.pathname,
      });
      deny(res, 400, "denied-scheme");
      return;
    }

    const host = target.hostname;
    const port = Number(target.port || 80);
    const httpPath = target.pathname;

    if (active >= maxConcurrent) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: "denied-concurrency",
        bytes: 0,
        path: httpPath,
      });
      deny(res, 503, "denied-concurrency");
      return;
    }

    let decision = await evaluateDestination(host, port, policy);
    if (!decision.allowed) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: decision.reason,
        bytes: 0,
        path: httpPath,
      });
      deny(res, 403, decision.reason);
      return;
    }

    // DNS rebinding re-check immediately before connect
    decision = await evaluateDestination(host, port, policy);
    if (!decision.allowed) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: decision.reason + ":rebind",
        bytes: 0,
        path: httpPath,
      });
      deny(res, 403, decision.reason);
      return;
    }

    active += 1;
    let bytes = 0;
    let finished = false;
    let allowed = false;
    let reason = "client-closed";
    const connectHost = decision.addresses[0] ?? host;

    const onDone = (doneReason: string, doneAllowed: boolean): void => {
      if (finished) return;
      finished = true;
      active = Math.max(0, active - 1);
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: doneAllowed,
        reason: doneReason,
        bytes,
        path: httpPath,
      });
    };

    const upstream = http.request(
      {
        host: connectHost,
        port,
        method,
        path: target.pathname + target.search,
        headers: upstreamHeaders(req.headers, target.host),
        timeout: connectTimeoutMs,
        setHost: false,
      },
      (upRes) => {
        allowed = true;
        reason = "allowed";
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on("data", (c: Buffer) => {
          bytes += c.length;
        });
        upRes.pipe(res);
      },
    );

    upstream.on("timeout", () => {
      reason = "connect-timeout";
      upstream.destroy(new Error("connect-timeout"));
    });
    upstream.on("socket", (socket) => {
      socket.once("connect", () => {
        const peer = socket.remoteAddress;
        if (peer && !decision.addresses.includes(peer)) {
          reason = "connected-peer-mismatch";
          upstream.destroy(new Error("connected peer differs from vetted address"));
        }
      });
    });
    upstream.on("error", () => {
      const failureReason =
        reason === "client-closed" || reason === "allowed" ? "upstream-error" : reason;
      onDone(failureReason, false);
      if (!res.headersSent) deny(res, 502, "upstream-error");
      else res.destroy();
    });
    res.on("close", () => {
      onDone(reason, allowed);
    });

    req.pipe(upstream);
    req.socket?.setTimeout(idleTimeoutMs);
  }

  async function handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const method = "CONNECT";
    const authority = req.url ?? "";
    const parsed = parseHostPort(authority, 443);
    if (!parsed) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host: "",
        port: 0,
        allowed: false,
        reason: "denied-url:invalid",
        bytes: 0,
      });
      deny(clientSocket, 400, "denied-url:invalid");
      return;
    }

    const { host, port } = parsed;

    if (active >= maxConcurrent) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: "denied-concurrency",
        bytes: 0,
      });
      deny(clientSocket, 503, "denied-concurrency");
      return;
    }

    let decision = await evaluateDestination(host, port, policy);
    if (!decision.allowed) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: decision.reason,
        bytes: 0,
      });
      deny(clientSocket, 403, decision.reason);
      return;
    }

    decision = await evaluateDestination(host, port, policy);
    if (!decision.allowed) {
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed: false,
        reason: decision.reason + ":rebind",
        bytes: 0,
      });
      deny(clientSocket, 403, decision.reason);
      return;
    }

    active += 1;
    let bytes = 0;
    let finished = false;
    const connectHost = decision.addresses[0] ?? host;

    const upstream = net.connect({ host: connectHost, port });

    const onDone = (reason: string, allowed: boolean) => {
      if (finished) return;
      finished = true;
      active = Math.max(0, active - 1);
      access.write({
        ts: new Date().toISOString(),
        method,
        host,
        port,
        allowed,
        reason,
        bytes,
      });
    };

    const timer = setTimeout(() => {
      upstream.destroy();
      clientSocket.destroy();
    }, connectTimeoutMs);

    let established = false;
    upstream.once("connect", () => {
      const peer = upstream.remoteAddress;
      if (peer && !decision.addresses.includes(peer)) {
        upstream.destroy();
        clientSocket.destroy();
        onDone("connected-peer-mismatch", false);
        return;
      }
      established = true;
      clearTimeout(timer);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) {
        bytes += head.length;
        upstream.write(head);
      }
      clientSocket.setTimeout(idleTimeoutMs);
      upstream.setTimeout(idleTimeoutMs);

      clientSocket.on("data", (c) => {
        bytes += c.length;
      });
      upstream.on("data", (c) => {
        bytes += c.length;
      });

      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("timeout", () => {
      upstream.destroy();
      clientSocket.destroy();
    });
    clientSocket.on("timeout", () => {
      upstream.destroy();
      clientSocket.destroy();
    });

    upstream.on("error", () => {
      clearTimeout(timer);
      if (!established && !clientSocket.destroyed) {
        deny(clientSocket, 502, "upstream-error");
      }
      onDone("upstream-error", false);
    });
    clientSocket.on("error", () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    clientSocket.on("close", () => {
      clearTimeout(timer);
      upstream.destroy();
      onDone(established ? "allowed" : "client-closed", established);
    });
  }

  healthServer.listen(healthPort, listenHost);
  proxyServer.listen(proxyPort, listenHost);

  const dnsReady: Promise<DnsSinkhole | null> =
    dnsPort > 0
      ? startDnsSinkhole(dnsPort, listenHost).then((s) => {
          dns = s;
          return s;
        })
      : Promise.resolve(null);
  void dnsReady.catch(() => null);

  const close = async (): Promise<void> => {
    const bound = await dnsReady.catch(() => null);
    if (bound) await bound.close();
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        proxyServer.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        healthServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  };

  return { proxyServer, healthServer, close, dnsReady };
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const started = startProxy();
  started.dnsReady.catch((err: unknown) => {
    process.stderr.write(`dns-bind-failed: ${String(err)}\n`);
    process.exit(1);
  });
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "proxy-listen",
      proxy: Number(process.env.PROXY_PORT ?? 3128),
      health: Number(process.env.HEALTH_PORT ?? 3129),
      dns: Number(process.env.DNS_PORT ?? 53),
      access_log: {
        verbose: isVerboseAccessLog(),
        path: accessLogFilePath(),
        max_bytes: accessLogMaxBytes(),
      },
    }) + "\n",
  );
}
