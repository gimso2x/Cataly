import { existsSync, readFileSync } from "node:fs";
import { localDate, OWNER_PROFILE_MAX_BYTES, ownerPaths, SECTIONS, sections, snapshotPath } from "./owner.ts";

export const MAX_DECISIONS = 20;
export const MAX_LOG_LINES = 14;
export const INTEREST_DAYS = 14;

const ENTRY = /^- \((\d{4}-\d{2}-\d{2})\) (\S.*)$/;
// Credentials and contact details. The distill procedure forbids them; this catches the obvious shapes.
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{8,}/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/, "a bearer token"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an e-mail address"],
];

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const entryText = (line: string): string => ENTRY.exec(line)?.[2] ?? line;

/**
 * Everything wrong with the profile, one line each; empty means it is fit for the lead's prompt. Besides structure,
 * size, dates and secrets, no decision in today's snapshot may disappear: its text must still be in Decisions (kept,
 * or quoted in a `(replaces: ...)` note) or in the decisions archive.
 */
export function checkOwner(root: string, now: number): string[] {
  const { profile, archive } = ownerPaths(root);
  if (!existsSync(profile)) return [`no profile at ${profile}`];
  const text = readFileSync(profile, "utf8");
  const problems: string[] = [];
  const bytes = Buffer.byteLength(text);
  if (bytes > OWNER_PROFILE_MAX_BYTES) problems.push(`size ${bytes} bytes is over ${OWNER_PROFILE_MAX_BYTES}`);
  const parts = sections(text);
  const headings = [...parts.keys()].slice(1);
  if (headings.join("\n") !== SECTIONS.join("\n"))
    problems.push(
      `sections must be exactly, in order: ${SECTIONS.join(", ")} (found: ${headings.join(", ") || "none"})`,
    );
  const today = localDate(now);
  for (const name of SECTIONS) {
    const lines = (parts.get(name) ?? []).filter((l) => l.trim() !== "");
    for (const line of lines) {
      const m = ENTRY.exec(line);
      if (!m || Number.isNaN(dayNumber(m[1]!))) problems.push(`${name}: not "- (YYYY-MM-DD) text": ${line}`);
      else if (m[1]! > today) problems.push(`${name}: dated after today: ${line}`);
      else if (name === "Current interests" && dayNumber(today) - dayNumber(m[1]!) > INTEREST_DAYS)
        problems.push(`${name}: not seen for over ${INTEREST_DAYS} days, remove it: ${line}`);
    }
    if (name === "Decisions" && lines.length > MAX_DECISIONS)
      problems.push(`Decisions: ${lines.length} lines, over ${MAX_DECISIONS}; move the oldest to ${archive}`);
    if (name === "Update log" && lines.length > MAX_LOG_LINES)
      problems.push(`Update log: ${lines.length} lines, keep the newest ${MAX_LOG_LINES}`);
  }
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) problems.push(`contains ${what}; remove it`);
  const snap = snapshotPath(root, today);
  if (existsSync(snap)) {
    const kept = `${(parts.get("Decisions") ?? []).join("\n")}\n${existsSync(archive) ? readFileSync(archive, "utf8") : ""}`;
    for (const line of sections(readFileSync(snap, "utf8")).get("Decisions") ?? []) {
      if (line.trim() === "" || kept.includes(entryText(line))) continue;
      problems.push(
        `Decisions: lost since today's snapshot (keep it, quote it in "(replaces: ...)" or archive it): ${line}`,
      );
    }
  }
  return problems;
}
