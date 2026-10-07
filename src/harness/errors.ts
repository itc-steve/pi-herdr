/**
 * Soft vs hard tool errors — pi-task/web-tools style:
 * validation and operational failures return as tool text;
 * user abort stays a hard throw so the harness marks the tool cancelled.
 */

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.message === "Aborted" ||
      /aborted/i.test(err.message))
  ) {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function softToolResult(
  message: string,
  details: Record<string, unknown> = {},
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { error: true, ...details },
  };
}
