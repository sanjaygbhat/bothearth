import { randomBytes } from "node:crypto";
import type {
  ComputerCapability,
  SandboxCreateOpts,
  SandboxHandle,
  SandboxRuntime,
  SandboxRuntimeKind,
} from "../types/contracts.ts";

export interface FakeComputerRecord extends SandboxHandle {
  status: "created" | "running" | "paused" | "stopped" | "destroyed";
  persistent: boolean;
  workspaceRoot: string;
}

/** In-memory SandboxRuntime for MODELBOT_TEST_FAKE_COMPUTER=1. */
export function createFakeSandbox(opts?: {
  workspaceRoot?: string;
}): SandboxRuntime & {
  get(computerId: string): FakeComputerRecord | undefined;
  list(): FakeComputerRecord[];
  start(computerId: string): Promise<void>;
  inspectStatus(computerId: string): Promise<"running" | "paused" | "stopped" | undefined>;
} {
  const workspaceRoot = opts?.workspaceRoot ?? "/tmp/modelbot-fake-workspace";
  const computers = new Map<string, FakeComputerRecord>();

  return {
    async detect(): Promise<Exclude<SandboxRuntimeKind, "auto">> {
      return "docker";
    },
    async create(createOpts: SandboxCreateOpts): Promise<SandboxHandle> {
      const computer_id = `cmp_${randomBytes(8).toString("hex")}`;
      const capabilities: ComputerCapability[] = [...createOpts.capabilities];
      const rec: FakeComputerRecord = {
        computer_id,
        name: createOpts.name,
        capabilities,
        status: "running",
        persistent: Boolean(createOpts.persistent),
        workspaceRoot: `${workspaceRoot}/${computer_id}`,
      };
      computers.set(computer_id, rec);
      return {
        computer_id: rec.computer_id,
        name: rec.name,
        capabilities: rec.capabilities,
      };
    },
    async start(computerId: string): Promise<void> {
      const rec = computers.get(computerId);
      if (!rec || rec.status === "destroyed") {
        throw new Error(`computer not found: ${computerId}`);
      }
      if (rec.status === "paused") {
        throw new Error("Cannot start a paused container");
      }
      rec.status = "running";
    },
    async inspectStatus(computerId: string) {
      const rec = computers.get(computerId);
      if (!rec || rec.status === "destroyed") return undefined;
      if (rec.status === "paused") return "paused";
      return rec.status === "running" ? "running" : "stopped";
    },
    async stop(computerId: string): Promise<void> {
      const rec = computers.get(computerId);
      if (!rec || rec.status === "destroyed") {
        throw new Error(`computer not found: ${computerId}`);
      }
      rec.status = "stopped";
    },
    async destroy(computerId: string): Promise<void> {
      const rec = computers.get(computerId);
      if (!rec) throw new Error(`computer not found: ${computerId}`);
      rec.status = "destroyed";
      computers.delete(computerId);
    },
    get(computerId: string): FakeComputerRecord | undefined {
      return computers.get(computerId);
    },
    list(): FakeComputerRecord[] {
      return [...computers.values()];
    },
  };
}
