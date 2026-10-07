/**
 * Session-file + scrollback readback helpers.
 */
import { existsSync, readFileSync } from "node:fs";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    stopReason?: string;
    errorMessage?: string;
  };
}

export function getNewEntries(
  sessionFile: string,
  afterLine: number,
): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

export function countSessionEntries(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    return raw.split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/** True when a real user message was appended after watermark (not extension noise). */
export function hasUserMessageAfter(
  sessionFile: string,
  watermark: number,
): boolean {
  try {
    const entries = getNewEntries(sessionFile, watermark);
    return entries.some((entry) => {
      if (entry.type !== "message") return false;
      const msg = entry as MessageEntry;
      return msg.message?.role === "user";
    });
  } catch {
    return false;
  }
}

export function findLastAssistantMessage(
  entries: SessionEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry!.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    if (
      msg.message.stopReason === "error" &&
      typeof msg.message.errorMessage === "string" &&
      msg.message.errorMessage.trim() !== ""
    ) {
      return `Herd agent error: ${msg.message.errorMessage.trim()}`;
    }
  }
  return null;
}

export function collectFromSessionFile(
  sessionFile: string,
  watermark: number,
): string | null {
  if (!existsSync(sessionFile)) return null;
  try {
    const entries = getNewEntries(sessionFile, watermark);
    return findLastAssistantMessage(entries);
  } catch {
    return null;
  }
}

export function extractFromScrollback(text: string): string | null {
  if (!text || !text.trim()) return null;

  const lines = text.replace(/\r/g, "").split("\n");
  const cleaned = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return false;
    if (/^(working|thinking|idle|blocked)\b/i.test(t) && t.length < 40) {
      return false;
    }
    if (/^took \d/i.test(t)) return false;
    return true;
  });

  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i]!.trim();
    if (t.startsWith(">") || t.startsWith("❯") || t.startsWith("$ ")) {
      start = i + 1;
    }
  }

  const body = cleaned.slice(start).join("\n").trim();
  if (body.length >= 20) return body;

  const fallback = cleaned.join("\n").trim();
  return fallback.length >= 20 ? fallback : null;
}
