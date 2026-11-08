import { defineConfig } from "vite";

// Bind 127.0.0.1 explicitly: Playwright polls http://127.0.0.1:5173,
// and Vite's default "localhost" host can resolve to ::1 on CI.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
