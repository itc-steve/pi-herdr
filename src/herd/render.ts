/**
 * Compact TUI renderers for the herd tool and its custom messages.
 *
 * `herdRenderCall` / `herdRenderResult` are drop-in for the herd tool's
 * `renderCall` / `renderResult` slots (the default boxed shell keeps owning
 * output padding, so no `renderShell: "self"`). `registerHerdMessageRenderers`
 * wires the herd-result, herd-peer, and herd-slash message renderers.
 */
import type {
	ExtensionAPI,
	KeybindingHints,
	MessageRenderOptions,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Minimum tool-render context surface the herd renderers use. */
export interface HerdToolRenderContext extends KeybindingHints {
	args: object;
	isPartial: boolean;
	expanded: boolean;
	isError: boolean;
	durationMs?: number;
}

/** Tool slot signature: matches ToolDefinition.renderCall. */
export function herdRenderCall(
	args: object,
	theme: Theme,
	_context: HerdToolRenderContext,
): Text {
	const a = args as Record<string, unknown>;
	let text = theme.fg("toolTitle", theme.bold("herd "));
	text += theme.fg("accent", typeof a.action === "string" && a.action ? a.action : "?");
	if (typeof a.worker === "string" && a.worker) text += theme.fg("muted", ` ${a.worker}`);
	if (typeof a.label === "string" && a.label) text += theme.fg("muted", ` “${a.label}”`);
	if (typeof a.jobId === "string" && a.jobId) text += theme.fg("dim", ` ${a.jobId}`);
	return new Text(text, 0, 0);
}

type ContentBlock = { type: string; text?: string };
type HerdContent = string | ContentBlock[];

function extractContent(content: HerdContent): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	let text = "";
	let images = 0;
	for (const block of content) {
		if (block.type === "text") text += block.text ?? "";
		else images += 1;
	}
	return { text, images };
}

const MAX_PREVIEW = 80;
function shorten(text: string): string {
	return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 3)}...` : text;
}
function firstLine(text: string): string {
	return text.split("\n").find((l) => l.trim()) ?? "";
}
function durationText(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Tool slot signature: matches ToolDefinition.renderResult. */
export function herdRenderResult(
	result: { content: HerdContent; details?: unknown },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: HerdToolRenderContext,
): Text {
	const { text, images } = extractContent(result.content);
	const imageNote = images ? theme.fg("dim", ` (+${images} image${images > 1 ? "s" : ""})`) : "";

	if (isPartial) {
		const progress = text.trim();
		if (!progress) return new Text(theme.fg("warning", "herd running...") + imageNote, 0, 0);
		if (expanded) return new Text(progress + imageNote, 0, 0);
		const shown = shorten(firstLine(progress));
		const hidden = progress !== shown || images > 0;
		const hint = hidden ? ` ${context.keyHint("app.tools.expand", "to expand")}` : "";
		return new Text(theme.fg("warning", "running ") + shown + imageNote + hint, 0, 0);
	}

	const isError =
		context.isError ||
		((result.details as { error?: unknown } | undefined)?.error === true);
	const head = firstLine(text);

	if (expanded) {
		// Full text exactly; details stay out of the view.
		return new Text((isError ? theme.fg("error", text) : text) + imageNote, 0, 0);
	}

	const shown = head ? shorten(head) : isError ? "error" : "done";
	// The "done"/"error" fallback labels are not hidden content: no expand
	// hint when the fallback replaced empty text.
	const hidden = (head !== "" && text !== shown) || images > 0;
	const hint = hidden ? ` ${context.keyHint("app.tools.expand", "to expand")}` : "";
	const duration =
		typeof context.durationMs === "number"
			? theme.fg("dim", ` (${durationText(context.durationMs)})`)
			: "";
	return new Text((isError ? theme.fg("error", shown) : shown) + imageNote + duration + hint, 0, 0);
}

function herdRenderMessage(
	message: { content: HerdContent },
	{ expanded, outputPad, keyHint }: MessageRenderOptions,
	theme: Theme,
): Text {
	const { text, images } = extractContent(message.content);
	const imageNote = images ? theme.fg("dim", ` (+${images} image${images > 1 ? "s" : ""})`) : "";
	if (expanded) return new Text(text + imageNote, outputPad, 0); // full text exactly
	const head = firstLine(text);
	const shown = head ? shorten(head) : "(empty)";
	const hidden = (head !== "" && text !== shown) || images > 0;
	const hint = hidden ? ` ${keyHint("app.tools.expand", "to expand")}` : "";
	return new Text(shown + imageNote + hint, outputPad, 0);
}

/** Register TUI renderers for the herd custom message types. */
export function registerHerdMessageRenderers(pi: ExtensionAPI): void {
	const render = (
		message: { content: HerdContent },
		options: MessageRenderOptions,
		theme: Theme,
	): Text => herdRenderMessage(message, options, theme);
	for (const customType of ["herd-result", "herd-peer", "herd-slash"]) {
		pi.registerMessageRenderer(customType, render);
	}
}
