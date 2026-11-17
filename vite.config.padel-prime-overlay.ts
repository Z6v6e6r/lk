import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

// Сборка одного оверлея клуба: PP_ENTRY=src/tenants/padel-prime/communities.tsx
// PP_FILE=communities.js PP_NAME=PadelPrimeCommunities npx vite build --config vite.config.padel-prime-overlay.ts
const entry = process.env.PP_ENTRY;
const fileName = process.env.PP_FILE;
const globalName = process.env.PP_NAME;

if (!entry || !fileName || !globalName) {
  throw new Error("PP_ENTRY, PP_FILE and PP_NAME are required");
}

export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  define: {
    "process.env": {},
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    lib: {
      entry,
      name: globalName,
      fileName: () => fileName,
      formats: ["iife"],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
