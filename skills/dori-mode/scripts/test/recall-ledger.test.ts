import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { conversationRecall, openRecallLedger } from "../src/messenger/recall-ledger.ts";
import { type TestState, withState } from "./fakes.ts";

const DAY = 24 * 60 * 60_000;
let state: TestState;
let now: number;
let warnings: string[];
beforeEach(() => {
  state = withState();
  now = Date.UTC(2026, 10, 20, 12);
  warnings = [];
});
afterEach(() => state.done());

const recall = (retentionDays?: number) =>
  conversationRecall(
    { stateDir: state.dir, recall: { enabled: true, ...(retentionDays ? { retentionDays } : {}) } },
    (warning) => warnings.push(warning),
    () => now,
  )!;
const said = (channel: string, thread: string, ref: string, text: string) =>
  recall().owner({ platform: "discord", channel, thread, ref, text });
const recalled = (line: string | undefined) => {
  const match = /^INBOUND_RECALL discord (\d+) (\d+) (.*)$/.exec(line ?? "");
  return { conversation: match?.[1], ref: match?.[2], ...(JSON.parse(match?.[3] ?? "null") as object) } as {
    conversation?: string;
    ref?: string;
    rows: { role: string; thread: string; text: string }[];
  };
};

test("recall is off by default and creates no ledger", () => {
  for (const config of [{ stateDir: state.dir }, { stateDir: state.dir, recall: { enabled: false } }])
    expect(conversationRecall(config, () => {})).toBeUndefined();
  expect(existsSync(join(state.dir, "recall.sqlite"))).toBe(false);
});

test("a past reference recalls owner messages and replies from every thread of the same channel only", () => {
  expect(said("20", "20", "1", "the deploy window is friday 18:00")).toBeUndefined();
  now += 1000;
  said("20", "21", "3", "ok, keep the deploy window note");
  now += 1000;
  // A reply joins the space its thread was first seen in.
  recall().lead({ platform: "discord", thread: "21", ref: "2", text: "moved the deploy window to monday" });
  said("30", "30", "4", "other channel: deploy window secret plan");
  said("40", "40", "5", "dm: deploy window in a DM");
  now += 1000;
  const result = recalled(said("20", "20", "6", "what was the deploy window we discussed last time?"));
  expect(result.conversation).toBe("20");
  expect(result.ref).toBe("6");
  expect(result.rows.map((row) => [row.role, row.thread, row.text])).toEqual([
    ["owner", "20", "the deploy window is friday 18:00"],
    ["owner", "21", "ok, keep the deploy window note"],
    ["lead", "21", "moved the deploy window to monday"],
  ]);
  expect(recalled(said("40", "40", "7", "저번에 말한 배포 일정")).rows).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a redelivered message is stored once and never recalls itself", () => {
  said("20", "20", "1", "earlier: rotate the staging key");
  const again = recalled(said("20", "20", "1", "earlier: rotate the staging key"));
  expect(again.rows).toEqual([]);
  const ledger = openRecallLedger(state.dir, undefined, now);
  try {
    expect(ledger.rows()).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

test("stored rows are redacted, owner-only and dropped after the retention period", () => {
  said("20", "20", "1", "token=abc123secret for the deploy");
  const ledger = openRecallLedger(state.dir, undefined, now);
  try {
    expect(ledger.rows().map((row) => row.text)).toEqual(["token=[redacted] for the deploy"]);
  } finally {
    ledger.close();
  }
  if (process.platform !== "win32") expect(statSync(join(state.dir, "recall.sqlite")).mode & 0o077).toBe(0);
  now += 8 * DAY;
  expect(
    recalled(recall(7).owner({ platform: "discord", channel: "20", thread: "20", ref: "2", text: "yesterday deploy?" }))
      .rows,
  ).toEqual([]);
});

test("a ledger failure is a warning, not a lost message", () => {
  const broken = conversationRecall(
    { stateDir: join(state.dir, "missing\0dir"), recall: { enabled: true } },
    (warning) => warnings.push(warning),
  )!;
  expect(
    broken.owner({ platform: "discord", channel: "20", thread: "20", ref: "1", text: "earlier?" }),
  ).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith("recall: ");
});

test("purge clears every row", () => {
  said("20", "20", "1", "one");
  said("30", "30", "2", "two");
  const ledger = openRecallLedger(state.dir, undefined, now);
  try {
    expect(ledger.purge()).toBe(2);
    expect(ledger.rows()).toEqual([]);
  } finally {
    ledger.close();
  }
});
