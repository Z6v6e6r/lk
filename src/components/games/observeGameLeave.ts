import { hasActiveGameLeaveMembership, type GameLeaveIdentity } from "./gameLeaveMembership.ts";

type Game = Parameters<typeof hasActiveGameLeaveMembership>[0] & { id: string };

// Read-only observation: an accepted leave must never be resubmitted by this loop.
export async function observeGameLeave<T extends Game>(options: {
  gameId: string;
  identity: GameLeaveIdentity;
  signal: AbortSignal;
  read: () => Promise<{ data: T | null; error: unknown }>;
  onRecord: (record: T) => void;
  attempts?: number;
  intervalMs?: number;
}): Promise<"complete" | "unconfirmed" | "cancelled"> {
  const { signal } = options;
  const attempts = options.attempts ?? 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) return "cancelled";
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, options.intervalMs ?? 5_000);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    if (signal.aborted) return "cancelled";
    try {
      const result = await options.read();
      if (signal.aborted) return "cancelled";
      if (!result.error && result.data?.id === options.gameId) {
        const complete = !hasActiveGameLeaveMembership(result.data, options.identity);
        options.onRecord(result.data);
        if (complete) return "complete";
      }
    } catch {
      // A failed read cannot prove completion or justify another write.
    }
  }
  return signal.aborted ? "cancelled" : "unconfirmed";
}
