import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    {
      // Serve public/wasm/*.js files as plain scripts (not ESM modules).
      // @hevcjs/core's Emscripten glue is CommonJS/IIFE — Vite must not
      // transform it via its module pipeline.
      name: "raw-wasm-glue",
      configureServer(server) {
        server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (req.url?.startsWith("/wasm/") && req.url.endsWith(".js")) {
            // Strip Vite's ?import query so the file is served raw
            req.url = req.url.replace(/\?import$/, "");
            res.setHeader("Content-Type", "application/javascript");
          }
          if (req.url?.endsWith(".wasm")) {
            res.setHeader("Content-Type", "application/wasm");
          }
          next();
        });
      },
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
