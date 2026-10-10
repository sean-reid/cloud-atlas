import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  worker: { format: "es" },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/maplibre-gl") || id.includes("topojson-client"))
            return "map";
          if (id.includes("world-atlas/countries-110m")) return "land-coarse";
          if (id.includes("world-atlas/countries-50m")) return "land-fine";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
});
