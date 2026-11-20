/** dori inbound telegram: the owner-gated Telegram receiver. */
import { die } from "./cli-context.ts";
import type { DoriConfig } from "./config.ts";
import { fetchHttp, MessengerError } from "./messenger/http.ts";
import { conversationRecall } from "./messenger/recall-ledger.ts";
import { Telegram } from "./messenger/telegram.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { inboundLagLog } from "./messenger/telegram-lag.ts";
import { realClock } from "./run.ts";

export const telegramInbound = async (config: DoriConfig, minutes: number): Promise<void> => {
  const { stateDir } = config;
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["DORI_TELEGRAM_TOKEN"] || die("DORI_TELEGRAM_TOKEN is not set"),
  );
  const store = fileTgInboundStore(`${stateDir}/telegram-offset`);
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("DORI_TELEGRAM_OWNER_ID");
  // One warning per process: a token that cannot react must not flood the receiver log on every message.
  let reactWarned = false;
  const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
  const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID");
  // Authentication and transport readiness must finish before advertising or consuming inbound work.
  const identity = await tg.call<{ id?: unknown; is_bot?: unknown }>("getMe", {}).catch(() => {
    throw new MessengerError("Telegram inbound bot identity could not be verified; check token and API access", 0);
  });
  if (
    !identity ||
    identity.is_bot !== true ||
    typeof identity.id !== "number" ||
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0
  )
    throw new MessengerError("Telegram getMe returned an invalid bot identity", 0);
  const webhook = await tg.call<{ url?: unknown }>("getWebhookInfo", {}).catch(() => {
    throw new MessengerError("Telegram inbound webhook status could not be verified; check API access", 0);
  });
  if (typeof webhook?.url !== "string")
    throw new MessengerError("Telegram getWebhookInfo returned an invalid webhook status", 0);
  if (webhook.url !== "")
    throw new MessengerError("Telegram inbound refused an active webhook; use a polling bot (webhook unchanged)", 409);
  console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
  // The INBOUND line stays exactly as monitors parse it; receive lag goes to its own jsonl.
  const recall = conversationRecall(config, (warning) => console.log(`WARN ${warning}`.slice(0, 300)));
  const recordLag = inboundLagLog(`${stateDir}/telegram-lag.jsonl`, (m) => console.log(`WARN ${m}`.slice(0, 300)));
  await telegramInboundLoop(
    tg,
    store,
    {
      ownerId,
      ...(groupChatId !== undefined ? { groupChatId } : {}),
      ...(topicId !== undefined ? { topicId } : {}),
    },
    minutes,
    (i) => {
      // A DM and a group are separate spaces; an edit replaces an owner message already kept, so it is not added.
      const recalled =
        i.kind === "message"
          ? recall?.owner({
              platform: "telegram",
              channel: String(i.chat),
              thread: i.thread === undefined ? String(i.chat) : `${i.chat}/${i.thread}`,
              ref: String(i.messageId ?? `u${i.updateId}`),
              text: i.text ?? "",
            })
          : undefined;
      console.log(recalled ? `${formatTelegramInbound(i)}\n${recalled}` : formatTelegramInbound(i));
      recordLag(i, realClock.now());
      // Read receipt: the owner sees the message was picked up the moment it is received.
      // One reaction only (never a bubble — it would clear the typing indicator), and a
      // failed reaction must never cost the message, so it is warned once and dropped.
      if (i.kind === "message" && i.messageId !== undefined) {
        const target = { chatId: i.chat, ...(i.thread !== undefined && i.thread !== 1 ? { threadId: i.thread } : {}) };
        void tg.react(target, i.messageId, "👀").catch((e: unknown) => {
          if (reactWarned) return;
          reactWarned = true;
          console.log(
            `WARN reaction failed (${e instanceof Error ? e.message : String(e)}); still answering`.slice(0, 300),
          );
        });
      }
    },
    (m) => console.log(`WARN ${m}`.slice(0, 300)),
  );
};
