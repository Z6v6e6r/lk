// Only this authoritative reducer response proves that no command was applied.
// Transport failures and unrecognised envelopes must keep the pending command.
export function isRejectedFprCommand(response: { status: number | null; error?: { raw?: unknown } | null }) {
  const raw = response.error?.raw;
  return response.status === 422 && raw !== null && typeof raw === "object"
    && "error" in raw && raw.error === "FPR_COMMAND_INVALID";
}
