import type { ServerWebSocket } from "bun";

export const app = "109867692300000071";
export const channel = "109867692300000072";
export const owner = "109867692300000073";
export const stranger = "109867692300000074";
export const token = "fixture-approval-token";

type Body = Record<string, unknown> & {
  readonly content?: string;
  readonly components?: readonly { readonly components: readonly { label: string; custom_id: string }[] }[];
};

/** A loopback Discord: REST messages, interaction callbacks and an interaction-only Gateway. */
export function fakeDiscord() {
  const posts: (Body & { channel: string })[] = [];
  const edits: (Body & { id: string })[] = [];
  const callbacks: number[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let seq = 1;
  let interaction = 100;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/gateway") return srv.upgrade(req) ? undefined : new Response(null, { status: 400 });
      if (url.pathname.startsWith("/api/v10/interactions/")) {
        callbacks.push(((await req.json()) as { type: number }).type);
        return new Response(null, { status: 204 });
      }
      if (req.headers.get("authorization") !== `Bot ${token}`) return new Response(null, { status: 401 });
      if (url.pathname === "/api/v10/applications/@me") return Response.json({ id: app });
      const match = /^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(url.pathname);
      if (match?.[1] && !match[2] && req.method === "POST") {
        posts.push({ ...((await req.json()) as Body), channel: match[1] });
        return Response.json({ id: `1098676923000002${String(posts.length).padStart(2, "0")}` });
      }
      if (match?.[2] && req.method === "PATCH") {
        edits.push({ ...((await req.json()) as Body), id: match[2] });
        return Response.json({ id: match[2] });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      },
      message(ws, data) {
        const payload = JSON.parse(String(data)) as { op: number };
        // The client accepts only a Discord resume host; the injected socket opener ignores it.
        const ready = { session_id: "fixture", resume_gateway_url: "wss://gateway.discord.gg" };
        if (payload.op === 2) ws.send(JSON.stringify({ op: 0, s: seq++, t: "READY", d: ready }));
        if (payload.op === 1) ws.send(JSON.stringify({ op: 11 }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  const gateway = `ws://127.0.0.1:${server.port}/gateway`;
  /** The buttons of the latest edit that showed any, as label → custom ID. */
  const buttons = () =>
    new Map(
      (edits.findLast((edit) => edit.components?.length)?.components ?? []).flatMap((row) =>
        row.components.map((button) => [button.label, button.custom_id] as const),
      ),
    );
  const click = (message: string, customId: string, actor = owner) => {
    const frame = JSON.stringify({
      op: 0,
      s: seq++,
      t: "INTERACTION_CREATE",
      d: {
        type: 3,
        id: `1098676923000003${interaction++}`,
        application_id: app,
        token: "fixture-interaction-token",
        channel_id: channel,
        member: { user: { id: actor } },
        message: { id: message },
        data: { component_type: 2, custom_id: customId },
      },
    });
    for (const socket of sockets) socket.send(frame);
  };
  return {
    api: `http://127.0.0.1:${server.port}/api/v10`,
    gateway,
    posts,
    edits,
    callbacks,
    buttons,
    click,
    connected: () => sockets.size,
    stop: () => server.stop(true),
  };
}

/**
 * Wait for a state the code under test reaches by itself over loopback HTTP and WebSocket traffic, which exposes no
 * completion event to await. Bounded so a regression fails instead of hanging.
 */
export async function until(ready: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}
