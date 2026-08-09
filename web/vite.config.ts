import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from /<repo>/, so that prefix has to be
  // baked into asset URLs at build time or every script and stylesheet 404s.
  // Left at "/" for the dev server and for any root-domain host.
  base: process.env.VITE_BASE ?? "/",
  server: {
    // The FCC proxy runs on the operator's machine and sends no CORS headers,
    // so the browser cannot call it directly. Vite proxies it in development.
    proxy: {
      "/tee": { target: "http://localhost:6674", changeOrigin: true, rewrite: (p) => p.replace(/^\/tee/, "") },
    },
  },
});
