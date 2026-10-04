import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// VITE_MOCK=1 serves the SPA against the in-memory mock API, so no Worker runtime is needed.
const mock = process.env.VITE_MOCK === "1";

export default defineConfig({
  plugins: [react(), ...(mock ? [] : [cloudflare()])],
  resolve: {
    alias: { "@shared": new URL("./src/shared", import.meta.url).pathname },
  },
});
