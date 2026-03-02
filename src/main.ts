import "dotenv/config";
import { ensureApiKey, resolveRuntimeConfig } from "./config.js";
import { connectRuntime, getToolName, shorten } from "./runtime.js";
import { ScreenshotCollector } from "./screenshot.js";
import { startInteractiveSession } from "./session.js";

async function main(): Promise<void> {
  ensureApiKey();

  const cliArgs = process.argv.slice(2);
  const config = resolveRuntimeConfig(cliArgs);

  const runtime = await connectRuntime({
    mcpUrl: config.mcpUrl,
    model: config.model,
    mcpTimeout: config.mcpTimeout,
    connectTimeout: config.connectTimeout,
  });

  const screenshotCollector = new ScreenshotCollector(config.screenshotDir);

  runtime.agent.on("agent_tool_start", (_context, tool) => {
    console.log(`[tool:start] ${getToolName(tool)}`);
  });

  runtime.agent.on("agent_tool_end", async (_context, tool, result) => {
    const toolName = getToolName(tool);
    console.log(`[tool:end] ${toolName} -> ${shorten(result)}`);
    await screenshotCollector.onToolEnd(toolName, result);
  });

  try {
    console.log(`[mcp] mode: ${config.mcpMode}`);
    console.log(`[mcp] connected: ${config.mcpUrl}`);
    console.log(`[screenshot] output dir: ${config.screenshotDir}`);

    await startInteractiveSession(
      runtime.agent,
      config.initialTask,
      config.maxTurns,
      screenshotCollector,
    );
  } finally {
    await runtime.close();
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
