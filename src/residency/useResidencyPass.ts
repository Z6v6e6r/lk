import { useCallback, useEffect, useRef, useState } from "react";
import type { Subscription } from "../utils/apiClient";
import { trackAnalyticsEvent } from "../utils/analytics";
import { residencyPassClient } from "./residencyApi.ts";
import { RESIDENCY_CHECK_URL, RESIDENCY_PASS_ENABLED } from "./residencyConfig.ts";
import {
  buildResidentPassQrValue,
  computeServerOffsetMs,
  isPassUsable,
  isProbeableFailure,
  mapFailureToState,
  passRemainingMs,
  resolveActiveCandidates,
  shouldAutoRenew,
  type ResidentPass,
  type ResidencyCandidate,
  type ResidencyFailure,
  type ResidencyViewState,
} from "./residencyPassModel.ts";

const TICK_MS = 500;
const STATUS_POLL_MS = 3000;

interface RuntimeState {
  state: ResidencyViewState;
  pass: ResidentPass | null;
  serverOffsetMs: number;
  renewals: number;
  statusAvailable: boolean;
  stopped: boolean;
}

const INITIAL_RUNTIME: RuntimeState = {
  state: { kind: "idle" },
  pass: null,
  serverOffsetMs: 0,
  renewals: 0,
  statusAvailable: false,
  stopped: false,
};

export interface ResidencyPassController {
  enabled: boolean;
  state: ResidencyViewState;
  remainingMs: number;
  qrValue: string | null;
  showNewPass: () => void;
  retry: () => void;
}

export interface UseResidencyPassOptions {
  open: boolean;
  subscriptions: readonly Subscription[] | null;
  stationId: string | null;
}

function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

function isVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

function orderCandidates(candidates: ResidencyCandidate[], preferredId: string | null): ResidencyCandidate[] {
  if (!preferredId) return candidates;
  const preferred = candidates.find((candidate) => candidate.clientSubscriptionId === preferredId);
  if (!preferred) return candidates;
  return [preferred, ...candidates.filter((candidate) => candidate.clientSubscriptionId !== preferredId)];
}

export function useResidencyPass({ open, subscriptions, stationId }: UseResidencyPassOptions): ResidencyPassController {
  const enabled = RESIDENCY_PASS_ENABLED;
  const [runtime, setRuntime] = useState<RuntimeState>(INITIAL_RUNTIME);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runtimeRef = useRef(INITIAL_RUNTIME);
  const subscriptionsRef = useRef<readonly Subscription[] | null>(subscriptions);
  const openRef = useRef(open);
  const inFlightRef = useRef<AbortController | null>(null);
  const statusInFlightRef = useRef<AbortController | null>(null);
  const preferredIdRef = useRef<string | null>(null);

  // The ref is the synchronous source of truth for async handlers; state mirrors it for render.
  const commitRuntime = useCallback((next: RuntimeState) => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);
  const updateRuntime = useCallback((updater: (previous: RuntimeState) => RuntimeState) => {
    const next = updater(runtimeRef.current);
    runtimeRef.current = next;
    setRuntime(next);
  }, []);

  useEffect(() => {
    subscriptionsRef.current = subscriptions;
  }, [subscriptions]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const abortInFlight = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    if (statusInFlightRef.current) {
      statusInFlightRef.current.abort();
      statusInFlightRef.current = null;
    }
  }, []);

  const probeStatus = useCallback(async () => {
    const pass = runtimeRef.current.pass;
    if (!pass || statusInFlightRef.current) return;
    const controller = new AbortController();
    statusInFlightRef.current = controller;
    const result = await residencyPassClient.fetchStatus(pass.passId, controller.signal);
    if (statusInFlightRef.current === controller) statusInFlightRef.current = null;
    if (controller.signal.aborted || !openRef.current) return;
    if (runtimeRef.current.pass?.passId !== pass.passId) return;
    if (!result.ok) {
      // A missing or unavailable status route keeps the screen in degraded mode.
      if (result.failure.status === 404 || result.failure.status === 503 || result.failure.networkError) {
        updateRuntime((previous) => (previous.statusAvailable ? { ...previous, statusAvailable: false } : previous));
      }
      return;
    }
    const status = result.value;
    if (!status.statusAvailable) {
      updateRuntime((previous) => (previous.statusAvailable ? { ...previous, statusAvailable: false } : previous));
      return;
    }
    updateRuntime((previous) => (previous.statusAvailable ? previous : { ...previous, statusAvailable: true }));
    if (status.state === "CONSUMED") {
      updateRuntime((previous) => ({
        ...previous,
        state: { kind: "issued", pass, consumedAt: status.consumedAt },
        stopped: true,
      }));
      trackAnalyticsEvent("residency_pass_issued", {});
      return;
    }
    if (status.state === "EXPIRED") {
      updateRuntime((previous) => ({
        ...previous,
        state: { kind: "expired", pass, autoRenewEnabled: !previous.stopped },
      }));
    }
  }, [updateRuntime]);

  const requestPass = useCallback(async (manual: boolean) => {
    if (inFlightRef.current) return;
    const candidatesResult = resolveActiveCandidates(subscriptionsRef.current, Date.now());
    if (candidatesResult.candidates.length === 0) {
      const frozen = candidatesResult.frozen;
      if (frozen) {
        commitRuntime({
          ...runtimeRef.current,
          pass: null,
          state: { kind: "frozen", holdUntil: frozen.holdUntil },
        });
        return;
      }
      const nextState: ResidencyViewState = candidatesResult.unavailable
        ? { kind: "unavailable", code: "RESIDENT_CLIENT_SUBSCRIPTIONS_UNAVAILABLE", retryable: true }
        : { kind: "no_subscription" };
      commitRuntime({ ...runtimeRef.current, pass: null, state: nextState });
      return;
    }
    const ordered = orderCandidates(candidatesResult.candidates, preferredIdRef.current);
    const controller = new AbortController();
    inFlightRef.current = controller;
    if (!runtimeRef.current.pass) {
      commitRuntime({ ...runtimeRef.current, state: { kind: "loading" } });
    }

    let lastFailure: ResidencyFailure | null = null;
    for (const candidate of ordered) {
      const result = await residencyPassClient.createPass(candidate.clientSubscriptionId, controller.signal);
      if (controller.signal.aborted || !openRef.current) {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        return;
      }
      if (result.ok) {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        const pass = result.value;
        const receivedAt = Date.now();
        const renewals = manual ? 0 : runtimeRef.current.renewals + 1;
        preferredIdRef.current = candidate.clientSubscriptionId;
        commitRuntime({
          state: { kind: "active", pass, renewals },
          pass,
          serverOffsetMs: computeServerOffsetMs(pass.issuedAt, receivedAt),
          renewals,
          statusAvailable: runtimeRef.current.statusAvailable,
          stopped: false,
        });
        trackAnalyticsEvent("residency_pass_created", { renewals });
        void probeStatus();
        return;
      }
      lastFailure = result.failure;
      if (!isProbeableFailure(result.failure.code) || result.failure.networkError) break;
    }
    if (inFlightRef.current === controller) inFlightRef.current = null;
    if (!lastFailure) return;
    const failure = lastFailure;
    if (failure.networkError) {
      updateRuntime((previous) => ({ ...previous, state: { kind: "offline", pass: previous.pass } }));
    } else {
      updateRuntime((previous) => ({ ...previous, state: mapFailureToState(failure) }));
    }
    trackAnalyticsEvent("residency_pass_failed", { code: failure.code, status: failure.status });
  }, [commitRuntime, probeStatus, updateRuntime]);

  const showNewPass = useCallback(() => {
    commitRuntime({ ...runtimeRef.current, stopped: false, renewals: 0, statusAvailable: false, state: { kind: "loading" } });
    void requestPass(true);
  }, [commitRuntime, requestPass]);

  const retry = useCallback(() => {
    void requestPass(false);
  }, [requestPass]);

  // Open / close lifecycle: opening starts a fresh pass, closing aborts every upstream call.
  useEffect(() => {
    if (!enabled || !open) {
      abortInFlight();
      commitRuntime(INITIAL_RUNTIME);
      return;
    }
    trackAnalyticsEvent("residency_pass_opened", {});
    if (subscriptionsRef.current === null) {
      commitRuntime({ ...INITIAL_RUNTIME, state: { kind: "loading" } });
      return;
    }
    void requestPass(true);
    return () => {
      abortInFlight();
    };
  }, [abortInFlight, commitRuntime, enabled, open, requestPass]);

  // Subscriptions arrive after the panel is already open (deep link on first cabinet render).
  useEffect(() => {
    if (!enabled || !open) return;
    if (subscriptions === null) return;
    const kind = runtimeRef.current.state.kind;
    if (kind !== "loading" && kind !== "unavailable") return;
    void requestPass(true);
  }, [enabled, open, requestPass, subscriptions]);

  // Countdown tick.
  useEffect(() => {
    if (!enabled || !open) return undefined;
    const id = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled, open]);

  // Expiry: renew automatically while allowed, otherwise show an explicit expired state.
  useEffect(() => {
    if (!enabled || !open) return;
    const current = runtimeRef.current;
    if (!current.pass || current.state.kind !== "active") return;
    if (passRemainingMs(current.pass, current.serverOffsetMs, nowMs) > 0) return;
    if (!isOnline()) {
      updateRuntime((previous) => ({ ...previous, state: { kind: "offline", pass: previous.pass } }));
      return;
    }
    const allowed = shouldAutoRenew({
      visible: isVisible(),
      online: true,
      statusAvailable: current.statusAvailable,
      renewals: current.renewals,
      stopped: current.stopped,
    });
    if (allowed) {
      void requestPass(false);
      return;
    }
    updateRuntime((previous) => ({ ...previous, state: { kind: "expired", pass: previous.pass, autoRenewEnabled: false } }));
  }, [enabled, nowMs, open, requestPass, updateRuntime]);

  // Status polling keeps "issued" confirmation and stops auto-generation on CONSUMED.
  useEffect(() => {
    if (!enabled || !open) return undefined;
    if (!runtime.pass || !runtime.statusAvailable || runtime.state.kind !== "active") return undefined;
    const id = window.setInterval(() => {
      if (!isVisible()) return;
      void probeStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, open, probeStatus, runtime.pass, runtime.state.kind, runtime.statusAvailable]);

  // Re-check when the tab returns from the background.
  useEffect(() => {
    if (!enabled || !open) return undefined;
    const handleVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      setNowMs(Date.now());
      const current = runtimeRef.current;
      if (!current.pass) {
        if (current.state.kind === "offline" || current.state.kind === "unavailable") void requestPass(false);
        return;
      }
      if (current.state.kind === "issued") {
        void probeStatus();
        return;
      }
      if (passRemainingMs(current.pass, current.serverOffsetMs, Date.now()) <= 0) {
        void requestPass(false);
        return;
      }
      void probeStatus();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [enabled, open, probeStatus, requestPass]);

  // Network transitions: never present an expired pass as valid while offline.
  useEffect(() => {
    if (!enabled || !open) return undefined;
    const handleOnline = () => {
      setNowMs(Date.now());
      const current = runtimeRef.current;
      if (!current.pass || current.state.kind !== "offline") return;
      if (passRemainingMs(current.pass, current.serverOffsetMs, Date.now()) > 0) {
        updateRuntime((previous) => (previous.pass
          ? { ...previous, state: { kind: "active", pass: previous.pass, renewals: previous.renewals } }
          : previous));
        return;
      }
      void requestPass(false);
    };
    const handleOffline = () => {
      setNowMs(Date.now());
      updateRuntime((previous) => (previous.pass ? { ...previous, state: { kind: "offline", pass: previous.pass } } : previous));
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [enabled, open, requestPass, updateRuntime]);

  const remainingMs = runtime.pass
    ? Math.max(0, passRemainingMs(runtime.pass, runtime.serverOffsetMs, nowMs))
    : 0;
  const qrValue = runtime.pass && isPassUsable(runtime.pass, runtime.serverOffsetMs, nowMs)
    ? buildResidentPassQrValue(RESIDENCY_CHECK_URL, runtime.pass.passToken, stationId)
    : null;

  return {
    enabled,
    state: runtime.state,
    remainingMs,
    qrValue,
    showNewPass,
    retry,
  };
}
