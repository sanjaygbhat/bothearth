import type { Keyboard } from "playwright";

export type RelayKey = { key: string; code?: string | null; mods: number | null; kind?: string | null };

// The remote browser runs on Linux. Treat the operator's Command key as Control.
function modifiers(mask: number): string[] {
  return [...((mask & 6) ? ["Control"] : []), ...((mask & 1) ? ["Alt"] : []), ...((mask & 8) ? ["Shift"] : [])];
}

export function keyChord(key: string, mods: number | null): string {
  return [...modifiers(mods ?? 0), key === "Meta" ? "Control" : key].join("+");
}

/** Preserve real down/up and repeat semantics using Playwright's key definitions. */
export class KeyboardRelay {
  private held = new Set<string>();
  private keyboard: Pick<Keyboard, "up" | "down" | "press" | "insertText">;
  constructor(keyboard: Pick<Keyboard, "up" | "down" | "press" | "insertText">) { this.keyboard = keyboard; }

  async reset(): Promise<void> {
    for (const key of [...this.held].reverse()) {
      try { await this.keyboard.up(key); } catch { /* A closed target must not block relinquishing control. */ }
      this.held.delete(key);
    }
  }

  async send(p: RelayKey): Promise<void> {
    try { await this.sendEvent(p); }
    finally { if (!p.kind) await this.reset(); }
  }

  private async sendEvent(p: RelayKey): Promise<void> {
    if (p.kind === "reset") return this.reset();
    const desired = new Set(modifiers(p.mods ?? 0));
    for (const key of ["Control", "Alt", "Shift"]) {
      if (desired.has(key) && !this.held.has(key)) { await this.keyboard.down(key); this.held.add(key); }
      if (!desired.has(key) && this.held.has(key)) { await this.keyboard.up(key); this.held.delete(key); }
    }
    if (["Control", "Meta", "Alt", "Shift"].includes(p.key) && p.kind) return;
    if (["Dead", "Process", "Unidentified"].includes(p.key)) return;
    const printable = [...p.key].length === 1;
    const base = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(p.code ?? "");
    const optionText = printable && Boolean((p.mods ?? 0) & 1) && base &&
      p.key.toLowerCase() !== (base[1] ?? base[2])!.toLowerCase();
    if (optionText || p.kind === "char") {
      if (optionText || !((p.mods ?? 0) & 7)) {
        if (p.kind !== "keyUp" && printable) await this.keyboard.insertText(p.key);
        else if (p.kind === "char" && p.key === "Enter") await this.keyboard.press("Enter");
      }
      return;
    }
    try {
      if (p.kind === "keyUp") { await this.keyboard.up(p.key); this.held.delete(p.key); }
      else if (p.kind === "keyDown" || p.kind === "rawKeyDown") { await this.keyboard.down(p.key); this.held.add(p.key); }
      else await this.keyboard.press(p.key);
    } catch (error) {
      if (!printable || !(error instanceof Error) || !error.message.includes("Unknown key:")) throw error;
      // Layout-resolved Unicode is text, not a synthetic name such as "Dead".
      if (p.kind !== "keyUp" && !((p.mods ?? 0) & 6)) await this.keyboard.insertText(p.key);
    }
  }
}
