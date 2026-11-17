import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

// Оверлей игр клуба «Падел Прайм»: тот же модуль, что и в ЛК1, но с темой клуба.
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
        entry: "src/tenants/padel-prime/games.tsx",
        name: "PadelPrimeGames",
        fileName: () => (isDevBundle ? "pade-prime-games-dev.js" : "pade-prime-games.js"),
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
