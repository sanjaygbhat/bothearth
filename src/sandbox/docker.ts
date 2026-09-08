import { spawn, spawnSync } from "node:child_process";
import type { DetectedRuntime } from "./detect.ts";
import { toolPath } from "../daemon/resolve-tool.ts";

export class DockerError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly argv: string[];
  constructor(message: string, code: number, stderr: string, argv: string[]) {
    super(message);
    this.name = "DockerError";
    this.code = code;
    this.stderr = stderr;
    this.argv = argv;
  }
}

export interface DockerCli {
  readonly binary: string;
  run(args: string[]): Promise<string>;
  runSync(args: string[]): string;
  spawn(args: string[]): ReturnType<typeof spawn>;
}

export function createDockerCli(runtime: DetectedRuntime): DockerCli {
  // Absolute path: a GUI-launched daemon inherits launchd's PATH, not the shell's.
  const binary = toolPath(runtime.binary);
  return {
    binary,
    async run(args: string[]): Promise<string> {
      return await new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stderr.on("data", (c: Buffer) => err.push(c));
        child.on("error", (e) => reject(e));
        child.on("close", (code) => {
          const stdout = Buffer.concat(out).toString("utf8");
          const stderr = Buffer.concat(err).toString("utf8");
          if (code !== 0) {
            reject(
              new DockerError(
                `${binary} ${args.join(" ")} failed (${code}): ${stderr.trim()}`,
                code ?? 1,
                stderr,
                args,
              ),
            );
            return;
          }
          resolve(stdout);
        });
      });
    },
    runSync(args: string[]): string {
      const r = spawnSync(binary, args, {
        encoding: "utf8",
        env: process.env,
      });
      if (r.error) throw r.error;
      if (r.status !== 0) {
        throw new DockerError(
          `${binary} ${args.join(" ")} failed (${r.status}): ${(r.stderr ?? "").trim()}`,
          r.status ?? 1,
          r.stderr ?? "",
          args,
        );
      }
      return r.stdout ?? "";
    },
    spawn(args: string[]) {
      return spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    },
  };
}

/** Ignore "already exists" / "no such" style errors. */
export async function runIgnore(
  cli: DockerCli,
  args: string[],
  ignoreSubstr: string[],
): Promise<void> {
  try {
    await cli.run(args);
  } catch (e) {
    if (e instanceof DockerError) {
      const msg = (e.stderr + e.message).toLowerCase();
      if (ignoreSubstr.some((s) => msg.includes(s.toLowerCase()))) return;
    }
    throw e;
  }
}
