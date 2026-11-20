import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  pointsAtPast,
  rankRecall,
  type RecallRow,
  recallRecord,
  type RecallSettings,
  storedText,
} from "./recall-text.ts";

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** The newest rows of one space that a search ranks. */
const CANDIDATES = 2000;

export type RecallLedger = {
  record(row: RecallRow): void;
  /** The space a conversation was first recorded in, if any. */
  channelOf(platform: string, thread: string): string | undefined;
  /** Newest first; without a space, every space's rows. */
  rows(space?: { readonly platform: string; readonly channel: string }): RecallRow[];
  purge(): number;
  close(): void;
};

/** `<stateDir>/recall.sqlite`, created owner-only; rows past the retention period are dropped on every open. */
export const openRecallLedger = (stateDir: string, settings: RecallSettings | undefined, now: number): RecallLedger => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "recall.sqlite");
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS turns (at INTEGER NOT NULL, platform TEXT NOT NULL, channel TEXT NOT NULL,
        thread TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'lead')), text TEXT NOT NULL,
        ref TEXT NOT NULL, PRIMARY KEY (platform, thread, role, ref));
      CREATE INDEX IF NOT EXISTS turns_space ON turns(platform, channel, at);`);
    db.query("DELETE FROM turns WHERE at < ?").run(now - (settings?.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    record(row) {
      db.query(
        "INSERT OR IGNORE INTO turns (at, platform, channel, thread, role, text, ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(row.at, row.platform, row.channel, row.thread, row.role, row.text, row.ref);
    },
    channelOf(platform, thread) {
      const found = db
        .query<{ channel: string }, [string, string]>(
          "SELECT channel FROM turns WHERE platform = ? AND thread = ? ORDER BY at LIMIT 1",
        )
        .get(platform, thread);
      return found?.channel;
    },
    rows(space) {
      return space
        ? db
            .query<RecallRow, [string, string, number]>(
              "SELECT * FROM turns WHERE platform = ? AND channel = ? ORDER BY at DESC LIMIT ?",
            )
            .all(space.platform, space.channel, CANDIDATES)
        : db.query<RecallRow, [number]>("SELECT * FROM turns ORDER BY at DESC LIMIT ?").all(CANDIDATES);
    },
    purge: () => db.query("DELETE FROM turns").run().changes,
    close: () => db.close(),
  };
};

type Turn = { readonly platform: string; readonly thread: string; readonly ref: string; readonly text: string };

/**
 * The messenger side of recall, or undefined while it is off. `owner` records an owner message and, when it points
 * back at an earlier conversation, returns the `INBOUND_RECALL` record ranked from the same space only. `lead`
 * records a delivered reply in the space its conversation was first seen in. A ledger failure is a warning: it
 * never costs the message or the reply.
 */
export const conversationRecall = (
  config: { readonly stateDir: string; readonly recall?: RecallSettings },
  warn: (message: string) => void,
  clock: () => number = Date.now,
) => {
  if (config.recall?.enabled !== true) return undefined;
  const withLedger = <T>(use: (ledger: RecallLedger, now: number) => T): T | undefined => {
    try {
      const now = clock();
      const ledger = openRecallLedger(config.stateDir, config.recall, now);
      try {
        return use(ledger, now);
      } finally {
        ledger.close();
      }
    } catch (error) {
      warn(`recall: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return undefined;
    }
  };
  return {
    owner: (turn: Turn & { readonly channel: string }): string | undefined =>
      withLedger((ledger, now) => {
        const text = storedText(turn.text);
        let record: string | undefined;
        if (pointsAtPast(text)) {
          const earlier = ledger
            .rows({ platform: turn.platform, channel: turn.channel })
            .filter((row) => !(row.role === "owner" && row.thread === turn.thread && row.ref === turn.ref));
          record = `INBOUND_RECALL ${turn.platform} ${turn.thread} ${turn.ref} ${recallRecord(rankRecall(text, earlier))}`;
        }
        if (text !== "") ledger.record({ ...turn, at: now, role: "owner", text });
        return record;
      }),
    lead: (turn: Turn & { readonly channel?: string }): void => {
      const text = storedText(turn.text);
      if (text === "") return;
      withLedger((ledger, now) => {
        const channel = ledger.channelOf(turn.platform, turn.thread) ?? turn.channel ?? turn.thread;
        ledger.record({
          platform: turn.platform,
          thread: turn.thread,
          ref: turn.ref,
          channel,
          at: now,
          role: "lead",
          text,
        });
      });
    },
  };
};
