import { type DiscordApprovals, discordApprovals } from "./headless-discord-approval.ts";
import { HeadlessEvents } from "./headless-events.ts";
import { beginNativeGoal, launchModelFromArgv } from "./headless-launch-model.ts";
import { answerFrame, type HeadlessObservation, type HeadlessRequest } from "./headless-protocol.ts";
import { type HostStart, type Reservation, serveHost } from "./headless-record.ts";
import { deliverLocal, HeadlessRemoteCommands, isRemoteCommand, type NativeState } from "./headless-remote.ts";
import { type HeadlessRpc, nativeStateOf, proveNativeRole, setNativeGoal, startRpc } from "./headless-rpc.ts";
import type { AgentStatus } from "./types.ts";

class Broker {
  private readonly events = new HeadlessEvents();
  private readonly dialogs = this.events.dialogs;
  private readonly remote = new HeadlessRemoteCommands();
  private bound: NativeState | undefined;
  private state: NativeState | undefined;
  private stateRead: Promise<NativeState | undefined> | undefined;
  private rpc: HeadlessRpc | undefined;
  private approvals: DiscordApprovals | undefined;
  private expectedModel: string | undefined;
  private detail: string | undefined;
  private mutation = false;
  private stopping = false;
  private fault = false;
  closedSessionId: string | undefined;

  constructor(private readonly reservation: Reservation) {}

  async start(start: HostStart, overlay: string): Promise<number> {
    const { cwd, ref } = this.reservation;
    this.expectedModel = launchModelFromArgv(start.argv);
    const rpc = await startRpc(
      start,
      cwd,
      ref.id,
      overlay,
      (frame) => {
        this.events.record(frame);
        this.approvals?.sync();
      },
      () => {
        this.fault = true;
        if (!this.stopping) this.detail = "OMP RPC stream disconnected or became untrustworthy";
      },
    );
    this.rpc = rpc;
    try {
      const role = this.harnessRole;
      const bound = await proveNativeRole(
        rpc,
        () => this.refresh(),
        start.expectedResumeId,
        role ? { role, refId: ref.id } : undefined,
      );
      this.bound = bound;
      const expectedSessionId = bound.sessionId;
      this.approvals = discordApprovals(
        start.env,
        { refId: ref.id, role, sessionId: expectedSessionId },
        this.dialogs,
        (requestId, value) => this.handle({ op: "answer", expectedSessionId, requestId, answer: { value } }),
      );
      return await rpc.exited.finally(() => this.approvals?.close());
    } catch (error) {
      this.detail = error instanceof Error ? error.message : String(error);
      // A stalled native exit is still live; do not publish a stopped receipt while it owns the session.
      if (!this.dialogs.size && this.state?.settled && !this.fault) await rpc.shutdown().catch(() => rpc.exited);
      else await rpc.exited;
      throw error;
    }
  }

  private get harnessRole() {
    const { role } = this.reservation;
    return role === "lead" || role === "duty" ? role : undefined;
  }

  private async refresh(): Promise<NativeState | undefined> {
    if (!this.rpc || this.fault || this.stopping) return undefined;
    this.stateRead ??= (async () => {
      const state = nativeStateOf(await this.rpc?.request({ type: "get_state" }));
      if (!state) return undefined;
      if (this.bound && (this.bound.sessionId !== state.sessionId || this.bound.sessionFile !== state.sessionFile)) {
        this.fault = true;
        this.detail = "OMP changed its bound transcript";
        return undefined;
      }
      this.state = state;
      if (state.settled) this.events.activeSince = undefined;
      return state;
    })().finally(() => {
      this.stateRead = undefined;
    });
    return this.stateRead;
  }

  private snapshot(state: NativeState | undefined): HeadlessObservation {
    const { ref, cwd, startedAt } = this.reservation;
    const held = this.dialogs.size > 0 || this.fault || this.stopping || !state || !this.bound;
    const status: AgentStatus = this.fault
      ? "error"
      : this.dialogs.size > 0 || state?.goal.status === "blocked"
        ? "blocked"
        : !state || !this.bound || this.stopping
          ? "unknown"
          : state.settled
            ? "idle"
            : "working";
    return {
      ref,
      cwd,
      startedAt,
      updatedAt: new Date().toISOString(),
      status,
      held,
      ...(this.rpc ? { pid: this.rpc.pid } : {}),
      ...(this.bound && !this.fault && this.state
        ? {
            role: this.harnessRole ? "cataly" : "lane",
            ...(this.harnessRole ? { harnessRole: this.harnessRole } : {}),
            sessionId: this.bound.sessionId,
            sessionFile: this.bound.sessionFile,
            goal: this.state.goal,
            ...(this.state.model === undefined ? {} : { model: this.state.model }),
          }
        : {}),
      ...(this.events.activeSince !== undefined ? { activeSince: this.events.activeSince } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      dialogs: [...this.dialogs.values()],
      recent: this.events.recent.slice(),
    };
  }

  private async observe(): Promise<HeadlessObservation> {
    // Reading during a dialog or initial handshake does not queue behind it. No mutation or answer is issued here.
    if (!this.bound || this.dialogs.size || this.stopping)
      return this.snapshot(this.dialogs.size ? this.state : undefined);
    return this.snapshot(await this.refresh().catch(() => undefined));
  }

  private async check(expected: string | undefined): Promise<NativeState> {
    if (
      !this.bound ||
      this.dialogs.size ||
      this.fault ||
      this.stopping ||
      (expected !== undefined && expected !== this.bound.sessionId)
    )
      throw new Error("native identity or actionable dialog holds this operation");
    const state = await this.refresh();
    if (!state || this.dialogs.size || this.fault || this.stopping)
      throw new Error("native identity or actionable dialog holds this operation");
    return state;
  }

  async handle(request: HeadlessRequest): Promise<unknown> {
    if (request.op === "observe") return this.observe();
    const rpc = this.rpc;
    if (!rpc) throw new Error("OMP process has not started");
    if (isRemoteCommand(request)) {
      if (this.harnessRole) throw new Error("native harness roles use the harness controls");
      return this.remote.handle(request, {
        rpc,
        boundSessionId: this.fault ? undefined : this.bound?.sessionId,
        check: (session) => this.check(session),
        exclusive: (operation) => this.exclusive(operation),
        shutdown: (session) => this.shutdown(rpc, session),
      });
    }
    if (request.op === "answer") {
      if (this.fault || this.stopping || !this.bound || request.expectedSessionId !== this.bound.sessionId)
        throw new Error("native dialog session does not match");
      const state = await this.refresh().catch(() => undefined);
      if (!state || this.fault || this.stopping) throw new Error("native dialog session readback unconfirmed");
      const dialog = this.dialogs.get(request.requestId);
      const frame = dialog && answerFrame(dialog, request.answer);
      if (!dialog || !frame) throw new Error("no matching native dialog or unsupported answer");
      // No answer replay after attempting the write; RPC UI replies do not have an ack.
      this.dialogs.delete(dialog.id);
      this.approvals?.sync();
      try {
        rpc.send(frame);
      } catch {
        this.fault = true;
        throw new Error("native answer delivery ambiguous; do not resend");
      }
      return { submitted: true };
    }
    return this.exclusive(async () => {
      switch (request.op) {
        case "deliver": {
          const state = await this.check(request.options.expectedSessionId).catch(() => undefined);
          return state
            ? deliverLocal(rpc, state, request.text, request.options)
            : { kind: "not-ready", status: this.dialogs.size ? "blocked" : "unknown" };
        }
        case "begin": {
          if (this.harnessRole) throw new Error("harness role cannot start a lane goal");
          const modelReadback = await beginNativeGoal(rpc, request, {
            reservation: this.reservation,
            model: this.expectedModel,
            check: (session) => this.check(session),
          });
          return { ...(await this.observe()), ...(modelReadback ? { modelReadback } : {}) };
        }
        case "goal": {
          if (this.harnessRole) throw new Error("harness role cannot change a lane goal");
          await setNativeGoal(rpc, request.target, () => this.check(request.expectedSessionId));
          return await this.observe();
        }
        case "close": {
          const state = await this.check(request.expectedSessionId);
          if (!state.settled) throw new Error("only a settled OMP session can close");
          await this.shutdown(rpc, state.sessionId);
          return { closed: true };
        }
        default:
          throw new Error("Unsupported headless operation");
      }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutation) throw new Error("another headless operation is in flight");
    this.mutation = true;
    try {
      return await operation();
    } finally {
      this.mutation = false;
    }
  }

  private async shutdown(rpc: HeadlessRpc, session: string): Promise<void> {
    this.stopping = true;
    this.closedSessionId = session;
    await rpc.shutdown();
  }
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir) {
    const { NativeLoop } = await import("./headless-loop.ts");
    await serveHost(dir, (reservation) => {
      const { role } = reservation;
      return role === "duty-loop" || role === "hourly-loop"
        ? new NativeLoop(reservation, role)
        : new Broker(reservation);
    });
  }
}
