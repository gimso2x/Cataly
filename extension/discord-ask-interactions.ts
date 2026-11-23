import {
  type ButtonConnection,
  type ButtonEndpoint,
  type ButtonSocket,
  openDiscordButtons,
} from "../skills/cataly-mode/scripts/src/messenger/discord-buttons.ts";
import type { AskData } from "./discord-ask-form.ts";

export type AskButtonSocket = ButtonSocket;

type AskButtonBinding = {
  readonly owner: string;
  readonly channel: string;
  readonly question: string;
  readonly answers: ReadonlyMap<string, AskData>;
};

/** The ASK card's buttons: only the ASK owner can answer, and the first confirmed click wins. */
export function openAskButtons(
  token: string,
  { question, ...binding }: AskButtonBinding,
  signal: AbortSignal,
  endpoint: ButtonEndpoint,
): Promise<ButtonConnection<AskData> | undefined> {
  return openDiscordButtons(
    token,
    { ...binding, message: question, denial: "Only the owner of this ASK can answer." },
    signal,
    endpoint,
  );
}
