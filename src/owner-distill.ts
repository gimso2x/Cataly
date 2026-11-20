import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fill, promptFile, type Deps } from "./harness.ts";
import { ConfigError, readConfig } from "./hooks.ts";
import { localDate, ownerPaths, snapshotPath } from "./owner.ts";
import type { LoopRun } from "./store-types.ts";

/** `ownerDistillHour` in config.json: the local hour (0-23) from which the hourly loop asks for one distill a day. */
export function distillHour(root: string): number | undefined {
  const config = readConfig(root);
  const value: unknown = config === undefined ? undefined : Reflect.get(config, "ownerDistillHour");
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23)
    throw new ConfigError(
      `config.json: ownerDistillHour must be a whole hour from 0 to 23, got ${JSON.stringify(value)}`,
    );
  return value;
}

const lastDate = (path: string): string | undefined => {
  try {
    const date: unknown = Reflect.get(JSON.parse(readFileSync(path, "utf8")) as object, "date");
    return typeof date === "string" ? date : undefined;
  } catch {
    // No record yet, or a torn one: asking again is the safe outcome, and the snapshot is never overwritten.
    return undefined;
  }
};

/**
 * Asks the lead for today's distill once, from the configured local hour, when the profile exists and a lead is
 * registered. The request is a line of the [LOOP] message naming the rendered procedure. The day is recorded as soon
 * as the line is part of the run, like a [DECIDE] question: a failed report to the lead is a finding, not a retry.
 */
export function distillStep(d: Deps, run: LoopRun): void {
  const root = d.store.root;
  let hour: number | undefined;
  try {
    hour = distillHour(root);
  } catch (e) {
    run.findings.push(`owner distill: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const { profile, archive } = ownerPaths(root);
  if (hour === undefined || !existsSync(profile) || !d.store.roles().lead) return;
  const now = d.now();
  const today = localDate(now);
  const state = join(root, "loop", "owner-distill.json");
  if (new Date(now).getHours() < hour || lastDate(state) === today) return;
  const procedure = join(root, "prompts", "owner-distill.md");
  mkdirSync(join(root, "prompts"), { recursive: true });
  const vars = { dori: d.doriCmd, date: today, profile, archive, snapshot: snapshotPath(root, today) };
  writeFileSync(procedure, fill(readFileSync(promptFile("owner-distill.md"), "utf8"), vars));
  writeFileSync(state, `${JSON.stringify({ date: today, at: now })}\n`);
  run.distill = `[OWNER-DISTILL ${today}] Update the owner profile once for today: read ${procedure} and follow it.`;
}
