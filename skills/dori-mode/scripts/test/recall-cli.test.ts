import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "record-fetch.ts");

const dori = (dir: string, recall: unknown, ...args: string[]) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {}, recall }));
  return run(
    [
      "env",
      `DORI_CONFIG=${config}`,
      `DORI_STATE_DIR=${dir}`,
      "DORI_TELEGRAM_TOKEN=123:not-a-real-token",
      `DORI_TEST_FETCH_LOG=${join(dir, "fetch.jsonl")}`,
      process.execPath,
      "--preload",
      recorder,
      cli,
      ...args,
    ],
    { timeoutMs: 20_000 },
  );
};

test("a delivered Telegram reply is searchable only in its own chat, and purge clears it", async () => {
  const state = withState();
  try {
    const on = { enabled: true };
    const sent = await dori(
      state.dir,
      on,
      "send",
      "telegram",
      "--to",
      "-1001",
      "--thread",
      "42",
      "--text",
      "rollout is friday",
    );
    expect([sent.code, sent.out, sent.err]).toEqual([0, "SENT 99", ""]);
    const own = await dori(state.dir, on, "recall", "rollout", "--thread", "telegram:-1001/42");
    expect(own.code).toBe(0);
    const [head, json] = [own.out.slice(0, own.out.indexOf("{")), own.out.slice(own.out.indexOf("{"))];
    expect(head).toBe("RECALL telegram -1001 ");
    expect(JSON.parse(json)).toMatchObject({ role: "lead", thread: "-1001/42", text: "rollout is friday" });
    expect((await dori(state.dir, on, "recall", "rollout", "--thread", "telegram:555")).out).toBe("RECALL_NONE");
    const refused = await dori(state.dir, on, "recall", "rollout", "--thread", "slack:C1");
    expect([refused.code, refused.err]).toEqual([
      1,
      "--thread must be discord:<channel-or-thread-id> or telegram:<chat>[/<topic>]",
    ]);
    const purged = await dori(state.dir, { enabled: false }, "recall", "purge");
    expect([purged.code, purged.out]).toEqual([0, "RECALL_PURGED 1"]);
    expect((await dori(state.dir, on, "recall", "rollout")).out).toBe("RECALL_NONE");
  } finally {
    state.done();
  }
}, 120_000);

// POSIX-only: the Discord queue and cursor stores require private uid-owned directories.
test.skipIf(process.platform === "win32")(
  "Discord intake ends a past-reference owner group with the recalled earlier message of that channel",
  async () => {
    const state = withState();
    try {
      const config = join(state.dir, "config.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, hooks: {}, recall: { enabled: true } }));
      const inbound = await run(
        [
          "env",
          `HOME=${state.dir}`,
          `DORI_CONFIG=${config}`,
          `DORI_STATE_DIR=${state.dir}`,
          "DORI_DISCORD_TOKEN=synthetic-inbound-token",
          "DORI_DISCORD_OWNER_ID=10",
          "DORI_DISCORD_CHANNEL_ID=20",
          "DORI_TEST_DISCORD_CASE=recall",
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-discord-inbound.ts"),
          cli,
          "inbound",
          "discord",
        ],
        { timeoutMs: 20_000 },
      );
      const lines = inbound.out.split("\n").filter((line) => line.startsWith("INBOUND"));
      expect(lines.slice(1, 3)).toEqual([
        'INBOUND discord 20 101 from=owner ref=- "first owner text"',
        'INBOUND discord 20 103 from=owner ref=101 "what was the first owner text earlier?"',
      ]);
      const recall = lines.at(-1)!;
      expect(recall).toStartWith("INBOUND_RECALL discord 20 103 ");
      const record = JSON.parse(recall.slice("INBOUND_RECALL discord 20 103 ".length));
      expect(record.rows.map((row: { role: string; text: string }) => [row.role, row.text])).toEqual([
        ["owner", "first owner text"],
      ]);
      expect(lines.filter((line) => line.startsWith("INBOUND_RECALL"))).toHaveLength(1);
    } finally {
      state.done();
    }
  },
  120_000,
);

test("without recall enabled, sending keeps nothing and searching is refused", async () => {
  const state = withState();
  try {
    const sent = await dori(state.dir, undefined, "send", "telegram", "--to", "-1001", "--text", "hello");
    expect([sent.code, sent.out]).toEqual([0, "SENT 99"]);
    expect(existsSync(join(state.dir, "recall.sqlite"))).toBe(false);
    const search = await dori(state.dir, undefined, "recall", "hello");
    expect([search.code, search.err]).toEqual([1, 'recall is off; set "recall": {"enabled": true} in config.json']);
    const invalid = await dori(state.dir, { enabled: "yes" }, "recall", "hello");
    expect([invalid.code, invalid.err]).toEqual([1, "invalid recall.enabled: expected true or false"]);
  } finally {
    state.done();
  }
}, 120_000);
