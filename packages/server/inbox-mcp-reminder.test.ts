/**
 * The Inbox reminder (Prompts → Inbox) over MCP (#3555): a session that
 * reaches the Inbox only through the MCP server never sees the person's
 * rules and reminder — the server's built-in instructions are static, and
 * at 2,007 of Claude Code's 2,048 characters they have no room for them.
 * So the reminder rides on the session's next tool result, once, the way a
 * terminal session gets it once at session start (resolveInboxReminderText).
 * The failures these guard: a session that never gets the rules (T3 Code,
 * which only connects over MCP); the reminder on every result instead of
 * once; a delivery consumed by an error result or by the connection's own
 * list call, so the agent never sees it; a reminder when the person set
 * neither text or turned it off.
 *
 * A real store in a temp dir and send_message's own handler; no Inbox
 * server, no network. The reminder itself is a stub here: the composition
 * (per-host texts, the shared fallback, the on/off switch) is the
 * production accessor's job, tested where it lives.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PEEK_META_KEY } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The person's rules and reminder, as the accessor would compose them. */
const REMINDER = "The person's rules for how you use the Plannotator Inbox: always confirm before sending.";

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function world(options: { reminder?: (host: string | undefined, wakes: boolean) => string | null; withReminder?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reminder-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const delivered = new Set<string>();
  const calls: { host: string | undefined; wakes: boolean }[] = [];
  const context = {
    store,
    baseUrl: () => "http://localhost:1/",
    resolveProject: async () => project,
    ...(options.withReminder === false
      ? {}
      : {
          inboxReminder: options.reminder ??
            ((host, wakes) => {
              calls.push({ host, wakes });
              return REMINDER;
            }),
          inboxReminderDelivered: delivered,
        }),
  } as unknown as InboxMcpContext;
  const server = createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> }> };
  const send = async (session: string, input: Record<string, unknown>, ctx: unknown = {}) => {
    const result = await server._registeredTools.send_message!.handler({ project_path: project.root, agent_session: session, ...input }, ctx);
    return { result, text: result.content[0]!.text };
  };
  return { send, delivered, calls };
}

test("an MCP session gets the reminder once, at the end of its first tool result", async () => {
  const w = world();
  const first = await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." });
  expect(first.result.isError).toBeUndefined();
  expect(first.text.endsWith(REMINDER)).toBe(true);
  expect(w.calls).toEqual([{ host: "t3", wakes: false }]);
  expect(w.delivered).toEqual(new Set(["ses_a"]));
  const second = await w.send("ses_a", { agent_host: "t3", body: "And another." });
  expect(second.text).not.toContain(REMINDER);
  expect(w.calls).toHaveLength(1);
});

test("a second session gets it too, and no host falls back to the shared texts", async () => {
  const w = world();
  await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." });
  const other = await w.send("ses_b", { body: "Hello from another session." });
  expect(other.text.endsWith(REMINDER)).toBe(true);
  expect(w.calls[1]).toEqual({ host: undefined, wakes: false });
  expect(w.delivered).toEqual(new Set(["ses_a", "ses_b"]));
});

test("nothing when the person set neither text, and the delivery is not consumed", async () => {
  let text: string | null = null;
  const w = world({ reminder: () => text });
  const first = await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." });
  expect(first.text).not.toContain(REMINDER);
  expect(w.delivered).toEqual(new Set());
  text = REMINDER;
  const second = await w.send("ses_a", { agent_host: "t3", body: "And another." });
  expect(second.text.endsWith(REMINDER)).toBe(true);
  expect(w.delivered).toEqual(new Set(["ses_a"]));
});

test("nothing when the context carries no reminder", async () => {
  const w = world({ withReminder: false });
  const sent = await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." });
  expect(sent.result.isError).toBeUndefined();
  expect(sent.text).not.toContain(REMINDER);
});

test("never on an error result, and the error does not consume the delivery", async () => {
  const w = world();
  const refused = await w.send("ses_a", { agent_host: "t3", body: "" });
  expect(refused.result.isError).toBe(true);
  expect(refused.text).not.toContain(REMINDER);
  expect(w.delivered).toEqual(new Set());
  expect(w.calls).toHaveLength(0);
  const sent = await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." });
  expect(sent.text.endsWith(REMINDER)).toBe(true);
});

test("a connection's own list call never consumes the delivery", async () => {
  const w = world();
  const peek = await w.send("ses_a", { agent_host: "t3", body: "Hello from the agent." }, { mcpReq: { _meta: { [INBOX_PEEK_META_KEY]: true } } });
  expect(peek.result.isError).toBeUndefined();
  expect(peek.text).not.toContain(REMINDER);
  expect(w.delivered).toEqual(new Set());
  expect(w.calls).toHaveLength(0);
  const sent = await w.send("ses_a", { agent_host: "t3", body: "And another." });
  expect(sent.text.endsWith(REMINDER)).toBe(true);
});
