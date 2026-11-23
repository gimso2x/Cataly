import { afterEach, expect, test } from "bun:test";
import { openBotSocket } from "../skills/cataly-mode/scripts/src/messenger/discord-buttons.ts";
import {
  approvalCard,
  DiscordApprovals,
  discordApprovals,
  maskApprovalText,
} from "../src/runtime/headless-discord-approval.ts";
import type { HeadlessDialog } from "../src/runtime/headless-protocol.ts";
import { channel, fakeDiscord, owner, stranger, token, until } from "./fixtures/discord-approval.ts";

const critical: HeadlessDialog = {
  id: "approval-1",
  kind: "approval",
  title: "Allow tool: bash\nReason: Critical pattern detected\nCommand: rm -f /tmp/x",
  options: ["Approve Once", "Approve for this session", "Deny"],
};
let stop: (() => void) | undefined;
afterEach(() => stop?.());

function harness(timeoutMs?: number, refuse = false) {
  const discord = fakeDiscord();
  stop = discord.stop;
  const dialogs = new Map([[critical.id, critical]]);
  const submitted: [string, string][] = [];
  const approvals = new DiscordApprovals(dialogs, {
    role: "lead",
    route: async () => ({ channel, owner, token, receiverStateDir: "/unused" }),
    submit: async (id, value) => {
      submitted.push([id, value]);
      if (refuse) throw new Error("no matching native dialog");
    },
    apiOverride: discord.api,
    open: () => openBotSocket(discord.gateway),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const shown = async () => {
    approvals.sync();
    await until(() => discord.buttons().size > 0 && discord.connected() > 0);
    const message = discord.edits[0]?.id;
    if (!message) throw new Error("card was not shown");
    return message;
  };
  const closing = async (text: string) => {
    await until(() => discord.edits.some((edit) => edit.components?.length === 0));
    const last = discord.edits.at(-1);
    expect(last?.components).toEqual([]);
    expect(last?.content).toContain(text);
  };
  return { discord, dialogs, submitted, approvals, shown, closing };
}

test("the owner's Approve answers that one native approval once and closes the card", async () => {
  const { discord, dialogs, submitted, approvals, shown, closing } = harness();
  const message = await shown();
  expect(discord.posts).toHaveLength(1);
  expect(discord.posts[0]?.channel).toBe(channel);
  expect(discord.posts[0]?.content).toContain("⚠️ **Reason: Critical pattern detected**");
  expect(discord.posts[0]?.content).toContain("Command: rm -f /tmp/x");
  // Session and remembered grants are never offered.
  expect([...discord.buttons().keys()]).toEqual(["Approve Once", "Deny"]);
  discord.click(message, discord.buttons().get("Approve Once")!);
  await until(() => submitted.length > 0);
  dialogs.delete(critical.id);
  approvals.sync();
  await closing("Approve Once: approved once by the owner.");
  expect(submitted).toEqual([[critical.id, "Approve Once"]]);
  expect(discord.callbacks).toEqual([6]);
});

test("another user's click is refused privately, and the owner's Deny is delivered", async () => {
  const { discord, submitted, shown, closing } = harness();
  const message = await shown();
  discord.click(message, discord.buttons().get("Approve Once")!, stranger);
  await until(() => discord.callbacks.length > 0);
  expect(discord.callbacks).toEqual([4]);
  expect(submitted).toEqual([]);
  discord.click(message, discord.buttons().get("Deny")!);
  await closing("Denied by the owner.");
  expect(submitted).toEqual([[critical.id, "Deny"]]);
});

test("a repeated click submits only the first answer", async () => {
  const { discord, submitted, shown, closing } = harness();
  const message = await shown();
  discord.click(message, discord.buttons().get("Approve Once")!);
  discord.click(message, discord.buttons().get("Deny")!);
  discord.click(message, discord.buttons().get("Approve Once")!);
  await closing("approved once by the owner.");
  expect(submitted).toEqual([[critical.id, "Approve Once"]]);
});

test("a local answer that wins the race closes the card and later clicks do nothing", async () => {
  const { discord, dialogs, submitted, approvals, shown, closing } = harness();
  const message = await shown();
  dialogs.delete(critical.id);
  approvals.sync();
  await closing("Nothing was approved from Discord.");
  await until(() => discord.connected() === 0);
  discord.click(message, discord.buttons().get("Approve Once")!);
  expect(submitted).toEqual([]);
});

test("a click the native side no longer accepts is reported, not retried", async () => {
  const { discord, submitted, shown, closing } = harness(undefined, true);
  discord.click(await shown(), discord.buttons().get("Approve Once")!);
  await closing("already answered or closed");
  expect(submitted).toHaveLength(1);
});

test("a cancelled or ended session closes every card", async () => {
  const { submitted, approvals, shown, closing } = harness();
  await shown();
  await approvals.close();
  await closing("Nothing was approved from Discord.");
  expect(submitted).toEqual([]);
});

test("an unanswered card times out without approving and the native dialog stays pending", async () => {
  const { dialogs, submitted, shown, closing } = harness(100);
  await shown();
  await closing("Timed out. Nothing was approved");
  expect(submitted).toEqual([]);
  expect(dialogs.has(critical.id)).toBe(true);
});

test("credentials are masked before the 800-character cut", () => {
  const discordToken = `${"M".repeat(24)}.${"a".repeat(6)}.${"b".repeat(27)}`;
  const masked = maskApprovalText(
    [
      `curl -H "Authorization: Bot ${discordToken}" https://example.test`,
      `export OPENAI_API_KEY=sk-live123 GH_TOKEN='ghp_abc' DB_PASSWORD="p w" SECRET=s3`,
      "send xoxb-123-456 github_pat_11ABC sk-proj-xyz",
      "curl -H 'Bearer abc.def'",
      discordToken,
    ].join("\n"),
  );
  for (const secret of [discordToken, "sk-live123", "ghp_abc", "p w", "s3", "xoxb-123", "github_pat_11ABC", "abc.def"])
    expect(masked).not.toContain(secret);
  expect(masked).toContain("OPENAI_API_KEY=[REDACTED]");
  expect(masked).toContain("Authorization: [REDACTED]");
  expect(maskApprovalText("x".repeat(900))).toBe(`${"x".repeat(800)}…`);
  const card = approvalCard({ ...critical, title: `Allow tool: bash\nCommand: echo ${"y".repeat(1_000)}` }, "lane");
  expect(card?.content.length).toBeLessThan(2_000);
  expect(card?.content).not.toContain("Reason:");
});

test("only approval prompts with a single-call answer become cards", () => {
  expect(approvalCard({ ...critical, kind: "select" }, "lead")).toBeUndefined();
  expect(approvalCard({ ...critical, options: ["Approve for this session", "Deny"] }, "lead")).toBeUndefined();
  expect(approvalCard({ ...critical, options: ["Approve", "Deny"] }, "lead")?.choices).toEqual(["Approve", "Deny"]);
});

test("without the opt-in, or for duty, no Discord bridge is created", async () => {
  const env = { CATALY_STATE_DIR: "/state", CATALY_DISCORD_APPROVALS: "" };
  const target = { refId: "ref", sessionId: "session" };
  const dialogs = new Map([[critical.id, critical]]);
  const submit = async () => undefined;
  expect(discordApprovals(env, { ...target, role: "lead" }, dialogs, submit)).toBeUndefined();
  const on = { ...env, CATALY_DISCORD_APPROVALS: "1" };
  expect(discordApprovals(on, { ...target, role: "duty" }, dialogs, submit)).toBeUndefined();
  const relative = { ...on, CATALY_STATE_DIR: "relative" };
  expect(discordApprovals(relative, { ...target, role: "lead" }, dialogs, submit)).toBeUndefined();
  const lane = discordApprovals(on, { ...target, role: undefined }, new Map(), submit);
  expect(lane).toBeInstanceOf(DiscordApprovals);
  await lane?.close();
});
