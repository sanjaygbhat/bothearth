import { execFile, spawn as spawnProcess, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { KeyboardRelay, type RelayKey } from "./live-key.ts";

export const DESKTOP = { width: 1280, height: 900, fps: 5 };
const CAPTURE_BACKOFF_MS = [250, 500, 1000] as const;
const CAPTURE_FRAME_MS = 3000;

/** Operator-only X11 desktop. No listening TCP ports; model observations remain page-scoped. */
export class Desktop {
  readonly env: NodeJS.ProcessEnv;
  private processes: ChildProcess[] = [];
  private capture: ChildProcess | null = null;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private capturing = false;
  private captureStarts = 0;
  private onCaptureFrame: ((jpeg: Uint8Array) => void) | null = null;
  private onCaptureStatus: ((status: "restarting" | "failed", reason: string) => void) | null = null;
  private clipboard: ChildProcess | null = null;
  private heldButtons = new Set<number>();
  private keyboard: KeyboardRelay;
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
    this.env = { ...process.env, DISPLAY: ":99", XAUTHORITY: join(directory, "Xauthority"), XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: join(directory, "cache"), XDG_RUNTIME_DIR: directory };
    const key = (value: string) => value.split("+").map(part => {
      const names: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Control: "Control_L", Shift: "Shift_L", Alt: "Alt_L", Meta: "Control_L", " ": "space" };
      if (names[part]) return names[part];
      if ([...part].length === 1) return `U${part.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      if (/^(?:F(?:[1-9]|1[0-2])|Tab|Escape|Delete|Home|End|Page_Up|Page_Down|Insert)$/.test(part)) return part;
      if (part === "PageUp" || part === "PageDown") return part === "PageUp" ? "Page_Up" : "Page_Down";
      throw new Error("Unsupported desktop key");
    }).join("+");
    const held = new Set<string>();
    this.keyboard = new KeyboardRelay({
      down: async value => {
        if ([...value].length === 1 && !held.has("Control") && !held.has("Alt")) { await this.text(value); return; }
        await this.run("xdotool", ["keydown", key(value)]); held.add(value);
      },
      up: async value => { if (held.delete(value)) await this.run("xdotool", ["keyup", key(value)]); },
      press: async value => { await this.run("xdotool", ["key", key(value)]); },
      insertText: async text => { await this.text(text); },
    });
  }
  private run(command: string, args: string[], input?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, { env: this.env, timeout: 5000, maxBuffer: 1024 * 1024 }, error => error ? reject(new Error(`${command} failed`)) : resolve());
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  private spawn(command: string, args: string[], stdio: StdioOptions = "ignore"): ChildProcess {
    return spawnProcess(command, args, { env: this.env, stdio });
  }
  private launch(command: string, args: string[]) {
    // The operator's terminal and file manager inherit group-writable files.
    // Pass argv directly; paths never become shell source.
    const child = this.spawn("sh", ["-c", 'umask 007; exec "$@"', "bothearth-desktop", command, ...args]);
    child.on("error", () => {});
    this.processes.push(child);
    return child;
  }
  async start(): Promise<void> {
    writeFileSync(this.env.XAUTHORITY!, "", { mode: 0o600 });
    await this.run("xauth", ["add", ":99", ".", randomBytes(16).toString("hex")]);
    const display = this.launch("Xvfb", [":99", "-screen", "0", "1280x900x24", "-nolisten", "tcp", "-auth", this.env.XAUTHORITY!]);
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await this.run("xdotool", ["getdisplaygeometry"]); ready = true; break; }
      catch { if (display.exitCode !== null) break; await sleep(100); }
    }
    if (!ready) { this.close(); throw new Error("Desktop display could not start"); }
    const menu = join(this.directory, "menu.xml"), config = join(this.directory, "rc.xml");
    writeFileSync(menu, `<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="BotHearth computer"><item label="Files"><action name="Execute"><command>pcmanfm /workspace</command></action></item><item label="Terminal"><action name="Execute"><command>xterm</command></action></item></menu></openbox_menu>`);
    const defaults = readFileSync("/etc/xdg/openbox/rc.xml", "utf8");
    const placement = "<placement><policy>Smart</policy><center>yes</center><monitor>Active</monitor></placement>";
    let rc = defaults.replace("<keyboard>", `<keyboard><keybind key="C-A-t"><action name="Execute"><command>xterm</command></action></keybind><keybind key="C-A-e"><action name="Execute"><command>pcmanfm /workspace</command></action></keybind>`)
      .replace(/<file>[^<]*menu.xml<\/file>/g, `<file>${menu}</file>`);
    rc = /<placement>[\s\S]*?<\/placement>/.test(rc)
      ? rc.replace(/<placement>[\s\S]*?<\/placement>/, placement)
      : rc.replace("</openbox_config>", `${placement}</openbox_config>`);
    writeFileSync(config, rc);
    this.launch("dbus-run-session", ["--", "openbox", "--config-file", config]);
  }
  stream(onFrame: (jpeg: Uint8Array) => void, onStatus?: (status: "restarting" | "failed", reason: string) => void): void {
    this.stopStream();
    this.onCaptureFrame = onFrame;
    this.onCaptureStatus = onStatus ?? null;
    this.capturing = true;
    this.captureStarts = 0;
    this.startCapture();
  }
  private startCapture(): void {
    if (!this.capturing) return;
    const child = this.spawn("ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-framerate", String(DESKTOP.fps), "-video_size", "1280x900", "-i", ":99", "-c:v", "mjpeg", "-threads", "1", "-q:v", "5", "-f", "image2pipe", "pipe:1"], ["ignore", "pipe", "ignore"]);
    this.capture = child;
    let buffer = Buffer.alloc(0);
    let framed = false;
    const gone = (reason: string) => {
      if (this.capture !== child) return;
      this.capture = null;
      if (this.captureTimer !== null) { clearTimeout(this.captureTimer); this.captureTimer = null; }
      child.kill();
      if (!this.capturing) return;
      this.captureLost(reason.slice(0, 200));
    };
    child.on("error", (error: Error) => gone(error.message));
    child.on("exit", (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code ?? 0}`));
    this.captureTimer = setTimeout(() => gone("first frame timed out"), CAPTURE_FRAME_MS);
    this.captureTimer.unref?.();
    child.stdout?.on("data", (data: Buffer) => {
      if (this.capture !== child) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 8 * 1024 * 1024) { gone("oversized frame"); return; }
      let end: number;
      while ((end = buffer.indexOf(Buffer.from([0xff, 0xd9]))) !== -1) {
        const frame = buffer.subarray(0, end + 2); buffer = buffer.subarray(end + 2);
        if (frame[0] === 0xff && frame[1] === 0xd8) {
          if (!framed) {
            framed = true;
            this.captureStarts = 0;
            if (this.captureTimer !== null) { clearTimeout(this.captureTimer); this.captureTimer = null; }
          }
          this.onCaptureFrame?.(frame);
        }
      }
    });
  }
  private captureLost(reason: string): void {
    if (this.captureStarts >= CAPTURE_BACKOFF_MS.length) {
      this.onCaptureStatus?.("failed", reason);
      return;
    }
    const delay = CAPTURE_BACKOFF_MS[this.captureStarts]!;
    this.captureStarts += 1;
    this.onCaptureStatus?.("restarting", reason);
    this.captureTimer = setTimeout(() => { this.captureTimer = null; this.startCapture(); }, delay);
    this.captureTimer.unref?.();
  }
  stopStream(): void {
    this.capturing = false;
    this.onCaptureFrame = null;
    this.onCaptureStatus = null;
    if (this.captureTimer !== null) { clearTimeout(this.captureTimer); this.captureTimer = null; }
    const child = this.capture;
    this.capture = null;
    child?.kill();
  }
  async pointer(p: { action: string; x: number; y: number; button: number | null; dx: number | null; dy: number | null }): Promise<void> {
    if (![p.x, p.y, p.dx ?? 0, p.dy ?? 0].every(Number.isFinite)) throw new Error("Invalid desktop coordinates");
    const button = p.button === 1 ? 2 : p.button === 2 ? 3 : 1;
    const args = ["mousemove", String(Math.max(0, Math.min(1279, Math.round(p.x)))), String(Math.max(0, Math.min(899, Math.round(p.y))))];
    if (p.action === "down") { args.push("mousedown", String(button)); this.heldButtons.add(button); }
    else if (p.action === "up") { args.push("mouseup", String(button)); this.heldButtons.delete(button); }
    else if (p.action === "wheel") {
      for (const [delta, negative, positive] of [[p.dy ?? 0, 4, 5], [p.dx ?? 0, 6, 7]])
        if (delta) args.push("click", "--delay", "0", "--repeat", String(Math.min(10, Math.max(1, Math.ceil(Math.abs(delta!) / 100)))), String(delta! < 0 ? negative : positive));
    }
    await this.run("xdotool", args);
  }
  async key(p: RelayKey): Promise<void> { await this.keyboard.send(p); }
  async text(text: string): Promise<void> {
    if (/^[\x00-\x7f]*$/.test(text)) { await this.run("xdotool", ["type", "--clearmodifiers", "--file", "-"], text); return; }
    // X keysyms cannot reliably carry Unicode into Chromium. Use the desktop's
    // native clipboard for Unicode, and clear it before returning model control.
    this.clipboard?.kill();
    const clipboard = this.spawn("xclip", ["-selection", "clipboard", "-in", "-quiet"], ["pipe", "ignore", "ignore"]);
    this.clipboard = clipboard;
    clipboard.on("error", () => {});
    clipboard.stdin!.on("error", () => {});
    clipboard.stdin!.end(text);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const value = await new Promise<string>(resolve => execFile("xclip", ["-selection", "clipboard", "-out"], { env: this.env, timeout: 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout)));
      if (value === text) { ready = true; break; }
      await sleep(10);
    }
    if (!ready) throw new Error("Desktop clipboard could not receive text");
    await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
    await sleep(100);
  }
  async reset(): Promise<void> {
    await this.keyboard.reset();
    this.clipboard?.kill(); this.clipboard = null;
    for (const button of this.heldButtons) await this.run("xdotool", ["mouseup", String(button)]).catch(() => {});
    this.heldButtons.clear();
  }
  close(): void { this.clipboard?.kill(); this.clipboard = null; this.stopStream(); for (const child of this.processes.reverse()) child.kill(); this.processes = []; }
}
