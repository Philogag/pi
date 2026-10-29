import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";

/** Visible slice of the content, in content lines, from the start of the window. */
export interface WindowedViewport {
	top: number;
	height: number;
}

export interface WindowedContainerOptions {
	/**
	 * Visible slice of the content. Returning undefined keeps every entry materialized.
	 * The callback may read state that the previous layout pass updated, so it can lag one frame;
	 * `overscan` covers that lag.
	 */
	getViewport?: () => WindowedViewport | undefined;
	/**
	 * Keep only the last `getViewportLines()` lines materialized instead of reading `getViewport`.
	 * Regular-screen renderers keep the whole line buffer for diffing, so they use this mode.
	 */
	windowFromEnd?: boolean;
	/** Screen height used by `windowFromEnd`. */
	getViewportLines?: () => number;
	/** Extra viewports kept materialized above and below. Default 1. */
	overscan?: number;
	/**
	 * Keep the rendered lines of evicted entries.
	 * Regular-screen renderers diff the whole line buffer, and fullscreen search, prompt jumps, and selection
	 * read the whole content, so both need the real lines of history. Turning this off collapses released
	 * entries to empty lines and is only safe when nothing reads the buffer outside the visible window.
	 */
	retainLines?: boolean | (() => boolean);
	/** Called with the component an entry released when it left the window. */
	onEvict?: (component: Component, entry: WindowedEntry) => void;
}

/** One entry of a {@link WindowedContainer}. Owners may flip `pinned` or replace `build`. */
export interface WindowedEntry {
	/** Builds a fresh component for this entry when it re-enters the window. */
	build: () => Component;
	/** The materialized component, present only while the entry is inside the window. */
	component?: Component;
	/** Rendered lines of an evicted entry, kept when `retainLines` is enabled. */
	lines?: string[];
	/** Entry never leaves the window. Streaming rows and rows without a build stay pinned. */
	pinned: boolean;
	/** Line height measured at the container width; `-1` until measured. */
	height: number;
	/** First content line of the entry. */
	start: number;
}

interface WindowedAddOptions {
	pinned?: boolean;
	/** Build function used to recreate the component after eviction. Omit to pin the component permanently. */
	build?: () => Component;
}

function disposeComponent(component: Component): void {
	const disposable = component as Component & { dispose?: () => void };
	disposable.dispose?.();
}

/**
 * Container that materializes only the components inside the visible window.
 *
 * Entries outside the window release their component (and its caches) and collapse to their measured
 * height, so a long transcript costs a line count per message instead of a live component tree.
 * `build` recreates the component when the entry scrolls back into the window.
 */
export class WindowedContainer extends Container {
	private readonly entries: WindowedEntry[] = [];
	private readonly getViewportOption?: () => WindowedViewport | undefined;
	private readonly getViewportLinesOption?: () => number;
	private readonly onEvictOption?: (component: Component, entry: WindowedEntry) => void;
	private readonly overscan: number;
	private readonly retainLinesOption: boolean | (() => boolean);
	private readonly windowFromEnd: boolean;
	private measuredWidth = -1;
	private contentHeight = 0;

	constructor(options: WindowedContainerOptions = {}) {
		super();
		this.getViewportOption = options.getViewport;
		this.getViewportLinesOption = options.getViewportLines;
		this.onEvictOption = options.onEvict;
		this.windowFromEnd = options.windowFromEnd === true;
		this.overscan = Math.max(0, Math.floor(options.overscan ?? 1));
		this.retainLinesOption = options.retainLines ?? false;
	}

	get entryCount(): number {
		return this.entries.length;
	}

	get height(): number {
		return this.contentHeight;
	}

	getEntries(): readonly WindowedEntry[] {
		return this.entries;
	}

	/** Append an entry; the component is built on the next render. */
	append(build: () => Component, options: WindowedAddOptions = {}): WindowedEntry {
		const entry: WindowedEntry = {
			build,
			pinned: options.pinned ?? false,
			height: -1,
			start: Math.max(0, this.contentHeight),
		};
		this.entries.push(entry);
		return entry;
	}

	/** Append an existing component. It stays materialized unless `build` is given. */
	appendComponent(component: Component, options: WindowedAddOptions = {}): WindowedEntry {
		const entry = this.append(options.build ?? (() => component), {
			pinned: options.pinned ?? options.build === undefined,
		});
		entry.component = component;
		return entry;
	}

	insertBefore(reference: Component, build: () => Component, options: WindowedAddOptions = {}): WindowedEntry {
		const index = this.indexOfEntry(reference);
		const entry: WindowedEntry = { build, pinned: options.pinned ?? false, height: -1, start: 0 };
		if (index === -1) this.entries.push(entry);
		else this.entries.splice(index, 0, entry);
		return entry;
	}

	insertBeforeEntry(
		reference: WindowedEntry,
		build: () => Component,
		options: WindowedAddOptions = {},
	): WindowedEntry {
		const entry: WindowedEntry = { build, pinned: options.pinned ?? false, height: -1, start: 0 };
		const index = this.entries.indexOf(reference);
		if (index === -1) this.entries.push(entry);
		else this.entries.splice(index, 0, entry);
		return entry;
	}

	entryOf(component: Component): WindowedEntry | undefined {
		return this.entries.find((entry) => entry.component === component);
	}

	removeEntry(entry: WindowedEntry): void {
		const index = this.entries.indexOf(entry);
		if (index === -1) return;
		if (entry.component) disposeComponent(entry.component);
		this.entries.splice(index, 1);
	}

	override addChild(component: Component): void {
		this.appendComponent(component);
	}

	override removeChild(component: Component): void {
		const entry = this.entryOf(component);
		if (entry) {
			this.removeEntry(entry);
			return;
		}
		const index = this.children.indexOf(component);
		if (index !== -1) this.children.splice(index, 1);
	}

	override clear(): void {
		for (const entry of this.entries) {
			if (entry.component) disposeComponent(entry.component);
		}
		this.entries.length = 0;
		this.children = [];
		this.contentHeight = 0;
	}

	override invalidate(): void {
		for (const entry of this.entries) {
			entry.lines = undefined;
			entry.height = -1;
			entry.component?.invalidate?.();
		}
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth !== this.measuredWidth) {
			this.measuredWidth = safeWidth;
			for (const entry of this.entries) {
				entry.lines = undefined;
				entry.height = -1;
			}
		}

		// Positions from the previous frame decide what to build, so evicted entries are not rebuilt just to measure.
		const window = this.contentHeight > 0 ? this.visibleWindow(this.contentHeight) : undefined;
		const retainLines =
			typeof this.retainLinesOption === "function" ? this.retainLinesOption() : this.retainLinesOption;
		const lines: string[] = [];
		for (const entry of this.entries) {
			const inside =
				!window ||
				entry.pinned ||
				entry.height < 0 ||
				(entry.start + entry.height > window.from && entry.start < window.to);
			const start = lines.length;
			if (inside) {
				entry.component ??= entry.build();
				const entryLines = entry.component.render(safeWidth);
				if (retainLines) entry.lines = entryLines;
				for (const line of entryLines) lines.push(line);
			} else if (entry.lines) {
				for (const line of entry.lines) lines.push(line);
			} else {
				// Alternate-screen renderers clip the buffer, so a released entry only has to keep its height.
				for (let index = 0; index < entry.height; index++) lines.push("");
			}
			entry.start = start;
			entry.height = lines.length - start;
		}
		this.contentHeight = lines.length;
		this.evictOutsideWindow();

		const live: Component[] = [];
		for (const entry of this.entries) {
			if (entry.component) live.push(entry.component);
		}
		this.children = live;
		return lines;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const entry = this.entryAtLine(event.y, event.width);
		if (!entry?.component) return undefined;
		const y = event.y - entry.start;
		// Materialized entries can still be shorter than the measured window when a rebuild changed its height.
		const height = entry.component.render(event.width).length;
		if (y >= height) return undefined;
		const result = dispatchMouseEvent(entry.component, { ...event, y, height });
		if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
		return result;
	}

	private entryAtLine(line: number, width: number): WindowedEntry | undefined {
		if (this.measuredWidth !== Math.max(1, Math.floor(width)) || this.contentHeight <= 0) this.render(width);
		for (const entry of this.entries) {
			if (entry.height >= 0 && line >= entry.start && line < entry.start + entry.height) return entry;
		}
		return undefined;
	}

	private indexOfEntry(component: Component): number {
		return this.entries.findIndex((entry) => entry.component === component);
	}

	private evictOutsideWindow(): void {
		if (this.contentHeight < 0) return;
		const window = this.visibleWindow(this.contentHeight);
		if (!window) return;
		for (const entry of this.entries) {
			if (!entry.component || entry.pinned) continue;
			const end = entry.start + entry.height;
			if (end > window.from && entry.start < window.to) continue;
			const component = entry.component;
			entry.component = undefined;
			this.onEvictOption?.(component, entry);
			disposeComponent(component);
		}
	}

	private visibleWindow(total: number): { from: number; to: number } | undefined {
		const pad = (height: number) => height * this.overscan;
		const viewport = this.getViewportOption?.();
		if (viewport && viewport.height > 0) {
			return {
				from: viewport.top - pad(viewport.height),
				to: viewport.top + viewport.height + pad(viewport.height),
			};
		}
		if (this.windowFromEnd) {
			const rows = this.getViewportLinesOption?.() ?? 0;
			if (rows <= 0) return undefined;
			return { from: total - rows - pad(rows), to: total + pad(rows) };
		}
		return undefined;
	}
}
