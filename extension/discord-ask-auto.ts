import type { AskLane } from "../skills/cataly-mode/scripts/src/messenger/discord-ask-route.ts";
import { LANE_KEY } from "../skills/cataly-mode/scripts/src/registry.ts";
import { isCatalyEntry, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";

const LANE_ENTRY = "omp-cataly:discord-ask-lane";
type AskLaneEntry = { readonly type: string; readonly customType?: string; readonly data?: unknown };

export function bindAskLane(
  branch: readonly AskLaneEntry[],
  sessionId: string,
  launched: string | undefined,
  record: (kind: string, data: AskLane) => void,
): AskLane | undefined {
  if (launched && LANE_KEY.test(launched)) {
    const binding = { key: launched, sessionId };
    record(SESSION_WIRE.askLane, binding);
    return binding;
  }
  const value = branch.findLast(
    (entry) => entry.type === "custom" && isCatalyEntry(entry.customType, LANE_ENTRY),
  )?.data;
  if (!value || typeof value !== "object" || !("sessionId" in value) || value.sessionId !== sessionId) return undefined;
  return "key" in value && typeof value.key === "string" && LANE_KEY.test(value.key)
    ? { key: value.key, sessionId }
    : undefined;
}
