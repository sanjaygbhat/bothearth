import { EventEmitter } from "node:events";
import type { EventType, UiEvent } from "../types/contracts.ts";

export type EventIds = { task_id?: string; computer_id?: string };

export type EmitEvent = (
  type: EventType,
  body: Record<string, unknown>,
  ids?: EventIds,
) => void | Promise<void>;

export class EventBus extends EventEmitter {
  emitEvent(ev: UiEvent): void {
    this.emit("event", ev);
  }

  subscribe(listener: (ev: UiEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }
}

export function makeEvent(
  type: EventType,
  body: Record<string, unknown>,
  ids?: EventIds,
): UiEvent {
  return {
    type,
    ts: new Date().toISOString(),
    body,
    ...(ids?.task_id ? { task_id: ids.task_id } : {}),
    ...(ids?.computer_id ? { computer_id: ids.computer_id } : {}),
  };
}
