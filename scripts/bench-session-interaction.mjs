/**
 * Long-session scroll and interaction benchmark.
 *
 * Resumes a real session in the built coding agent (inside a throwaway tmux pty),
 * drives scrolling, mouse wheel, typing and the working indicator with keystrokes,
 * and samples the pi process from /proc: CPU time, RSS, and bytes written to the
 * terminal (`wchar`). Answers "does an interaction cost scale with the transcript
 * or with the viewport" on a session you actually use.
 *
 * Requirements: Linux (/proc), tmux, and a built tree (`npm run build`).
 *
 * Usage (this checkout):
 *   npm run bench:session -- --session ~/.pi/agent/sessions/<project>/<file>.jsonl
 *
 * A/B against another revision, for example the parent of the commit under test:
 *   git worktree add --detach /tmp/pi-base <rev>
 *   cd /tmp/pi-base && npm ci --ignore-scripts && npm run build
 *   node scripts/bench-session-interaction.mjs --session <file> \
 *     --tree /tmp/pi-base --compare-tree . --runs 3
 *
 * `--tree` is measured first, `--compare-tree` second; rounds interleave so host
 * noise hits both sides. Page up/down and wheel bursts return the transcript to
 * the tail, so every phase starts from the same place.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COLUMNS = 120;
const ROWS = 40;
const SUSTAINED_PAGES = 60;
const WHEEL_EVENTS = 100;
const TYPED_CHARS = 60;
const SPINNER_WINDOWS = 3;
const SPINNER_WINDOW_MS = 5000;
const WHEEL_UP = "\u001b[<64;30;20M";
const WHEEL_DOWN = "\u001b[<65;30;20M";
const KEY_GAP_MS = 80;
const WHEEL_GAP_MS = 25;
const TYPE_GAP_MS = 40;
const SETTLE_MS = 1200;
const TYPED_TEXT = "abcdefghij";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const socket = `pi-bench-${process.pid}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
	const options = { mode: "fullscreen", runs: 1, pages: 20, json: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		const value = argv[index + 1];
		if (!["--session", "--tree", "--compare-tree", "--mode", "--runs", "--pages"].includes(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (value === undefined) throw new Error(`Missing value for ${arg}`);
		index++;
		const key = arg.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (arg === "--runs" || arg === "--pages") options[key] = Number.parseInt(value, 10);
		else options[key] = value;
	}
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
		return;
	}
	requireLinux();
	requireTmux();
	if (!options.session) throw new Error("--session <path> is required");
	if (!fs.existsSync(options.session)) throw new Error(`session not found: ${options.session}`);
	if (options.mode !== "fullscreen" && options.mode !== "regular") throw new Error("--mode must be fullscreen or regular");

	const trees = [{ label: "tree", dir: resolve(options.tree ?? repoRoot) }];
	if (options.compareTree) trees.push({ label: "compare", dir: resolve(options.compareTree) });
	for (const tree of trees) {
		const cli = join(tree.dir, "packages", "coding-agent", "dist", "cli.js");
		if (!fs.existsSync(cli)) throw new Error(`built CLI not found: ${cli} (run npm run build)`);
		tree.cli = cli;
	}

	const rounds = [];
	for (let run = 0; run < options.runs; run++) {
		for (const tree of trees) rounds.push(await measureTree(tree, options, run));
	}

	if (options.json) {
		process.stdout.write(`${JSON.stringify({ mode: options.mode, session: resolve(options.session), rounds }, null, 2)}\n`);
		return;
	}
	const summary = sanitizeRounds(rounds, trees);
	for (const tree of trees) printTable(`${tree.label} (${tree.dir})`, summary[tree.label]);
	if (trees.length === 2) printDelta(trees[0], trees[1], medianMetrics(summary[trees[0].label]), medianMetrics(summary[trees[1].label]));
}

function requireLinux() {
	if (process.platform !== "linux") throw new Error("this benchmark needs Linux /proc; it does not run on this platform");
}

function requireTmux() {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
	} catch {
		throw new Error("tmux is required: the benchmark drives the TUI through a throwaway tmux server");
	}
}

function tmux(...args) {
	return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
}

function tmuxQuiet(...args) {
	try {
		return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function killServer() {
	tmuxQuiet("kill-server");
}

function sample(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
		const kilo = (key) => {
			const match = status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
			return match ? Number(match[1]) : 0;
		};
		const wchar = fs.readFileSync(`/proc/${pid}/io`, "utf8").match(/^wchar:\s+(\d+)/m);
		return {
			cpuSec: (Number(fields[11]) + Number(fields[12])) / 100,
			rssMb: kilo("VmRSS") / 1024,
			peakMb: kilo("VmHWM") / 1024,
			bytes: wchar ? Number(wchar[1]) : 0,
			at: Date.now(),
		};
	} catch {
		return undefined;
	}
}

/** Waits until the transcript has painted and the process has gone quiet, so load time is real paint time. */
async function waitForReady(pid, startedAt) {
	let previous = sample(pid);
	const deadline = startedAt + 300_000;
	while (Date.now() < deadline) {
		await sleep(200);
		const current = sample(pid);
		if (!current) throw new Error("pi exited before the TUI became ready");
		const rate = (current.cpuSec - (previous?.cpuSec ?? current.cpuSec)) / ((current.at - (previous?.at ?? current.at)) / 1000);
		const painted = tmuxQuiet("capture-pane", "-p", "-t", "bench").trim().length > 0;
		if (!painted || Date.now() - startedAt < 3000 || rate >= 0.05) {
			previous = current;
			continue;
		}
		await sleep(800);
		const settled = sample(pid);
		if (settled && (settled.cpuSec - current.cpuSec) / ((settled.at - current.at) / 1000) < 0.08) return settled;
		previous = settled ?? current;
	}
	throw new Error("timed out waiting for the TUI to become idle");
}

async function sendKeys(keys, gapMs) {
	for (const key of keys) {
		if (key.startsWith("\u001b")) tmux("send-keys", "-t", "bench", "-l", key);
		else tmux("send-keys", "-t", "bench", key);
		await sleep(gapMs);
	}
}

/** CPU and bytes for a burst of interactions, normalised per event. */
async function burst(pid, keys, gapMs) {
	const before = sample(pid);
	await sendKeys(keys, gapMs);
	await sleep(SETTLE_MS);
	const after = sample(pid);
	const cpuSec = after.cpuSec - before.cpuSec;
	const bytes = Math.max(0, after.bytes - before.bytes);
	return {
		events: keys.length,
		cpuSec: round(cpuSec, 3),
		cpuMsPerEvent: round((cpuSec * 1000) / keys.length, 2),
		bytes,
		bytesPerEvent: Math.round(bytes / keys.length),
	};
}

async function window(pid, durationMs) {
	const before = sample(pid);
	await sleep(durationMs);
	const after = sample(pid);
	const cpuSec = after.cpuSec - before.cpuSec;
	return {
		cpuSec: round(cpuSec, 3),
		corePct: round((cpuSec / (durationMs / 1000)) * 100, 1),
		bytes: Math.max(0, after.bytes - before.bytes),
		rssMb: round(after.rssMb, 1),
	};
}

async function measureTree(tree, options, run) {
	killServer();
	const command = [
		"exec env",
		"PI_OFFLINE=1",
		"PI_SKIP_VERSION_CHECK=1",
		`node ${JSON.stringify(tree.cli)}`,
		"--no-extensions",
		"--session",
		JSON.stringify(resolve(options.session)),
		"--tui-mode",
		options.mode,
	].join(" ");
	const startedAt = Date.now();
	tmux("new-session", "-d", "-s", "bench", "-x", String(COLUMNS), "-y", String(ROWS), command);
	tmux("set-option", "-g", "window-size", "manual");
	const pid = Number(tmuxQuiet("list-panes", "-t", "bench", "-F", "#{pane_pid}").trim());
	try {
		const ready = await waitForReady(pid, startedAt);
		const painted = tmuxQuiet("capture-pane", "-p", "-t", "bench").split("\n").filter((line) => line.trim()).length;

		// Warm the scroll path once so the first measured page is not a cold materialization.
		await burst(pid, Array(3).fill("PPage"), 60);
		await burst(pid, Array(3).fill("NPage"), 60);

		const pages = Array(options.pages).fill("PPage");
		const pageUp = await burst(pid, pages, KEY_GAP_MS);
		const pageDown = await burst(pid, Array(options.pages).fill("NPage"), KEY_GAP_MS);
		const sustained = await burst(pid, Array(SUSTAINED_PAGES).fill("PPage"), 40);
		await burst(pid, Array(SUSTAINED_PAGES).fill("NPage"), 40);
		const wheelUp = await burst(pid, Array(WHEEL_EVENTS).fill(WHEEL_UP), WHEEL_GAP_MS);
		const wheelDown = await burst(pid, Array(WHEEL_EVENTS).fill(WHEEL_DOWN), WHEEL_GAP_MS);
		const typing = await burst(
			pid,
			Array.from({ length: TYPED_CHARS }, (_, index) => TYPED_TEXT[index % TYPED_TEXT.length]),
			TYPE_GAP_MS,
		);
		await burst(pid, Array(TYPED_CHARS + 4).fill("BSpace"), 25);

		// Working indicator: a bash execution keeps the spinner rendering.
		tmux("send-keys", "-t", "bench", "-l", `!sleep ${(SPINNER_WINDOWS * SPINNER_WINDOW_MS) / 1000 + 4}`);
		tmux("send-keys", "-t", "bench", "Enter");
		await sleep(1500);
		const spinner = [];
		for (let index = 0; index < SPINNER_WINDOWS; index++) spinner.push(await window(pid, SPINNER_WINDOW_MS));

		const final = sample(pid);
		return {
			label: tree.label,
			dir: tree.dir,
			run,
			load: {
				wallMs: ready.at - startedAt,
				cpuSec: round(ready.cpuSec, 3),
				rssMb: round(ready.rssMb, 1),
				bytes: ready.bytes,
				paintedRows: painted,
			},
			pageUp,
			pageDown,
			sustained,
			wheelUp,
			wheelDown,
			typing,
			spinner,
			totals: {
				cpuSec: round(final.cpuSec - ready.cpuSec, 3),
				rssMb: round(final.rssMb, 1),
				peakMb: round(final.peakMb, 1),
			},
		};
	} finally {
		killServer();
	}
}

function round(value, digits) {
	return Number(value.toFixed(digits));
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const metrics = [
	{ label: "cold load wall (s)", pick: (round) => round.load.wallMs / 1000 },
	{ label: "cold load CPU (s)", pick: (round) => round.load.cpuSec },
	{ label: "cold load RSS (MB)", pick: (round) => round.load.rssMb },
	{ label: "page-up CPU / key (ms)", pick: (round) => round.pageUp.cpuMsPerEvent },
	{ label: "page-down CPU / key (ms)", pick: (round) => round.pageDown.cpuMsPerEvent },
	{ label: "sustained scroll CPU / key (ms)", pick: (round) => round.sustained.cpuMsPerEvent },
	{ label: "mouse-wheel CPU / event (ms)", pick: (round) => round.wheelUp.cpuMsPerEvent },
	{ label: "typing CPU / keystroke (ms)", pick: (round) => round.typing.cpuMsPerEvent },
	{ label: "spinner CPU (% of one core)", pick: (round) => median(round.spinner.slice(1).map((item) => item.corePct)) },
	{ label: "RSS after interaction (MB)", pick: (round) => round.totals.rssMb },
	{ label: "peak RSS (MB)", pick: (round) => round.totals.peakMb },
];

function sanitizeRounds(rounds, trees) {
	const summary = {};
	for (const tree of trees) summary[tree.label] = rounds.filter((round) => round.label === tree.label);
	return summary;
}

function medianMetrics(rounds) {
	return metrics.map((metric) => ({ label: metric.label, value: median(rounds.map((round) => metric.pick(round))) }));
}

function printTable(title, rounds) {
	const width = Math.max(...metrics.map((metric) => metric.label.length));
	const values = metrics.map((metric) => median(rounds.map((round) => metric.pick(round))));
	process.stdout.write(`\n${title}  (${rounds.length} run${rounds.length === 1 ? "" : "s"})\n`);
	metrics.forEach((metric, index) => {
		process.stdout.write(`  ${metric.label.padEnd(width)}  ${format(values[index])}\n`);
	});
}

function printDelta(baseTree, compareTree, base, compare) {
	const width = Math.max(...base.map((metric) => metric.label.length));
	process.stdout.write(`\n${compareTree.label} relative to ${baseTree.label} (negative is cheaper than ${baseTree.label})\n`);
	base.forEach((metric, index) => {
		const left = metric.value;
		const right = compare[index].value;
		const percent = left === 0 ? "n/a" : `${(((right - left) / left) * 100).toFixed(0)}%`;
		process.stdout.write(`  ${metric.label.padEnd(width)}  ${format(left)}  ${format(right)}  ${percent}\n`);
	});
}

function format(value) {
	if (value === undefined) return "n/a";
	return Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("en-US") : value.toFixed(2);
}

main().catch((error) => {
	killServer();
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
