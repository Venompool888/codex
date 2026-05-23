import { expect, test } from "@playwright/test";

const token = "test-token";

function authedPath(path = "/") {
  return `${path}${path.includes("?") ? "&" : "?"}token=${token}`;
}

test("exposes a configured project registry", async ({ request }) => {
  const response = await request.get("/api/projects");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.projects).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "codex-web",
      name: "codex-web",
      workspace: expect.objectContaining({ cwd: expect.stringContaining("/codex-web") }),
    }),
  ]));
});

test("renders the project-first product shell and primary project pages", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({
            data: JSON.stringify({
              type: "connected",
              threadId: "t-product",
              cwd: "/root/codex/codex-web",
              model: "gpt-test",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "turn_started",
              turnId: "turn-product",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "item_completed",
              turnId: "turn-product",
              item: {
                id: "cmd-product",
                type: "commandExecution",
                command: "pnpm build",
                cwd: "/root/codex/codex-web",
                aggregatedOutput: "build ok",
                exitCode: 0,
                durationMs: 2400,
                status: "completed",
              },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "item_completed",
              turnId: "turn-product",
              item: {
                id: "files-product",
                type: "fileChange",
                status: "completed",
                changes: [{ path: "src/app/AppShell.tsx", kind: "add", diff: "@@\n+shell" }],
              },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({ type: "turn_completed", turnId: "turn-product", usage: null }),
          });
        });
      }

      send() {}
      close() { this.readyState = 3; this.onclose?.({}); }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));

  await expect(page.getByRole("heading", { name: "codex-web" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "项目导航" })).toContainText("对话");
  await expect(page.getByRole("button", { name: "任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: "文件变更" })).toBeVisible();
  await expect(page.getByRole("button", { name: "搜索" })).toBeVisible();
  await expect(page.getByRole("button", { name: "设置" })).toBeVisible();

  await page.getByRole("button", { name: "任务" }).click();
  await expect(page.getByRole("heading", { name: "运行任务详情" })).toBeVisible();
  await expect(page.getByText("pnpm build")).toBeVisible();

  await page.getByRole("button", { name: "文件变更" }).click();
  await expect(page.getByRole("heading", { name: "文件变更" })).toBeVisible();
  await expect(page.getByText("src/app/AppShell.tsx")).toBeVisible();

  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByRole("heading", { name: "搜索" })).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
});
