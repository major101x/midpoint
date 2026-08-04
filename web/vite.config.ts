import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The FCC proxy runs on the operator's machine and sends no CORS headers,
    // so the browser cannot call it directly. Vite proxies it in development.
    proxy: {
      "/tee": { target: "http://localhost:6674", changeOrigin: true, rewrite: (p) => p.replace(/^\/tee/, "") },
    },
  },
});
