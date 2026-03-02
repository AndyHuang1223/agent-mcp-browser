import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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

function createFilenameSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
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

  try {
    if (image.kind === "base64") {
      const timestamp = formatTimestampForFilename(new Date());
      const suffix = createFilenameSuffix();
      const filename = `screenshot-${timestamp}-${suffix}.${image.extension}`;
      const targetPath = path.join(screenshotDir, filename);
      const buffer = Buffer.from(image.data, "base64");
      await writeFile(targetPath, buffer);
      return targetPath;
    } else {
      const normalizedSourcePath = image.sourcePath.startsWith("~/")
        ? path.join(process.env.HOME ?? "", image.sourcePath.slice(2))
        : image.sourcePath;
      const resolvedSourcePath = path.resolve(normalizedSourcePath);
      const parsedSourceName = path.parse(normalizedSourcePath);
      const sourceBasename = parsedSourceName.name || "screenshot";
      const sourceExtension =
        parsedSourceName.ext ||
        `.${getImageExtensionFromPath(normalizedSourcePath)}`;
      const timestamp = formatTimestampForFilename(new Date());
      const suffix = createFilenameSuffix();
      const targetFilename = `${sourceBasename}-${timestamp}-${suffix}${sourceExtension}`;
      const targetPath = path.join(screenshotDir, targetFilename);

      if (resolvedSourcePath === path.resolve(targetPath)) {
        return targetPath;
      }

      try {
        await rename(resolvedSourcePath, targetPath);
      } catch {
        await copyFile(resolvedSourcePath, targetPath);
        try {
          await unlink(resolvedSourcePath);
        } catch (cleanupError: unknown) {
          const message =
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError);
          console.warn(
            `[screenshot] 已複製但無法移除來源檔 ${resolvedSourcePath}：${message}`,
          );
        }
      }

      return targetPath;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[screenshot] 無法儲存截圖：${message}`);
    return undefined;
  }
}

export class ScreenshotCollector {
  private enabled = false;
  private savedPaths: string[] = [];

  constructor(private readonly screenshotDir: string) {}

  startTurn(userInput: string): void {
    this.enabled = shouldCaptureScreenshot(userInput);
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
