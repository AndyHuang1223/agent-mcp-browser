# agent-mcp-browser

用 TypeScript + OpenAI Agents SDK 建立可操控瀏覽器的 Agent，並透過 Playwright MCP server（HTTP `/mcp`）提供工具。

## Prerequisites

- Node.js 22+
- pnpm
- OpenAI API Key

## Setup

1. 安裝依賴

   ```bash
   pnpm install
   ```

2. 建立環境變數

   ```bash
   cp .env.example .env
   ```

3. 在 `.env` 設定 `OPENAI_API_KEY`

可選：設定 `MCP_MODE=headless` 或 `MCP_MODE=attach`，啟動時會顯示目前模式（實際連線目標仍由 `MCP_SERVER_URL` 決定）。

## Run

先啟動 Playwright MCP server（HTTP，預設 headless）：

```bash
pnpm run mcp:server
```

若要讓 agent 連到你目前正在使用的 Chrome 分頁（沿用既有登入狀態與 tabs），請先安裝 Playwright MCP Bridge extension，然後改用 attach 模式：

```bash
pnpm run mcp:server:attach
```

再開另一個終端啟動 Agent：

```bash
pnpm run dev
```

可帶入自訂任務（未帶入會使用預設任務）：

```bash
pnpm run dev -- "請打開 https://example.com 並告訴我頁面標題"
```

使用多步驟瀏覽模板（搜尋→點擊→擷取→JSON 輸出）：

```bash
pnpm run dev -- --template browse-flow --url "https://news.ycombinator.com" --topic "今天最熱門的 AI 相關討論"
```

## 控制你目前正在瀏覽的頁面（Attach 模式）

若你希望 agent 直接操作你已開啟的 Chrome 分頁（不是新開一個自動化視窗），請使用以下流程：

1. 安裝 Chrome 的 **Playwright MCP Bridge** extension。
2. 在 `.env` 設定：

   ```dotenv
   MCP_MODE=attach
   MCP_SERVER_URL=http://127.0.0.1:8931/mcp
   ```

3. 啟動 MCP server（attach）：

   ```bash
   pnpm run mcp:server:attach
   ```

4. 另開終端啟動 agent：

   ```bash
   pnpm run dev
   ```

5. 看到啟動輸出含 `[mcp] mode: attach`，代表目前是 attach 模式。

補充：`MCP_MODE` 只用來標示目前模式並輸出到 log，實際連線目標由 `MCP_SERVER_URL` 與你啟動的 `mcp:server:*` 指令決定。

## Type Check

```bash
pnpm run typecheck
```

## Notes

- 若看到 `缺少 OPENAI_API_KEY`，請確認 `.env` 已設定。
- 若看到 `MCP 伺服器連線失敗`，請確認 `pnpm run mcp:server` 正在執行，且 `MCP_SERVER_URL` 正確。
- 主程式會輸出 `tool:start` / `tool:end`，用來確認確實有呼叫 MCP 工具。
- `--template browse-flow` 會生成標準化多步驟任務，適合重複驗證與 demo。
