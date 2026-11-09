import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// hero-svg лежит в ROOT/assets — vite раздаёт его как есть (publicDir).
export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, "../../assets"),
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: "http://127.0.0.1:8710", changeOrigin: true },
      "/projects": { target: "http://127.0.0.1:8710", changeOrigin: true },
    },
  },
});
