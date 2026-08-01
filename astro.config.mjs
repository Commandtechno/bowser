import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// https://astro.build/config
export default defineConfig({
  output: "server",
  server: {
    port: 7504
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
