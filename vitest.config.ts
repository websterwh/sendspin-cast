import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The SDK ships extensionless ESM imports intended for bundlers, not Node.
    server: { deps: { inline: ["@sendspin/sendspin-js"] } },
  },
});
