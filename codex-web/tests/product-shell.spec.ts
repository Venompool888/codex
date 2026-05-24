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

test("renders the Codex Remote project and session control loop", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sentMessages = [];

    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: (event: unknown) => void;
      onclose?: (event: unknown) => void;
      onmessage?: (event: { data: string }) => void;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({
            data: JSON.stringify({
              type: "connected",
              threadId: "session-product",
              cwd: "/root/codex/codex-web",
              model: "gpt-test",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({ type: "settings", model: "gpt-test", effort: "high" }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "config_state",
              config: {
                model: "gpt-test",
                modelReasoningEffort: "high",
                approvalPolicy: "on-request",
                sandboxMode: "workspace-write",
                webSearch: "disabled",
              },
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

      send(data: string) {
        const msg = JSON.parse(data);
        (window as any).__sentMessages.push(msg);

        if (msg.type === "list_models") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "models_list",
              models: [
                {
                  id: "gpt-test",
                  displayName: "gpt-test",
                  description: "Current session model",
                  supportedEfforts: ["low", "medium", "high"],
                  defaultEffort: "high",
                  isDefault: true,
                },
                {
                  id: "gpt-next",
                  displayName: "gpt-next",
                  description: "Alternate session model",
                  supportedEfforts: ["medium", "high"],
                  defaultEffort: "medium",
                  isDefault: false,
                },
              ],
            }),
          });
        }

        if (msg.type === "list_threads") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "threads_list",
              nextCursor: null,
              threads: [{
                id: "session-old",
                preview: "Past session",
                name: "Past session",
                cwd: "/root/codex/codex-web",
                modelProvider: "openai",
                status: "done",
                createdAt: 1,
                updatedAt: 2,
                agentNickname: null,
                agentRole: null,
              }],
            }),
          });
        }

        if (msg.type === "resume_thread") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "connected",
              threadId: msg.threadId,
              cwd: "/root/codex/codex-web",
              model: "gpt-next",
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              type: "thread_history",
              threadId: msg.threadId,
              entries: [{
                id: "turn-history",
                kind: "turn",
                status: "done",
                usage: null,
                itemOrder: ["cmd-history", "files-history"],
                items: [
                  {
                    id: "cmd-history",
                    type: "commandExecution",
                    command: "pnpm build",
                    cwd: "/root/codex/codex-web",
                    aggregatedOutput: "build ok",
                    exitCode: 0,
                    durationMs: 2400,
                    status: "completed",
                  },
                  {
                    id: "files-history",
                    type: "fileChange",
                    status: "completed",
                    changes: [{ path: "src/app/AppShell.tsx", kind: "add", diff: "@@\n+shell" }],
                  },
                ],
              }],
            }),
          });
        }
      }

      close() {
        this.readyState = 3;
        this.onclose?.({});
      }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));

  await expect(page.locator(".product-shell.desktop-shell")).toBeVisible();
  await expect(page.locator(".app-sidebar")).toBeVisible();
  await expect(page.locator(".app-main")).toBeVisible();
  await expect(page.locator(".app-inspector")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "全局导航" })).toContainText("Projects");
  await expect(page.getByRole("navigation", { name: "全局导航" })).toContainText("Sessions");
  await expect(page.getByRole("navigation", { name: "全局导航" })).toContainText("Tasks");
  await expect(page.getByRole("navigation", { name: "全局导航" })).toContainText("Files");
  await expect(page.getByRole("complementary", { name: "运行摘要" })).toContainText("Progress");
  await expect(page.getByRole("complementary", { name: "运行摘要" })).toContainText("Outputs");

  await expect(page.locator(".brand")).toHaveText("Codex Remote");
  await expect(page.getByLabel("Codex Remote sidebar").getByText("远程 CLI 控制工作台", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "codex-web" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "项目导航" })).toContainText("对话");
  await expect(page.getByRole("navigation", { name: "项目导航" })).not.toContainText("搜索");
  await expect(page.getByRole("button", { name: "任务", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "文件变更", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "项目选项", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remote", exact: true })).toBeVisible();

  await expect(page.locator(".session-label")).toHaveText("Session");
  await expect(page.locator(".header-meta .hinfo.mono")).toContainText("#session-");
  await expect(page.getByTitle("切换模型")).toContainText("gpt-test");
  await expect(page.getByRole("button", { name: "high" })).toHaveClass(/active/);
  await expect(page.locator(".hinfo.cwd")).toHaveAttribute("title", "/root/codex/codex-web");

  await page.getByTitle("切换模型").click();
  await expect(page.getByText("gpt-next")).toBeVisible();
  await page.getByText("gpt-next").click();
  await page.getByRole("button", { name: "medium", exact: true }).click();

  await page.getByTitle("Session 列表").click();
  await expect(page.getByText("Past session")).toBeVisible();
  await page.getByText("Past session").click();

  const sentMessages = await page.evaluate(() => (window as any).__sentMessages);
  expect(sentMessages).toContainEqual({ type: "list_models" });
  expect(sentMessages).toContainEqual({ type: "set_model", model: "gpt-next" });
  expect(sentMessages).toContainEqual({ type: "set_effort", effort: "medium" });
  expect(sentMessages).toContainEqual({ type: "list_threads" });
  expect(sentMessages).toContainEqual({ type: "resume_thread", threadId: "session-old" });

  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行任务详情" })).toBeVisible();
  await expect(page.locator(".task-page").getByText("pnpm build")).toBeVisible();

  await page.getByRole("button", { name: "文件变更", exact: true }).click();
  await expect(page.getByRole("heading", { name: "文件变更" })).toBeVisible();
  await expect(page.locator(".files-page").getByText("src/app/AppShell.tsx")).toBeVisible();

  await page.getByRole("button", { name: "Remote", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remote 状态" })).toBeVisible();
  await expect(page.getByText("连接状态")).toBeVisible();
  await expect(page.getByText("workspace-write")).toBeVisible();
  await expect(page.getByText("on-request")).toBeVisible();
  await expect(page.getByText("API Key")).toHaveCount(0);
  await expect(page.getByText("账号")).toHaveCount(0);
  await expect(page.getByText("登录")).toHaveCount(0);

  await page.getByRole("button", { name: "New Session", exact: true }).click();
  const messagesAfterNewSession = await page.evaluate(() => (window as any).__sentMessages);
  expect(messagesAfterNewSession).toContainEqual({ type: "new_thread" });
});
