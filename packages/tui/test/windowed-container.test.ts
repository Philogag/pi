import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { WindowedContainer } from "../src/components/windowed-container.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class LineComponent implements Component {
	renders = 0;
	invalidations = 0;
	disposed = false;
	readonly height: number;
	readonly label: string;

	constructor(height: number, label = "line") {
		this.height = height;
		this.label = label;
	}

	render(_width: number): string[] {
		this.renders++;
		return Array.from({ length: this.height }, (_, index) => `${this.label}${index}`);
	}

	invalidate(): void {
		this.invalidations++;
	}

	dispose(): void {
		this.disposed = true;
	}
}

test("evicts entries outside the window and keeps the line count stable", () => {
	let top = 0;
	const container = new WindowedContainer({ getViewport: () => ({ top, height: 4 }), overscan: 0 });
	const created: LineComponent[] = [];
	for (let index = 0; index < 10; index++) {
		container.append(() => {
			const component = new LineComponent(2, `m${index}-`);
			created.push(component);
			return component;
		});
	}

	const first = container.render(40);
	assert.equal(first.length, 20);
	// Window covers lines 0-3, so entries 0 and 1 stay materialized.
	assert.equal(created[0]!.disposed, false);
	assert.equal(created[1]!.disposed, false);
	assert.equal(created[5]!.disposed, true);
	assert.equal(container.getEntries().filter((entry) => entry.component !== undefined).length, 2);

	top = 16;
	const second = container.render(40);
	assert.equal(second.length, 20);
	assert.equal(second[0], "");
	assert.equal(second[19], "m9-1");
	assert.equal(created[0]!.disposed, true);
	// Only the entries covering lines 16-20 own components again.
	const live = container.getEntries().filter((entry) => entry.component !== undefined);
	assert.deepEqual(
		live.map((entry) => entry.start),
		[16, 18],
	);
	assert.equal(container.children.length, 2);
});

test("rebuilds a component when an entry scrolls back into the window", () => {
	let top = 0;
	const container = new WindowedContainer({ getViewport: () => ({ top, height: 2 }), overscan: 0 });
	const created: LineComponent[] = [];
	for (let index = 0; index < 6; index++) {
		container.append(() => {
			const component = new LineComponent(2, `m${index}-`);
			created.push(component);
			return component;
		});
	}
	container.render(30);
	top = 10;
	container.render(30);
	assert.equal(created[0]!.disposed, true);

	top = 0;
	const lines = container.render(30);
	assert.equal(lines[0], "m0-0");
	assert.notEqual(container.getEntries()[0]!.component, created[0]);
	assert.ok(container.getEntries()[0]!.component);
});

test("retainLines keeps the rendered lines of evicted entries and still releases the component", () => {
	let top = 0;
	const container = new WindowedContainer({ getViewport: () => ({ top, height: 2 }), overscan: 0, retainLines: true });
	const created: LineComponent[] = [];
	for (let index = 0; index < 6; index++) {
		container.append(() => {
			const component = new LineComponent(2, `m${index}-`);
			created.push(component);
			return component;
		});
	}
	container.render(30);
	top = 10;
	const lines = container.render(30);
	assert.equal(lines[0], "m0-0");
	assert.equal(created[0]!.disposed, true);
	assert.equal(created[0]!.renders, 1);
});

test("pinned entries stay materialized", () => {
	let top = 0;
	const container = new WindowedContainer({ getViewport: () => ({ top, height: 2 }), overscan: 0 });
	const pinned = new LineComponent(2, "p-");
	container.appendComponent(pinned);
	for (let index = 0; index < 5; index++) container.append(() => new LineComponent(2, `m${index}-`));
	container.render(30);
	top = 10;
	container.render(30);
	assert.equal(pinned.disposed, false);
	assert.equal(container.getEntries()[0]!.component, pinned);
});

test("windowFromEnd keeps only the tail window materialized", () => {
	const container = new WindowedContainer({ windowFromEnd: true, getViewportLines: () => 4, overscan: 0 });
	const created: LineComponent[] = [];
	for (let index = 0; index < 10; index++) {
		container.append(() => {
			const component = new LineComponent(2, `m${index}-`);
			created.push(component);
			return component;
		});
	}
	const lines = container.render(30);
	assert.equal(lines.length, 20);
	assert.equal(container.getEntries().filter((entry) => entry.component !== undefined).length, 2);
	assert.equal(created[9]!.disposed, false);
	assert.equal(created[0]!.disposed, true);
});

test("width changes remeasure every entry and rerender the window", () => {
	const top = 0;
	const widths: number[] = [];
	class WidthAware implements Component {
		renders = 0;
		readonly id: number;

		constructor(id: number) {
			this.id = id;
		}
		render(width: number): string[] {
			this.renders++;
			widths.push(width);
			return Array.from({ length: Math.ceil(40 / width) }, () => `w${this.id}`);
		}
		invalidate(): void {}
	}
	const container = new WindowedContainer({ getViewport: () => ({ top, height: 2 }), overscan: 0 });
	for (let index = 0; index < 4; index++) container.append(() => new WidthAware(index));
	assert.equal(container.render(40).length, 4);
	assert.equal(container.render(20).length, 8);
	assert.ok(widths.includes(20));
});

test("invalidate drops heights and re-renders live components", () => {
	const container = new WindowedContainer({ getViewport: () => ({ top: 0, height: 10 }), overscan: 0 });
	const created: LineComponent[] = [];
	for (let index = 0; index < 3; index++) {
		container.append(() => {
			const component = new LineComponent(2, `m${index}-`);
			created.push(component);
			return component;
		});
	}
	container.render(30);
	container.invalidate();
	assert.equal(created[0]!.invalidations, 1);
	// Heights are dropped but the content height stays usable, so the window still guards the next render.
	assert.equal(container.height, 6);
	container.render(30);
	assert.equal(container.height, 6);
});

test("insertBefore and removeEntry keep entry order", () => {
	const container = new WindowedContainer();
	const first = container.appendComponent(new LineComponent(1, "a"));
	const last = container.appendComponent(new LineComponent(1, "c"));
	container.insertBefore(last.component!, () => new LineComponent(1, "b"));
	assert.deepEqual(container.render(20), ["a0", "b0", "c0"]);
	container.removeEntry(first);
	assert.deepEqual(container.render(20), ["b0", "c0"]);
});

test("insertBeforeEntry only builds the inserted entry", () => {
	let built = 0;
	const container = new WindowedContainer({
		windowFromEnd: true,
		getViewportLines: () => 4,
		overscan: 0,
		retainLines: true,
	});
	for (let index = 0; index < 50; index++) {
		container.append(() => {
			built += 1;
			return new LineComponent(2, `row${index}-`);
		});
	}
	container.render(30);
	built = 0;
	const anchor = container.getEntries()[20]!;
	const inserted = container.insertBeforeEntry(anchor, () => {
		built += 1;
		return new LineComponent(1, "custom");
	});
	assert.equal(inserted.pinned, false);
	assert.equal(built, 0);
	container.render(30);
	assert.equal(built, 1);
	assert.equal(container.getEntries()[20], inserted);
});

test("fullscreen search still reaches entries released outside the window", async () => {
	const terminal = new VirtualTerminal(60, 8);
	let view: ScrollView;
	const container = new WindowedContainer({
		retainLines: true,
		overscan: 1,
		getViewport: () => ({ top: view.scrollTop, height: view.viewportHeight }),
	});
	view = new ScrollView(container, { follow: "end", primary: true });
	container.append(() => new Text("needle in history", 0, 0));
	for (let index = 0; index < 40; index++) {
		container.append(() => new Text(`entry ${index}\nsecond line`, 0, 0));
	}
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(view);
	tui.start();
	await terminal.waitForRender();
	// The window follows the scroll position that the first layout pass publishes.
	tui.requestRender();
	await terminal.waitForRender();
	assert.ok(
		container.getEntries().some((entry) => entry.component === undefined),
		"history outside the window should be released",
	);

	terminal.sendInput("\x1b[102;6u");
	terminal.sendInput("needle");
	await terminal.waitForRender();
	assert.ok(terminal.getViewport().some((line) => line.includes("1/1")));

	terminal.sendInput("\r");
	await terminal.waitForRender();
	assert.ok(terminal.getViewport().some((line) => line.includes("needle in history")));
	tui.stop();
});
