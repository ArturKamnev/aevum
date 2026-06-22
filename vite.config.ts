import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**"],
  },
});
