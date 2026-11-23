import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDiscordAskReceiver } from "../skills/cataly-mode/scripts/src/messenger/discord-ask-receiver.ts";
import { headlessArgv, HeadlessRuntime, type HeadlessObservation } from "../src/runtime/headless.ts";
import { channel, fakeDiscord, owner, token, until } from "./fixtures/discord-approval.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

// The broker is a separate process reached over its socket; it publishes no event to subscribe to, so read it again.
async function observeUntil(read: () => Promise<HeadlessObservation>, ready: (seen: HeadlessObservation) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const seen = await read();
    if (ready(seen)) return seen;
    if (Date.now() > deadline) throw new Error(`native lead did not reach the expected state: ${seen.status}`);
    await Bun.sleep(50);
  }
}

/** A fake native lead behind the real headless broker, with a live local Discord receiver for its inbound channel. */
async function lead(optIn: boolean) {
  const f = headlessFixture();
  const discord = fakeDiscord();
  const stateDir = join(f.home, "state");
  writeFileSync(join(f.home, "discord-token"), token, { mode: 0o600 });
  const receiver = openDiscordAskReceiver(stateDir, token, owner, [channel], () => [channel], {
    apiOverride: discord.api,
  });
  receiver.refresh();
  const rt = new HeadlessRuntime(stateDir, f.env);
  const ref = await rt.create({ name: "lead", role: "lead", cwd: f.home, env: {} });
  const seen = await rt.startNative(ref, headlessArgv(f.deps.config.agentCommand, "fixture/initial", "lead"), {
    ...f.env,
    CATALY_STATE_DIR: stateDir,
    CATALY_DISCORD_API_BASE: discord.api,
    CATALY_DISCORD_GATEWAY_URL: discord.gateway,
    CATALY_DISCORD_APPROVALS: optIn ? "1" : "",
  });
  const session = seen.sessionId;
  if (!session) throw new Error("fake native lead failed to prove its session");
  const done = async () => {
    await rt.stopHarnessRole(ref, "lead", session).catch(() => undefined);
    receiver.close();
    discord.stop();
    rmSync(f.home, { recursive: true, force: true });
  };
  return { f, discord, rt, ref, session, done };
}

// Headless brokers need Unix sockets; the receiver lease and token file need POSIX privacy.
test.skipIf(process.platform === "win32")(
  "an opted-in headless lead posts its approval to Discord and the owner's Approve runs that call",
  async () => {
    const { f, discord, rt, ref, session, done } = await lead(true);
    try {
      expect(await rt.deliver(ref, "request approval")).toMatchObject({ kind: "delivered" });
      const blocked = await observeUntil(
        () => rt.observe(ref),
        (seen) => seen.dialogs.length > 0,
      );
      expect(blocked.status).toBe("blocked");
      const request = blocked.dialogs[0]!;
      await until(() => discord.buttons().size > 0 && discord.connected() > 0, 10_000);
      expect(discord.posts.map((post) => post.channel)).toEqual([channel]);
      expect([...discord.buttons().keys()]).toEqual(["Approve Once", "Deny"]);
      discord.click(discord.edits[0]!.id, discord.buttons().get("Approve Once")!);
      await observeUntil(
        () => rt.observe(ref),
        (seen) => seen.status === "idle" && seen.dialogs.length === 0,
      );
      expect(f.frames().filter((frame) => frame["type"] === "extension_ui_response")).toEqual([
        { type: "extension_ui_response", id: request.id, value: "Approve Once" },
      ]);
      await until(() => discord.edits.some((edit) => edit.components?.length === 0), 10_000);
      expect(discord.edits.at(-1)?.content).toContain("approved once by the owner");
      expect(session).toBe(blocked.sessionId!);
    } finally {
      await done();
    }
  },
  40_000,
);

test.skipIf(process.platform === "win32")(
  "without the opt-in the lead's approval stays local and nothing reaches Discord",
  async () => {
    const { f, discord, rt, ref, session, done } = await lead(false);
    try {
      expect(await rt.deliver(ref, "request approval")).toMatchObject({ kind: "delivered" });
      const blocked = await observeUntil(
        () => rt.observe(ref),
        (seen) => seen.dialogs.length > 0,
      );
      await rt.answer(ref, blocked.dialogs[0]!.id, { value: "Deny" }, session);
      await observeUntil(
        () => rt.observe(ref),
        (seen) => seen.status === "idle",
      );
      expect(f.frames().filter((frame) => frame["type"] === "extension_ui_response")).toEqual([
        { type: "extension_ui_response", id: blocked.dialogs[0]!.id, value: "Deny" },
      ]);
      expect(discord.posts).toEqual([]);
      expect(discord.connected()).toBe(0);
    } finally {
      await done();
    }
  },
  40_000,
);
