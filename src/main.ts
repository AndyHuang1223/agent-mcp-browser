import "dotenv/config";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  Agent,
  type CallModelInputFilter,
  MCPServerStreamableHttp,
  connectMcpServers,
  run,
  type AgentInputItem,
  type Tool,
} from "@openai/agents";

const DEFAULT_MCP_URL = "http://127.0.0.1:8931/mcp";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TARGET_URL = "https://example.com";
const DEFAULT_MCP_MODE = "headless";
const DEFAULT_SCREENSHOT_DIR = "./screenshots";
const DEFAULT_SHOPPING_LOCALE = "台灣（繁體中文）";
const DEFAULT_SHOPPING_MAX_RESULTS = 8;
const MAX_SHOPPING_RESULTS_LIMIT = 20;

type TemplateName = "browse-flow" | "product-search";
type MCPMode = "headless" | "attach";

type ShoppingSearchOptions = {
  query: string;
  budgetMin?: number;
  budgetMax?: number;
  locale: string;
  maxResults: number;
  allowOpenProductPage: boolean;
  allowAddToCart: boolean;
  allowPreCheckout: boolean;
};

const VALUE_FLAGS = new Set([
  "--template",
  "--url",
  "--topic",
  "--query",
  "--budget-min",
  "--budget-max",
  "--locale",
  "--max-results",
  "--screenshot-dir",
]);

const BOOLEAN_FLAGS = new Set([
  "--allow-open-product-page",
  "--allow-cart",
  "--allow-precheckout",
]);

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

function hasFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

function readOptionalNumberArg(
  args: string[],
  key: string,
): number | undefined {
  const rawValue = getArgValue(args, key);
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`參數 ${key} 不是有效數字：${rawValue}`);
  }

  return parsed;
}

function readOptionalIntArg(args: string[], key: string): number | undefined {
  const parsed = readOptionalNumberArg(args, key);
  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isInteger(parsed)) {
    throw new Error(`參數 ${key} 必須是整數：${parsed}`);
  }

  return parsed;
}

function getPositionalArgs(args: string[]): string[] {
  return args.filter((value, index) => {
    const previous = args[index - 1];
    if (value.startsWith("--")) {
      return false;
    }
    if (previous && VALUE_FLAGS.has(previous)) {
      return false;
    }
    return true;
  });
}

function createProductSearchTask(options: ShoppingSearchOptions): string {
  const budgetRange =
    options.budgetMin === undefined && options.budgetMax === undefined
      ? "不限預算"
      : `${options.budgetMin ?? 0} ~ ${options.budgetMax ?? "不限"}`;

  const actionBoundary = options.allowPreCheckout
    ? "你可做到結帳前步驟（例如規格選擇、加入購物車、填寫前置資訊），但不得提交最終訂單。"
    : options.allowAddToCart
      ? "你可開商品頁與加入購物車，但不得進入結帳流程。"
      : options.allowOpenProductPage
        ? "你可開啟商品頁比對資訊，但不得加入購物車或進入結帳。"
        : "你只能搜尋與整理商品資訊，不可點擊任何可能造成交易狀態改變的按鈕。";

  return [
    "你是商品搜尋代理，請使用瀏覽器工具完成任務。",
    `搜尋關鍵字：${options.query}`,
    `地區與語言：${options.locale}`,
    `預算範圍：${budgetRange}`,
    `候選商品數量上限：${options.maxResults}`,
    "請至少檢視 3 個不同來源（例如搜尋引擎結果頁、電商站、品牌官網或論壇討論）。",
    "步驟 1：先列出搜尋策略與會用到的關鍵詞變體。",
    "步驟 2：實際搜尋並蒐集候選商品，優先收集價格、運費、出貨地、到貨時間、退換貨資訊。",
    "步驟 3：去除明顯不符合預算或規格的候選後，再輸出最終建議清單。",
    "步驟 4：最終輸出請用繁體中文，並附上每項商品的來源網址。",
    `操作邊界：${actionBoundary}`,
    "高風險規則：任何加入購物車、填寫資料、或可能導向交易確認頁的動作前，必須先輸出「需要你的明確確認」並停止等待下一次指令。",
    "限制：不得捏造價格或庫存；若資料不足，請明確標示為「未取得」。",
  ].join("\n");
}

function resolveShoppingSearchOptions(args: string[]): ShoppingSearchOptions {
  const positionalArgs = getPositionalArgs(args);
  const query = getArgValue(args, "--query") ?? positionalArgs.join(" ").trim();
  if (!query) {
    throw new Error("product-search 模板需要提供 --query 或文字查詢內容。");
  }

  const budgetMin = readOptionalNumberArg(args, "--budget-min");
  const budgetMax = readOptionalNumberArg(args, "--budget-max");

  if (budgetMin !== undefined && budgetMin < 0) {
    throw new Error("--budget-min 不可小於 0。");
  }

  if (budgetMax !== undefined && budgetMax < 0) {
    throw new Error("--budget-max 不可小於 0。");
  }

  if (
    budgetMin !== undefined &&
    budgetMax !== undefined &&
    budgetMin > budgetMax
  ) {
    throw new Error("--budget-min 不可大於 --budget-max。");
  }

  const maxResults =
    readOptionalIntArg(args, "--max-results") ?? DEFAULT_SHOPPING_MAX_RESULTS;

  if (maxResults <= 0 || maxResults > MAX_SHOPPING_RESULTS_LIMIT) {
    throw new Error(
      `--max-results 必須介於 1 到 ${MAX_SHOPPING_RESULTS_LIMIT}。`,
    );
  }

  const allowOpenProductPage = hasFlag(args, "--allow-open-product-page");
  const allowAddToCart = hasFlag(args, "--allow-cart");
  const allowPreCheckout = hasFlag(args, "--allow-precheckout");

  if (allowPreCheckout && !allowAddToCart) {
    throw new Error("使用 --allow-precheckout 時，請同時提供 --allow-cart。");
  }

  return {
    query,
    budgetMin,
    budgetMax,
    locale: getArgValue(args, "--locale") ?? DEFAULT_SHOPPING_LOCALE,
    maxResults,
    allowOpenProductPage,
    allowAddToCart,
    allowPreCheckout,
  };
}

function resolveTaskFromArgs(args: string[]): string {
  const template = getArgValue(args, "--template") as TemplateName | undefined;

  if (template === "browse-flow") {
    const targetUrl = getArgValue(args, "--url") ?? DEFAULT_TARGET_URL;
    const topic = getArgValue(args, "--topic") ?? "該網站的核心內容";
    return createBrowseFlowTask(targetUrl, topic);
  }

  if (template === "product-search") {
    return createProductSearchTask(resolveShoppingSearchOptions(args));
  }

  const positionalArgs = getPositionalArgs(args);

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

function readStringFromEnv(name: string, fallback: string): string {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  return rawValue;
}

function shouldCaptureScreenshot(userInput: string): boolean {
  return /(截圖|螢幕截圖|screenshot|screen\s*shot)/i.test(userInput);
}

function formatTimestampForFilename(date: Date): string {
  const pad2 = (value: number) => value.toString().padStart(2, "0");
  const pad3 = (value: number) => value.toString().padStart(3, "0");
  return [
    date.getFullYear().toString(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "-",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
    "-",
    pad3(date.getMilliseconds()),
  ].join("");
}

function getScreenshotFileExtension(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  return "png";
}

type ExtractedImage =
  | {
      kind: "base64";
      data: string;
      extension: string;
    }
  | {
      kind: "path";
      sourcePath: string;
      extension: string;
    };

function isLikelyBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 128) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(normalized);
}

function getImageExtensionFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase().replace(".", "");
  if (
    extension === "png" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "webp"
  ) {
    return extension === "jpeg" ? "jpg" : extension;
  }
  return "png";
}

function extractImageFromString(value: string): ExtractedImage | undefined {
  const dataUrlMatch = value.match(
    /data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)/i,
  );
  if (dataUrlMatch) {
    return {
      kind: "base64",
      extension:
        dataUrlMatch[1].toLowerCase() === "jpeg"
          ? "jpg"
          : dataUrlMatch[1].toLowerCase(),
      data: dataUrlMatch[2].replace(/\s+/g, ""),
    };
  }

  const pngPathMatch = value.match(/([~/.A-Za-z0-9_-]+\.(png|jpg|jpeg|webp))/i);
  if (pngPathMatch) {
    return {
      kind: "path",
      sourcePath: pngPathMatch[1],
      extension: getImageExtensionFromPath(pngPathMatch[1]),
    };
  }

  if (isLikelyBase64(value)) {
    return {
      kind: "base64",
      extension: "png",
      data: value.replace(/\s+/g, ""),
    };
  }

  return undefined;
}

function extractImagePayload(value: unknown): ExtractedImage | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return extractImageFromString(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractImagePayload(item);
      if (extracted) {
        return extracted;
      }
    }
    return undefined;
  }

  if (typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === "string") {
        if (
          key.toLowerCase().includes("mime") &&
          nestedValue.startsWith("image/")
        ) {
          continue;
        }

        const direct = extractImageFromString(nestedValue);
        if (direct) {
          if (
            direct.kind === "base64" &&
            key.toLowerCase().includes("mime") &&
            typeof (value as Record<string, unknown>).mimeType === "string"
          ) {
            return {
              kind: "base64",
              data: direct.data,
              extension: getScreenshotFileExtension(
                String((value as Record<string, unknown>).mimeType),
              ),
            };
          }
          return direct;
        }
      }

      const extracted = extractImagePayload(nestedValue);
      if (extracted) {
        return extracted;
      }
    }
  }

  return undefined;
}

async function saveExtractedImage(
  image: ExtractedImage,
  screenshotDir: string,
): Promise<string | undefined> {
  try {
    await mkdir(screenshotDir, { recursive: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[screenshot] 無法建立目錄 ${screenshotDir}：${message}`);
    return undefined;
  }

  const timestamp = formatTimestampForFilename(new Date());
  const suffix = Math.random().toString(36).slice(2, 6);
  const filename = `screenshot-${timestamp}-${suffix}.${image.extension}`;
  const targetPath = path.join(screenshotDir, filename);

  try {
    if (image.kind === "base64") {
      const buffer = Buffer.from(image.data, "base64");
      await writeFile(targetPath, buffer);
    } else {
      const resolvedSourcePath = image.sourcePath.startsWith("~/")
        ? path.join(process.env.HOME ?? "", image.sourcePath.slice(2))
        : image.sourcePath;
      await copyFile(resolvedSourcePath, targetPath);
    }
    return targetPath;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[screenshot] 無法儲存截圖：${message}`);
    return undefined;
  }
}

class ScreenshotCollector {
  private enabled = false;
  private savedPaths: string[] = [];

  constructor(private readonly screenshotDir: string) {}

  startTurn(enabled: boolean): void {
    this.enabled = enabled;
    this.savedPaths = [];
  }

  async onToolEnd(toolName: string, result: unknown): Promise<void> {
    if (!this.enabled || !/screenshot/i.test(toolName)) {
      return;
    }

    const stringResult =
      typeof result === "string" ? result : JSON.stringify(result);
    const parsedResult = (() => {
      if (typeof result !== "string") {
        return result;
      }
      try {
        return JSON.parse(result);
      } catch {
        return result;
      }
    })();

    const extracted =
      extractImagePayload(parsedResult) ?? extractImagePayload(stringResult);
    if (!extracted) {
      console.warn(
        "[screenshot] 偵測到 screenshot 工具，但未找到可儲存的圖片資料。",
      );
      return;
    }

    const savedPath = await saveExtractedImage(extracted, this.screenshotDir);
    if (!savedPath) {
      return;
    }

    this.savedPaths.push(savedPath);
  }

  finishTurn(): void {
    if (!this.enabled) {
      return;
    }

    if (this.savedPaths.length === 0) {
      console.log("[screenshot] 本輪沒有可儲存的截圖輸出。");
      return;
    }

    for (const savedPath of this.savedPaths) {
      console.log(`[screenshot] 已儲存：${savedPath}`);
    }
  }
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

function formatFinalOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "(無輸出)";
  }

  return JSON.stringify(value, null, 2);
}

function buildTaskWithHistory(userInput: string, history: string[]): string {
  if (history.length === 0) {
    return userInput;
  }

  const recentHistory = history.slice(-8).join("\n");
  return [
    "請延續同一個對話與瀏覽器 session，並參考以下最近對話紀錄。",
    recentHistory,
    `使用者最新指令：${userInput}`,
  ].join("\n\n");
}

function isValidImageUrl(value: string): boolean {
  if (value.startsWith("data:image/")) {
    return true;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeInvalidImageUrlNode(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeInvalidImageUrlNode(item))
      .filter((item) => item !== undefined);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type.toLowerCase() : "";
  const imageUrl =
    typeof source.image_url === "string" ? source.image_url : undefined;
  const image = typeof source.image === "string" ? source.image : undefined;
  const imageUrlCamel =
    typeof source.imageUrl === "string" ? source.imageUrl : undefined;

  const hasInvalidImageRef = [imageUrl, image, imageUrlCamel].some(
    (candidate) => typeof candidate === "string" && !isValidImageUrl(candidate),
  );

  if (
    hasInvalidImageRef &&
    (type === "input_image" || type === "image" || type === "image_url")
  ) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(source)) {
    if (
      (key === "image_url" || key === "image" || key === "imageUrl") &&
      typeof nestedValue === "string" &&
      !isValidImageUrl(nestedValue)
    ) {
      continue;
    }

    const cleaned = sanitizeInvalidImageUrlNode(nestedValue);
    if (cleaned !== undefined) {
      sanitized[key] = cleaned;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return undefined;
  }

  if (
    type === "input_image" &&
    typeof sanitized.image !== "string" &&
    typeof sanitized.imageUrl !== "string" &&
    typeof sanitized.image_url !== "string" &&
    typeof sanitized.file_id !== "string"
  ) {
    return undefined;
  }

  return sanitized;
}

const sanitizeInvalidImageUrlsBeforeModelCall: CallModelInputFilter = ({
  modelData,
}) => {
  const sanitizedInput = modelData.input
    .map((item) => sanitizeInvalidImageUrlNode(item))
    .filter(
      (item): item is AgentInputItem => item !== undefined,
    ) as AgentInputItem[];

  return {
    ...modelData,
    input: sanitizedInput,
  };
};

async function runSingleTurn(
  agent: Agent,
  userInput: string,
  history: string[],
  maxTurns: number,
  screenshotCollector: ScreenshotCollector,
): Promise<void> {
  console.log(`[run] task: ${userInput}`);
  screenshotCollector.startTurn(shouldCaptureScreenshot(userInput));

  const task = buildTaskWithHistory(userInput, history);
  const result = await run(agent, task, {
    maxTurns,
    callModelInputFilter: sanitizeInvalidImageUrlsBeforeModelCall,
  });
  const finalOutput = formatFinalOutput(result.finalOutput);

  console.log("\n=== Final Output ===");
  console.log(finalOutput);
  screenshotCollector.finishTurn();

  history.push(`使用者：${userInput}`);
  history.push(`助理：${finalOutput}`);
}

async function startInteractiveSession(
  agent: Agent,
  initialTask: string | undefined,
  maxTurns: number,
  screenshotCollector: ScreenshotCollector,
): Promise<void> {
  const history: string[] = [];
  const rl = readline.createInterface({ input, output });
  let shouldExit = false;

  const handleSignal = () => {
    shouldExit = true;
    rl.close();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    console.log("輸入 /exit 可離開。\n");

    if (initialTask) {
      try {
        await runSingleTurn(
          agent,
          initialTask,
          history,
          maxTurns,
          screenshotCollector,
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`[error] 首輪任務失敗：${error.message}`);
        } else {
          console.error("[error] 首輪任務失敗", error);
        }
      }
    }

    while (!shouldExit) {
      const userInput = (await rl.question("You> ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      try {
        await runSingleTurn(
          agent,
          userInput,
          history,
          maxTurns,
          screenshotCollector,
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`[error] 任務執行失敗：${error.message}`);
        } else {
          console.error("[error] 任務執行失敗", error);
        }
      }

      console.log();
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    rl.close();
  }
}

async function main(): Promise<void> {
  ensureApiKey();

  const mcpUrl = process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL;
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const mcpMode = readMcpModeFromEnv();
  const mcpTimeout = readNumberFromEnv("MCP_TIMEOUT_MS", 20_000);
  const connectTimeout = readNumberFromEnv("MCP_CONNECT_TIMEOUT_MS", 10_000);
  const maxTurns = readNumberFromEnv("AGENT_MAX_TURNS", 12);

  const cliArgs = process.argv.slice(2);
  const screenshotDir = path.resolve(
    getArgValue(cliArgs, "--screenshot-dir") ??
      readStringFromEnv("SCREENSHOT_DIR", DEFAULT_SCREENSHOT_DIR),
  );
  const initialTask =
    cliArgs.length > 0 ? resolveTaskFromArgs(cliArgs) : undefined;

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
      "你是瀏覽器自動化助理。需要存取網頁內容時，必須優先使用可用的 MCP 工具，不要捏造內容。若動作涉及加入購物車、填寫個資、付款或提交訂單，必須先要求使用者明確確認，不可直接執行。回覆請簡潔且使用繁體中文。",
    mcpServers: servers.active,
  });
  const screenshotCollector = new ScreenshotCollector(screenshotDir);

  agent.on("agent_tool_start", (_context, tool) => {
    console.log(`[tool:start] ${getToolName(tool)}`);
  });

  agent.on("agent_tool_end", async (_context, tool, result) => {
    console.log(`[tool:end] ${getToolName(tool)} -> ${shorten(result)}`);
    await screenshotCollector.onToolEnd(getToolName(tool), result);
  });

  try {
    console.log(`[mcp] mode: ${mcpMode}`);
    console.log(`[mcp] connected: ${mcpUrl}`);
    console.log(`[screenshot] output dir: ${screenshotDir}`);
    await startInteractiveSession(
      agent,
      initialTask,
      maxTurns,
      screenshotCollector,
    );
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
