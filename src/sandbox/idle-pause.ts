/**
 * Idle docker-pause sweep. Tracks last tool/resume activity in-process; never
 * probes the computer to learn idleness. Status/list polls do not wake.
 */

export interface IdlePauseHooks {
  now?: () => number;
  idlePauseMin: number;
  pauseComputer: (computerId: string) => Promise<void>;
  unpauseComputer: (computerId: string) => Promise<void>;
  listComputers: () => Iterable<string>;
  isTakeoverActive: (computerId: string) => boolean;
}

export interface IdlePauseController {
  track(computerId: string): void;
  forget(computerId: string): void;
  pausedHas(computerId: string): boolean;
  statusPoll(computerId?: string): void;
  wake(computerId: string): Promise<void>;
  tick(): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createIdlePauseController(hooks: IdlePauseHooks): IdlePauseController {
  const now = hooks.now ?? Date.now;
  const lastActive = new Map<string, number>();
  const paused = new Set<string>();
  const reconciled = new Set<string>();
  const waking = new Map<string, Promise<void>>();
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function thresholdMs(): number {
    return hooks.idlePauseMin * 60_000;
  }

  function track(computerId: string): void {
    if (!lastActive.has(computerId)) lastActive.set(computerId, now());
  }

  function forget(computerId: string): void {
    lastActive.delete(computerId);
    paused.delete(computerId);
    reconciled.delete(computerId);
    inFlight.delete(computerId);
  }

  function statusPoll(_computerId?: string): void {
    // Intentionally empty: list/status must not unpause or reset idle.
  }

  async function wake(computerId: string): Promise<void> {
    lastActive.set(computerId, now());
    await inFlight.get(computerId);
    if (reconciled.has(computerId) && !paused.has(computerId)) return;
    // A previous daemon may have paused this persistent container. Docker unpause
    // is idempotent; reconcile on first activity, never on status/list polling.
    let pending = waking.get(computerId);
    if (!pending) {
      pending = hooks.unpauseComputer(computerId).then(() => {
        paused.delete(computerId);
        reconciled.add(computerId);
      }).finally(() => waking.delete(computerId));
      waking.set(computerId, pending);
    }
    await pending;
  }

  async function tick(): Promise<void> {
    if (hooks.idlePauseMin <= 0) return;
    const limit = thresholdMs();
    const t = now();
    for (const id of hooks.listComputers()) {
      track(id);
      if (hooks.isTakeoverActive(id)) {
        lastActive.set(id, t);
        continue;
      }
      if (paused.has(id) || inFlight.has(id)) continue;
      const last = lastActive.get(id) ?? t;
      if (t - last <= limit) continue;
      const pausing = hooks.pauseComputer(id).then(() => { paused.add(id); });
      inFlight.set(id, pausing);
      try { await pausing; } finally { inFlight.delete(id); }
    }
  }

  function start(intervalMs = 30_000): void {
    if (timer || hooks.idlePauseMin <= 0) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    track,
    forget,
    statusPoll,
    wake,
    tick,
    start,
    stop,
    pausedHas: (id) => paused.has(id),
  };
}
