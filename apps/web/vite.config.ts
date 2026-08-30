import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const daemon = "http://127.0.0.1:3210";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/v1": daemon,
      "/health": daemon,
    },
  },
  plugins: [
    tailwindcss(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
});
