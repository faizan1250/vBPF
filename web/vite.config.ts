import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function pagesBase(): string {
  const raw = process.env["VITE_BASE_PATH"] ?? "/";
  const trimmed = raw.trim() === "" ? "/" : raw.trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

// Bind 127.0.0.1 explicitly: Playwright polls http://127.0.0.1:5173,
// and Vite's default "localhost" host can resolve to ::1 on CI.
// /api and /ws are proxied to the API server so the browser stays
// same-origin (the API enforces an Origin allowlist).
// VITE_BASE_PATH sets the Pages subpath (e.g. /vBPF/); local, docker, and
// preview builds default to /.
export default defineConfig({
  base: pagesBase(),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env["VBPF_API_URL"] ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/ws": {
        target: (
          process.env["VBPF_API_URL"] ?? "http://127.0.0.1:8080"
        ).replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
