/**
 * Pi: Inbox replies to a handed-off session never arrive (#3539). A session that hands its work
 * to a new session (`ctx.newSession({ parentSession })`) leaves its replies waiting on the old
 * id, which polls no more. The new session's Pi extension wakes for the ancestors no live Pi
 * claims, so their replies land here too, and the deliveries share the one `waiting` slot in
 * order. The failures this catches: no ancestor wake at all, a wake for a session a live Pi
 * still claims, a wake that stops touching or disposing with the main one, and a second
 * delivery overwriting the first's wait (whose promise then never resolves and whose wake never
 * delivers again).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxLeaseFileOf } from "./generated/inbox/agent-link.ts";
import { readPiSessionClaims, writePiSessionClaim } from "./generated/inbox/pi-session-claim.ts";
import { readPiSessionHeader, resolveHandoffAncestors, setupPiInbox } from "./inbox.ts";
import { setPiHost } from "./pi-host.ts";
import {
	createInboxWorld,
	destroyInboxWorld,
	personSends,
	QUESTION,
	removeStubbedHtml,
	startInbox,
	stubBuiltHtml,
	waitFor,
	type InboxWorld,
} from "../../tests/helpers/inbox-world.ts";

const saved = { ...process.env };
const cleanup: (() => void)[] = [];
afterEach(() => {
	setPiHost("pi");
	for (const undo of cleanup.splice(0)) undo();
	for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A Pi session file whose header (line 1) is `header`, followed by one body line. */
function writeSessionFile(dir: string, name: string, header: Record<string, unknown>): string {
	const file = join(dir, name);
	writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message","role":"user","content":"hi"}\n`);
	return file;
}

describe("readPiSessionHeader", () => {
	test("reads the id and parentSession from the first line only", () => {
		const dir = tempDir("plannotator-pi-handoff-header-");
		const file = writeSessionFile(dir, "s.jsonl", { id: "s-1", parentSession: "/tmp/old.jsonl", type: "session" });
		expect(readPiSessionHeader(file)).toEqual({ id: "s-1", parentSession: "/tmp/old.jsonl" });
	});

	test("null for a missing file, an empty file, and a first line that is not a header", () => {
		const dir = tempDir("plannotator-pi-handoff-header-");
		expect(readPiSessionHeader(join(dir, "gone.jsonl"))).toBeNull();
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(readPiSessionHeader(empty)).toBeNull();
		const junk = join(dir, "junk.jsonl");
		writeFileSync(junk, "not json\n{\"id\":\"s-1\"}\n");
		expect(readPiSessionHeader(junk)).toBeNull();
	});
});

describe("resolveHandoffAncestors", () => {
	test("no parentSession, no ancestors", () => {
		const dir = tempDir("plannotator-pi-handoff-chain-");
		const dataDir = tempDir("plannotator-pi-handoff-data-");
		const file = writeSessionFile(dir, "current.jsonl", { id: "current" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: file, dataDir })).toEqual([]);
		expect(resolveHandoffAncestors({ sessionId: "current", dataDir })).toEqual([]);
	});

	test("walks the chain nearest first, up to the limit, and resolves relative paths", () => {
		const dir = tempDir("plannotator-pi-handoff-chain-");
		const dataDir = tempDir("plannotator-pi-handoff-data-");
		writeSessionFile(dir, "third.jsonl", { id: "third" });
		writeSessionFile(dir, "second.jsonl", { id: "second", parentSession: "third.jsonl" });
		writeSessionFile(dir, "first.jsonl", { id: "first", parentSession: "second.jsonl" });
		const current = writeSessionFile(dir, "current.jsonl", { id: "current", parentSession: "first.jsonl" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir })).toEqual(["first", "second", "third"]);
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir, maxAncestors: 2 })).toEqual(["first", "second"]);
	});

	test("stops at the first ancestor a live Pi still claims, and never wakes for it", () => {
		const dir = tempDir("plannotator-pi-handoff-chain-");
		const dataDir = tempDir("plannotator-pi-handoff-data-");
		// pid 1 runs: a claim under it is a live Pi.
		writePiSessionClaim(dataDir, { session: "second", pid: 1, rpc: false, title: "pi", owner: "handoff-test" });
		expect(readPiSessionClaims(dataDir).map((claim) => claim.session)).toEqual(["second"]);
		const second = writeSessionFile(dir, "second.jsonl", { id: "second" });
		const first = writeSessionFile(dir, "first.jsonl", { id: "first", parentSession: "second.jsonl" });
		const current = writeSessionFile(dir, "current.jsonl", { id: "current", parentSession: "first.jsonl" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir })).toEqual(["first"]);
		// A claim on the nearest ancestor stops the walk at once.
		writePiSessionClaim(dataDir, { session: "first", pid: 1, rpc: false, title: "pi", owner: "handoff-test" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir })).toEqual([]);
	});

	test("this process's own claim never counts as a live claim", () => {
		const dir = tempDir("plannotator-pi-handoff-chain-");
		const dataDir = tempDir("plannotator-pi-handoff-data-");
		writePiSessionClaim(dataDir, { session: "first", pid: process.pid, rpc: false, title: "pi", owner: "handoff-test" });
		const first = writeSessionFile(dir, "first.jsonl", { id: "first" });
		const current = writeSessionFile(dir, "current.jsonl", { id: "current", parentSession: "first.jsonl" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir })).toEqual(["first"]);
	});

	test("stops at a loop, a missing file, and a header without an id", () => {
		const dir = tempDir("plannotator-pi-handoff-chain-");
		const dataDir = tempDir("plannotator-pi-handoff-data-");
		writeSessionFile(dir, "a.jsonl", { id: "a", parentSession: "b.jsonl" });
		writeSessionFile(dir, "b.jsonl", { id: "b", parentSession: "a.jsonl" });
		const current = writeSessionFile(dir, "current.jsonl", { id: "current", parentSession: "a.jsonl" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: current, dataDir })).toEqual(["a", "b"]);
		writeSessionFile(dir, "gone.jsonl", { id: "gone", parentSession: "nope.jsonl" });
		const currentMissing = writeSessionFile(dir, "current.jsonl", { id: "current", parentSession: "gone.jsonl" });
		expect(resolveHandoffAncestors({ sessionId: "current", sessionFile: currentMissing, dataDir })).toEqual(["gone"]);
	});
});

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const ends: (() => void)[] = [];

beforeAll(() => {
	stubs = stubBuiltHtml();
});
afterAll(() => {
	removeStubbedHtml(stubs);
});
afterEach(async () => {
	for (const end of ends.splice(0)) end();
	for (const w of worlds.splice(0)) await destroyInboxWorld(w);
});

/** A stand-in for Pi's ExtensionAPI and one session's context (as in inbox-send-now.test.ts). */
function fakePi(project: string, sessionFile: string) {
	const handlers = new Map<string, ((event: any, ctx?: any) => unknown)[]>();
	const sent: { text: string; deliverAs: string | undefined }[] = [];
	let tool: { execute: (...args: any[]) => Promise<{ content: { text: string }[] }> } | null = null;
	let idle = false;
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: project,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "pi-session-handoff",
			getSessionFile: () => sessionFile,
			getSessionName: () => null as string | null,
			getBranch: () => [],
		},
		ui: { notify: () => {} },
	};
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const pi = {
		on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (definition: never) => {
			tool = definition;
		},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			sent.push({ text, deliverAs: options?.deliverAs });
		},
	};
	return {
		pi,
		ctx,
		sent,
		emit,
		setIdle: (value: boolean) => {
			idle = value;
		},
		tool: () => tool!,
		/** The same context, but for the handed-off session (its send_message names that id). */
		ancestorCtx: {
			...ctx,
			sessionManager: { ...ctx.sessionManager, getSessionId: () => "pi-session-old" },
		},
	};
}

type HandoffWorld = {
	w: InboxWorld;
	fake: ReturnType<typeof fakePi>;
	currentFile: string;
};

function readLease(dataDir: string, sessionId: string): { owner: unknown; at: number; touchedAt: number } | null {
	try {
		return JSON.parse(readFileSync(inboxLeaseFileOf(dataDir, "pi", sessionId), "utf8")) as { owner: unknown; at: number; touchedAt: number };
	} catch {
		return null;
	}
}

/** A running Inbox under a temp data dir, with a handoff chain current → old → grand. */
async function startHandoffWorld(): Promise<HandoffWorld> {
	const w = createInboxWorld("plannotator-inbox-pi-handoff-", "pi-handoff", "pi");
	worlds.push(w);
	startInbox(w);
	mkdirSync(w.dataDir, { recursive: true });
	writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
	process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
	process.env.PLANNOTATOR_BIN = join(w.bin, "plannotator");
	const sessions = tempDir("plannotator-pi-handoff-sessions-");
	const grandFile = writeSessionFile(sessions, "grand.jsonl", { id: "pi-session-grand" });
	const oldFile = writeSessionFile(sessions, "old.jsonl", { id: "pi-session-old", parentSession: grandFile });
	const currentFile = writeSessionFile(sessions, "current.jsonl", { id: "pi-session-handoff", parentSession: oldFile });
	// The grand session is still running (pid 1): no wake for it.
	writePiSessionClaim(w.dataDir, { session: "pi-session-grand", pid: 1, rpc: false, title: "pi", owner: "handoff-test" });
	const fake = fakePi(w.project, currentFile);
	await setupPiInbox(fake.pi as never, { isAskActive: () => false });
	fake.emit("session_start", {});
	ends.push(() => fake.emit("session_shutdown", {}));
	return { w, fake, currentFile };
}

describe.skipIf(process.platform === "win32")("Pi: the handed-off session's replies", () => {
	test("session_start wakes the unclaimed ancestors, none for the live one; input touches them, shutdown releases them", async () => {
		const { w, fake } = await startHandoffWorld();
		// The current session and its handed-off predecessor are woken; the live grand session is not.
		expect(readLease(w.dataDir, "pi-session-handoff")?.owner).toBeTruthy();
		expect(readLease(w.dataDir, "pi-session-old")?.owner).toBeTruthy();
		expect(existsSync(inboxLeaseFileOf(w.dataDir, "pi", "pi-session-grand"))).toBe(false);
		expect(readPiSessionClaims(w.dataDir).map((claim) => claim.session)).toContain("pi-session-handoff");
		// Input in this process touches the ancestor wake too: its lease is re-taken.
		writeFileSync(inboxLeaseFileOf(w.dataDir, "pi", "pi-session-old"), JSON.stringify({ owner: null, at: 0, touchedAt: 0 }));
		fake.emit("input", { source: "user" });
		expect(readLease(w.dataDir, "pi-session-old")?.owner).toBeTruthy();
		// Shutdown disposes the ancestor wakes with the main one: their leases are released.
		fake.emit("session_shutdown", {});
		expect(readLease(w.dataDir, "pi-session-handoff")?.owner).toBeNull();
		expect(readLease(w.dataDir, "pi-session-old")?.owner).toBeNull();
	}, 60_000);

	test("both replies arrive, one after the other, and neither wake gets stuck", async () => {
		const { w, fake } = await startHandoffWorld();
		fake.setIdle(true);
		const current = await fake.tool().execute("call-1", { action: "send_message", body: QUESTION }, undefined, undefined, fake.ctx);
		const askedCurrent = JSON.parse(current.content[0]!.text.slice(current.content[0]!.text.indexOf("{"))) as { message_id: string; thread_id: string };
		const ancestor = await fake.tool().execute("call-2", { action: "send_message", body: QUESTION }, undefined, undefined, fake.ancestorCtx);
		const askedAncestor = JSON.parse(ancestor.content[0]!.text.slice(ancestor.content[0]!.text.indexOf("{"))) as { message_id: string; thread_id: string };
		const replyCurrent = await personSends(w, askedCurrent.message_id, "Retry with the same key.");
		const replyAncestor = await personSends(w, askedAncestor.message_id, "Use the other key.");
		// The second delivery waits for the first to settle: only one is in flight at a time.
		const first = await waitFor("the first delivery", () => fake.sent[0]);
		expect(fake.sent).toHaveLength(1);
		fake.emit("message_start", { message: { role: "user", content: first.text } });
		const second = await waitFor("the second delivery", () => fake.sent[1]);
		fake.emit("message_start", { message: { role: "user", content: second.text } });
		const deliveredIds = [first.text, second.text].map((text) => text.split("\n", 1)[0]);
		expect(deliveredIds.some((line) => line.endsWith(`(${replyCurrent})`))).toBe(true);
		expect(deliveredIds.some((line) => line.endsWith(`(${replyAncestor})`))).toBe(true);
		// A further reply to the session that was delivered first still arrives: its wake is not stuck.
		// (personSends dedupes on `window-<messageId>-<words.length>`, so this reply's length must
		// differ from the first reply to the same message, or the Inbox returns the old reply.)
		const firstSession = first.text.includes("Retry with the same key.") ? askedCurrent : askedAncestor;
		const replyAgain = await personSends(w, firstSession.message_id, "Once more, with the same key, please.");
		const third = await waitFor("the follow-up delivery", () => fake.sent[2]);
		expect(third.text.split("\n", 1)[0]!.endsWith(`(${replyAgain})`)).toBe(true);
		fake.emit("message_start", { message: { role: "user", content: third.text } });
	}, 60_000);
});
