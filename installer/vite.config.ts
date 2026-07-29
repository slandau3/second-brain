import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Tauri expects a fixed dev-server port; fail fast if it's taken.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        details: fileURLToPath(new URL("./details.html", import.meta.url)),
      },
    },
  },
});
