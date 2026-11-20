/** dori recall: search or clear the opt-in conversation ledger. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { openRecallLedger } from "./messenger/recall-ledger.ts";
import { rankRecall, recalledItem } from "./messenger/recall-text.ts";

/** `discord:<channel-or-thread>` or `telegram:<chat>[/<topic>]`, the conversation the ledger recorded. */
const conversation = (ref: string): { platform: string; thread: string } => {
  const match = /^(discord):(\d{1,20})$|^(telegram):(-?\d{1,20}(?:\/\d{1,20})?)$/.exec(ref);
  if (!match) return die("--thread must be discord:<channel-or-thread-id> or telegram:<chat>[/<topic>]");
  return match[1] ? { platform: match[1], thread: match[2]! } : { platform: match[3]!, thread: match[4]! };
};

export const recallCommand: Command = async ({ positionals, opt, values, config }) => {
  const words = positionals.slice(1);
  const now = Date.now();
  if (positionals[0] === "purge" && words.length === 0) {
    if (values["thread"] !== undefined) die("recall purge clears every space; it takes no --thread");
    // Clearing works with recall off too, so turning it off and purging leaves nothing behind.
    if (!existsSync(join(config.stateDir, "recall.sqlite"))) return console.log("RECALL_PURGED 0");
    const ledger = openRecallLedger(config.stateDir, config.recall, now);
    try {
      console.log(`RECALL_PURGED ${ledger.purge()}`);
    } finally {
      ledger.close();
    }
    return;
  }
  if (config.recall?.enabled !== true) die('recall is off; set "recall": {"enabled": true} in config.json');
  const query = positionals.join(" ").trim() || die("recall needs a query, or purge");
  const limitText = opt("limit");
  const limit = limitText === undefined ? 4 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit <= 0) die("--limit must be a positive whole number of rows");
  const ref = opt("thread");
  const ledger = openRecallLedger(config.stateDir, config.recall, now);
  try {
    // With --thread only that conversation's space is searched; without it, the operator searches every space.
    const space = ref === undefined ? undefined : conversation(ref);
    const rows = ledger.rows(
      space && {
        platform: space.platform,
        channel: ledger.channelOf(space.platform, space.thread) ?? space.thread.split("/")[0]!,
      },
    );
    const found = rankRecall(query, rows).slice(0, limit);
    if (found.length === 0) console.log("RECALL_NONE");
    for (const row of found) console.log(`RECALL ${row.platform} ${row.channel} ${JSON.stringify(recalledItem(row))}`);
  } finally {
    ledger.close();
  }
};
