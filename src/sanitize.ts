import type { AgentInputItem, CallModelInputFilter } from "@openai/agents";

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

export const sanitizeInvalidImageUrlsBeforeModelCall: CallModelInputFilter = ({
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
