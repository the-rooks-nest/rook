import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LINES = 200;
const KEEP_LINES = Math.floor(MAX_LINES / 2);
const CHUNK_SIZE = 64 * 1024;
const JS_STRING_MAX_CHARS = 0x1fffffe8;
const MAX_LOG_CHARS = Math.floor(JS_STRING_MAX_CHARS * 0.75);
const MAX_STRING_VALUE_CHARS = 1_000_000;

function createArrayTruncationMarker(omittedCount: number, path: string, totalCount: number) {
  return {
    __prompt_logger: {
      truncated: true,
      reason: "Earlier items were omitted to keep this JSONL log entry bounded.",
      path,
      omittedCount,
      originalCount: totalCount,
      keptNewestCount: totalCount - omittedCount,
    },
  };
}

function createStringTruncationMarker(value: string) {
  const keepChars = Math.max(0, Math.floor(MAX_STRING_VALUE_CHARS / 2));
  return `[prompt-logger truncated ${value.length - keepChars} leading chars; keeping last ${keepChars}] ${value.slice(-keepChars)}`;
}

function getAtPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setAtPath(root: unknown, path: string[], value: unknown) {
  let current = root as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = current[path[index]] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function truncateArrayAtPath(payload: unknown, path: string[]): boolean {
  const existing = getAtPath(payload, path);
  if (!Array.isArray(existing) || existing.length <= 1) return false;

  const pathLabel = path.join(".");
  let omittedCount = 1;
  while (omittedCount < existing.length) {
    const replacement = [
      createArrayTruncationMarker(omittedCount, pathLabel, existing.length),
      ...existing.slice(omittedCount),
    ];
    setAtPath(payload, path, replacement);

    if (JSON.stringify(payload).length <= MAX_LOG_CHARS) return true;
    omittedCount += 1;
  }

  setAtPath(payload, path, [createArrayTruncationMarker(existing.length, pathLabel, existing.length)]);
  return true;
}

function truncateLongStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_VALUE_CHARS ? createStringTruncationMarker(value) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateLongStrings(item));
  }

  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, truncateLongStrings(child)]),
  );
}

function trySerialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function serializePayloadForLog(payload: unknown): string {
  const normalizedPayload = truncateLongStrings(payload);
  const initial = trySerialize(normalizedPayload);
  if (initial && initial.length <= MAX_LOG_CHARS) return initial;

  const truncated = structuredClone(normalizedPayload);
  const candidatePaths = [
    ["messages"],
    ["input"],
    ["body", "messages"],
    ["body", "input"],
  ];

  for (const path of candidatePaths) {
    truncateArrayAtPath(truncated, path);
    const serialized = trySerialize(truncated);
    if (serialized && serialized.length <= MAX_LOG_CHARS) return serialized;
  }

  const withShortStrings = truncateLongStrings(truncated);
  const serialized = trySerialize(withShortStrings);
  if (serialized && serialized.length <= MAX_LOG_CHARS) return serialized;

  return JSON.stringify({
    __prompt_logger: {
      truncated: true,
      reason: "Payload exceeded prompt logger size limits even after array and string truncation.",
      originalLengthEstimate: initial?.length,
      maxLogChars: MAX_LOG_CHARS,
    },
    tail: serialized?.slice(-Math.floor(MAX_STRING_VALUE_CHARS / 2)),
  });
}

function trimLogFile(logFile: string) {
  if (!existsSync(logFile)) return;

  const { size } = statSync(logFile);
  if (size === 0) return;

  const fd = openSync(logFile, "r");

  try {
    let position = size;
    let newlineCount = 0;
    let keepStart = 0;
    let foundKeepBoundary = false;
    let exceedsMaxLines = false;

    while (position > 0 && !exceedsMaxLines) {
      const toRead = Math.min(CHUNK_SIZE, position);
      position -= toRead;

      const buffer = Buffer.allocUnsafe(toRead);
      readSync(fd, buffer, 0, toRead, position);

      for (let index = toRead - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        newlineCount += 1;
        if (!foundKeepBoundary && newlineCount > KEEP_LINES) {
          keepStart = position + index + 1;
          foundKeepBoundary = true;
        }

        if (newlineCount > MAX_LINES) {
          exceedsMaxLines = true;
          break;
        }
      }
    }

    if (!exceedsMaxLines || !foundKeepBoundary) return;

    const keptBuffers: Buffer[] = [];
    let readPosition = keepStart;

    while (readPosition < size) {
      const toRead = Math.min(CHUNK_SIZE, size - readPosition);
      const buffer = Buffer.allocUnsafe(toRead);
      readSync(fd, buffer, 0, toRead, readPosition);
      keptBuffers.push(buffer);
      readPosition += toRead;
    }

    writeFileSync(logFile, Buffer.concat(keptBuffers));
  } finally {
    closeSync(fd);
  }
}

export default function promptTraceLogger(pi: ExtensionAPI) {
  const logFile = process.env.ROOK_PI_TRACE_LOG_PATH?.trim()
    ? process.env.ROOK_PI_TRACE_LOG_PATH
    : join(process.cwd(), ".var", "pi-traces.jsonl");
  mkdirSync(dirname(logFile), { recursive: true });
  if (!existsSync(logFile)) writeFileSync(logFile, "", "utf8");

  pi.on("before_provider_request", (event) => {
    appendFileSync(logFile, `${serializePayloadForLog(event.payload)}\n`, "utf8");
    trimLogFile(logFile);
  });
}
