import { appendBundleVersion } from "./bundleVersion";

export type WidgetMountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: unknown;
};

export type WidgetModule = {
  mount: (options?: WidgetMountOptions) => void;
  update?: (options?: WidgetMountOptions) => void;
  unmount?: (targetId?: string) => void;
};

export type LoadWidgetOptions = {
  forceReload?: boolean;
};

export type WidgetGlobalName =
  | "LKWidgetGames"
  | "LKWidgetTournaments"
  | "LKWidgetOnboarding"
  | "LKWidgetLevelsInfo"
  | "LKWidgetCommunities";

type AppWindow = Window & Record<WidgetGlobalName, WidgetModule | undefined>;

const scriptPromises: Partial<Record<WidgetGlobalName, Promise<WidgetModule>>> = {};

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  urls.forEach((url) => {
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

function swapPadlHubOrigin(url: URL): URL | null {
  if (url.hostname === "padlhub.su") {
    const next = new URL(url.toString());
    next.hostname = "padlhub.ru";
    return next;
  }

  if (url.hostname === "padlhub.ru") {
    const next = new URL(url.toString());
    next.hostname = "padlhub.su";
    return next;
  }

  return null;
}

function buildCandidateSources(src: string): string[] {
  const baseUrl = typeof window !== "undefined" ? window.location.href : undefined;
  const runtimeCacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const withRuntimeCacheBust = (candidate: string): string => {
    const versioned = appendBundleVersion(candidate);
    try {
      const url = new URL(versioned, baseUrl);
      url.searchParams.set("module_ts", runtimeCacheBust);
      return url.toString();
    } catch {
      const separator = versioned.includes("?") ? "&" : "?";
      return `${versioned}${separator}module_ts=${encodeURIComponent(runtimeCacheBust)}`;
    }
  };

  try {
    const resolved = new URL(src, baseUrl);
    const candidates = [resolved.toString()];

    if (typeof window !== "undefined") {
      const currentOrigin = window.location.origin;
      if (resolved.origin !== currentOrigin) {
        candidates.push(new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, currentOrigin).toString());
      }
    }

    const swappedOrigin = swapPadlHubOrigin(resolved);
    if (swappedOrigin) {
      candidates.push(swappedOrigin.toString());
    }

    return dedupeUrls(candidates).map(withRuntimeCacheBust);
  } catch {
    return [withRuntimeCacheBust(src)];
  }
}

function loadWidgetScript(src: string, globalName: WidgetGlobalName): Promise<WidgetModule> {
  return new Promise<WidgetModule>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      const mod = (window as unknown as AppWindow)[globalName];
      if (!mod) {
        script.remove();
        reject(new Error(`Module ${globalName} did not register on window after loading ${src}`));
        return;
      }
      resolve(mod);
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(script);
  });
}

export function loadWidget(
  src: string,
  globalName: WidgetGlobalName,
  options: LoadWidgetOptions = {},
): Promise<WidgetModule> {
  const appWindow = window as unknown as AppWindow;
  if (options.forceReload) {
    scriptPromises[globalName] = undefined;
    appWindow[globalName] = undefined;
  }

  if (!options.forceReload && appWindow[globalName]) {
    return Promise.resolve(appWindow[globalName] as WidgetModule);
  }

  const pending = scriptPromises[globalName];
  if (!options.forceReload && pending) {
    return pending;
  }

  const request = (async () => {
    const candidates = buildCandidateSources(src);
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        return await loadWidgetScript(candidate, globalName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
      }
    }

    scriptPromises[globalName] = undefined;
    throw new Error(errors.join(" | "));
  })();

  scriptPromises[globalName] = request;
  return request;
}
