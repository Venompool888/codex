import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReasoningEffort } from "../../shared.js";

export type CodexConfig = {
  model: string;
  effort: ReasoningEffort;
  baseUrl: string;
  modelCatalogJson: string;
};

export const CODEX_BIN =
  process.env.CODEX_BIN ??
  "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex";

export function readConfig(): CodexConfig {
  try {
    const home = process.env.HOME ?? "/root";
    const toml = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "unknown";
    const effort = (toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? "high") as ReasoningEffort;
    const baseUrl = toml.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    const modelCatalogJson = toml.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    return { model, effort, baseUrl, modelCatalogJson };
  } catch {
    return { model: "unknown", effort: "high", baseUrl: "", modelCatalogJson: "" };
  }
}

export function codexArgs(config: CodexConfig, repoModelCatalog: string): string[] {
  const args = ["app-server"];
  const modelCatalogJson =
    process.env.CODEX_WEB_MODEL_CATALOG_JSON ??
    (config.baseUrl && !config.modelCatalogJson && existsSync(repoModelCatalog)
      ? repoModelCatalog
      : "");

  if (modelCatalogJson && process.env.CODEX_WEB_MODEL_CATALOG_JSON !== "off") {
    args.push("-c", `model_catalog_json=${JSON.stringify(modelCatalogJson)}`);
  }

  args.push("--listen", "stdio://");
  return args;
}
