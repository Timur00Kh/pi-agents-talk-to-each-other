import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_VERSION = "0.1.0";
const HEARTBEAT_MS = 2_000;
const INBOX_POLL_MS = 1_000;
const ACTIVE_TTL_MS = 30_000;
const MAX_PREVIEW_CHARS = 180;

const hostname = os.hostname().replace(/[^a-zA-Z0-9_.-]+/g, "-");
const AGENT_ID = `agent-${hostname}-${process.pid}`;

type AgentStatus = "idle" | "busy" | "tool" | "offline";
type ControlAction = "compact" | "reload" | "new_session";

interface RoomConfig {
  defaultRoom?: string;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

interface AgentRecord {
  id: string;
  room: string;
  status: AgentStatus;
  pid: number;
  hostname: string;
  cwd: string;
  sessionFile?: string;
  model?: string;
  currentTool?: string;
  currentToolPreview?: string;
  contextTokens?: number;
  contextPercent?: number;
  tokenTotals?: TokenTotals;
  startedAt: number;
  lastSeen: number;
  version: string;
}

interface RoomMessage {
  id: string;
  kind: "message" | "control";
  room: string;
  from: string;
  to: string;
  createdAt: number;
  text?: string;
  action?: ControlAction;
  instructions?: string;
  kickoff?: string;
}

interface RuntimeState {
  room?: string;
  status: AgentStatus;
  currentTool?: string;
  currentToolPreview?: string;
  startedAt: number;
}

const state: RuntimeState = {
  status: "idle",
  startedAt: Date.now(),
};

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let inboxTimer: ReturnType<typeof setInterval> | undefined;
const pendingControls = new Map<string, RoomMessage>();

function roomsRoot(): string {
  return path.join(getAgentDir(), "rooms");
}

function configPath(): string {
  return path.join(roomsRoot(), "config.json");
}

function sanitizeRoomName(room: string): string {
  const clean = room.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("Room name is empty. Use letters, numbers, dot, underscore or dash.");
  return clean.slice(0, 80);
}

function roomDir(room: string): string {
  return path.join(roomsRoot(), sanitizeRoomName(room));
}

function agentsDir(room: string): string {
  return path.join(roomDir(room), "agents");
}

function inboxDir(room: string, agentId = AGENT_ID): string {
  return path.join(roomDir(room), "inbox", agentId);
}

function ensureRoom(room: string): void {
  fs.mkdirSync(agentsDir(room), { recursive: true });
  fs.mkdirSync(inboxDir(room), { recursive: true });
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readConfig(): RoomConfig {
  return readJson<RoomConfig>(configPath()) ?? {};
}

function writeConfig(config: RoomConfig): void {
  writeJsonAtomic(configPath(), config);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function truncate(text: string, max = MAX_PREVIEW_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function maskSensitive(text: string): string {
  return text
    .replace(/:([^:@\s/]+)@/g, ":****@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ****")
    .replace(/(api[_-]?key|token|secret|password|passwd|authorization)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2****");
}

function previewArgs(args: unknown): string {
  try {
    const raw = typeof args === "string" ? args : JSON.stringify(args);
    return truncate(maskSensitive(raw ?? ""));
  } catch {
    return "(unserializable arguments)";
  }
}

function modelLabel(ctx: ExtensionContext): string | undefined {
  const model = (ctx as any).model;
  if (!model) return undefined;
  if (typeof model === "string") return model;
  const provider = model.provider ? `${model.provider}/` : "";
  return `${provider}${model.id ?? model.name ?? "unknown"}`;
}

function tokenTotals(ctx: ExtensionContext): TokenTotals | undefined {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  let sawUsage = false;

  try {
    for (const entry of ctx.sessionManager.getEntries() as any[]) {
      const message = entry?.message ?? entry?.data?.message ?? entry;
      const usage = message?.usage;
      if (!usage) continue;
      sawUsage = true;
      totals.input += Number(usage.input ?? 0);
      totals.output += Number(usage.output ?? 0);
      totals.cacheRead += Number(usage.cacheRead ?? 0);
      totals.cacheWrite += Number(usage.cacheWrite ?? 0);
      totals.total += Number(usage.totalTokens ?? usage.tokens ?? 0);
      totals.cost += Number(usage.cost?.total ?? usage.cost ?? 0);
    }
  } catch {
    return undefined;
  }

  return sawUsage ? totals : undefined;
}

function contextInfo(ctx: ExtensionContext): { tokens?: number; percent?: number } {
  const usage = ctx.getContextUsage?.();
  const tokens = Number((usage as any)?.tokens ?? (usage as any)?.totalTokens ?? 0) || undefined;
  let percent = Number((usage as any)?.percent ?? (usage as any)?.percentage ?? 0) || undefined;

  const model = (ctx as any).model;
  const windowSize = Number(model?.contextWindow ?? model?.context_window ?? 0);
  if (!percent && tokens && windowSize) percent = Math.round((tokens / windowSize) * 1000) / 10;
  if (percent && percent <= 1) percent = Math.round(percent * 1000) / 10;

  return { tokens, percent };
}

function agentFile(room: string, agentId = AGENT_ID): string {
  return path.join(agentsDir(room), `${agentId}.json`);
}

function currentRecord(ctx: ExtensionContext, statusOverride?: AgentStatus): AgentRecord | undefined {
  if (!state.room) return undefined;
  const { tokens, percent } = contextInfo(ctx);
  const idleStatus: AgentStatus = ctx.isIdle() ? "idle" : "busy";
  const status = statusOverride ?? (state.status === "tool" ? "tool" : idleStatus);

  return {
    id: AGENT_ID,
    room: state.room,
    status,
    pid: process.pid,
    hostname,
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    model: modelLabel(ctx),
    currentTool: status === "tool" ? state.currentTool : undefined,
    currentToolPreview: status === "tool" ? state.currentToolPreview : undefined,
    contextTokens: tokens,
    contextPercent: percent,
    tokenTotals: tokenTotals(ctx),
    startedAt: state.startedAt,
    lastSeen: Date.now(),
    version: EXTENSION_VERSION,
  };
}

function writeSelf(ctx: ExtensionContext, statusOverride?: AgentStatus): void {
  if (!state.room) return;
  const record = currentRecord(ctx, statusOverride);
  if (!record) return;
  ensureRoom(state.room);
  writeJsonAtomic(agentFile(state.room), record);
}

function writeOffline(room: string, ctx?: ExtensionContext): void {
  const previous = readJson<AgentRecord>(agentFile(room));
  const record: AgentRecord = {
    ...(previous ?? {
      id: AGENT_ID,
      room,
      pid: process.pid,
      hostname,
      cwd: ctx?.cwd ?? process.cwd(),
      startedAt: state.startedAt,
      version: EXTENSION_VERSION,
    }),
    status: "offline",
    currentTool: undefined,
    currentToolPreview: undefined,
    lastSeen: Date.now(),
  };
  writeJsonAtomic(agentFile(room), record);
}

function listAgents(room: string, includeStale = false): AgentRecord[] {
  const dir = agentsDir(room);
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const records: AgentRecord[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = readJson<AgentRecord>(path.join(dir, entry.name));
    if (!record) continue;
    const stale = now - record.lastSeen > ACTIVE_TTL_MS;
    if (!includeStale && (record.status === "offline" || stale)) continue;
    records.push(stale && record.status !== "offline" ? { ...record, status: "offline" } : record);
  }

  return records.sort((a, b) => {
    if (a.id === AGENT_ID) return -1;
    if (b.id === AGENT_ID) return 1;
    return b.lastSeen - a.lastSeen;
  });
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatAgent(record: AgentRecord): string {
  const ctx = record.contextPercent !== undefined ? ` ctx:${record.contextPercent}%` : record.contextTokens ? ` ctx:${record.contextTokens}` : "";
  const tool = record.currentTool ? ` tool:${record.currentTool}` : "";
  const preview = record.currentToolPreview ? ` ${record.currentToolPreview}` : "";
  const model = record.model ? ` model:${record.model}` : "";
  return `${record.id} ${record.status}${tool}${ctx}${model} cwd:${record.cwd}${preview}`;
}

function enqueueMessage(room: string, message: RoomMessage): void {
  ensureRoom(room);
  const targetInbox = inboxDir(room, message.to);
  fs.mkdirSync(targetInbox, { recursive: true });
  writeJsonAtomic(path.join(targetInbox, `${message.id}.json`), message);
  appendJsonLine(path.join(roomDir(room), "events.jsonl"), { type: "enqueue", ...message });
}

function createUserMessage(room: string, to: string, text: string): RoomMessage {
  return {
    id: makeId("msg"),
    kind: "message",
    room,
    from: AGENT_ID,
    to,
    text,
    createdAt: Date.now(),
  };
}

function createControlMessage(
  room: string,
  to: string,
  action: ControlAction,
  instructions?: string,
  kickoff?: string,
): RoomMessage {
  return {
    id: makeId("ctl"),
    kind: "control",
    room,
    from: AGENT_ID,
    to,
    action,
    instructions,
    kickoff,
    createdAt: Date.now(),
  };
}

function connectToRoom(roomInput: string, ctx: ExtensionContext, setDefault: boolean): string {
  const room = sanitizeRoomName(roomInput);
  if (state.room && state.room !== room) disconnect(ctx, true, false);

  state.room = room;
  state.status = ctx.isIdle() ? "idle" : "busy";
  state.currentTool = undefined;
  state.currentToolPreview = undefined;
  ensureRoom(room);
  writeSelf(ctx);
  appendJsonLine(path.join(roomDir(room), "events.jsonl"), {
    type: "join",
    room,
    agentId: AGENT_ID,
    pid: process.pid,
    cwd: ctx.cwd,
    at: Date.now(),
  });

  if (setDefault) writeConfig({ ...readConfig(), defaultRoom: room });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (inboxTimer) clearInterval(inboxTimer);

  heartbeatTimer = setInterval(() => {
    try {
      writeSelf(ctx);
    } catch {
      // Keep the extension non-fatal if the room directory is temporarily unavailable.
    }
  }, HEARTBEAT_MS);

  inboxTimer = setInterval(() => {
    processInbox(piRef!, ctx).catch(() => undefined);
  }, INBOX_POLL_MS);

  return room;
}

function disconnect(ctx: ExtensionContext | undefined, markOffline: boolean, clearDefault: boolean): void {
  const room = state.room;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (inboxTimer) clearInterval(inboxTimer);
  heartbeatTimer = undefined;
  inboxTimer = undefined;

  if (room && markOffline) {
    try {
      writeOffline(room, ctx);
      appendJsonLine(path.join(roomDir(room), "events.jsonl"), {
        type: "leave",
        room,
        agentId: AGENT_ID,
        at: Date.now(),
      });
    } catch {
      // ignore shutdown write failures
    }
  }

  state.room = undefined;
  state.status = "offline";
  state.currentTool = undefined;
  state.currentToolPreview = undefined;

  if (clearDefault) {
    const config = readConfig();
    delete config.defaultRoom;
    writeConfig(config);
  }
}

function roomRequired(): string {
  if (!state.room) throw new Error("This agent is not connected to a room. Run `/room connect <name>` first.");
  return state.room;
}

async function processInbox(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!state.room) return;
  const dir = inboxDir(state.room);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const filePath = path.join(dir, file);
    const message = readJson<RoomMessage>(filePath);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Another reader should not exist, but ignore races.
    }
    if (!message || message.to !== AGENT_ID || message.room !== state.room) continue;
    if (message.from === AGENT_ID) continue;

    appendJsonLine(path.join(roomDir(state.room), "events.jsonl"), {
      type: "deliver",
      room: state.room,
      id: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      at: Date.now(),
    });

    if (message.kind === "message") {
      const text = [
        "[Agent room message]",
        `Room: ${message.room}`,
        `From: ${message.from}`,
        `Message ID: ${message.id}`,
        "",
        message.text ?? "",
        "",
        `If you need to reply, call room_send_message with to = \"${message.from}\". Include your own agent id (${AGENT_ID}) when useful.`,
      ].join("\n");

      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: "followUp" });
      continue;
    }

    if (message.kind === "control") {
      if (message.action === "compact") {
        ctx.compact({
          customInstructions: message.instructions,
          onComplete: () => ctx.ui.notify?.(`Room control compact completed (${message.id})`, "info"),
          onError: (error) => ctx.ui.notify?.(`Room control compact failed: ${error.message}`, "error"),
        });
      } else {
        pendingControls.set(message.id, message);
        const command = `/room-internal-control ${message.id}`;
        if (ctx.isIdle()) pi.sendUserMessage(command);
        else pi.sendUserMessage(command, { deliverAs: "followUp" });
      }
    }
  }
}

let piRef: ExtensionAPI | undefined;

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.on("session_start", async (_event, ctx) => {
    const defaultRoom = readConfig().defaultRoom;
    if (defaultRoom) {
      try {
        const room = connectToRoom(defaultRoom, ctx, false);
        ctx.ui.setStatus?.("agent-room", `room:${room}`);
      } catch (error) {
        ctx.ui.notify?.(`Agent room auto-connect failed: ${(error as Error).message}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disconnect(ctx, true, false);
  });

  pi.on("agent_start", async (_event, ctx) => {
    state.status = "busy";
    state.currentTool = undefined;
    state.currentToolPreview = undefined;
    writeSelf(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    state.status = "idle";
    state.currentTool = undefined;
    state.currentToolPreview = undefined;
    writeSelf(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    state.status = "tool";
    state.currentTool = event.toolName;
    state.currentToolPreview = previewArgs(event.args);
    writeSelf(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    state.status = ctx.isIdle() ? "idle" : "busy";
    state.currentTool = undefined;
    state.currentToolPreview = undefined;
    writeSelf(ctx);
  });

  pi.registerCommand("room", {
    description: "Create/connect/list local Pi agent rooms",
    handler: async (args, ctx) => {
      const [commandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const command = commandRaw ?? "status";

      try {
        if (command === "create" || command === "connect") {
          const roomName = rest[0];
          if (!roomName) {
            ctx.ui.notify("Usage: /room connect <room> [--no-default]", "warning");
            return;
          }
          const setDefault = !rest.includes("--no-default");
          const room = connectToRoom(roomName, ctx, setDefault);
          ctx.ui.setStatus?.("agent-room", `room:${room}`);
          ctx.ui.notify(`Connected to room '${room}' as ${AGENT_ID}${setDefault ? " (saved as default)" : ""}`, "info");
          return;
        }

        if (command === "leave" || command === "disconnect") {
          const keepDefault = rest.includes("--keep-default");
          disconnect(ctx, true, !keepDefault);
          ctx.ui.setStatus?.("agent-room", "room:-");
          ctx.ui.notify(`Left room${keepDefault ? " (default kept)" : ""}`, "info");
          return;
        }

        if (command === "default") {
          const roomName = rest[0];
          if (!roomName || roomName === "off" || roomName === "none" || roomName === "clear") {
            const config = readConfig();
            delete config.defaultRoom;
            writeConfig(config);
            ctx.ui.notify("Default room cleared", "info");
            return;
          }
          const room = sanitizeRoomName(roomName);
          ensureRoom(room);
          writeConfig({ ...readConfig(), defaultRoom: room });
          ctx.ui.notify(`Default room set to '${room}'`, "info");
          return;
        }

        if (command === "whoami") {
          writeSelf(ctx);
          const record = state.room ? readJson<AgentRecord>(agentFile(state.room)) : undefined;
          ctx.ui.notify(record ? JSON.stringify(record, null, 2) : `Not connected. Agent id: ${AGENT_ID}`, "info");
          return;
        }

        if (command === "list" || command === "agents") {
          const room = roomRequired();
          writeSelf(ctx);
          const agents = listAgents(room, rest.includes("--stale"));
          ctx.ui.notify(agents.map(formatAgent).join("\n") || "No active agents", "info");
          return;
        }

        if (command === "send") {
          const to = rest[0];
          const text = rest.slice(1).join(" ");
          if (!to || !text) {
            ctx.ui.notify("Usage: /room send <agent-id> <message>", "warning");
            return;
          }
          const room = roomRequired();
          const message = createUserMessage(room, to, text);
          enqueueMessage(room, message);
          ctx.ui.notify(`Queued message ${message.id} to ${to}`, "info");
          return;
        }

        if (command === "status") {
          const config = readConfig();
          const text = [
            `Agent: ${AGENT_ID}`,
            `Current room: ${state.room ?? "not connected"}`,
            `Default room: ${config.defaultRoom ?? "not set"}`,
            state.room ? `Active agents: ${listAgents(state.room).length}` : undefined,
          ].filter(Boolean).join("\n");
          ctx.ui.notify(text, "info");
          return;
        }

        ctx.ui.notify([
          "Usage:",
          "/room connect <room> [--no-default]",
          "/room create <room>",
          "/room leave [--keep-default]",
          "/room list [--stale]",
          "/room send <agent-id> <message>",
          "/room whoami",
          "/room default <room|off>",
        ].join("\n"), "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("room-internal-control", {
    description: "Internal command used by agent-room control messages",
    handler: async (args, ctx) => {
      const id = args.trim();
      const message = pendingControls.get(id);
      if (!message) {
        ctx.ui.notify(`Missing room control payload: ${id}`, "warning");
        return;
      }
      pendingControls.delete(id);

      if (message.action === "reload") {
        await ctx.waitForIdle();
        await ctx.reload();
        return;
      }

      if (message.action === "new_session") {
        await ctx.waitForIdle();
        const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
        const kickoff = message.kickoff;
        await ctx.newSession({
          parentSession,
          withSession: async (newCtx) => {
            if (kickoff?.trim()) await newCtx.sendUserMessage(kickoff.trim());
          },
        });
      }
    },
  });

  pi.registerTool({
    name: "room_whoami",
    label: "Room Whoami",
    description: "Get this Pi agent's room id, agent id, status, cwd, model, session and context usage.",
    promptSnippet: "Get this agent's room identity and debug status.",
    promptGuidelines: [
      "Use room_whoami when you need your own agent id before sending it to another room agent.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state.room) writeSelf(ctx);
      const record = state.room ? readJson<AgentRecord>(agentFile(state.room)) : undefined;
      const fallback = {
        id: AGENT_ID,
        room: state.room ?? null,
        status: state.room ? state.status : "not_connected",
        cwd: ctx.cwd,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(record ?? fallback, null, 2) }],
        details: record ?? fallback,
      };
    },
  });

  pi.registerTool({
    name: "room_list_agents",
    label: "Room List Agents",
    description: "List active agents in the current room with status, current tool, cwd, model, and context usage.",
    promptSnippet: "List local Pi agents connected to the same room and see whether they are idle or busy.",
    promptGuidelines: [
      "Use room_list_agents before delegating work to find an idle target agent id.",
      "room_list_agents may show tool previews; treat them as debug hints, not complete logs.",
    ],
    parameters: Type.Object({
      includeStale: Type.Optional(Type.Boolean({ description: "Include offline/stale agents. Default false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      writeSelf(ctx);
      const agents = listAgents(room, params.includeStale ?? false);
      return {
        content: [{ type: "text", text: agents.map(formatAgent).join("\n") || "No active agents." }],
        details: { room, self: AGENT_ID, agents },
      };
    },
  });

  pi.registerTool({
    name: "room_send_message",
    label: "Room Send Message",
    description: "Send a user-message prompt to another Pi agent in the current room by agent id.",
    promptSnippet: "Send a task, question, or completion report to another room agent.",
    promptGuidelines: [
      "Use room_send_message to delegate to an idle room agent or report completion back to the requester.",
      "When delegating, include your agent id and ask the target to reply with room_send_message when done or blocked.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      message: Type.String({ description: "Message/task to deliver to the target agent." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      writeSelf(ctx);
      const message = createUserMessage(room, params.to, params.message);
      enqueueMessage(room, message);
      return {
        content: [{ type: "text", text: `Queued message ${message.id} to ${params.to} in room ${room}.` }],
        details: { room, message },
      };
    },
  });

  pi.registerTool({
    name: "room_control_agent",
    label: "Room Control Agent",
    description: "Ask another room agent extension to run a local session control action: compact, reload, or new_session.",
    promptSnippet: "Request compact/reload/new_session on another room agent.",
    promptGuidelines: [
      "Use room_control_agent sparingly; prefer room_send_message for normal delegation.",
      "Do not call room_control_agent unless the user or coordinating agent explicitly needs session control.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      action: Type.Union([
        Type.Literal("compact"),
        Type.Literal("reload"),
        Type.Literal("new_session"),
      ], { description: "Control action to run on the target agent." }),
      instructions: Type.Optional(Type.String({ description: "Optional compaction instructions." })),
      kickoff: Type.Optional(Type.String({ description: "Optional first prompt after new_session." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      writeSelf(ctx);
      const message = createControlMessage(room, params.to, params.action as ControlAction, params.instructions, params.kickoff);
      enqueueMessage(room, message);
      return {
        content: [{ type: "text", text: `Queued control ${params.action} (${message.id}) to ${params.to} in room ${room}.` }],
        details: { room, control: message },
      };
    },
  });
}
