import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import {
	WindowedContainer,
	type WindowedContainerOptions,
	type WindowedEntry,
} from "../src/components/windowed-container.ts";
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

class WidthAwareLine implements Component {
	renders = 0;
	readonly widths: number[] = [];
	readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	render(width: number): string[] {
		this.renders++;
		this.widths.push(width);
		const rows = width < 30 ? 4 : 2;
		return Array.from({ length: rows }, () => `${this.label}@${width}`);
	}

	invalidate(): void {}
}

/** Counts builds per index and keeps the component each entry mounted last. */
class WidthFixture {
	readonly container: WindowedContainer;
	private readonly buildCountsByIndex = new Map<number, number>();
	private readonly components = new Map<number, WidthAwareLine>();

	constructor(count: number, options: WindowedContainerOptions) {
		this.container = new WindowedContainer(options);
		for (let index = 0; index < count; index++) {
			this.container.append(() => {
				this.buildCountsByIndex.set(index, (this.buildCountsByIndex.get(index) ?? 0) + 1);
				const component = new WidthAwareLine(`m${index}`);
				this.components.set(index, component);
				return component;
			});
		}
	}

	buildCounts(): number[] {
		return this.container.getEntries().map((_, index) => this.buildCountsByIndex.get(index) ?? 0);
	}

	entry(index: number): WindowedEntry {
		return this.container.getEntries()[index]!;
	}

	widths(index: number): number[] {
		return this.components.get(index)!.widths;
	}
}

test("a narrower terminal measures the whole transcript again", () => {
	const fixture = new WidthFixture(8, {
		getViewport: () => ({ top: 0, height: 4 }),
		overscan: 0,
		retainLines: true,
	});
	fixture.container.render(40);
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 1, 1, 1, 1]);

	const lines = fixture.container.render(20);
	// Narrower lines re-wrap into more lines, so no entry keeps the height it measured at the wide width.
	assert.deepEqual(fixture.buildCounts(), [1, 1, 2, 2, 2, 2, 2, 2]);
	assert.deepEqual(
		fixture.container.getEntries().map((entry) => entry.height),
		[4, 4, 4, 4, 4, 4, 4, 4],
	);
	assert.equal(fixture.container.height, 32);
	// The entry was released at the wide width, so the component the shrink builds starts at the new width.
	assert.deepEqual(fixture.widths(5), [20]);
	assert.equal(lines[16], "m4@20");
});

test("a wider terminal measures the whole transcript again", () => {
	const fixture = new WidthFixture(8, {
		getViewport: () => ({ top: 0, height: 4 }),
		overscan: 0,
		retainLines: true,
	});
	fixture.container.render(20);

	const lines = fixture.container.render(40);
	assert.deepEqual(fixture.buildCounts(), [1, 2, 2, 2, 2, 2, 2, 2]);
	assert.deepEqual(
		fixture.container.getEntries().map((entry) => entry.height),
		[2, 2, 2, 2, 2, 2, 2, 2],
	);
	assert.equal(fixture.container.height, 16);
	assert.equal(lines[4], "m2@40");
});

test("lazyResize keeps history as estimates when the terminal widens", () => {
	const fixture = new WidthFixture(8, {
		getViewport: () => ({ top: 0, height: 4 }),
		overscan: 0,
		retainLines: true,
		lazyResize: () => true,
	});
	fixture.container.render(20);

	const lines = fixture.container.render(40);
	// Lines that were already narrower than the terminal keep their wrapping, so only the window is measured.
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 1, 1, 1, 1]);
	assert.deepEqual(fixture.widths(0), [20, 40]);
	assert.deepEqual(
		fixture.container.getEntries().map((entry) => entry.height),
		[2, 4, 4, 4, 4, 4, 4, 4],
	);
	assert.deepEqual(fixture.entry(1).lines, ["m1@20", "m1@20", "m1@20", "m1@20"]);
	assert.equal(fixture.container.height, 30);
	assert.deepEqual(fixture.widths(1), [20]);
	assert.equal(lines[2], "m1@20");
});

test("lazyResize keeps history as estimates when the terminal narrows", () => {
	const fixture = new WidthFixture(8, {
		getViewport: () => ({ top: 0, height: 4 }),
		overscan: 0,
		retainLines: true,
		lazyResize: () => true,
	});
	fixture.container.render(40);
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 1, 1, 1, 1]);

	const lines = fixture.container.render(20);
	// A resize builds no component outside the window; only the two inside it render again.
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 1, 1, 1, 1]);
	assert.deepEqual(fixture.widths(0), [40, 20]);
	assert.equal(fixture.entry(2).component, undefined);
	// Heights and lines outside the window stay as estimates from the previous width.
	assert.deepEqual(
		fixture.container.getEntries().map((entry) => entry.height),
		[4, 4, 2, 2, 2, 2, 2, 2],
	);
	assert.deepEqual(fixture.entry(2).lines, ["m2@40", "m2@40"]);
	assert.equal(fixture.container.height, 20);
	assert.equal(lines[0], "m0@20");
	assert.equal(lines[8], "m2@40");
});

test("scrolling after a resize remeasures the entries that enter the window", () => {
	let top = 0;
	const fixture = new WidthFixture(8, {
		getViewport: () => ({ top, height: 4 }),
		overscan: 0,
		retainLines: true,
		lazyResize: () => true,
	});
	fixture.container.render(40);
	fixture.container.render(20);

	top = 12;
	const lines = fixture.container.render(20);
	// The two entries the window reaches now are rebuilt and measured at the new width.
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 2, 2, 1, 1]);
	assert.deepEqual(
		fixture.container.getEntries().map((entry) => entry.height),
		[4, 4, 2, 2, 4, 4, 2, 2],
	);
	assert.deepEqual(fixture.widths(4), [20]);
	assert.equal(fixture.container.height, 24);
	assert.equal(lines[12], "m4@20");
});

test("windowFromEnd remeasures only the tail window when lazy", () => {
	const fixture = new WidthFixture(10, {
		windowFromEnd: true,
		getViewportLines: () => 4,
		overscan: 0,
		lazyResize: () => true,
	});
	fixture.container.render(20);

	const lines = fixture.container.render(40);
	assert.deepEqual(fixture.buildCounts(), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
	assert.deepEqual(fixture.widths(8), [20]);
	assert.deepEqual(fixture.widths(9), [20, 40]);
	// Nine entries keep their measured 4 lines; only the one in the tail window shrinks to 2.
	assert.equal(fixture.container.height, 9 * 4 + 2);
	assert.equal(lines.length, 38);
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
