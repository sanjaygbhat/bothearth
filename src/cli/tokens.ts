/**
 * Token mint + 0600 persistence.
 * `start` persists only the bootstrap hash; `init` still writes plaintext.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

interface ModelbotTokens {
  mcp_token: string;
  bootstrap_token?: string;
  bootstrap_token_hash?: string;
}

export function mintRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashBootstrapToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function writeTokensFile(path: string, tokens: ModelbotTokens): void {
  const body: Record<string, string> = { mcp_token: tokens.mcp_token };
  if (tokens.bootstrap_token) body.bootstrap_token = tokens.bootstrap_token;
  if (tokens.bootstrap_token_hash) {
    body.bootstrap_token_hash = tokens.bootstrap_token_hash;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function readTokensFile(path: string): ModelbotTokens | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelbotTokens>;
  if (typeof raw.mcp_token !== "string" || !raw.mcp_token) return null;
  const out: ModelbotTokens = { mcp_token: raw.mcp_token };
  if (typeof raw.bootstrap_token === "string" && raw.bootstrap_token) {
    out.bootstrap_token = raw.bootstrap_token;
  }
  if (typeof raw.bootstrap_token_hash === "string" && raw.bootstrap_token_hash) {
    out.bootstrap_token_hash = raw.bootstrap_token_hash;
  }
  return out;
}

/** MCP bearer from env or `tokens.json`. Bootstrap is minted per `start`, not reused. */
export function resolveRuntimeTokens(homeTokensPath: string): { mcp_token: string } {
  const fromFile = readTokensFile(homeTokensPath);
  const mcp_token =
    process.env.MODELBOT_MCP_TOKEN ??
    process.env.MODELBOT_TOKEN ??
    fromFile?.mcp_token;
  if (!mcp_token) {
    throw new Error("run modelbot init first");
  }
  return { mcp_token };
}

/** Write mcp + sha256(bootstrap) only — never the plaintext bootstrap secret. */
function persistBootstrapHash(
  path: string,
  mcpToken: string,
  bootstrapToken: string,
): void {
  const existing = readTokensFile(path);
  writeTokensFile(path, {
    mcp_token: existing?.mcp_token ?? mcpToken,
    bootstrap_token_hash: hashBootstrapToken(bootstrapToken),
  });
}

/** Fresh one-time bootstrap for `start`. Persists hash at each path; returns plaintext to print. */
export function mintStartBootstrapToken(
  mcpToken: string,
  persistPaths: readonly string[],
): string {
  const token = mintRandomToken(32);
  for (const path of persistPaths) persistBootstrapHash(path, mcpToken, token);
  return token;
}
