import "dotenv/config";
import {
  Agent,
  MCPServerStreamableHttp,
  connectMcpServers,
  run,
  type Tool,
} from "@openai/agents";

const DEFAULT_MCP_URL = "http://127.0.0.1:8931/mcp";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TARGET_URL = "https://example.com";
const DEFAULT_MCP_MODE = "headless";

type TemplateName = "browse-flow";
type MCPMode = "headless" | "attach";

function getArgValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function createBrowseFlowTask(targetUrl: string, topic: string): string {
  return [
    `請使用瀏覽器工具完成以下多步驟任務，起始網址：${targetUrl}`,
    `研究主題：${topic}`,
    "步驟 1：進入起始網址，確認頁面可載入。",
    "步驟 2：找出頁面中與主題最相關的連結並點擊至少一個。",
    "步驟 3：擷取你實際看到的關鍵資訊（標題、重點內容、來源網址）。",
    "步驟 4：輸出 JSON，欄位必須為 summary、keyPoints、visitedUrls。",
    "限制：不要捏造內容，資訊不足時明確寫出無法取得。",
  ].join("\n");
}

function resolveTaskFromArgs(args: string[]): string {
  const template = getArgValue(args, "--template") as TemplateName | undefined;

  if (template === "browse-flow") {
    const targetUrl = getArgValue(args, "--url") ?? DEFAULT_TARGET_URL;
    const topic = getArgValue(args, "--topic") ?? "該網站的核心內容";
    return createBrowseFlowTask(targetUrl, topic);
  }

  const positionalArgs = args.filter((value, index) => {
    const previous = args[index - 1];
    if (value.startsWith("--")) {
      return false;
    }
    if (
      previous === "--template" ||
      previous === "--url" ||
      previous === "--topic"
    ) {
      return false;
    }
    return true;
  });

  return (
    positionalArgs.join(" ").trim() ||
    "請打開 https://example.com，讀取頁面標題與第一段內容，最後用繁體中文摘要。"
  );
}

function ensureApiKey(): void {
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

function getToolName(tool: Tool): string {
  if ("name" in tool && typeof tool.name === "string" && tool.name.length > 0) {
    return tool.name;
  }
  return "unknown_tool";
}

function shorten(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

async function main(): Promise<void> {
  ensureApiKey();

  const mcpUrl = process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL;
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const mcpMode = readMcpModeFromEnv();
  const mcpTimeout = readNumberFromEnv("MCP_TIMEOUT_MS", 20_000);
  const connectTimeout = readNumberFromEnv("MCP_CONNECT_TIMEOUT_MS", 10_000);

  const cliArgs = process.argv.slice(2);
  const task = resolveTaskFromArgs(cliArgs);

  const server = new MCPServerStreamableHttp({
    name: "playwright-mcp",
    url: mcpUrl,
    timeout: mcpTimeout,
    cacheToolsList: true,
  });

  const servers = await connectMcpServers([server], {
    strict: true,
    connectTimeoutMs: connectTimeout,
    closeTimeoutMs: 5_000,
  });

  if (servers.active.length === 0) {
    throw new Error(`MCP 伺服器連線失敗：${mcpUrl}`);
  }

  const agent = new Agent({
    name: "Playwright Browser Agent",
    model,
    instructions:
      "你是瀏覽器自動化助理。需要存取網頁內容時，必須優先使用可用的 MCP 工具，不要捏造內容。回覆請簡潔且使用繁體中文。",
    mcpServers: servers.active,
  });

  agent.on("agent_tool_start", (_context, tool) => {
    console.log(`[tool:start] ${getToolName(tool)}`);
  });

  agent.on("agent_tool_end", (_context, tool, result) => {
    console.log(`[tool:end] ${getToolName(tool)} -> ${shorten(result)}`);
  });

  try {
    console.log(`[mcp] mode: ${mcpMode}`);
    console.log(`[mcp] connected: ${mcpUrl}`);
    console.log(`[run] task: ${task}`);

    const result = await run(agent, task, { maxTurns: 12 });

    console.log("\n=== Final Output ===");
    console.log(result.finalOutput);
  } finally {
    await servers.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`[error] ${error.message}`);
  } else {
    console.error("[error] 發生未知錯誤", error);
  }
  process.exitCode = 1;
});
