import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  HetznerClient,
  HetznerApiError,
  HetznerProvider,
} from "../../../src/deploy/hetzner.ts";
import { loadRemoteState } from "../../../src/deploy/state.ts";
import { TAILSCALE_UDP_PORT } from "../../../src/deploy/types.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

describe("hetzner client against mock HTTP", () => {
  let baseUrl = "";
  let home = "";
  const servers = new Map<
    number,
    {
      id: number;
      name: string;
      status: string;
      public_net: { ipv4: { ip: string } | null; ipv6: { ip: string } | null };
    }
  >();
  let nextId = 100;
  let firewallCreated = false;
  let failCreate = false;
  let pollCount = 0;

  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/ssh_keys") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ssh_key: { id: 7, name: "modelbot-demo", fingerprint: "SHA256:x" },
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/ssh_keys") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ssh_keys: [] }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/firewalls") {
      const parsed = JSON.parse(body) as {
        rules: Array<{ protocol: string; port: string }>;
      };
      const ports = parsed.rules.map((r) => `${r.protocol}/${r.port}`);
      assert.ok(ports.includes("tcp/22"));
      assert.ok(ports.includes(`udp/${TAILSCALE_UDP_PORT}`));
      assert.ok(!ports.some((p) => p.includes("7777") || p.includes("3000")));
      firewallCreated = true;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ firewall: { id: 55, name: "modelbot-demo-private" } }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/servers") {
      if (failCreate) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "quota" } }));
        return;
      }
      const parsed = JSON.parse(body) as {
        name: string;
        user_data: string;
        firewalls?: unknown[];
        public_net?: { enable_ipv4: boolean };
      };
      assert.ok(parsed.user_data.startsWith("#cloud-config"));
      assert.ok(parsed.user_data.includes("127.0.0.1:7777"));
      assert.ok(!parsed.user_data.includes("privileged"));
      assert.ok(parsed.firewalls?.length);
      const id = nextId++;
      servers.set(id, {
        id,
        name: parsed.name,
        status: "initializing",
        public_net: {
          ipv4: parsed.public_net?.enable_ipv4
            ? { ip: "203.0.113.10" }
            : null,
          ipv6: { ip: "2001:db8::10" },
        },
      });
      pollCount = 0;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ server: servers.get(id) }));
      return;
    }

    const serverMatch = url.pathname.match(/^\/servers\/(\d+)$/);
    if (serverMatch) {
      const id = Number(serverMatch[1]);
      if (req.method === "GET") {
        const s = servers.get(id);
        if (!s) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        pollCount++;
        if (pollCount >= 2) s.status = "running";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ server: s }));
        return;
      }
      if (req.method === "DELETE") {
        if (!servers.has(id)) {
          res.writeHead(404);
          res.end();
          return;
        }
        servers.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/firewalls/")) {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("no route");
  };

  let server: ReturnType<typeof createServer>;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "modelbot-deploy-"));
    server = createServer((req, res) => {
      void readBody(req).then((body) => handler(req, res, body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("create → wait → delete sequence", async () => {
    servers.clear();
    failCreate = false;
    firewallCreated = false;
    const client = new HetznerClient({ token: "test-token", baseUrl });
    const fw = await client.createFirewall("modelbot-demo-private");
    assert.equal(fw.firewall.id, 55);
    assert.equal(firewallCreated, true);

    const key = await client.uploadSshKey(
      "modelbot-demo",
      "ssh-ed25519 AAAA modelbot",
    );
    assert.equal(key.ssh_key.id, 7);

    const created = await client.createServer({
      name: "demo",
      server_type: "cx23",
      image: "ubuntu-24.04",
      location: "nbg1",
      ssh_keys: [key.ssh_key.id],
      user_data: "#cloud-config\n# note 127.0.0.1:7777\n",
      firewalls: [{ firewall: fw.firewall.id }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
      labels: { "modelbot-deploy": "uuid" },
    });
    assert.equal(created.server.status, "initializing");

    const running = await client.waitUntilRunning(created.server.id, {
      attempts: 5,
      delayMs: 1,
      sleep: async () => {},
    });
    assert.equal(running.status, "running");
    assert.equal(running.public_net.ipv4?.ip, "203.0.113.10");

    await client.deleteServer(created.server.id);
    await assert.rejects(
      () => client.getServer(created.server.id),
      (err: unknown) => err instanceof HetznerApiError && err.status === 404,
    );
  });

  it("surfaces API errors on create", async () => {
    failCreate = true;
    const client = new HetznerClient({ token: "test-token", baseUrl });
    await assert.rejects(
      () =>
        client.createServer({
          name: "x",
          server_type: "cx23",
          image: "ubuntu-24.04",
          location: "nbg1",
          ssh_keys: [1],
          user_data: "#cloud-config\n127.0.0.1:7777\n",
        }),
      (err: unknown) => err instanceof HetznerApiError && err.status === 422,
    );
    failCreate = false;
  });

  it("provider deploy + destroy persists state", async () => {
    servers.clear();
    failCreate = false;
    const ran: string[] = [];
    const provider = new HetznerProvider({
      home,
      baseUrl,
      publicKey: "ssh-ed25519 AAAA test",
      waitAttempts: 5,
      waitDelayMs: 1,
      sleep: async () => {},
      runner: async (step) => {
        ran.push(step.id);
      },
    });

    const result = await provider.deploy({
      name: "demo",
      provider: "hetzner",
      token: "test-token",
      ipv4: true,
      tarballPath: "modelbot-0.0.1.tgz",
    });
    assert.equal(result.dryRun, false);
    assert.ok(result.serverId);
    assert.equal(result.ipv4, "203.0.113.10");
    assert.ok(ran.includes("preflight"));
    assert.ok(ran.includes("enable-daemon"));

    const state = loadRemoteState("demo", home);
    assert.ok(state);
    assert.equal(state!.provider, "hetzner");

    const destroyed = await provider.destroy(
      { name: "demo", yes: true, token: "test-token" },
      state!,
    );
    assert.equal(destroyed.deleted, true);
    assert.equal(loadRemoteState("demo", home), null);
  });
});
