import { discordGateway, type GatewaySocket } from "./discord-gateway.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { fetchHttp } from "./http.ts";

export type ButtonSocket = (url: string) => GatewaySocket;

/** One message's buttons: only `owner` may press them, and each custom ID stands for exactly one answer. */
export type ButtonBinding<T> = {
  readonly owner: string;
  readonly channel: string;
  readonly message: string;
  readonly answers: ReadonlyMap<string, T>;
  /** The ephemeral reply anyone other than the owner receives. */
  readonly denial: string;
};
export type ButtonConnection<T> = {
  readonly answer: Promise<{ data: T }>;
  isSubmitting(): boolean;
  close(): void;
};
export type ButtonEndpoint = {
  readonly base: string;
  readonly apiOverride: string;
  readonly open: ButtonSocket | undefined;
};
const clock = {
  now: Date.now,
  random: Math.random,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (value: unknown) => {
    if (typeof value === "number" || (value && typeof value === "object" && "hasRef" in value))
      clearTimeout(value as ReturnType<typeof setTimeout>);
  },
};
export const openBotSocket: ButtonSocket = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
    onMessage: (cb) =>
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") cb(event.data);
      }),
    onClose: (cb) => socket.addEventListener("close", (event) => cb(event.code)),
    onError: (cb) => socket.addEventListener("error", () => cb()),
  };
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Interaction-only Gateway: does not subscribe to chat or alter presence. The first confirmed owner click wins. */
export async function openDiscordButtons<T>(
  token: string,
  binding: ButtonBinding<T>,
  signal: AbortSignal,
  { base, apiOverride, open }: ButtonEndpoint,
): Promise<ButtonConnection<T> | undefined> {
  if (!open && apiOverride) return undefined; // Never send a fixture credential to Discord's real Gateway.
  if (signal.aborted) return undefined;
  const answer = Promise.withResolvers<{ data: T }>();
  const ready = Promise.withResolvers<boolean>();
  let accepting = false;
  let submitting = false;
  let settled = false;
  const application = await fetchHttp({
    method: "GET",
    url: `${base}/applications/@me`,
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  });
  if (application.status !== 200) return undefined;
  const info: unknown = JSON.parse(application.body);
  if (!object(info) || !isDiscordSnowflake(info["id"]) || info["interactions_endpoint_url"]) return undefined;
  const app = info["id"];
  if (signal.aborted) return undefined;
  const handle = async (type: string, event: unknown) => {
    if (type !== "INTERACTION_CREATE" || !accepting || signal.aborted || !object(event)) return;
    const { id, token: callback, application_id, channel_id, channel, message, member, user, data } = event;
    if (
      event["type"] !== 3 ||
      application_id !== app ||
      !isDiscordSnowflake(id) ||
      typeof callback !== "string" ||
      !/^[\w.-]{1,1024}$/.test(callback) ||
      (channel_id ?? (object(channel) ? channel["id"] : undefined)) !== binding.channel ||
      !object(message) ||
      message["id"] !== binding.message ||
      (message["channel_id"] !== undefined && message["channel_id"] !== binding.channel) ||
      !object(data) ||
      data["component_type"] !== 2 ||
      typeof data["custom_id"] !== "string"
    )
      return;
    if (!binding.answers.has(data["custom_id"])) return;
    const picked = binding.answers.get(data["custom_id"]) as T;
    const author = object(member) ? member["user"] : user;
    const allowed = object(author) && author["id"] === binding.owner && author["bot"] !== true;
    if (allowed && submitting) return;
    if (allowed) submitting = true;
    try {
      const res = await fetchHttp({
        method: "POST",
        url: `${base}/interactions/${id}/${callback}/callback`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          allowed
            ? { type: 6 }
            : { type: 4, data: { flags: 64, content: binding.denial, allowed_mentions: { parse: [] } } },
        ),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_500)]),
      });
      if (allowed && (res.status === 200 || res.status === 204) && !signal.aborted) {
        settled = true;
        accepting = false;
        answer.resolve({ data: picked });
      }
    } finally {
      if (allowed) submitting = false;
    }
  };
  const gateway = discordGateway(open ?? openBotSocket, token, clock, () => {}, {
    label: "BUTTONS",
    intents: 0,
    online: false,
    onReady() {
      accepting = !settled;
      ready.resolve(accepting);
    },
    onDisconnect() {
      accepting = false;
    },
    onDispatch(type, event) {
      void handle(type, event).catch(() => {
        /* Discord did not confirm the click; the button may be pressed again. */
      });
    },
  });
  const close = () => {
    accepting = false;
    gateway.close();
    signal.removeEventListener("abort", close);
    ready.resolve(false);
  };
  signal.addEventListener("abort", close, { once: true });
  void gateway.done.then(close, close);
  const deadline = setTimeout(() => ready.resolve(false), 3_000);
  const available = await ready.promise;
  clearTimeout(deadline);
  if (!available || !accepting) {
    close();
    return undefined;
  }
  return { answer: answer.promise, isSubmitting: () => submitting, close };
}
