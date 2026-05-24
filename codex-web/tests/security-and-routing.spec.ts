import { expect, test } from "@playwright/test";

const token = "test-token";

function authedPath(path = "/") {
  return `${path}${path.includes("?") ? "&" : "?"}token=${token}`;
}

test("keeps controls disabled until app-server finishes initializing", async ({ page }) => {
  await page.goto(authedPath("/"));

  await expect(page.getByTitle("/status")).toBeDisabled();
  await expect(page.locator(".dot.connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTitle("/status")).toBeEnabled();

  await page.getByTitle("/status").click();
  await expect(page.getByText(/thread:/)).toBeVisible();
});

test("shows startup failure details instead of an inert empty state", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({
            data: JSON.stringify({
              type: "startup_failed",
              message: "initialize timed out after 30s\n\n最近 app-server 日志:\nTokenRefreshFailed",
            }),
          });
        });
      }

      send() {}
      close() { this.readyState = 3; this.onclose?.({}); }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await expect(page.getByText("app-server 初始化失败")).toBeVisible();
  await expect(page.getByText("TokenRefreshFailed")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(page.getByTitle("/status")).toBeDisabled();
});

test("rejects websocket connections without the auth token", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(() => new Promise<string>((resolve) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onopen = () => resolve("open");
    ws.onclose = () => resolve("closed");
    ws.onerror = () => undefined;
    setTimeout(() => resolve("timeout"), 5000);
  }));

  expect(result).toBe("closed");
});

test("does not serve files outside dist/client", async ({ request }) => {
  const response = await request.get("/%2e%2e%2fserver.ts");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("CodexSession");
});

test("fs_list cannot escape the workspace root", async ({ page }) => {
  await page.goto(authedPath("/"));

  const result = await page.evaluate(({ token }) => new Promise<any>((resolve) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "connected") {
        ws.send(JSON.stringify({ type: "fs_list", path: "/etc" }));
      }
      if (msg.type === "fs_list_result") {
        ws.close();
        resolve(msg);
      }
    };
    ws.onerror = () => resolve({ type: "error" });
    setTimeout(() => resolve({ type: "timeout" }), 15_000);
  }), { token });

  expect(result.type).toBe("fs_list_result");
  expect(result.entries).toEqual([]);
});

test("sanitizes markdown before rendering assistant messages", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_started", turnId: "turn-1" }) });
          this.onmessage?.({
            data: JSON.stringify({
              type: "item_completed",
              turnId: "turn-1",
              item: {
                id: "agent-1",
                type: "agentMessage",
                text: "<script>window.__xss=1</script><img src=x onerror=\"window.__xss=2\"><a href=\"javascript:window.__xss=3\">bad</a>",
              },
            }),
          });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_completed", turnId: "turn-1", usage: null }) });
        });
      }

      send() {}
      close() { this.readyState = 3; this.onclose?.({}); }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await page.waitForSelector(".md");

  const rendered = await page.locator(".md").evaluate((el) => ({
    html: el.innerHTML,
    xss: (window as any).__xss ?? null,
    hasScript: !!el.querySelector("script"),
    hasOnError: !!el.querySelector("[onerror]"),
    href: el.querySelector("a")?.getAttribute("href") ?? null,
  }));

  expect(rendered).toEqual({
    html: "<img src=\"x\"><a>bad</a>",
    xss: null,
    hasScript: false,
    hasOnError: false,
    href: null,
  });
});

test("routes late item events by turnId instead of current turn", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_started", turnId: "turn-1" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_started", turnId: "turn-2" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "item_completed", turnId: "turn-1", item: { id: "a1", type: "agentMessage", text: "first turn" } }) });
          this.onmessage?.({ data: JSON.stringify({ type: "item_completed", turnId: "turn-2", item: { id: "a2", type: "agentMessage", text: "second turn" } }) });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_completed", turnId: "turn-1", usage: null }) });
          this.onmessage?.({ data: JSON.stringify({ type: "turn_completed", turnId: "turn-2", usage: null }) });
        });
      }

      send() {}
      close() { this.readyState = 3; this.onclose?.({}); }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await expect(page.getByText("first turn")).toBeVisible();
  await expect(page.getByText("second turn")).toBeVisible();

  const turns = await page.locator(".turn-entry").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  expect(turns.some((text) => text.includes("first turn") && !text.includes("second turn"))).toBe(true);
  expect(turns.some((text) => text.includes("second turn") && !text.includes("first turn"))).toBe(true);
});

test("renders thread history and sends resume_thread", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t-current", cwd: "/root/codex/codex-web", model: "m" }) });
          this.onmessage?.({
            data: JSON.stringify({
              type: "threads_list",
              nextCursor: null,
              threads: [
                { id: "t-old", preview: "Past task", name: null, cwd: "/root/codex/codex-web", modelProvider: "openai", status: "notLoaded", createdAt: 1, updatedAt: 2, agentNickname: null, agentRole: null },
              ],
            }),
          });
        });
      }

      send(data: string) { (window as any).__sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await expect(page.getByText("Past task")).toBeVisible();
  await page.getByText("Past task").click();

  const sent = await page.evaluate(() => (window as any).__sent);
  expect(sent).toContainEqual({ type: "resume_thread", threadId: "t-old" });
});

test("adds file mentions from fuzzy search and sends mention payload", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
        });
      }

      send(data: string) {
        const msg = JSON.parse(data);
        (window as any).__sent.push(msg);
        if (msg.type === "fuzzy_file_search") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "fuzzy_file_search_result",
              query: msg.query,
              files: [{ name: "App.tsx", path: "src/App.tsx", root: "/root/codex/codex-web", score: 10 }],
            }),
          });
        }
      }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await page.locator("textarea").fill("review @App");
  await page.getByText("@App.tsx").click();
  await page.getByRole("button", { name: "发送" }).click();

  const sendMsg = await page.evaluate(() => (window as any).__sent.find((msg: any) => msg.type === "send"));
  expect(sendMsg.text).toBe("review @App.tsx");
  expect(sendMsg.mentions).toEqual([{ name: "App.tsx", path: "/root/codex/codex-web/src/App.tsx" }]);
});

test("updates file approval modal when real diff arrives", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
          this.onmessage?.({ data: JSON.stringify({ type: "approval_file", id: "ap-1", reason: "Need edit", changes: [] }) });
          this.onmessage?.({
            data: JSON.stringify({
              type: "approval_file_updated",
              id: "ap-1",
              changes: [{ path: "src/App.tsx", kind: "update", diff: "@@\n-old\n+new" }],
            }),
          });
        });
      }

      send() {}
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await expect(page.getByText("Need edit")).toBeVisible();
  await expect(page.getByText("src/App.tsx")).toBeVisible();
  await expect(page.getByText("+new")).toBeVisible();
});

test("renders remote status from config data without writable config panels", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
        });
      }

      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.type === "read_config") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "config_state",
              config: { model: "m", modelReasoningEffort: "high", approvalPolicy: "on-request", sandboxMode: "workspace-write", webSearch: "live" },
            }),
          });
        }
        if (msg.type === "list_mcp") {
          this.onmessage?.({
            data: JSON.stringify({
              type: "mcp_statuses",
              servers: [{ name: "filesystem", authStatus: "unsupported", tools: ["read_file"], resourceCount: 1, resourceTemplateCount: 0, startupStatus: "ready", error: null }],
            }),
          });
        }
      }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await expect(page.getByTitle("配置")).toHaveCount(0);
  await expect(page.getByTitle("MCP 状态")).toHaveCount(0);

  await page.getByRole("button", { name: "Remote", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Remote 状态" })).toBeVisible();
  await expect(page.getByText("审批策略")).toBeVisible();
  await expect(page.getByText("on-request")).toBeVisible();
  await expect(page.getByText("沙箱模式")).toBeVisible();
  await expect(page.getByText("workspace-write")).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByText("filesystem")).toHaveCount(0);
  await expect(page.getByText("read_file")).toHaveCount(0);
});

test("submits request_user_input answers", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;

      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: "connected", threadId: "t", cwd: "/root/codex/codex-web", model: "m" }) });
          this.onmessage?.({
            data: JSON.stringify({
              type: "input_request",
              request: {
                id: "input-1",
                title: "需要你的输入",
                questions: [{ id: "confirm", header: "Confirm", question: "Continue?", isOther: false, isSecret: false, options: [{ label: "Yes", description: "Proceed" }] }],
              },
            }),
          });
        });
      }

      send(data: string) { (window as any).__sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
  });

  await page.goto(authedPath("/"));
  await page.getByRole("button", { name: /Yes/ }).click();
  await page.getByRole("button", { name: "提交" }).click();

  const sent = await page.evaluate(() => (window as any).__sent);
  expect(sent).toContainEqual({ type: "respond_input", id: "input-1", answers: { confirm: ["Yes"] } });
});
