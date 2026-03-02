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

## Run

先啟動 Playwright MCP server（HTTP）：

```bash
pnpm run mcp:server
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

## Type Check

```bash
pnpm run typecheck
```

## Notes

- 若看到 `缺少 OPENAI_API_KEY`，請確認 `.env` 已設定。
- 若看到 `MCP 伺服器連線失敗`，請確認 `pnpm run mcp:server` 正在執行，且 `MCP_SERVER_URL` 正確。
- 主程式會輸出 `tool:start` / `tool:end`，用來確認確實有呼叫 MCP 工具。
- `--template browse-flow` 會生成標準化多步驟任務，適合重複驗證與 demo。
