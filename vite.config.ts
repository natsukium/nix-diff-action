import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "ES2022",
    sourcemap: true,
    ssr: true,
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        cleanup: resolve(import.meta.dirname, "src/cleanup.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
      },
    },
  },
  ssr: {
    target: "node",
    // Bundle all dependencies into single file (required for GitHub Actions)
    noExternal: true,
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
