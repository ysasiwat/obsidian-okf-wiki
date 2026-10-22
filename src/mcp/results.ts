// Tool result shaping shared by read and write tools.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { ServiceError } from "../service/types";

/** Tool results above this size are refused: large results crash Obsidian's renderer. */
export const MAX_RESULT_CHARS = 256 * 1024;

export function failure(message: string, hint?: string, code?: string, data?: Record<string, unknown>): CallToolResult {
  const lines = [code ? `[${code}] ${message}` : message];
  if (hint) lines.push(`Hint: ${hint}`);
  if (data && Object.keys(data).length > 0) lines.push(`Data: ${JSON.stringify(data)}`);
  return { isError: true, content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function success(data: object): CallToolResult {
  const text = JSON.stringify(data);
  if (text.length > MAX_RESULT_CHARS) {
    return failure(`The result is ${Math.round(text.length / 1024)} KiB, over the ${MAX_RESULT_CHARS / 1024} KiB limit.`, "Narrow the request: a smaller limit, max_chars, a section, or a filter.");
  }
  return { content: [{ type: "text" as const, text }], structuredContent: data };
}

function handle(e: unknown, onError?: (e: unknown) => void): CallToolResult {
  if (e instanceof ServiceError) return failure(e.message, e.hint, e.code, e.data);
  onError?.(e);
  return failure("Internal error while handling the request.", "Retry once; if it persists, the vault owner can check the Obsidian developer console.");
}

export function run(fn: () => object, onError?: (e: unknown) => void): CallToolResult {
  try {
    return success(fn());
  } catch (e) {
    return handle(e, onError);
  }
}

export async function runAsync(fn: () => Promise<object>, onError?: (e: unknown) => void): Promise<CallToolResult> {
  try {
    return success(await fn());
  } catch (e) {
    return handle(e, onError);
  }
}
