import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { USAGE, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import {
  DATE_RE,
  lineDiff,
  ownerPaths,
  ownerPromptSection,
  revert,
  snapshot,
  snapshotDates,
  snapshotPath,
  TEMPLATE,
} from "./owner.ts";
import { checkOwner } from "./owner-check.ts";
import { Refusal } from "./refusal.ts";

const snapshotOf = (root: string, date: string | undefined): string => {
  if (date !== undefined && !DATE_RE.test(date)) throw new Refusal(`${date} is not a date (YYYY-MM-DD)`);
  const chosen = date ?? snapshotDates(root).at(-1);
  if (chosen === undefined || !existsSync(snapshotPath(root, chosen)))
    throw new Refusal(
      `no owner snapshot${chosen ? ` for ${chosen}` : ""}; dated snapshots: ${snapshotDates(root).join(" ") || "none"}`,
    );
  return chosen;
};

/** `dori harness owner init|show|snapshot|check|diff [DATE]|revert DATE`: the owner profile (owner.ts). */
export function runOwner(d: Deps, a: Args, x: string | undefined): number {
  const root = d.store.root;
  const { profile } = ownerPaths(root);
  if (x === "init") {
    if (existsSync(profile)) throw new Refusal(`${profile} exists; edit it or use dori harness owner revert`);
    writeFileSync(profile, TEMPLATE);
    console.log(`OWNER_INIT ${profile}: the lead reads it from its next start`);
    return 0;
  }
  if (!existsSync(profile) && x !== "revert") {
    if (x !== "show") throw new Refusal(`no owner profile at ${profile}; dori harness owner init creates one`);
    console.log(`NO_OWNER_PROFILE ${profile}: the lead's prompt has no owner section`);
    return 0;
  }
  switch (x) {
    case "show":
      console.log(ownerPromptSection(root));
      return 0;
    case "snapshot": {
      const s = snapshot(root, d.now());
      console.log(`${s.written ? "SNAPSHOT" : "SNAPSHOT_KEPT"} ${s.path}`);
      return 0;
    }
    case "check": {
      const problems = checkOwner(root, d.now());
      for (const p of problems) console.log(`OWNER_PROBLEM ${p}`);
      if (problems.length === 0) console.log(`OWNER_OK ${Buffer.byteLength(readFileSync(profile))} bytes`);
      return problems.length === 0 ? 0 : 1;
    }
    case "diff": {
      const date = snapshotOf(root, a.pos[2]);
      const lines = lineDiff(
        readFileSync(snapshotPath(root, date), "utf8").split("\n"),
        readFileSync(profile, "utf8").split("\n"),
      );
      console.log(lines.length === 0 ? `NO_CHANGES since ${date}` : [`DIFF ${date} -> now`, ...lines].join("\n"));
      return 0;
    }
    case "revert": {
      const date = a.pos[2];
      if (date === undefined) throw new Refusal(`owner revert needs a snapshot date\n\n${USAGE}`);
      const saved = revert(root, snapshotOf(root, date), d.now());
      console.log(`REVERTED ${profile} to ${date}; the previous profile is saved at ${saved}`);
      return 0;
    }
    default:
      throw new Refusal(`unknown owner command ${x}\n\n${USAGE}`);
  }
}
