import type { ScreencastFrameHeader, ToolResult } from "../types/contracts.ts";

export interface ComputerCallContext { navigationOrigins: string[]; }

export interface LiveFrameEvent {
  header: ScreencastFrameHeader;
  payload: Uint8Array;
  bytes: Uint8Array;
}

/** Daemon ↔ computer transport surface (ARCH §5). */
export interface ComputerClient {
  readonly computerId: string;
  call(method: string, params?: unknown, context?: ComputerCallContext): Promise<ToolResult>;
  grantTakeover(takeoverId: string): Promise<ToolResult>;
  releaseTakeover(takeoverId: string): Promise<ToolResult>;
  declineTakeover(takeoverId: string): Promise<ToolResult>;
  expireTakeover(takeoverId: string): Promise<ToolResult>;
  relayInput(msg: unknown): Promise<ToolResult>;
  startLive(intervalMs?: number): void;
  stopLive(): void;
  close(): Promise<void>;
  on(event: "frame", listener: (ev: LiveFrameEvent) => void): this;
  on(event: "takeover", listener: (ev: unknown) => void): this;
  on(event: "mode", listener: (ev: unknown) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}
