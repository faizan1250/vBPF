import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Bind 127.0.0.1 explicitly: Playwright polls http://127.0.0.1:5173,
// and Vite's default "localhost" host can resolve to ::1 on CI.
// /api and /ws are proxied to the API server so the browser stays
// same-origin (the API enforces an Origin allowlist).
export default defineConfig({
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
