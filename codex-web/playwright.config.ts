import { defineConfig } from "@playwright/test";

const port = process.env.CODEX_WEB_TEST_PORT ?? "3197";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `pnpm build && CODEX_WEB_AUTH_TOKEN=test-token PORT=${port} NODE_ENV=production pnpm start`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
