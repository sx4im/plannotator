/**
 * Handed-off Pi sessions (#3539): when a session hands its work to a new
 * one (`ctx.newSession({ parentSession })`), replies to the old session never
 * arrive — the old session is gone. A session start walks the `parentSession`
 * chain in the session files' headers and starts one extra `InboxWake` per
 * gone ancestor, into the new session. The failures this catches: a chain
 * that is never walked, a walk that does not stop at a still-running
 * predecessor, and two deliveries racing on the one `waiting` slot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDeliveryQueue,
	findHandoffAncestors,
	parseSessionHeaderLine,
	readSessionHeaderFile,
	setupPiInbox,
} from "./inbox.ts";

const saved = { ...process.env };
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const undo of cleanup.splice(0)) undo();
	for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A session file with the given header, in `dir`. */
function sessionFile(dir: string, name: string, header: Record<string, unknown>): string {
	const file = join(dir, name);
	writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message","id":"m1"}\n`);
	return file;
}

describe("parseSessionHeaderLine", () => {
	test("reads id and parentSession from a session header", () => {
		expect(parseSessionHeaderLine('{"type":"session","id":"ses-a","parentSession":"/tmp/old.jsonl"}')).toEqual({
			id: "ses-a",
			parentSession: "/tmp/old.jsonl",
		});
	});

	test("a header without a parent has no parentSession", () => {
		expect(parseSessionHeaderLine('{"type":"session","id":"ses-a"}')).toEqual({ id: "ses-a" });
	});

	test("anything that is not a session header is null", () => {
		expect(parseSessionHeaderLine('{"type":"message","id":"m1"}')).toBeNull();
		expect(parseSessionHeaderLine('{"type":"session"}')).toBeNull();
		expect(parseSessionHeaderLine("not json")).toBeNull();
		expect(parseSessionHeaderLine("")).toBeNull();
	});
});

describe("readSessionHeaderFile", () => {
	test("reads the first line of a session file", () => {
		const dir = tempDir("plannotator-pi-handoff-header-");
		const file = sessionFile(dir, "s.jsonl", { type: "session", id: "ses-a", parentSession: "/tmp/old.jsonl" });
		expect(readSessionHeaderFile(file)).toEqual({ id: "ses-a", parentSession: "/tmp/old.jsonl" });
	});

	test("a missing file, or a file whose first line is not a header, is null", () => {
		const dir = tempDir("plannotator-pi-handoff-header-");
		expect(readSessionHeaderFile(join(dir, "nope.jsonl"))).toBeNull();
		const file = join(dir, "m.jsonl");
		writeFileSync(file, '{"type":"message","id":"m1"}\n');
		expect(readSessionHeaderFile(file)).toBeNull();
	});
});

describe("findHandoffAncestors", () => {
	test("walks the chain nearest first, and stops where the chain ends", () => {
		const dir = tempDir("plannotator-pi-handoff-walk-");
		const a = sessionFile(dir, "a.jsonl", { type: "session", id: "ses-a" });
		const b = sessionFile(dir, "b.jsonl", { type: "session", id: "ses-b", parentSession: a });
		const c = sessionFile(dir, "c.jsonl", { type: "session", id: "ses-c", parentSession: b });
		expect(findHandoffAncestors(c, () => false)).toEqual(["ses-b", "ses-a"]);
	});

	test("stops at the first ancestor a live Pi still claims, without waking it", () => {
		const dir = tempDir("plannotator-pi-handoff-walk-");
		const a = sessionFile(dir, "a.jsonl", { type: "session", id: "ses-a" });
		const b = sessionFile(dir, "b.jsonl", { type: "session", id: "ses-b", parentSession: a });
		const c = sessionFile(dir, "c.jsonl", { type: "session", id: "ses-c", parentSession: b });
		expect(findHandoffAncestors(c, (id) => id === "ses-b")).toEqual([]);
		expect(findHandoffAncestors(c, (id) => id === "ses-a")).toEqual(["ses-b"]);
	});

	test("a relative parentSession resolves against the session file's folder", () => {
		const dir = tempDir("plannotator-pi-handoff-walk-");
		sessionFile(dir, "a.jsonl", { type: "session", id: "ses-a" });
		const c = sessionFile(dir, "c.jsonl", { type: "session", id: "ses-c", parentSession: "a.jsonl" });
		expect(findHandoffAncestors(c, () => false)).toEqual(["ses-a"]);
	});

	test("a cycle, a missing parent file, and the level cap all end the walk", () => {
		const dir = tempDir("plannotator-pi-handoff-walk-");
		const a = sessionFile(dir, "a.jsonl", { type: "session", id: "ses-a", parentSession: "b.jsonl" });
		const b = sessionFile(dir, "b.jsonl", { type: "session", id: "ses-b", parentSession: "a.jsonl" });
		expect(findHandoffAncestors(b, () => false)).toEqual(["ses-a"]);
		const c = sessionFile(dir, "c.jsonl", { type: "session", id: "ses-c", parentSession: join(dir, "gone.jsonl") });
		expect(findHandoffAncestors(c, () => false)).toEqual([]);
		const files: string[] = [];
		for (let i = 0; i < 7; i++) {
			files.push(sessionFile(dir, `s${i}.jsonl`, { type: "session", id: `ses-${i}`, parentSession: i === 0 ? undefined : join(dir, `s${i - 1}.jsonl`) }));
		}
		expect(findHandoffAncestors(files[6]!, () => false, readSessionHeaderFile, 2)).toEqual(["ses-5", "ses-4"]);
	});
});

describe("createDeliveryQueue", () => {
	test("runs tasks one at a time, in order", async () => {
		const enqueue = createDeliveryQueue();
		const seen: string[] = [];
		const first = enqueue(async () => {
			seen.push("first-start");
			await new Promise((resolve) => setTimeout(resolve, 10));
			seen.push("first-end");
			return "first";
		});
		const second = enqueue(async () => {
			seen.push("second-start");
			return "second";
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen).toEqual(["first-start"]);
		expect(await first).toBe("first");
		expect(await second).toBe("second");
		expect(seen).toEqual(["first-start", "first-end", "second-start"]);
	});

	test("a rejection does not block the queue", async () => {
		const enqueue = createDeliveryQueue();
		await expect(enqueue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(await enqueue(async () => "ok")).toBe("ok");
	});
});

/** A stand-in for Pi's ExtensionAPI, whose session file the test sets per session. */
function fakePi() {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	let sessionId = "";
	let sessionFile: string | undefined;
	const files = new Map<string, string>();
	const ctx = {
		hasUI: true,
		mode: "interactive",
		cwd: "/tmp",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getSessionName: () => undefined,
			getBranch: () => [],
		},
	};
	return {
		pi: {
			on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerTool: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
		},
		setFile(id: string, file: string) {
			files.set(id, file);
		},
		start(id: string) {
			sessionId = id;
			sessionFile = files.get(id);
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		},
		input() {
			for (const handler of handlers.get("input") ?? []) handler({ source: "user" }, ctx);
		},
		shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
		},
	};
}

function dataDirWithInboxTools(): string {
	const dataDir = tempDir("plannotator-pi-handoff-");
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
	writeFileSync(
		join(dataDir, "inbox", "connection-tools.json"),
		JSON.stringify({ tools: [{ name: "send_message", description: "Send a message", inputSchema: { type: "object", properties: {} } }] }),
	);
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_INBOX_TOOL = "1";
	return dataDir;
}

function leaseSessions(dataDir: string): string[] {
	const dir = join(dataDir, "inbox", "leases");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name: string) => name.endsWith(".json"))
		.map((name: string) => name.replace(/^pi-/, "").replace(/\.json$/, ""));
}

function leaseOwner(dataDir: string, sessionId: string): string | null {
	try {
		const value = JSON.parse(readFileSync(join(dataDir, "inbox", "leases", `pi-${sessionId}.json`), "utf8")) as { owner?: unknown };
		return typeof value.owner === "string" ? value.owner : null;
	} catch {
		return null;
	}
}

describe("ancestor wakes on session start", () => {
	test("a handed-off session wakes its gone ancestors, into this session", async () => {
		const dataDir = dataDirWithInboxTools();
		const sessions = tempDir("plannotator-pi-handoff-sessions-");
		const a = sessionFile(sessions, "a.jsonl", { type: "session", id: "ses-a" });
		const b = sessionFile(sessions, "b.jsonl", { type: "session", id: "ses-b", parentSession: a });
		const c = sessionFile(sessions, "c.jsonl", { type: "session", id: "ses-c", parentSession: b });
		const one = fakePi();
		one.setFile("ses-c", c);
		await setupPiInbox(one.pi as never, { isAskActive: () => false });
		one.start("ses-c");
		expect(leaseSessions(dataDir).sort()).toEqual(["ses-a", "ses-b", "ses-c"]);
		one.shutdown();
		expect(leaseOwner(dataDir, "ses-b")).toBeNull();
		expect(leaseOwner(dataDir, "ses-a")).toBeNull();
	});

	test("the walk stops at a predecessor a live Pi still claims", async () => {
		const dataDir = dataDirWithInboxTools();
		const sessions = tempDir("plannotator-pi-handoff-sessions-");
		const a = sessionFile(sessions, "a.jsonl", { type: "session", id: "ses-a" });
		const b = sessionFile(sessions, "b.jsonl", { type: "session", id: "ses-b", parentSession: a });
		const c = sessionFile(sessions, "c.jsonl", { type: "session", id: "ses-c", parentSession: b });
		mkdirSync(join(dataDir, "inbox", "pi-sessions"), { recursive: true });
		writeFileSync(
			join(dataDir, "inbox", "pi-sessions", "ses-b.1.json"),
			JSON.stringify({ session: "ses-b", pid: 1, rpc: false, title: "pi", owner: "other" }),
		);
		const one = fakePi();
		one.setFile("ses-c", c);
		await setupPiInbox(one.pi as never, { isAskActive: () => false });
		one.start("ses-c");
		expect(leaseSessions(dataDir).sort()).toEqual(["ses-c"]);
		one.shutdown();
	});

	test("a session with no parent gets no ancestor wakes", async () => {
		const dataDir = dataDirWithInboxTools();
		const sessions = tempDir("plannotator-pi-handoff-sessions-");
		const c = sessionFile(sessions, "c.jsonl", { type: "session", id: "ses-c" });
		const one = fakePi();
		one.setFile("ses-c", c);
		await setupPiInbox(one.pi as never, { isAskActive: () => false });
		one.start("ses-c");
		expect(leaseSessions(dataDir).sort()).toEqual(["ses-c"]);
		one.shutdown();
	});

	test("a new session drops the old lineage's wakes", async () => {
		const dataDir = dataDirWithInboxTools();
		const sessions = tempDir("plannotator-pi-handoff-sessions-");
		const a = sessionFile(sessions, "a.jsonl", { type: "session", id: "ses-a" });
		const b = sessionFile(sessions, "b.jsonl", { type: "session", id: "ses-b", parentSession: a });
		const other = sessionFile(sessions, "other.jsonl", { type: "session", id: "ses-other" });
		const one = fakePi();
		one.setFile("ses-b", b);
		one.setFile("ses-other", other);
		await setupPiInbox(one.pi as never, { isAskActive: () => false });
		one.start("ses-b");
		expect(leaseSessions(dataDir).sort()).toEqual(["ses-a", "ses-b"]);
		one.start("ses-other");
		expect(leaseOwner(dataDir, "ses-a")).toBeNull();
		expect(leaseSessions(dataDir).sort()).toEqual(["ses-a", "ses-b", "ses-other"]);
		one.shutdown();
	});
});
