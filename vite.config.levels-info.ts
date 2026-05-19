import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

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
        entry: "src/levels-info.tsx",
        name: "LKWidget",
        fileName: () => (isDevBundle ? "levels-info-dev.js" : "levels-info.js"),
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
