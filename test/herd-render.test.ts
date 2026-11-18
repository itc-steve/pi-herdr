import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	herdRenderCall,
	herdRenderResult,
	registerHerdMessageRenderers,
	type HerdToolRenderContext,
} from "../src/herd/render.ts";

// Fake theme: mark colors so assertions can inspect which token was used.
const theme = {
	fg: (color: string, text: string) => `[${color}]${text}`,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => `*${text}*`,
} as unknown as Theme;

function makeContext(overrides: Partial<HerdToolRenderContext> = {}): HerdToolRenderContext {
	const hints = {
		keyText: (id: string) => `[${id}]`,
		keyHint: (id: string, desc: string) => `(${id} ${desc})`,
	};
	return { args: {}, isPartial: false, expanded: false, isError: false, ...hints, ...overrides };
}

function lines(component: Text): string {
	return component.render(400).map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
}

describe("herdRenderCall", () => {
	it("shows action, worker, label, jobId — not the task text", () => {
		const out = lines(
			herdRenderCall(
				{
					action: "spawn",
					worker: "local",
					label: "tests",
					task: "implement a large bounded task with many details",
				},
				theme,
				makeContext(),
			),
		);
		assert.match(out, /spawn/);
		assert.match(out, /local/);
		assert.match(out, /tests/);
		assert.ok(!out.includes("implement a large bounded task"));
	});

	it("shows jobId for job-scoped actions", () => {
		const out = lines(herdRenderCall({ action: "accept", jobId: "job-9" }, theme, makeContext()));
		assert.match(out, /accept/);
		assert.match(out, /job-9/);
	});

	it("falls back to ? when action is missing", () => {
		const out = lines(herdRenderCall({}, theme, makeContext()));
		assert.match(out, /\?/);
	});
});

describe("herdRenderResult", () => {
	it("collapsed shows first nonempty line plus expand hint when more is hidden", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "\nuseful first line\nsecond line\n" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.match(out, /useful first line/);
		assert.ok(!out.includes("second line"));
		assert.match(out, /app\.tools\.expand/);
	});

	it("omits the expand hint when nothing is hidden", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.equal(out, "ok");
	});

	it("empty final result shows the done fallback without an expand hint", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.equal(out, "done");
	});

	it("truncates a long first line but still offers expansion", () => {
		const long = "x".repeat(200);
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: long }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.ok(out.length < 120);
		assert.match(out, /app\.tools\.expand/);
	});

	it("expanded shows the full text exactly, keeping artifact paths", () => {
		const text = "Wrote /home/sdane/.pi/agent/herd/runs/x/report.md\nsecond line\nthird line";
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text }] },
				{ expanded: true, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.equal(out, text);
		assert.ok(!out.includes("app.tools.expand"));
	});

	it("keeps text from every block in a content array (collapsed and expanded)", () => {
		const content = [
			{ type: "text", text: "part one\n" },
			{ type: "text", text: "part two\n" },
		];
		const collapsed = lines(
			herdRenderResult({ content }, { expanded: false, isPartial: false }, theme, makeContext()),
		);
		assert.match(collapsed, /part one/);
		const expanded = lines(
			herdRenderResult({ content }, { expanded: true, isPartial: false }, theme, makeContext()),
		);
		assert.match(expanded, /part one/);
		assert.match(expanded, /part two/);
	});

	it("marks image-only content instead of dropping it", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "image", data: "xx", mimeType: "image/png" } as { type: string; text?: string }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.match(out, /\(\+1 image\)/);
	});

	it("partial shows compact progress text labelled running", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "queue: 2 waiting, 1 running" }] },
				{ expanded: false, isPartial: true },
				theme,
				makeContext(),
			),
		);
		assert.match(out, /\[warning\]running queue: 2 waiting, 1 running/);
		assert.ok(!out.includes("app.tools.expand"));
	});

	it("partial with hidden progress offers expansion, and expanded shows the full text", () => {
		const partial = { content: [{ type: "text", text: "job a: queued\njob b: running\njob c: waiting" }] };
		const collapsed = lines(
			herdRenderResult(partial, { expanded: false, isPartial: true }, theme, makeContext()),
		);
		assert.match(collapsed, /\[warning\]running job a: queued/);
		assert.ok(!collapsed.includes("job b"));
		assert.match(collapsed, /app\.tools\.expand/);
		const expanded = lines(
			herdRenderResult(partial, { expanded: true, isPartial: true }, theme, makeContext()),
		);
		assert.match(expanded, /job c: waiting/);
	});

	it("partial with empty content falls back to the generic running line", () => {
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "" }] },
				{ expanded: false, isPartial: true },
				theme,
				makeContext(),
			),
		);
		assert.match(out, /\[warning\]herd running\.{3}/);
	});

	it("error details and context.isError color the head as error", () => {
		const viaDetails = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "boom" }], details: { error: true, action: "spawn" } },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.match(viaDetails, /\[error\]boom/);
		const viaContext = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "boom" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext({ isError: true }),
			),
		);
		assert.match(viaContext, /\[error\]boom/);
	});

	it("appends duration when present, stays silent otherwise", () => {
		const withMs = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext({ durationMs: 1234 }),
			),
		);
		assert.match(withMs, /\(1\.2s\)/);
		const without = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				makeContext(),
			),
		);
		assert.equal(without, "ok");
	});

	it("honors a non-default keyHint callback", () => {
		const ctx = makeContext();
		(ctx as unknown as { keyHint: (id: string, desc: string) => string }).keyHint = (id, desc) =>
			`PRESS-X [${id}] ${desc}`;
		const out = lines(
			herdRenderResult(
				{ content: [{ type: "text", text: "line1\nline2" }] },
				{ expanded: false, isPartial: false },
				theme,
				ctx,
			),
		);
		assert.match(out, /PRESS-X \[app\.tools\.expand\] to expand/);
	});
});

describe("registerHerdMessageRenderers", () => {
	type Msg = { content: unknown };
	type MsgOpts = {
		expanded: boolean;
		outputPad: number;
		keyHint: (id: string, desc: string) => string;
	};
	type MsgRenderer = (m: Msg, o: MsgOpts, t: Theme) => unknown;

	function fakePi() {
		const registered = new Map<string, MsgRenderer>();
		const pi = {
			registerMessageRenderer(customType: string, renderer: MsgRenderer): void {
				registered.set(customType, renderer);
			},
			registered,
		};
		return pi;
	}

	const registerPi = (pi: ReturnType<typeof fakePi>) =>
		registerHerdMessageRenderers(pi as unknown as Parameters<typeof registerHerdMessageRenderers>[0]);

	const messageOptions: MsgOpts = {
		expanded: false,
		outputPad: 0,
		keyHint: (id: string, desc: string) => `(${id} ${desc})`,
	};

	it("registers exactly herd-result, herd-peer, and herd-slash", () => {
		const pi = fakePi();
		registerPi(pi);
		assert.deepEqual([...pi.registered.keys()].sort(), ["herd-peer", "herd-result", "herd-slash"]);
	});

	it("collapsed message shows first line; expanded shows full text", () => {
		const pi = fakePi();
		registerPi(pi);
		const render = pi.registered.get("herd-result") as MsgRenderer;
		const content = "pointer: /home/sdane/.pi/agent/herd/runs/x/report.md\nread the artifact\n";
		const collapsed = lines(render({ content }, messageOptions, theme) as Text);
		assert.match(collapsed, /pointer: \/home\/sdane\/\.pi\/agent\/herd\/runs\/x\/report\.md/);
		assert.ok(!collapsed.includes("read the artifact"));
		assert.match(collapsed, /app\.tools\.expand/);
		const expanded = lines(
			render({ content }, { ...messageOptions, expanded: true }, theme) as Text,
		);
		assert.equal(expanded, content.replace(/\n$/, ""));
	});

	it("empty message shows the empty fallback without an expand hint", () => {
		const pi = fakePi();
		registerPi(pi);
		const render = pi.registered.get("herd-result") as MsgRenderer;
		const out = lines(render({ content: "" }, messageOptions, theme) as Text);
		assert.equal(out, "(empty)");
	});

	it("message Text uses options.outputPad as horizontal padding", () => {
		const pi = fakePi();
		registerPi(pi);
		const render = pi.registered.get("herd-slash") as MsgRenderer;
		const component = render(
			{ content: "short" },
			{ ...messageOptions, outputPad: 4 },
			theme,
		) as Text;
		assert.ok(component instanceof Text);
		const padded = component.render(400)[0];
		assert.ok(padded.startsWith("    "));
		const unpadded = (render({ content: "short" }, messageOptions, theme) as Text).render(400)[0];
		assert.equal(unpadded.startsWith("    "), false);
	});

	it("message content array text blocks are preserved when expanded", () => {
		const pi = fakePi();
		registerPi(pi);
		const render = pi.registered.get("herd-peer") as MsgRenderer;
		const out = lines(
			render(
				{ content: [{ type: "text", text: "note one\n" }, { type: "text", text: "note two" }] },
				{ ...messageOptions, expanded: true },
				theme,
			) as Text,
		);
		assert.match(out, /note one/);
		assert.match(out, /note two/);
	});
});
