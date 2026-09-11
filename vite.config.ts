import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no HMR websocket conflicts. Port 1421 so a
// running iViz dev server (1420) and Mission Builder can coexist.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    host: host ?? false,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["es2022", "chrome110"],
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
