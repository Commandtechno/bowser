import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// https://astro.build/config
export default defineConfig({
  output: "server",
  server: {
    port: 8888,
    // loopback only - remote access goes through `tailscale serve` (see scripts/bowser-service.ps1).
    // explicit IPv4 rather than "localhost", which can resolve to ::1 and miss the proxy
    host: "127.0.0.1"
  },
  adapter: node({
    mode: "standalone"
  }),
  vite: {
    ssr: {
      // native modules can't be bundled by vite
      external: ["@libsql/client", "libsql", "@node-rs/argon2"]
    }
  }
});
