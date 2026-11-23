import { dirname, isAbsolute, join } from "node:path";
import { selfSession } from "../../../../../src/runtime/registry.ts";
import { configPath } from "../config.ts";
import { type CatalyRole, readPaneState } from "../lane-state.ts";
import { Registry, RESERVED_LANE_KEY, statusOf } from "../registry.ts";
import { readPrivateAskFile } from "./discord-ask-mailbox.ts";
import { discordAskReceivers } from "./discord-ask-receiver.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

export type AskLane = { readonly key: string; readonly sessionId: string };
/** An automatically discovered destination: the live receiver's owner and one channel it watches. */
export type DiscordTokenRoute = {
  readonly channel: string;
  readonly owner: string;
  readonly receiverStateDir: string;
  readonly token: string;
};
type Env = Readonly<Record<string, string | undefined>>;

/** The Discord channel of the open lane registered to this process's own session: headless, else its Tern block. */
export async function laneChannel(
  stateDir: string,
  sessionId: string,
  binding: AskLane | undefined,
  env: Env = process.env,
): Promise<string | undefined> {
  const pane = selfSession(env);
  if (!pane) return undefined;
  // A Tern block is inherited by nested runs: only the process whose pane record names this session owns it.
  if (pane.runtime !== "headless") {
    const current = readPaneState(stateDir, pane.id);
    if (current?.pid !== process.pid || current.role !== "lane" || current.sessionId !== sessionId) return undefined;
  }
  const matching = (await new Registry(stateDir).scan()).lanes.filter(
    (lane) =>
      lane.key !== RESERVED_LANE_KEY &&
      statusOf(lane) !== "closed" &&
      lane.sessionRef?.runtime === pane.runtime &&
      lane.sessionRef.id === pane.id,
  );
  const lane = matching.length === 1 ? matching[0] : undefined;
  if (
    !lane ||
    (lane.session !== sessionId &&
      !(lane.session === undefined && binding?.sessionId === sessionId && binding.key === lane.key)) ||
    typeof lane.thread !== "string" ||
    !lane.thread.startsWith("discord:")
  )
    return undefined;
  const channel = lane.thread.slice("discord:".length);
  return isDiscordSnowflake(channel) ? channel : undefined;
}

export async function automaticDiscordAskRoute(
  stateDir: string,
  role: CatalyRole,
  sessionId: string,
  binding?: AskLane,
  env: Env = process.env,
): Promise<DiscordTokenRoute | undefined> {
  const home = env["CATALY_HOME"] ?? dirname(env["CATALY_CONFIG"] ?? configPath());
  // Never let a relative override resolve against a lane's project directory.
  if (!isAbsolute(home)) return undefined;
  const tokenFile = join(home, "discord-token");
  // Older lead processes may already have the bot credential without the standard token file.
  // Lanes never use inherited messenger credentials, and discovery still requires a matching live receiver.
  const fileToken = readPrivateAskFile(tokenFile, 16_384);
  const token = (fileToken ?? (role === "cataly" ? env["CATALY_DISCORD_TOKEN"] : undefined))?.trim();
  if (!token || !/^[\w.-]+$/.test(token)) return undefined;
  const target = role === "lane" ? await laneChannel(stateDir, sessionId, binding, env) : undefined;
  if (role === "lane" && !target) return undefined;
  const receivers = discordAskReceivers(stateDir, token, env["CATALY_DISCORD_API_BASE"] ?? "");
  // A registered lane names its own destination; never fall back to the lead's channel.
  // For a lead, discovered channels are not defaults and multiple explicit destinations are ambiguous.
  const routes = new Map<string, DiscordTokenRoute>();
  for (const receiver of receivers) {
    for (const channel of target ? [target] : receiver.explicit) {
      if (!receiver.watched.includes(channel)) continue;
      routes.set(`${receiver.owner}:${channel}`, {
        channel,
        owner: receiver.owner,
        token,
        receiverStateDir: stateDir,
      });
    }
  }
  return routes.size === 1 ? routes.values().next().value : undefined;
}
