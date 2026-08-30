import type { Plugin } from "vite";

const REACT_CLIENT_INTERNALS_MARKER =
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
const MAX_ROOT_BUNDLE_MARKER_COUNT = 3;

export function assertSingleReactRuntime(source: string, artifactName: string): void {
  const markerCount = source.split(REACT_CLIENT_INTERNALS_MARKER).length - 1;
  if (markerCount > MAX_ROOT_BUNDLE_MARKER_COUNT) {
    throw new Error(
      `${artifactName} contains duplicate React runtimes (${markerCount} client-internals markers)`,
    );
  }
}

export function reactRuntimeSingletonGuard(): Plugin {
  return {
    name: "lk-react-runtime-singleton-guard",
    generateBundle(_options, bundle) {
      for (const [artifactName, artifact] of Object.entries(bundle)) {
        if (artifact.type === "chunk" && artifactName.startsWith("bundle")) {
          assertSingleReactRuntime(artifact.code, artifactName);
        }
      }
    },
  };
}
