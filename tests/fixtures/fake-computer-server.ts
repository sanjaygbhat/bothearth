#!/usr/bin/env node
/**
 * Fake computer-server: stdio JSON-RPC + multiplexed live frames.
 * Shapes from src/protocol + src/types — never redefined here.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, normalize, sep } from "node:path";
import type {
  BrowserSnapshotOutput,
  BrowserScreenshotOutput,
  ComputerJsonRpcRequest,
  ComputerJsonRpcResponse,
  ScreencastFrameHeader,
  ShellExecOutput,
  TakeoverState,
  TakeoverWireState,
  ToolName,
  ToolResult,
} from "../../src/types/contracts.ts";
import { TOOL_NAMES } from "../../src/types/contracts.ts";
import {
  encodeLiveStdioFrame,
  encodeRpcFrame,
  decodeStdioBody,
  JSON_RPC_ERROR,
  jsonRpcTransportError,
  MAX_STDIO_BODY_BYTES,
  STDIO_RPC_TYPE,
} from "../../src/protocol/stdio.ts";
import {
  applyTakeoverTransition,
  isTakeoverBusy,
  isTakeoverExemptTool,
  toWireState,
} from "../../src/protocol/takeover.ts";
import { toolError, ERROR_MESSAGES } from "../../src/protocol/errors.ts";

/** Minimal valid 1×1 JPEG (deterministic). */
export const FIXTURE_JPEG = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcA//Z",
    "base64",
  ),
);

const CSS_W = 800;
const CSS_H = 600;
const SCALE = 1;

export type FakeControlMethod =
  | "screencast.subscribe"
  | "screencast.unsubscribe"
  | "takeover.grant"
  | "takeover.release"
  | "takeover.decline"
  | "takeover.validate"
  | "live.pointer"
  | "live.key"
  | "live.text";

type PageId = "home" | "login" | "download";

interface SiteNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: PageId;
  password?: boolean;
}

interface SitePage {
  id: PageId;
  url: string;
  title: string;
  nodes: SiteNode[];
}

function initialPages(): Record<PageId, SitePage> {
  return {
    home: {
      id: "home",
      url: "https://fixture.local/",
      title: "Fixture Home",
      nodes: [
        { ref: "e1", role: "link", name: "Login", href: "login" },
        { ref: "e2", role: "link", name: "Downloads", href: "download" },
        { ref: "e3", role: "heading", name: "Welcome" },
      ],
    },
    login: {
      id: "login",
      url: "https://fixture.local/login",
      title: "Fixture Login",
      nodes: [
        { ref: "e1", role: "textbox", name: "Username", value: "" },
        { ref: "e2", role: "textbox", name: "Password", value: "", password: true },
        { ref: "e3", role: "button", name: "Sign in" },
        { ref: "e4", role: "link", name: "Home", href: "home" },
      ],
    },
    download: {
      id: "download",
      url: "https://fixture.local/download",
      title: "Fixture Download",
      nodes: [
        { ref: "e1", role: "link", name: "report.pdf" },
        { ref: "e2", role: "link", name: "Home", href: "home" },
      ],
    },
  };
}

function yamlFromNodes(nodes: SiteNode[]): string {
  const lines = ["- document:"];
  for (const n of nodes) {
    const val =
      n.value !== undefined
        ? n.password
          ? ` value=${"*".repeat(n.value.length)}`
          : ` value=${JSON.stringify(n.value)}`
        : "";
    lines.push(`  - ${n.role} "${n.name}" [ref=${n.ref}]${val}`);
  }
  return lines.join("\n");
}

export interface FakeComputerOptions {
  workspaceRoot?: string;
  write?: (frame: Uint8Array) => void;
  now?: () => number;
}

export class FakeComputerServer {
  readonly workspaceRoot: string;
  private pages = initialPages();
  private page: PageId = "home";
  private snapshotId = "snap_0";
  private snapSeq = 0;
  private takeoverState: TakeoverState = "agent";
  private takeoverId: string | null = null;
  private expiresAt: string | null = null;
  private epoch = 1;
  private frameSeq = 0;
  private subscribed = false;
  private screencastTimer: ReturnType<typeof setInterval> | null = null;
  private readonly write: (frame: Uint8Array) => void;
  private readonly now: () => number;
  private buf = new Uint8Array(0);

  constructor(opts: FakeComputerOptions = {}) {
    this.workspaceRoot =
      opts.workspaceRoot ??
      mkdtempSync(join(tmpdir(), "modelbot-fake-ws-"));
    mkdirSync(this.workspaceRoot, { recursive: true });
    writeFileSync(join(this.workspaceRoot, "hello.txt"), "fixture workspace\n");
    this.write = opts.write ?? ((f) => process.stdout.write(f));
    this.now = opts.now ?? (() => Date.now());
  }

  stop(): void {
    this.unsubscribe();
  }

  /** Feed raw stdio bytes (length-prefixed). */
  feed(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    while (this.buf.length >= 4) {
      const bodyLen = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      ).getUint32(0, false);
      if (bodyLen > MAX_STDIO_BODY_BYTES || bodyLen < 1) {
        this.write(
          encodeRpcFrame(
            jsonRpcTransportError(null, JSON_RPC_ERROR.LIMIT, "bad body_len"),
          ),
        );
        this.buf = new Uint8Array(0);
        return;
      }
      if (this.buf.length < 4 + bodyLen) return;
      const body = this.buf.subarray(4, 4 + bodyLen);
      this.buf = this.buf.subarray(4 + bodyLen);
      this.handleBody(body);
    }
  }

  /** Handle one JSON-RPC request object (for unit tests). */
  handleRpc(msg: ComputerJsonRpcRequest): ComputerJsonRpcResponse {
    return this.dispatch(msg);
  }

  private handleBody(body: Uint8Array): void {
    let decoded;
    try {
      decoded = decodeStdioBody(body);
    } catch (e) {
      this.write(
        encodeRpcFrame(
          jsonRpcTransportError(
            null,
            JSON_RPC_ERROR.PARSE,
            e instanceof Error ? e.message : "parse error",
          ),
        ),
      );
      return;
    }
    if (decoded.type !== STDIO_RPC_TYPE) {
      this.write(
        encodeRpcFrame(
          jsonRpcTransportError(null, JSON_RPC_ERROR.INVALID_REQUEST, "live uplink forbidden"),
        ),
      );
      return;
    }
    const raw = decoded.message as Record<string, unknown>;
    if (raw?.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      this.write(
        encodeRpcFrame(
          jsonRpcTransportError(
            (raw?.id as string | number | null) ?? null,
            JSON_RPC_ERROR.INVALID_REQUEST,
            "invalid request",
          ),
        ),
      );
      return;
    }
    // Notification: no id → process, no response
    if (!("id" in raw) || raw.id === undefined) {
      this.dispatch({
        jsonrpc: "2.0",
        id: 0,
        method: raw.method,
        params: raw.params,
      });
      return;
    }
    const req = raw as unknown as ComputerJsonRpcRequest;
    const res = this.dispatch(req);
    this.write(encodeRpcFrame(res));
  }

  private dispatch(req: ComputerJsonRpcRequest): ComputerJsonRpcResponse {
    const method = req.method;
    try {
      if (method === "screencast.subscribe") {
        this.subscribe();
        return ok(req.id, { ok: true, data: { subscribed: true, fps: 2 } });
      }
      if (method === "screencast.unsubscribe") {
        this.unsubscribe();
        return ok(req.id, { ok: true, data: { subscribed: false } });
      }
      if (method === "takeover.grant") {
        return ok(req.id, this.grantTakeover());
      }
      if (method === "takeover.release") {
        return ok(req.id, this.releaseTakeover());
      }
      if (method === "takeover.decline") {
        return ok(req.id, this.declineTakeover());
      }
      if (method === "takeover.validate") {
        return ok(req.id, this.validateTakeover());
      }
      if (method === "live.pointer" || method === "live.key" || method === "live.text") {
        return ok(req.id, this.inputRelay(method, req.params));
      }

      if (!(TOOL_NAMES as readonly string[]).includes(method)) {
        return jsonRpcTransportError(
          req.id,
          JSON_RPC_ERROR.METHOD_NOT_FOUND,
          `method not found: ${method}`,
        );
      }

      const tool = method as ToolName;
      if (isTakeoverBusy(this.takeoverState) && !isTakeoverExemptTool(tool)) {
        return ok(req.id, this.busyError());
      }

      const result = this.callTool(tool, req.params);
      return ok(req.id, result);
    } catch (e) {
      return jsonRpcTransportError(
        req.id,
        JSON_RPC_ERROR.INTERNAL,
        e instanceof Error ? e.message : "internal",
      );
    }
  }

  private busyError(): ToolResult {
    return toolError("E_TAKEOVER_BUSY", ERROR_MESSAGES.E_TAKEOVER_BUSY, {
      takeover_id: this.takeoverId ?? "tk_none",
      state: toWireState(this.takeoverState),
      expires_at: this.expiresAt ?? new Date(this.now() + 600_000).toISOString(),
    });
  }

  private callTool(name: ToolName, params: unknown): ToolResult {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (name) {
      case "browser_navigate":
        return this.navigate(String(p.url ?? ""));
      case "browser_snapshot":
        return { ok: true, data: this.snapshot() };
      case "browser_click":
        return this.click(String(p.snapshot_id ?? ""), String(p.ref ?? ""));
      case "browser_type":
        return this.type(
          String(p.snapshot_id ?? ""),
          String(p.ref ?? ""),
          String(p.text ?? ""),
        );
      case "browser_press":
        return { ok: true, data: { pressed: String(p.key ?? "") } };
      case "browser_scroll":
        return { ok: true, data: { scrolled: true } };
      case "browser_select":
        return this.requireSnap(String(p.snapshot_id ?? ""), () => ({
          ok: true as const,
          data: { selected: p.values ?? [] },
        }));
      case "browser_upload":
        return this.requireSnap(String(p.snapshot_id ?? ""), () => ({
          ok: true as const,
          data: { uploaded: p.paths ?? [] },
        }));
      case "browser_tabs":
        return {
          ok: true,
          data: {
            tabs: [{ tab_id: "t0", url: this.pages[this.page].url, title: this.pages[this.page].title }],
            active: "t0",
          },
        };
      case "browser_screenshot":
        return { ok: true, data: this.screenshot() };
      case "browser_wait":
        return { ok: true, data: { waited: true } };
      case "browser_restart":
        return { ok: true, data: { url: this.pages[this.page].url } };
      case "computer_mouse":
      case "computer_key":
      case "computer_type":
        return { ok: true, data: { relayed: false, note: "agent path; use live.* in HUMAN" } };
      case "shell_exec":
        return { ok: true, data: this.shellExec(String(p.command ?? "")) };
      case "files_list":
        return this.filesList(String(p.path ?? "/workspace"));
      case "files_read":
        return this.filesRead(String(p.path ?? ""), p.offset as number | null, p.limit as number | null);
      case "files_write":
        return this.filesWrite(String(p.path ?? ""), String(p.content ?? ""), Boolean(p.mkdir));
      case "files_delete":
        return this.filesDelete(String(p.path ?? ""));
      case "request_takeover":
        return this.requestTakeover(String(p.reason ?? "need human"));
      case "takeover_status":
        return this.takeoverStatus(String(p.takeover_id ?? ""));
      case "connector_call":
        return toolError("E_CAPABILITY", "connectors not available in fake server");
      case "done":
        return { ok: true, data: { summary: String(p.summary ?? ""), status: p.status ?? "success" } };
      default: {
        const _x: never = name;
        return toolError("E_IO", `unhandled ${_x}`);
      }
    }
  }

  private navigate(url: string): ToolResult {
    if (url.includes("/login")) this.page = "login";
    else if (url.includes("/download")) this.page = "download";
    else this.page = "home";
    this.bumpSnapshot();
    return { ok: true, data: { url: this.pages[this.page].url, title: this.pages[this.page].title } };
  }

  private snapshot(): BrowserSnapshotOutput {
    const pg = this.pages[this.page];
    const refs = pg.nodes.map((n) => n.ref);
    return {
      snapshot_id: this.snapshotId,
      yaml: yamlFromNodes(pg.nodes),
      truncated: false,
      refs,
      url: pg.url,
      title: pg.title,
    };
  }

  private bumpSnapshot(): void {
    this.snapSeq += 1;
    this.snapshotId = `snap_${this.snapSeq}`;
  }

  private requireSnap(snapshotId: string, fn: () => ToolResult): ToolResult {
    if (snapshotId !== this.snapshotId) {
      return toolError("E_STALE_REF", ERROR_MESSAGES.E_STALE_REF, {
        snapshot_id: snapshotId,
        current: this.snapshotId,
      });
    }
    return fn();
  }

  private click(snapshotId: string, ref: string): ToolResult {
    return this.requireSnap(snapshotId, () => {
      const node = this.pages[this.page].nodes.find((n) => n.ref === ref);
      if (!node) return toolError("E_STALE_REF", "unknown ref", { ref });
      if (node.href) {
        this.page = node.href;
      }
      this.bumpSnapshot();
      return { ok: true, data: { clicked: ref, url: this.pages[this.page].url } };
    });
  }

  private type(snapshotId: string, ref: string, text: string): ToolResult {
    return this.requireSnap(snapshotId, () => {
      const node = this.pages[this.page].nodes.find((n) => n.ref === ref);
      if (!node) return toolError("E_STALE_REF", "unknown ref", { ref });
      node.value = (node.value ?? "") + text;
      this.bumpSnapshot();
      return { ok: true, data: { typed: text.length, ref } };
    });
  }

  private screenshot(): BrowserScreenshotOutput & { jpeg_base64: string } {
    return {
      image_id: "img_fixture",
      mime: "image/jpeg",
      width: CSS_W,
      height: CSS_H,
      css_width: CSS_W,
      css_height: CSS_H,
      scale: SCALE,
      scroll_x: 0,
      scroll_y: 0,
      jpeg_base64: Buffer.from(FIXTURE_JPEG).toString("base64"),
    };
  }

  private shellExec(command: string): ShellExecOutput {
    return {
      exit_code: 0,
      stdout: `fixture: ${command}\n`,
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
    };
  }

  /** Map /workspace/... → workspaceRoot; reject escapes + profile-like paths. */
  jailPath(userPath: string): { ok: true; abs: string; rel: string } | { ok: false; error: ToolResult } {
    const raw = userPath.trim() || "/workspace";
    if (
      raw.includes("/.config") ||
      raw.includes("Cookies") ||
      raw.startsWith("/home/") ||
      raw.startsWith("/profile")
    ) {
      return { ok: false, error: toolError("E_POLICY", "path outside workspace jail", { path: raw }) };
    }
    let rel = raw;
    if (rel === "/workspace" || rel === "/workspace/") rel = ".";
    else if (rel.startsWith("/workspace/")) rel = rel.slice("/workspace/".length);
    else if (rel.startsWith("/")) {
      return { ok: false, error: toolError("E_POLICY", "absolute path outside /workspace", { path: raw }) };
    }
    const abs = resolve(this.workspaceRoot, rel);
    const root = resolve(this.workspaceRoot);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return { ok: false, error: toolError("E_POLICY", "path escape blocked", { path: raw }) };
    }
    // Normalize and re-check after normalize (symlink-less)
    const norm = normalize(abs);
    if (norm !== root && !norm.startsWith(root + sep)) {
      return { ok: false, error: toolError("E_POLICY", "path escape blocked", { path: raw }) };
    }
    return { ok: true, abs: norm, rel: rel === "." ? "" : rel };
  }

  private filesList(path: string): ToolResult {
    const j = this.jailPath(path);
    if (!j.ok) return j.error;
    if (!existsSync(j.abs)) return toolError("E_IO", "not found", { path });
    const st = statSync(j.abs);
    if (!st.isDirectory()) {
      return { ok: true, data: { entries: [{ name: j.rel.split("/").pop(), type: "file" }] } };
    }
    const entries = readdirSync(j.abs).map((name) => {
      const t = statSync(join(j.abs, name)).isDirectory() ? "dir" : "file";
      return { name, type: t };
    });
    return { ok: true, data: { entries } };
  }

  private filesRead(path: string, offset: number | null, limit: number | null): ToolResult {
    const j = this.jailPath(path);
    if (!j.ok) return j.error;
    if (!existsSync(j.abs) || !statSync(j.abs).isFile()) {
      return toolError("E_IO", "not a file", { path });
    }
    const text = readFileSync(j.abs, "utf8");
    const lines = text.split("\n");
    const start = offset ?? 0;
    const lim = limit ?? 4000;
    const slice = lines.slice(start, start + lim).join("\n");
    return { ok: true, data: { content: slice, truncated: start + lim < lines.length } };
  }

  private filesWrite(path: string, content: string, mkdir: boolean): ToolResult {
    const j = this.jailPath(path);
    if (!j.ok) return j.error;
    const dir = join(j.abs, "..");
    if (mkdir) mkdirSync(dir, { recursive: true });
    else if (!existsSync(dir)) return toolError("E_IO", "parent missing", { path });
    writeFileSync(j.abs, content);
    return { ok: true, data: { bytes: Buffer.byteLength(content) } };
  }

  private filesDelete(path: string): ToolResult {
    const j = this.jailPath(path);
    if (!j.ok) return j.error;
    if (!existsSync(j.abs)) return toolError("E_IO", "not found", { path });
    unlinkSync(j.abs);
    return { ok: true, data: { deleted: true } };
  }

  private requestTakeover(reason: string): ToolResult {
    const next = applyTakeoverTransition(this.takeoverState, "request");
    if (!next) {
      return toolError("E_IO", `cannot request from ${this.takeoverState}`, { reason });
    }
    this.takeoverState = next;
    this.takeoverId = `tk_${this.snapSeq + 1}`;
    this.expiresAt = new Date(this.now() + 600_000).toISOString();
    // Capture barrier: stop model-bound screencast while busy
    this.unsubscribe();
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId,
        state: toWireState(this.takeoverState) as TakeoverWireState,
        expires_at: this.expiresAt,
      },
    };
  }

  private takeoverStatus(takeoverId: string): ToolResult {
    if (this.takeoverId && takeoverId && takeoverId !== this.takeoverId) {
      return toolError("E_IO", "unknown takeover_id", { takeover_id: takeoverId });
    }
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId ?? takeoverId,
        state: toWireState(this.takeoverState),
        expires_at: this.expiresAt ?? new Date(this.now()).toISOString(),
      },
    };
  }

  private grantTakeover(): ToolResult {
    const next = applyTakeoverTransition(this.takeoverState, "grant");
    if (!next) return toolError("E_IO", `cannot grant from ${this.takeoverState}`);
    this.takeoverState = next;
    this.epoch += 1;
    this.unsubscribe();
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId,
        state: toWireState(this.takeoverState),
        expires_at: this.expiresAt,
      },
    };
  }

  private releaseTakeover(): ToolResult {
    const next = applyTakeoverTransition(this.takeoverState, "release");
    if (!next) return toolError("E_POLICY", `cannot release from ${this.takeoverState}`);
    this.takeoverState = next;
    this.epoch += 1;
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId,
        state: toWireState(this.takeoverState),
        expires_at: this.expiresAt,
      },
    };
  }

  private declineTakeover(): ToolResult {
    const next = applyTakeoverTransition(this.takeoverState, "decline");
    if (!next) return toolError("E_POLICY", `cannot decline from ${this.takeoverState}`);
    this.takeoverState = next;
    this.epoch += 1;
    this.takeoverId = null;
    this.expiresAt = null;
    return {
      ok: true,
      data: {
        takeover_id: "",
        state: toWireState(this.takeoverState),
        expires_at: new Date(this.now()).toISOString(),
      },
    };
  }

  private validateTakeover(): ToolResult {
    const next = applyTakeoverTransition(this.takeoverState, "validated");
    if (!next) return toolError("E_IO", `cannot validate from ${this.takeoverState}`);
    this.takeoverState = next;
    this.bumpSnapshot();
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId,
        state: toWireState(this.takeoverState),
        expires_at: this.expiresAt,
      },
    };
  }

  private inputRelay(method: string, params: unknown): ToolResult {
    if (this.takeoverState !== "human") {
      return toolError("E_POLICY", "input relay only in HUMAN", {
        state: toWireState(this.takeoverState),
        method,
      });
    }
    return { ok: true, data: { accepted: true, method, params: params ?? {} } };
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.screencastTimer = setInterval(() => this.emitFrame(), 500);
    // Immediate first frame
    this.emitFrame();
  }

  private unsubscribe(): void {
    this.subscribed = false;
    if (this.screencastTimer) {
      clearInterval(this.screencastTimer);
      this.screencastTimer = null;
    }
  }

  private emitFrame(): void {
    if (!this.subscribed) return;
    this.frameSeq += 1;
    const mode =
      this.takeoverState === "human"
        ? "human"
        : this.takeoverState === "resume_validating"
          ? "validating"
          : "agent";
    const header: ScreencastFrameHeader = {
      v: 1,
      seq: this.frameSeq,
      ts: this.now(),
      mime: "image/jpeg",
      mode,
      epoch: this.epoch,
      target: "p0",
      viewport: { w: CSS_W, h: CSS_H, dpr: SCALE },
      meta: {
        offsetTop: 0,
        pageScaleFactor: SCALE,
        deviceWidth: CSS_W,
        deviceHeight: CSS_H,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    };
    this.write(encodeLiveStdioFrame(header, FIXTURE_JPEG));
  }

  getTakeoverState(): TakeoverState {
    return this.takeoverState;
  }

  getSnapshotId(): string {
    return this.snapshotId;
  }
}

function ok(id: string | number, result: unknown): ComputerJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Stdio main: read stdin binary frames. */
export function runStdioMain(): FakeComputerServer {
  const server = new FakeComputerServer();
  const stdin = process.stdin;
  stdin.on("data", (chunk: Buffer) => {
    server.feed(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  stdin.on("end", () => {
    server.stop();
    process.exit(0);
  });
  stdin.resume();
  return server;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("fake-computer-server.ts") ||
    process.argv[1].endsWith("fake-computer-server.js"));

if (isMain) {
  // Avoid readline — binary framing on stdin
  runStdioMain();
}
