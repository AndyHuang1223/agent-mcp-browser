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

或使用更直覺的互動模式指令：

```bash
pnpm run repl:direct
```

若你要一鍵啟動 Attach MCP server + REPL（單一指令）：

```bash
pnpm run repl
```

若你需要較詳細的啟動診斷（除錯）：

```bash
pnpm run repl:attach:verbose
```

若需要自訂截圖資料夾，請在 `.env` 設定 `PLAYWRIGHT_MCP_OUTPUT_DIR`。

啟動後會進入互動模式（同一個 session 持續下 prompt）：

- 輸入內容後按 Enter 即執行。
- 輸入 `/exit` 可離開。
- 在同一個程序內會沿用同一個 Agent/MCP 連線與瀏覽器控制 session。
- 當你在指令中明確要求「截圖 / screenshot」時，若工具有回傳圖片資料，程式會儲存到 `PLAYWRIGHT_MCP_OUTPUT_DIR` 指定路徑。
- 截圖檔名會自動加上時間戳與短隨機碼（例如 `screenshot-20260302-164512-123-abcd.png`），避免同名覆蓋。
- 若工具回傳的是既有圖片路徑（非 base64），搬移到輸出資料夾時也會套用同樣的重新命名規則。

可帶入自訂任務作為「首輪指令」，執行後仍會留在互動模式：

```bash
pnpm run dev -- "請打開 https://example.com 並告訴我頁面標題"
```

使用多步驟瀏覽模板（搜尋→點擊→擷取→JSON 輸出）：

```bash
pnpm run dev -- --template browse-flow --url "https://news.ycombinator.com" --topic "今天最熱門的 AI 相關討論"
```

使用商品搜尋模板（跨站搜尋、比價、輸出候選清單）：

```bash
pnpm run dev -- --template product-search --query "Nintendo Switch 2" --locale "台灣（繁體中文）" --max-results 8
```

或使用範例腳本：

```bash
pnpm run task:product-search:demo
```

允許做到結帳前流程（仍有安全確認閘門）：

```bash
pnpm run task:product-search:precheckout-demo
```

## 控制你目前正在瀏覽的頁面（Attach 模式）

若你希望 agent 直接操作你已開啟的 Chrome 分頁（不是新開自動化視窗），請使用 Attach 模式。

### 1) 基本設定

在 `.env` 至少設定：

```dotenv
MCP_MODE=attach
MCP_SERVER_URL=http://127.0.0.1:8931/mcp
```

可選（建議）：

```dotenv
PLAYWRIGHT_MCP_EXTENSION_TOKEN=貼上 extension 顯示的 token 值
```

> 注意：只貼 token 值本體，不要再加 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 前綴。

### 2) 一鍵啟動（建議）

1. Chrome 先開你要控制的網站分頁（同一個視窗、非無痕）。
1. 直接啟動（會自動先起 attach server，等就緒後再進 REPL）：

```bash
pnpm run repl
```

1. 用簡短任務先驗證目前頁面：

```bash
pnpm run repl -- "回報目前分頁網址與標題，不要導航"
```

若輸出網址是你目標網站，即表示接管成功。

補充：若你要手動分開啟動（除錯用），仍可使用 `pnpm run mcp:server:attach` + `pnpm run repl:direct`。

### 3) 有沒有設定 PLAYWRIGHT_MCP_EXTENSION_TOKEN 的影響

- 有設定 token（建議）：
  - 通常可略過上方「allow/continue」類型確認。
  - 連線流程較穩定，重啟後較少卡在初次授權。
- 沒有設定 token：
  - 幾乎每次新連線都可能需要手動確認。
  - 操作流程較容易中斷。

補充：即使設定 token，仍可能需要在 extension 流程中選擇要 expose 的頁面；這是安全機制。

### 4) 常見現象與排查

- 現象 A：`browser_tabs` 只看到 extension 分頁
  - 原因：目前 expose 的就是 extension 自己那一頁。
  - 處理：先在同視窗開目標網站，再重新走 extension 連線流程，讓目標網站分頁被 expose。

- 現象 B：每次都跳確認畫面
  - 原因：token 未設定、格式錯誤、或 token 已失效。
  - 處理：從 extension 頁重新複製 token，覆蓋 `.env` 後重啟 `pnpm run mcp:server:attach`。

- 現象 C：指令失敗顯示 `429 Rate limit reached`
  - 原因：OpenAI TPM 限流，不是 attach relay 失敗。
  - 處理：稍等幾秒重試，並改用更短任務文字或分兩段操作（先驗證頁面，再做搜尋）。

### 5) Attach 模式搜尋範例

```bash
pnpm run dev -- "先回報目前分頁網址與標題；若是 pchome.com.tw，搜尋『吸頂燈』並回傳前 5 筆商品名稱、價格、商品頁網址。不要切到其他網站。"
```

補充：`MCP_MODE` 只用來標示目前模式並輸出到 log，實際連線目標由 `MCP_SERVER_URL` 與你啟動的 `mcp:server:*` 指令決定。

## 商品搜尋模板參數

`--template product-search` 支援以下參數：

- `--query`：商品搜尋關鍵字（必填，若未提供會讀取位置參數）。
- `--budget-min` / `--budget-max`：預算區間（可選，數字）。
- `--locale`：地區與語言（預設 `台灣（繁體中文）`）。
- `--max-results`：輸出候選商品上限（預設 8，範圍 1~20）。
- `--allow-open-product-page`：允許代理進入商品頁比對資訊。
- `--allow-cart`：允許代理執行加入購物車相關動作。
- `--allow-precheckout`：允許代理做到結帳前流程（必須同時加 `--allow-cart`）。

### 高風險操作安全規則

- 任何加入購物車、填寫資料、或進入交易確認相關動作前，代理會先輸出「需要你的明確確認」。
- 即使啟用 `--allow-precheckout`，代理仍不得提交最終訂單。
- 若你只想查資料，建議不要加 `--allow-cart` / `--allow-precheckout`。

## Type Check

```bash
pnpm run typecheck
```

## Lint

```bash
pnpm run lint
```

## Notes

- 若看到 `缺少 OPENAI_API_KEY`，請確認 `.env` 已設定。
- 若看到 `MCP 伺服器連線失敗`，請確認 `pnpm run mcp:server` 正在執行，且 `MCP_SERVER_URL` 正確。
- 主程式會輸出 `tool:start` / `tool:end`，用來確認確實有呼叫 MCP 工具。
- `--template browse-flow` 會生成標準化多步驟任務，適合重複驗證與 demo。
