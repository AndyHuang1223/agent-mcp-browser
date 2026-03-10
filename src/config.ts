import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskFromArgs } from "./templates.js";

const DEFAULT_MCP_URL = "http://localhost:8931/mcp";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_MCP_MODE = "headless";
const DEFAULT_OUTPUT_DIR = "./playwright-mcp-output/";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type MCPMode = "headless" | "attach";

export type RuntimeConfig = {
  mcpUrl: string;
  model: string;
  mcpMode: MCPMode;
  mcpTimeout: number;
  connectTimeout: number;
  maxTurns: number;
  screenshotDir: string;
  initialTask?: string;
};

export function ensureApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY，請先設定環境變數。");
  }
}

function readNumberFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (Number.isNaN(parsed)) {
    throw new Error(`環境變數 ${name} 不是有效數字：${rawValue}`);
  }

  return parsed;
}

function readMcpModeFromEnv(): MCPMode {
  const rawValue = process.env.MCP_MODE?.trim().toLowerCase();
  if (!rawValue) {
    return DEFAULT_MCP_MODE;
  }

  if (rawValue === "headless" || rawValue === "attach") {
    return rawValue;
  }

  throw new Error(`環境變數 MCP_MODE 僅支援 headless 或 attach：${rawValue}`);
}

function resolveScreenshotDir(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.resolve(PROJECT_ROOT, rawPath);
}

function resolveScreenshotDirFromEnv(): string {
  const mcpOutputDir = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR?.trim();
  if (mcpOutputDir) {
    return resolveScreenshotDir(mcpOutputDir);
  }

  return resolveScreenshotDir(DEFAULT_OUTPUT_DIR);
}

export function resolveRuntimeConfig(cliArgs: string[]): RuntimeConfig {
  const screenshotDir = resolveScreenshotDirFromEnv();

  return {
    mcpUrl: process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL,
    model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    mcpMode: readMcpModeFromEnv(),
    mcpTimeout: readNumberFromEnv("MCP_TIMEOUT_MS", 20_000),
    connectTimeout: readNumberFromEnv("MCP_CONNECT_TIMEOUT_MS", 10_000),
    maxTurns: readNumberFromEnv("AGENT_MAX_TURNS", 12),
    screenshotDir,
    initialTask: cliArgs.length > 0 ? resolveTaskFromArgs(cliArgs) : undefined,
  };
}
