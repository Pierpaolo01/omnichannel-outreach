import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  // The Node server mounts Vite as middleware in development; Vite never serves on its own.
  server: { hmr: { port: 24690 } },
});
