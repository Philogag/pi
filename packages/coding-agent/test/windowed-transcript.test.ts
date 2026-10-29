import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { WindowedContainer } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function createContext(): { mode: Record<string, unknown>; container: WindowedContainer } {
	const container = new WindowedContainer({
		windowFromEnd: true,
		getViewportLines: () => 20,
		overscan: 1,
		retainLines: true,
	});
	const mode = Object.create(InteractiveMode.prototype) as Record<string, unknown>;
	const props: Record<string, unknown> = {
		chatContainer: container,
		outputPad: 1,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getUserMessageText: (message: { content: string }) => message.content,
		editor: {},
		ui: { requestRender: () => {} },
		session: { extensionRunner: { getMessageRenderer: () => undefined } },
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => 40 },
		sessionManager: { getCwd: () => "/tmp" },
		getRegisteredToolDefinition: () => undefined,
		toolStates: new WeakMap(),
	};
	for (const [key, value] of Object.entries(props)) {
		Object.defineProperty(mode, key, { value, configurable: true, writable: true });
	}
	return { mode, container };
}

function userMessage(prefix: string, index: number): UserMessage {
	return { role: "user", content: `${prefix} ${index} ${"lorem ipsum ".repeat(8)}`, timestamp: index } as UserMessage;
}

function assistantMessage(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `answer ${index} ${"dolor sit amet ".repeat(8)}` }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: index,
	} as unknown as AssistantMessage;
}

describe("windowed transcript", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps only the tail window materialized across a long transcript", () => {
		const { mode, container } = createContext();
		const add = (InteractiveMode.prototype as unknown as Record<string, unknown>).addMessageToChat as (
			this: unknown,
			message: unknown,
		) => void;
		for (let index = 0; index < 300; index++) {
			add.call(mode, userMessage("q", index));
			add.call(mode, assistantMessage(index));
		}
		expect(container.entryCount).toBe(600);
		const lines = container.render(100);
		expect(lines.length).toBe(container.height);
		expect(lines.length).toBeGreaterThan(2000);
		const live = container.getEntries().filter((entry) => entry.component !== undefined);
		// 20 visible rows plus one overscan viewport above and below stays far below the 600 entries.
		expect(live.length).toBeLessThan(20);
		expect(container.children.length).toBe(live.length);
	});

	it("releases tool rows after their result and rebuilds them on re-entry", () => {
		const { mode, container } = createContext();
		const create = (InteractiveMode.prototype as unknown as Record<string, unknown>).createToolExecution as (
			this: unknown,
			name: string,
			id: string,
			args: unknown,
		) => Component & { updateResult: (result: unknown) => void };
		const updateResult = (InteractiveMode.prototype as unknown as Record<string, unknown>).updateToolResult as (
			this: unknown,
			component: Component & { updateResult: (result: unknown) => void },
			result: unknown,
		) => void;

		const pending = create.call(mode, "read", "call-1", { path: "/tmp/a" });
		container.render(100);
		const entry = container.entryOf(pending);
		expect(entry?.pinned).toBe(true);

		updateResult.call(mode, pending, { content: [{ type: "text", text: "ok" }], isError: false });
		expect(entry?.pinned).toBe(false);

		// Fill the transcript so the finished row leaves the window.
		const add = (InteractiveMode.prototype as unknown as Record<string, unknown>).addMessageToChat as (
			this: unknown,
			message: unknown,
		) => void;
		for (let index = 0; index < 40; index++) add.call(mode, userMessage("q", index));
		container.render(100);
		expect(entry?.component).toBeUndefined();
		expect(entry?.pinned).toBe(false);
	});
});
