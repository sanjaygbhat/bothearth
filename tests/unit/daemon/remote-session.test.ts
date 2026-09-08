import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import { canonicalHttpsOrigin } from "../../../src/daemon/auth.ts";

test("private HTTPS proxy enrollment binds origin, protects cookies, survives restart and revokes a lost device", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modelbot-remote-tls-"));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  let target = "";
  const proxy = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const upstream = httpRequest(target + req.url, { method: req.method, headers: { ...req.headers, connection: "close" }, agent: false }, (response) => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(JSON.stringify({ error: "fixture upstream unavailable" })); }); req.pipe(upstream);
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest(target + req.url, { headers: req.headers });
    upstream.on("upgrade", (response, connection, first) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (first.length) socket.write(first); if (head.length) connection.write(head);
      socket.pipe(connection).pipe(socket);
      connection.on("error", () => socket.destroy()); socket.on("error", () => connection.destroy());
    });
    upstream.on("response", (res) => { socket.end(`HTTP/1.1 ${res.statusCode} Rejected\r\nConnection: close\r\n\r\n`); res.resume(); });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `https://localhost:${(proxy.address() as AddressInfo).port}`;
  const options = { host: "127.0.0.1", port: 0, workspaceRoot: dir, sqlitePath: join(dir, "state.sqlite"),
    mcpToken: "synthetic-mcp", bootstrapToken: "synthetic-start", publicOrigin: origin };
  let daemon = await startDaemon(options); target = daemon.baseUrl;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const req = httpsRequest(origin + path, { family: 4, servername: "localhost", ca: requireCert, method, headers: { Origin: origin, "content-type": "application/json", ...(body ? { "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}), ...headers } }, (res) => {
      let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null }));
    }); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const requireCert = await readFile(cert);
  try {
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: "random-unissued" })).status, 401);
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: options.bootstrapToken }, { Origin: "https://attacker.invalid" })).status, 403);
    const owner = await call("/api/v1/session/bootstrap", "POST", { token: options.bootstrapToken, label: "Owner" });
    assert.equal(owner.status, 200);
    const cookie = owner.headers["set-cookie"]![0]!;
    assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/); assert.doesNotMatch(cookie, /Domain=/);
    const auth = { Cookie: cookie.split(";")[0]!, "x-csrf-token": owner.body.csrf };
    assert.equal((await call("/api/v1/session/pairings", "POST", {}, { Cookie: auth.Cookie })).status, 403);
    assert.equal((await call("/api/v1/session/pairings", "POST", {}, { Authorization: "Bearer synthetic-mcp" })).status, 403);
    const invitation = await call("/api/v1/session/pairings", "POST", {}, auth);
    assert.equal(invitation.status, 201); assert.equal(invitation.headers["cache-control"], "no-store");
    const token = new URL(invitation.body.url).hash.slice("#bootstrap=".length);
    assert.ok(!JSON.stringify(daemon.store.db.prepare("SELECT * FROM bootstrap_tokens").all()).includes(token));
    const phone = await call("/api/v1/session/bootstrap", "POST", { token, label: "Phone" });
    assert.equal(phone.status, 200);
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token })).status, 401);
    const phoneAuth = { Cookie: phone.headers["set-cookie"]![0]!.split(";")[0]!, "x-csrf-token": phone.body.csrf };
    // A copied remote cookie is not valid through a second authority or the local recovery origin.
    assert.equal((await fetch(target + "/api/v1/session", { headers: phoneAuth })).status, 401);
    assert.equal((await call("/api/v1/session", "GET", undefined, { ...phoneAuth, Host: "other.example" })).status, 403);
    await daemon.close(); daemon = await startDaemon(options); target = daemon.baseUrl;
    assert.equal((await call("/api/v1/session", "GET", undefined, phoneAuth)).status, 200);
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: options.bootstrapToken })).status, 401, "restart must not resurrect a used token");
    const inventory = await call("/api/v1/session/devices", "GET", undefined, auth);
    const device = inventory.body.devices.find((entry: any) => entry.label === "Phone");
    assert.match(device.id, /^[a-f0-9]{32}$/); assert.equal(device.current, false);
    assert.ok(!JSON.stringify(inventory.body).includes(phoneAuth.Cookie.split("=")[1]!));
    assert.ok(!JSON.stringify(inventory.body).includes(phone.body.csrf));
    const liveSocket = await new Promise<import("node:net").Socket>((resolve, reject) => {
      const req = httpsRequest(origin + "/api/v1/events", { family: 4, ca: requireCert,
        headers: { Origin: origin, Cookie: phoneAuth.Cookie, Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "c3ludGhldGljLWRldmljZQ==" } });
      req.on("upgrade", (_res, socket) => resolve(socket)); req.on("error", reject); req.end();
    });
    const phoneInvitation = await call("/api/v1/session/pairings", "POST", {}, phoneAuth);
    const ownerInvitation = await call("/api/v1/session/pairings", "POST", {}, auth);
    assert.equal(phoneInvitation.status, 201); assert.equal(ownerInvitation.status, 201);
    liveSocket.resume();
    const ended = once(liveSocket, "end");
    assert.equal((await call(`/api/v1/session/devices/${device.id}`, "DELETE", {}, auth)).status, 200);
    await Promise.race([ended, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("revoked TLS socket remained open")), 2500); timer.unref(); })]);
    liveSocket.destroy();
    assert.equal((await call("/api/v1/session", "GET", undefined, phoneAuth)).status, 401);
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: new URL(phoneInvitation.body.url).hash.slice(11) })).status, 401, "revoked issuers cannot leave usable enrollment links");
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: new URL(ownerInvitation.body.url).hash.slice(11) })).status, 200, "another valid issuer retains enrollment authority");
    const expired = daemon.store.createPairing(origin)!;
    daemon.store.db.prepare("UPDATE bootstrap_tokens SET expires_at = '2000-01-01' WHERE used_at IS NULL").run();
    assert.equal((await call("/api/v1/session/bootstrap", "POST", { token: new URL(expired.url).hash.slice(11) })).status, 401);
  } finally {
    await daemon.close(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairing issuance is bounded, origin bound, and contains no persisted bearer", () => {
  const store = new Store();
  try {
    store.registerBootstrapToken("legacy-hash", new Date(Date.now() + 60000).toISOString());
    assert.equal(store.consumeBootstrapToken("legacy-hash", undefined, "https://owner.example"), false);
    assert.equal(store.consumeBootstrapToken("legacy-hash", undefined, "http://127.0.0.1:7777"), true);
    for (let i = 0; i < 20; i++) assert.ok(store.createPairing("https://owner.example"));
    assert.equal(store.createPairing("https://owner.example"), null);
    const hash = store.db.prepare("SELECT token_hash FROM bootstrap_tokens WHERE used_at IS NULL LIMIT 1").get()!.token_hash as string;
    assert.equal(store.consumeBootstrapToken(hash, undefined, "https://other.example"), false);
    assert.equal(store.consumeBootstrapToken(hash, undefined, "https://owner.example"), true);
    assert.ok(store.createPairing("https://owner.example"));
    assert.throws(() => canonicalHttpsOrigin("https://user:password@example.com"));
    assert.throws(() => canonicalHttpsOrigin("https://example.com/path"));
    assert.throws(() => canonicalHttpsOrigin("http://example.com"));
    assert.equal(canonicalHttpsOrigin("https://example.com:444"), "https://example.com:444");
  } finally { store.close(); }
});


test("pairing authority expires with its issuer while host recovery remains independent", () => {
  const store = new Store();
  const origin = "https://owner.example";
  const hash = (url: string) => createHash("sha256").update(new URL(url).hash.slice(11)).digest("hex");
  try {
    const issuer = store.createSession(60000, origin);
    const invitation = store.createPairing(origin, issuer.id)!;
    const host = store.createPairing(origin)!;
    assert.equal(store.createPairing(origin, "missing-issuer"), null);
    store.db.prepare("UPDATE sessions SET expires_at = '2000-01-01' WHERE id = ?").run(issuer.id);
    assert.equal(store.consumeBootstrapToken(hash(invitation.url), undefined, origin), false);
    assert.equal(store.createPairing(origin, issuer.id), null);
    assert.equal(store.consumeBootstrapToken(hash(host.url), undefined, origin), true);
  } finally { store.close(); }
});
