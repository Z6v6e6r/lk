import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

// Тематический бандл клуба «Падел Прайм» (тенант Dvjlor).
// Отдельный IIFE, чтобы не менять prod-бандл ПадлХАБа и не зависеть от его релизов.
export default defineConfig(({ mode }) => {
  const isDevBundle = mode === "dev";

  return {
    plugins: [
      react(),
      cssInjectedByJsPlugin(),
    ],
    define: {
      "process.env": {},
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      emptyOutDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: 4096,
      lib: {
        entry: "src/tenants/padel-prime/main.tsx",
        name: "PadelPrimeLK",
        fileName: () => (isDevBundle ? "padel-prime-lk-dev.js" : "padel-prime-lk.js"),
        formats: ["iife"],
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  };
});
