import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately; /api is proxied so the browser sees one origin.
const backend = `http://localhost:${process.env.BACKEND_PORT ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: backend, changeOrigin: false }, "/health": backend },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // React and the router change rarely; keep them in their own long-cached file.
        manualChunks: (id) => (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id) ? "react" : undefined),
      },
    },
  },
});
