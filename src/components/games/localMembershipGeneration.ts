export function createLocalMembershipId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local:${crypto.randomUUID()}`;
  }

  return `local:${Date.now()}:${Math.random().toString(36).slice(2, 12)}:${Math.random().toString(36).slice(2, 12)}`;
}
