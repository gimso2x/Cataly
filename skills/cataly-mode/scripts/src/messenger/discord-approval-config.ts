/** The headless supervisor reads only this variable: "1" posts native tool approvals to Discord, anything else does not. */
export const DISCORD_APPROVALS_ENV = "CATALY_DISCORD_APPROVALS";

/** Opt-in, off by default: native tool approvals of headless lead and lane sessions become owner-only Discord buttons. */
export type DiscordApprovals = { readonly enabled: boolean };

export const discordApprovalsError = (value: unknown): string | undefined =>
  value === undefined ||
  (value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "enabled") &&
    "enabled" in value &&
    typeof value.enabled === "boolean")
    ? undefined
    : "invalid discordApprovals: expected { enabled: true } or { enabled: false }";

/** Always set, so a launch never inherits the launcher's own setting from another Cataly home. */
export const discordApprovalsEnv = (config: {
  readonly discordApprovals?: DiscordApprovals | undefined;
}): Record<string, string> => ({ [DISCORD_APPROVALS_ENV]: config.discordApprovals?.enabled === true ? "1" : "" });
