import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { DISCORD_APPROVALS_ENV } from "../src/messenger/discord-approval-config.ts";
import { laneLaunchEnv } from "../src/slack-token.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const load = (raw: object) => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify(raw));
  return loadConfig(path, state.dir, { HOME: state.dir });
};

test("Discord approvals are off unless the config enables them", async () => {
  expect((await load({})).discordApprovals).toBeUndefined();
  expect((await load({ discordApprovals: { enabled: true } })).discordApprovals).toEqual({ enabled: true });
  expect((await load({ discordApprovals: { enabled: false } })).discordApprovals).toEqual({ enabled: false });
});

test.each([[null], [true], ["on"], [[]], [{}], [{ enabled: "yes" }], [{ enabled: true, session: true }]])(
  "an invalid discordApprovals value %p stops the command",
  async (discordApprovals: unknown) => {
    await expect(load({ discordApprovals })).rejects.toThrow("invalid discordApprovals");
  },
);

test("every lane launch states the setting, so it never inherits the launcher's", () => {
  const config = join(state.dir, "config.json");
  const inherited = { HOME: state.dir, [DISCORD_APPROVALS_ENV]: "1" };
  expect(laneLaunchEnv(inherited, config)[DISCORD_APPROVALS_ENV]).toBe("");
  const resolved = { stateDir: state.dir, ompUlwPath: "" };
  expect(laneLaunchEnv(inherited, config, resolved)[DISCORD_APPROVALS_ENV]).toBe("");
  expect(
    laneLaunchEnv({ HOME: state.dir }, config, { ...resolved, discordApprovals: { enabled: true } })[
      DISCORD_APPROVALS_ENV
    ],
  ).toBe("1");
});
