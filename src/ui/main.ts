/**
 * The app entry point. Everything here is wiring: import the modules that claim
 * routes, hand the shell a status chip, and start the router.
 *
 * Each view module registers itself as a side effect of being imported, so the
 * order below is the order the router tries patterns in. `tasks.ts` comes last
 * because it carries the catch-all.
 */

import { publishStatusPill } from "./home.ts"; // #/
import "./task.ts"; //          #/tasks/:id
import "./tasks.ts"; //         #/tasks, #/live/:computerId?, and the catch-all
import "./settings.ts"; //      #/settings/:section? as an overlay, plus ⌘,
import "./palette.ts"; //       ⌘K, the keyboard map, native bridge, alert loop
import "./needs-you.ts"; //     the in-app "your bot needs you" strip + title mark
import { modelbotNative } from "./native.ts";
import {
  currentSession,
  PAIR_AGAIN,
  renewalReturnHash,
  resetSession,
  type SessionInfo,
} from "./session.ts";
import { initShell, toast } from "./shell.ts";

/**
 * The session alone is enough to name the AI. Home republishes the chip from
 * the readiness probe as soon as that lands, which is the fuller answer; this
 * is what shows in the meantime.
 */
function publishSessionPill(session: SessionInfo | null): void {
  const provider =
    session?.execution_mode === "codex" ? ("codex" as const) : ("claude" as const);
  publishStatusPill({
    status: session?.task_start_available
      ? { task_start_available: true, ai: { provider } }
      : null,
    model: session?.model ?? null,
    executionMode: session?.execution_mode ?? null,
  });
}

/**
 * A startup link can arrive at any time: the first load, or a fresh one pasted
 * into a window that is already open because the old session expired. Both are
 * the same exchange, and neither may lose the screen you were on — the hash is
 * stripped back to the current route before the request goes out.
 */
async function useSession(returnHash = ""): Promise<void> {
  try {
    publishSessionPill(await currentSession(returnHash));
  } catch {
    toast(
      "error",
      modelbotNative.isNative
        ? "That sign-in link could not be used. Open ModelBot from your Applications folder again to get a fresh one."
        : `That sign-in link could not be used. ${PAIR_AGAIN}`,
    );
  }
}

initShell();
void useSession();

window.addEventListener("hashchange", (event) => {
  const back = renewalReturnHash(event.oldURL, event.newURL, location.href);
  if (back === null) return;
  resetSession();
  void useSession(back);
});
