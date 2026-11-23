import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DISCORD_APPROVALS_ENV } from "../../skills/cataly-mode/scripts/src/messenger/discord-approval-config.ts";
import {
  automaticDiscordAskRoute,
  type DiscordTokenRoute,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-ask-route.ts";
import {
  type ButtonConnection,
  type ButtonSocket,
  openBotSocket,
  openDiscordButtons,
} from "../../skills/cataly-mode/scripts/src/messenger/discord-buttons.ts";
import { isDiscordSnowflake } from "../../skills/cataly-mode/scripts/src/messenger/discord-inbound-state.ts";
import { Discord, discordApiBase } from "../../skills/cataly-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "../../skills/cataly-mode/scripts/src/messenger/http.ts";
import type { HeadlessDialog, NativeHarnessRole } from "./headless-protocol.ts";

/** Only the single-call answers. Session and remembered grants never become buttons. */
const SINGLE_CALL = ["Approve", "Approve Once", "Deny"] as const;
type SingleCall = (typeof SINGLE_CALL)[number];
const DETAIL_LIMIT = 800;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const mentions = { parse: [], replied_user: false };
const TIMED_OUT = Symbol("timed out");
const CLOSED = Symbol("closed");

const SECRETS: readonly [RegExp, string][] = [
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=("[^"]*"|'[^']*'|[^\s"';&|]+)/gi, "$1=[REDACTED]"],
  [/(Authorization:\s*)[^\n"']+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,40}/g, "[REDACTED]"],
  [/\b(sk-|xox[abp]-|ghp_|github_pat_)[\w-]+/g, "$1[REDACTED]"],
];

/** Hide credential-shaped text, then cut to the card limit. Masking first keeps a cut from exposing half a secret. */
export function maskApprovalText(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRETS) masked = masked.replace(pattern, replacement);
  return masked.length > DETAIL_LIMIT ? `${masked.slice(0, DETAIL_LIMIT)}…` : masked;
}

export type ApprovalCard = { readonly content: string; readonly choices: readonly SingleCall[] };

/** The card for one native approval prompt (`Allow tool:`, optional `Reason:`, then the tool's own details). */
export function approvalCard(dialog: HeadlessDialog, role: string): ApprovalCard | undefined {
  const approve = dialog.options?.find((option) => option === "Approve" || option === "Approve Once");
  if (dialog.kind !== "approval" || !approve || !dialog.options?.includes("Deny")) return undefined;
  const text = Bun.stripANSI(dialog.title ?? dialog.message ?? "").replace(/[^\P{Cc}\n\t]/gu, "");
  const lines = text.split("\n");
  const tool = lines.find((line) => line.startsWith("Allow tool: "))?.slice("Allow tool: ".length);
  const reason = lines.find((line) => line.startsWith("Reason: "))?.slice("Reason: ".length);
  const details = lines.filter((line) => !line.startsWith("Allow tool: ") && !line.startsWith("Reason: ")).join("\n");
  const plain = (value: string) => value.replace(/[`*_~|\\<>@#]/g, "").slice(0, 120);
  const content = [
    `**Cataly approval needed** (${role})`,
    `Tool: \`${plain(tool ?? "unknown") || "unknown"}\``,
    ...(reason ? [`⚠️ **Reason: ${plain(reason)}**`] : []),
    ...(details.trim() ? ["```text", maskApprovalText(details.trim()).replaceAll("```", "`\u200b``"), "```"] : []),
    `${approve} runs this one call only; Deny refuses it. Nothing is approved automatically.`,
  ].join("\n");
  return { content, choices: [approve, "Deny"] };
}

type Options = {
  readonly role: string;
  readonly route: () => Promise<DiscordTokenRoute | undefined>;
  readonly submit: (dialogId: string, value: SingleCall) => Promise<unknown>;
  readonly apiOverride: string;
  readonly open: ButtonSocket | undefined;
  readonly timeoutMs?: number;
};

/** Mirrors pending native approval dialogs to owner-only Discord buttons. The local dialog always stays answerable. */
export class DiscordApprovals {
  readonly #cards = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;

  constructor(
    private readonly dialogs: ReadonlyMap<string, HeadlessDialog>,
    private readonly options: Options,
  ) {}

  /** Call whenever the dialog set changes: new approvals get a card, vanished ones close theirs. */
  sync(): void {
    if (this.#closed) return;
    for (const [id, card] of this.#cards) {
      if (this.dialogs.has(id)) continue;
      card.abort();
      this.#cards.delete(id);
    }
    for (const dialog of this.dialogs.values()) {
      if (dialog.kind !== "approval" || this.#cards.has(dialog.id)) continue;
      const card = new AbortController();
      this.#cards.set(dialog.id, card);
      const shown = this.#present(dialog, card.signal).catch(() => {
        /* Discord is best-effort; the native dialog is unchanged. */
      });
      this.#pending.add(shown);
      void shown.finally(() => this.#pending.delete(shown));
    }
  }

  /** The session ended: close every card and give the closing edits a moment to land. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const card of this.#cards.values()) card.abort();
    this.#cards.clear();
    if (this.#pending.size === 0) return;
    const grace = Promise.withResolvers<void>();
    // Unreferenced: a stalled Discord edit must not keep the exiting supervisor alive.
    const timer = setTimeout(grace.resolve, 4_000).unref();
    await Promise.race([Promise.allSettled([...this.#pending]), grace.promise]);
    clearTimeout(timer);
  }

  async #present(dialog: HeadlessDialog, signal: AbortSignal): Promise<void> {
    const card = approvalCard(dialog, this.options.role);
    const route = card && (await this.options.route());
    if (!card || !route || signal.aborted) return;
    const { apiOverride, open } = this.options;
    const base = discordApiBase(apiOverride);
    const discord = new Discord(fetchHttp, { now: Date.now, sleep: Bun.sleep }, route.token, base);
    const path = `/channels/${route.channel}/messages`;
    const posted = await discord.call<{ id?: unknown }>(
      "POST",
      path,
      {
        content: `${card.content}\n\nConnecting the buttons…`,
        allowed_mentions: mentions,
        nonce: randomUUID().replaceAll("-", "").slice(0, 24),
        enforce_nonce: true,
      },
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    const message = posted?.id;
    if (!isDiscordSnowflake(message)) return;
    let status = "Closed: answered locally, cancelled, or the session ended. Nothing was approved from Discord.";
    let buttons: ButtonConnection<SingleCall> | undefined;
    try {
      const prefix = `cataly-approval:${randomUUID()}`;
      const answers = new Map(card.choices.map((choice, index) => [`${prefix}:${index}`, choice]));
      const denial = "Only the Cataly owner can answer this approval.";
      const binding = { owner: route.owner, channel: route.channel, message, answers, denial };
      buttons = await openDiscordButtons(route.token, binding, signal, { base, apiOverride, open });
      if (!buttons) {
        if (!signal.aborted) status = "Discord buttons are unavailable. Answer this approval in the local session.";
        return;
      }
      const components = [...answers].map(([custom_id, label]) => ({
        type: 2,
        style: label === "Deny" ? 4 : 3,
        label,
        custom_id,
      }));
      await discord.call(
        "PATCH",
        `${path}/${message}`,
        { content: card.content, allowed_mentions: mentions, components: [{ type: 1, components }] },
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
      const expired = Promise.withResolvers<typeof TIMED_OUT>();
      const timer = setTimeout(() => expired.resolve(TIMED_OUT), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const closed = Promise.withResolvers<typeof CLOSED>();
      if (signal.aborted) closed.resolve(CLOSED);
      else signal.addEventListener("abort", () => closed.resolve(CLOSED), { once: true });
      const outcome = await Promise.race([
        buttons.answer.then((answer) => answer.data),
        closed.promise,
        expired.promise,
      ]);
      clearTimeout(timer);
      if (outcome === TIMED_OUT)
        status = "Timed out. Nothing was approved; the call still waits for an answer in the local session.";
      else if (outcome !== CLOSED) {
        status = await this.options.submit(dialog.id, outcome).then(
          () => (outcome === "Deny" ? "Denied by the owner." : `${outcome}: approved once by the owner.`),
          () => "This approval was already answered or closed; the click was not applied.",
        );
      }
    } finally {
      buttons?.close();
      const closing = `${card.content}\n\n${status}`;
      await discord
        .call(
          "PATCH",
          `${path}/${message}`,
          { content: closing.length <= 2_000 ? closing : status, allowed_mentions: mentions, components: [] },
          AbortSignal.timeout(3_000),
        )
        .catch(() => undefined);
    }
  }
}

/** Opted-in lead and lane brokers only; the token is read from `$CATALY_HOME/discord-token` in this process. */
export function discordApprovals(
  env: Readonly<Record<string, string | undefined>>,
  target: { readonly refId: string; readonly role: NativeHarnessRole | undefined; readonly sessionId: string },
  dialogs: ReadonlyMap<string, HeadlessDialog>,
  submit: Options["submit"],
): DiscordApprovals | undefined {
  const stateDir = env["CATALY_STATE_DIR"];
  const { refId, sessionId } = target;
  // Duty has no Discord ASK destination; a broker without a harness role is a lane.
  const role = target.role === undefined ? "lane" : target.role === "lead" ? "lead" : undefined;
  if (env[DISCORD_APPROVALS_ENV] !== "1" || !role || !stateDir || !isAbsolute(stateDir)) return undefined;
  const routeEnv = { ...env, CATALY_HEADLESS_ID: refId, CATALY_DISCORD_TOKEN: undefined };
  const apiOverride = env["CATALY_DISCORD_API_BASE"] ?? "";
  // A fixture Gateway is honored only with a fixture API, so a test credential never reaches Discord.
  const gateway = apiOverride ? env["CATALY_DISCORD_GATEWAY_URL"] : undefined;
  const approvals = new DiscordApprovals(dialogs, {
    role,
    route: () =>
      automaticDiscordAskRoute(stateDir, role === "lead" ? "cataly" : "lane", sessionId, undefined, routeEnv),
    submit,
    apiOverride,
    open: gateway ? () => openBotSocket(gateway) : undefined,
  });
  // A prompt can arrive while the session identity is still being proven.
  approvals.sync();
  return approvals;
}
