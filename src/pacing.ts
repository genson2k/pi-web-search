import { setTimeout as sleep } from "node:timers/promises";
import { untilAborted } from "./browser";
let queue = Promise.resolve();
let next = 0;
/** OMP-style process-local Exa pacing; canceled requests never delay later slots. */
export async function waitForExaSlot(signal?: AbortSignal): Promise<void> {
  const raw = Number(process.env.PI_WEB_SEARCH_EXA_DELAY_MS ?? 1000);
  const delay = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60000) : 1000;
  if (!delay) return;
  const queued = queue.then(async () => {
    signal?.throwIfAborted();
    const wait = Math.max(0, next - Date.now());
    if (wait) await sleep(wait, undefined, { signal });
    signal?.throwIfAborted();
    next = Date.now() + delay;
  });
  queue = queued.catch(() => {});
  if (signal) await untilAborted(signal, () => queued);
  else await queued;
}
