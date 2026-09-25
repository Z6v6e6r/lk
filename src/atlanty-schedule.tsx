import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AtlantySchedulePage, {
  type AtlantyScheduleConfig,
} from "./components/atlanty-schedule/AtlantySchedulePage";
import {
  normalizeAtlantyBookingMode,
  normalizeAtlantyCategories,
  resolveAtlantyBookingDirectionIds,
  resolveAtlantyBookingTypeIds,
} from "./utils/atlantyScheduleModel";
import {
  readAtlantyLkBookingReturn,
  resumeAtlantyLkBookingReturn,
} from "./utils/atlantyLkBookingWindow";

type AtlantyMountOptions = {
  targetId?: string;
  config?: AtlantyScheduleConfig;
};

type AtlantyScheduleWidgetModule = {
  mount: (options?: AtlantyMountOptions) => void;
  update: (options?: AtlantyMountOptions) => void;
  unmount: () => void;
};

type AtlantyWindow = Window & {
  LKWidgetAtlantySchedule?: AtlantyScheduleWidgetModule;
  LK_ATLANTY_SCHEDULE_CONFIG?: AtlantyScheduleConfig;
};

export const ATLANTY_SCHEDULE_TARGET_ID = "atlanty-schedule-root";

const AUTO_MOUNT_TIMEOUT_MS = 15_000;

let atlantyRoot: ReturnType<typeof createRoot> | null = null;
let mountedTargetId: string | null = null;

function readRuntimeConfig(): AtlantyScheduleConfig {
  if (typeof window === "undefined") return {};
  const runtime = (window as AtlantyWindow).LK_ATLANTY_SCHEDULE_CONFIG;
  return runtime && typeof runtime === "object" ? runtime : {};
}

function renderInto(targetId: string, config: AtlantyScheduleConfig) {
  const container = document.getElementById(targetId);
  if (!container) return false;

  atlantyRoot?.unmount();
  atlantyRoot = createRoot(container);
  mountedTargetId = targetId;
  atlantyRoot.render(
    <StrictMode>
      <AtlantySchedulePage config={config} />
    </StrictMode>,
  );
  return true;
}

function mount(options: AtlantyMountOptions = {}) {
  if (typeof document === "undefined") return;
  const targetId = options.targetId || ATLANTY_SCHEDULE_TARGET_ID;
  const config = options.config || readRuntimeConfig();
  if (!renderInto(targetId, config)) {
    mountedTargetId = null;
  }
}

function update(options: AtlantyMountOptions = {}) {
  if (!atlantyRoot) {
    mount(options);
    return;
  }
  const config = options.config || readRuntimeConfig();
  atlantyRoot.render(
    <StrictMode>
      <AtlantySchedulePage config={config} />
    </StrictMode>,
  );
}

function unmount() {
  atlantyRoot?.unmount();
  atlantyRoot = null;
  mountedTargetId = null;
}

/**
 * Возврат из оплаты: ЛК1 дописывает к адресу витрины `groupExerciseId` и статус
 * платежа. Открываем окно записи на этом событии; параметры убираются только
 * после успешного открытия (см. `resumeAtlantyLkBookingReturn`).
 */
function consumeBookingPaymentReturn(config: AtlantyScheduleConfig) {
  if (typeof window === "undefined") return;
  if (normalizeAtlantyBookingMode(config.booking) !== "lk") return;
  if (!readAtlantyLkBookingReturn(window.location.href)) return;

  const categories = normalizeAtlantyCategories(config.categories);
  void resumeAtlantyLkBookingReturn({
    directionIds: resolveAtlantyBookingDirectionIds(config.bookingDirectionIds, categories),
    directionLabel: config.title?.trim() || null,
    allowedTypeIds: resolveAtlantyBookingTypeIds(config.bookingAllowedTypeIds, categories),
  });
}

/**
 * Tilda рендерит блоки лениво, поэтому ждём появления контейнера блока T123.
 */
function scheduleAutoMount() {
  if (typeof document === "undefined") return;
  if (mountedTargetId) return;

  const attempt = () => {
    if (mountedTargetId) return true;
    return renderInto(ATLANTY_SCHEDULE_TARGET_ID, readRuntimeConfig());
  };

  if (attempt()) return;

  const observer = new MutationObserver(() => {
    if (attempt()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), AUTO_MOUNT_TIMEOUT_MS);
}

if (typeof window !== "undefined") {
  (window as AtlantyWindow).LKWidgetAtlantySchedule = { mount, update, unmount };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scheduleAutoMount();
      consumeBookingPaymentReturn(readRuntimeConfig());
    }, { once: true });
  } else {
    scheduleAutoMount();
    consumeBookingPaymentReturn(readRuntimeConfig());
  }
}

export { mount, update, unmount };
