import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  // Warn at build time if GA measurement ID is missing in production
  if (mode === "production" && !env.VITE_GA_MEASUREMENT_ID) {
    console.warn(
      "\x1b[33m⚠ VITE_GA_MEASUREMENT_ID is not set — Google Analytics will be disabled in this build.\x1b[0m",
    );
  }

  return {
    plugins: [react()],
    build: {
      // Target modern evergreen browsers so the app bundle ships native ES2022
      // (async/await, optional chaining, class fields, etc.) instead of any
      // accidental legacy transforms. Matches the actual user matrix since
      // WebP is already baseline for this app.
      target: "es2022",
      rollupOptions: {
        output: {
          // Split vendor libs out of the main chunk for better long-term
          // cache hits across app deploys. React + Router change rarely, app
          // code changes every release. Socket.IO is ~60 KB and only used
          // in multiplayer/live features, but it's imported at module scope
          // elsewhere, so a dedicated chunk at least keeps it cacheable.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("/react-router") || id.includes("/react-router-dom") || id.includes("/@remix-run/router")) {
              return "vendor-router";
            }
            if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
              return "vendor-react";
            }
            if (id.includes("/socket.io-client/") || id.includes("/engine.io-client/") || id.includes("/socket.io-parser/") || id.includes("/engine.io-parser/")) {
              return "vendor-socket";
            }
            return undefined;
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: [path.resolve(import.meta.dirname, "./src/__tests__/setupTests.ts")],
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      allowedHosts: ["price.games"],
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
        "/socket.io": {
          target: "http://localhost:3001",
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
