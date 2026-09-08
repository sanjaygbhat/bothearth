// Assertions run inside the shipped images. A missing tool or broken probe fails.
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const [mode, ...args] = process.argv.slice(2);
const networkErrors = new Set(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
const timeoutError = () => Object.assign(new Error("network probe timed out"), { code: "ETIMEDOUT" });
const knownNetworkError = (error) => error instanceof Error && networkErrors.has(error.code);

function status(socket, request, keepOpen = false) {
  return new Promise((resolve, reject) => {
    let headers = "";
    const timer = setTimeout(() => fail(timeoutError()), 15_000);
    const clear = () => { clearTimeout(timer); socket.removeListener("data", data); socket.removeListener("error", fail); socket.removeListener("end", ended); };
    const fail = (error) => { clear(); socket.destroy(); reject(error); };
    const ended = () => fail(new Error("connection ended before valid HTTP headers"));
    const data = (chunk) => {
      headers += chunk.toString("latin1");
      if (headers.length > 64 * 1024) return fail(new Error("oversized HTTP headers"));
      if (!headers.includes("\r\n\r\n")) return;
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(headers);
      if (!match) return fail(new Error("invalid HTTP response"));
      clear(); if (!keepOpen) socket.destroy();
      resolve(Number(match[1]));
    };
    socket.on("data", data); socket.on("error", fail); socket.on("end", ended);
    socket.write(request);
  });
}

async function request(urlString, websocket = false) {
  const url = new URL(urlString);
  assert(["http:", "https:"].includes(url.protocol));
  let socket = net.connect(3128, "proxy");
  try {
    if (url.protocol === "https:") {
      const target = `${url.hostname}:${url.port || 443}`;
      const connect = await status(socket, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, true);
      if (connect !== 200) return connect;
      socket = tls.connect({ socket, servername: url.hostname });
    }
    const path = url.protocol === "https:" ? url.pathname + url.search : url.href;
    const headers = websocket ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" : "Connection: close\r\n";
    return await status(socket, `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\n${headers}\r\n`);
  } finally { socket.destroy(); }
}

async function blockedTcp(host, port, family) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port), ...(family ? { family: Number(family) } : {}) });
    const timer = setTimeout(() => { socket.destroy(); reject(timeoutError()); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
  }), knownNetworkError, `unexpected direct TCP connection: ${host}:${port}`);
}

async function blockedUdp() {
  // A real DNS query, not an HTTP request to a DNS server's address.
  const query = Buffer.from("123401000001000000000000076578616d706c6503636f6d0000010001", "hex");
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(timeoutError()); }, 3000);
    socket.once("message", () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.send(query, 53, "8.8.8.8");
  }), knownNetworkError, "direct UDP DNS unexpectedly received a response");
}

let result = { mode, status: "PASS" };
if (mode === "request") {
  assert.equal(args.length, 2); const code = await request(args[0]);
  assert.equal(code, Number(args[1]), args[0]); result.code = code;
} else if (mode === "blocked-tcp") {
  assert(args.length >= 2 && args.length <= 3); await blockedTcp(...args);
} else if (mode === "blocked-udp") {
  assert.equal(args.length, 0); await blockedUdp();
} else if (mode === "connect") {
  assert.equal(args.length, 2); const socket = net.connect(3128, "proxy");
  try { assert.equal(await status(socket, `CONNECT example.com:${args[0]} HTTP/1.1\r\nHost: example.com:${args[0]}\r\n\r\n`), Number(args[1])); }
  finally { socket.destroy(); }
} else if (mode === "dns") {
  assert(args.length > 0);
  for (const name of args) await assert.rejects(dns.lookup(name), (error) => error.code === "ENOTFOUND", name);
} else if (mode === "dns-stats") {
  const response = await fetch("http://127.0.0.1:3129/dnsz", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); const stats = await response.json();
  assert.equal(stats.forwarded, 0); assert(stats.queries > 0);
  for (const name of args) assert(stats.names.includes(name), `sinkhole did not observe ${name}`);
  result.queries = stats.queries; result.forwarded = stats.forwarded;
} else if (mode === "dns-private") {
  const response = await fetch("http://proxy:3129/dnsz", { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 404);
} else if (mode === "chromium-dns") {
  assert.equal(args.length, 1);
  const { chromium } = createRequire("/opt/playwright/package.json")("playwright");
  const browser = await chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: true,
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "egress-chromium-")) },
    proxy: { server: "http://proxy:3128" }, ignoreDefaultArgs: ["--disable-dev-shm-usage"] });
  try {
    const cdp = await browser.newBrowserCDPSession();
    const command = await cdp.send("Browser.getBrowserCommandLine");
    assert(!command.arguments.some((arg) => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"].includes(arg)));
    const page = await browser.newPage();
    let response;
    try { response = await page.goto(`http://${args[0]}/`, { timeout: 8000, waitUntil: "domcontentloaded" }); }
    catch (error) { assert.match(String(error), /net::ERR_(?:NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED|CONNECTION_RESET|TUNNEL_CONNECTION_FAILED|CONNECTION_CLOSED)/); }
    if (response) assert(response.status() >= 400, `unexpected navigation HTTP ${response.status()}`);
  } finally { await browser.close(); }
} else if (mode === "websocket") {
  assert.equal(args.length, 0);
  try {
    const code = await request("https://echo.websocket.org/", true);
    result = code === 101 ? { mode, status: "PASS", code } : { mode, status: "SKIP", reason: `public echo returned HTTP ${code}; no WebSocket upgrade verified` };
  } catch (error) {
    if (!knownNetworkError(error)) throw error;
    result = { mode, status: "SKIP", reason: `public echo unavailable: ${error.code}` };
  }
} else { throw new Error(`unknown egress probe: ${mode}`); }
console.log(JSON.stringify(result));
