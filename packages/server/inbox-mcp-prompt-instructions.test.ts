/**
 * The person's own Inbox texts (Settings → Prompts → Inbox, the shared slot)
 * reach an MCP-connected session through the server instructions, when they
 * fit under the 2,048-character cap; without them the instructions are the
 * base text, byte for byte. No Inbox is started: the MCP server is built,
 * never served.
 */
import { describe, expect, test } from "bun:test";
import {
  INBOX_MCP_INSTRUCTIONS,
  INBOX_MCP_INSTRUCTIONS_MAX_CHARS,
  createInboxMcpServer,
  inboxMcpInstructions,
  resolveInboxMcpPromptText,
  type InboxMcpContext,
} from "./inbox-mcp";

const RULES = "Never send proactive updates.";
const REMINDER = "Custom reminder.";

type ServerWithInstructions = { server: { _instructions: string } };

function serverInstructions(promptText: () => string | null): string {
  const server = createInboxMcpServer({
    codeReviewOn: () => false,
    inboxPromptText: promptText,
  } as unknown as InboxMcpContext);
  return (server as unknown as ServerWithInstructions).server._instructions;
}

describe("resolveInboxMcpPromptText", () => {
  test("nothing set reads as unset", () => {
    expect(resolveInboxMcpPromptText({})).toBeNull();
    expect(resolveInboxMcpPromptText(null)).toBeNull();
    expect(resolveInboxMcpPromptText("nope")).toBeNull();
    expect(resolveInboxMcpPromptText({ prompts: { inbox: {} } })).toBeNull();
    expect(resolveInboxMcpPromptText({ prompts: { inbox: { rules: "   " } } })).toBeNull();
  });

  test("rules alone, reminder alone, and both", () => {
    expect(resolveInboxMcpPromptText({ prompts: { inbox: { rules: RULES } } })).toBe(RULES);
    expect(resolveInboxMcpPromptText({ prompts: { inbox: { reminder: REMINDER } } })).toBe(REMINDER);
    expect(
      resolveInboxMcpPromptText({ prompts: { inbox: { reminder: REMINDER, rules: RULES } } }),
    ).toBe(`${REMINDER}\n\n${RULES}`);
  });

  test("an over-long reminder is ignored, like the terminal path", () => {
    expect(resolveInboxMcpPromptText({ prompts: { inbox: { reminder: "x".repeat(9001) } } })).toBeNull();
  });
});

describe("inboxMcpInstructions", () => {
  test("no extra text leaves the base instructions byte for byte", () => {
    expect(inboxMcpInstructions(null)).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions(undefined)).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions("")).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions("   ")).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("a short extra text is appended", () => {
    const got = inboxMcpInstructions(RULES);
    expect(got).toBe(`${INBOX_MCP_INSTRUCTIONS}\n\n${RULES}`);
    expect(got.length).toBeLessThanOrEqual(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
  });

  test("the cap is honoured exactly: 39 fits, 40 does not", () => {
    const room = INBOX_MCP_INSTRUCTIONS_MAX_CHARS - INBOX_MCP_INSTRUCTIONS.length - 2;
    expect(room).toBe(39);
    expect(inboxMcpInstructions("x".repeat(room))).toBe(`${INBOX_MCP_INSTRUCTIONS}\n\n${"x".repeat(room)}`);
    expect(inboxMcpInstructions("x".repeat(room + 1))).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("a long extra text stays out entirely, never cut", () => {
    expect(inboxMcpInstructions("x".repeat(100))).toBe(INBOX_MCP_INSTRUCTIONS);
  });
});

describe("the MCP server's instructions", () => {
  test("without the accessor the instructions are the base text", () => {
    const server = createInboxMcpServer({ codeReviewOn: () => false } as unknown as InboxMcpContext);
    expect((server as unknown as ServerWithInstructions).server._instructions).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("a short configured text is appended at construction", () => {
    expect(serverInstructions(() => RULES)).toBe(`${INBOX_MCP_INSTRUCTIONS}\n\n${RULES}`);
  });

  test("a long configured text stays out", () => {
    expect(serverInstructions(() => "x".repeat(100))).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("the accessor is read at each construction, so a change applies to the next server", () => {
    let text: string | null = "First.";
    expect(serverInstructions(() => text)).toEndWith("First.");
    text = "Second.";
    expect(serverInstructions(() => text)).toEndWith("Second.");
    text = null;
    expect(serverInstructions(() => text)).toBe(INBOX_MCP_INSTRUCTIONS);
  });
});
