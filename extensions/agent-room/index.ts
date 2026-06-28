import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_VERSION = "0.4.0";
const HEARTBEAT_MS = 2_000;
const INBOX_POLL_MS = 1_000;
const ACTIVE_TTL_MS = 30_000;
const MAX_PREVIEW_CHARS = 180;

const hostname = os.hostname().replace(/[^a-zA-Z0-9_.-]+/g, "-");
const AGENT_ID = `agent-${hostname}-${process.pid}`;

type AgentStatus = "idle" | "busy" | "tool" | "offline";
type ControlAction = "compact" | "reload" | "new_session" | "abort";

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
  canControl: boolean;
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
  delivery?: "steer" | "followUp";
}

interface RuntimeState {
  room?: string;
  status: AgentStatus;
  currentTool?: string;
  currentToolPreview?: string;
  canControl: boolean;
  startedAt: number;
}

const state: RuntimeState = {
  status: "idle",
  canControl: false,
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

function controlDir(): string {
  return path.join(roomsRoot(), "control");
}

function controlFlagPath(agentId = AGENT_ID): string {
  return path.join(controlDir(), `${agentId}.json`);
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

function readControlFlag(agentId = AGENT_ID): boolean {
  return readJson<{ enabled: boolean }>(controlFlagPath(agentId))?.enabled ?? false;
}

function writeControlFlag(enabled: boolean, agentId = AGENT_ID): void {
  if (enabled) writeJsonAtomic(controlFlagPath(agentId), { enabled: true, at: Date.now() });
  else {
    try {
      fs.unlinkSync(controlFlagPath(agentId));
    } catch {
      // already gone
    }
  }
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
    canControl: state.canControl,
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
      canControl: state.canControl,
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

function formatAgent(record: AgentRecord): string {
  const ctrl = record.canControl ? " [control]" : "";
  const ctx = record.contextPercent !== undefined ? ` ctx:${record.contextPercent}%` : record.contextTokens ? ` ctx:${record.contextTokens}` : "";
  const tool = record.currentTool ? ` tool:${record.currentTool}` : "";
  const preview = record.currentToolPreview ? ` ${record.currentToolPreview}` : "";
  const model = record.model ? ` model:${record.model}` : "";
  return `${record.id} ${record.status}${ctrl}${tool}${ctx}${model} cwd:${record.cwd}${preview}`;
}

function enqueueMessage(room: string, message: RoomMessage): void {
  ensureRoom(room);
  const targetInbox = inboxDir(room, message.to);
  fs.mkdirSync(targetInbox, { recursive: true });
  writeJsonAtomic(path.join(targetInbox, `${message.id}.json`), message);
  appendJsonLine(path.join(roomDir(room), "events.jsonl"), { type: "enqueue", ...message });
}

function createUserMessage(room: string, to: string, text: string, delivery?: "steer" | "followUp"): RoomMessage {
  return {
    id: makeId("msg"),
    kind: "message",
    room,
    from: AGENT_ID,
    to,
    text,
    delivery,
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
    canControl: state.canControl,
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

function controlRequired(): void {
  if (!state.canControl) {
    throw new Error(
      "Control is not enabled for this agent. Run `/room control on` to enable room_control_agent.",
    );
  }
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

      const delivery = message.delivery ?? "followUp";
      if (ctx.isIdle()) {
        pi.sendUserMessage(text);
      } else if (delivery === "steer") {
        pi.sendUserMessage(text, { deliverAs: "steer" });
      } else {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      }
      continue;
    }

    if (message.kind === "control") {
      if (message.action === "abort") {
        ctx.abort();
        if (ctx.hasUI) ctx.ui.notify?.(`Room control abort from ${message.from} (${message.id})`, "warning");
      } else if (message.action === "compact") {
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

// ── Session reading helpers ──────────────────────────────────────────

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: any;
  summary?: string;
  customType?: string;
  content?: any;
  [key: string]: any;
}

function readSessionEntries(sessionFile: string): SessionEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const entries: SessionEntry[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function formatEntryForHistory(entry: SessionEntry, maxChars = 500): string | null {
  if (entry.type === "session") return null;
  if (entry.type === "message" && entry.message) {
    const msg = entry.message;
    const role = msg.role ?? "unknown";
    let body: string;
    if (typeof msg.content === "string") {
      body = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") parts.push(part.text ?? "");
        else if (part.type === "toolCall") {
          const argPreview = JSON.stringify(part.arguments ?? {}).slice(0, 120);
          parts.push(`[toolCall: ${part.name}(${argPreview})]`);
        } else if (part.type === "thinking") {
          // skip thinking blocks in history
        } else if (part.type === "image") {
          parts.push("[image]");
        }
      }
      body = parts.join(" ").trim();
    } else {
      body = JSON.stringify(msg.content ?? "");
    }
    if (!body) return null;
    const truncated = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
    return `[${role}] ${truncated}`;
  }
  if (entry.type === "compaction") {
    return `[compaction] ${truncate(entry.summary ?? "", maxChars)}`;
  }
  if (entry.type === "branch_summary") {
    return `[branchSummary] ${truncate(entry.summary ?? "", maxChars)}`;
  }
  if (entry.type === "custom_message") {
    const text = typeof entry.content === "string" ? entry.content : "";
    return `[custom:${entry.customType ?? "?"}] ${truncate(text, maxChars)}`;
  }
  if (entry.type === "model_change") {
    return `[model_change] ${entry.provider ?? "?"}/${entry.modelId ?? "?"}`;
  }
  return null;
}

function getTargetSessionFile(room: string, targetAgentId: string): string | undefined {
  const record = readJson<AgentRecord>(agentFile(room, targetAgentId));
  return record?.sessionFile;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function runSummarization(
  transcript: string,
  systemPrompt: string,
  model: string | undefined,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ output: string; error?: string; exitCode: number }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-room-summarize-"));
  const promptFile = path.join(tmpDir, "prompt.md");
  try {
    await fs.promises.writeFile(promptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });

    const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];
    if (model) piArgs.push("--model", model);
    piArgs.push("--append-system-prompt", promptFile);
    piArgs.push(transcript);

    const invocation = getPiInvocation(piArgs);

    const result = await new Promise<{ output: string; error: string; exitCode: number }>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let finalText = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            const parts = event.message.content ?? [];
            for (const part of parts) {
              if (part.type === "text") finalText += part.text;
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      };

      let buffer = "";
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve({ output: finalText || "(no output)", error: stderr, exitCode: code ?? 0 });
      });

      proc.on("error", () => {
        resolve({ output: "", error: "Failed to spawn pi subprocess", exitCode: 1 });
      });

      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    return result;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup is best-effort
    }
  }
}

let piRef: ExtensionAPI | undefined;

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.on("session_start", async (_event, ctx) => {
    // Restore control permission from persistent flag file (survives reloads).
    state.canControl = readControlFlag();

    const defaultRoom = readConfig().defaultRoom;
    if (defaultRoom) {
      try {
        const room = connectToRoom(defaultRoom, ctx, false);
        ctx.ui.setStatus?.("agent-room", `room:${room}${state.canControl ? " [control]" : ""}`);
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
            ctx.ui.notify("Usage: /room connect <room> [--default]", "warning");
            return;
          }
          const setDefault = rest.includes("--default");
          const room = connectToRoom(roomName, ctx, setDefault);
          ctx.ui.setStatus?.("agent-room", `room:${room}${state.canControl ? " [control]" : ""}`);
          ctx.ui.notify(`Connected to room '${room}' as ${AGENT_ID}${setDefault ? " (saved as default)" : ""}${state.canControl ? " [control]" : ""}`, "info");
          return;
        }

        if (command === "leave" || command === "disconnect") {
          const keepDefault = rest.includes("--keep-default");
          disconnect(ctx, true, !keepDefault);
          ctx.ui.setStatus?.("agent-room", "room:-");
          ctx.ui.notify(`Left room${keepDefault ? " (default kept)" : ""}`, "info");
          return;
        }

        if (command === "control") {
          const action = rest[0]?.toLowerCase();
          if (action === "on" || action === "enable") {
            state.canControl = true;
            writeControlFlag(true);
            if (state.room) writeSelf(ctx);
            ctx.ui.setStatus?.("agent-room", `room:${state.room ?? "-"} [control]`);
            ctx.ui.notify(`Control enabled for ${AGENT_ID}. room_control_agent is now available.`, "info");
            return;
          }
          if (action === "off" || action === "disable") {
            state.canControl = false;
            writeControlFlag(false);
            if (state.room) writeSelf(ctx);
            ctx.ui.setStatus?.("agent-room", `room:${state.room ?? "-"}`);
            ctx.ui.notify(`Control disabled for ${AGENT_ID}. room_control_agent is now blocked.`, "info");
            return;
          }
          ctx.ui.notify("Usage: /room control on|off", "warning");
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
          const summary = record
            ? JSON.stringify(record, null, 2)
            : `Not connected. Agent id: ${AGENT_ID}\nControl: ${state.canControl ? "enabled" : "disabled"}`;
          ctx.ui.notify(summary, "info");
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
          let text = rest.slice(1).join(" ");
          let delivery: "steer" | "followUp" | undefined;
          if (text.includes("--steer")) {
            delivery = "steer";
            text = text.replace(/--steer\b/g, "").trim();
          } else if (text.includes("--follow-up")) {
            delivery = "followUp";
            text = text.replace(/--follow-up\b/g, "").trim();
          }
          if (!to || !text) {
            ctx.ui.notify("Usage: /room send <agent-id> <message> [--steer|--follow-up]", "warning");
            return;
          }
          const room = roomRequired();
          const message = createUserMessage(room, to, text, delivery);
          enqueueMessage(room, message);
          ctx.ui.notify(`Queued message ${message.id} to ${to} (delivery: ${delivery ?? "followUp"})`, "info");
          return;
        }

        if (command === "status") {
          const config = readConfig();
          const text = [
            `Agent: ${AGENT_ID}`,
            `Current room: ${state.room ?? "not connected"}`,
            `Default room: ${config.defaultRoom ?? "not set"}`,
            `Control: ${state.canControl ? "enabled" : "disabled"}`,
            state.room ? `Active agents: ${listAgents(state.room).length}` : undefined,
          ].filter(Boolean).join("\n");
          ctx.ui.notify(text, "info");
          return;
        }

        ctx.ui.notify([
          "Usage:",
          "/room connect <room> [--default]",
          "/room create <room> [--default]",
          "/room leave [--keep-default]",
          "/room control on|off",
          "/room list [--stale]",
          "/room send <agent-id> <message> [--steer|--follow-up]",
          "/room whoami",
          "/room default <room|off>",
          "/room status",
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
        canControl: state.canControl,
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
    description: "List active agents in the current room with status, current tool, cwd, model, context usage, and control flag.",
    promptSnippet: "List local Pi agents connected to the same room and see whether they are idle or busy.",
    promptGuidelines: [
      "Use room_list_agents before delegating work to find an idle target agent id.",
      "Agents marked [control] can use room_control_agent on others.",
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
      "Use delivery=\"steer\" to urgently interrupt a busy agent that is doing something wrong. Use delivery=\"followUp\" (default) for normal messages that can wait.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      message: Type.String({ description: "Message/task to deliver to the target agent." }),
      delivery: Type.Optional(Type.Union([
        Type.Literal("steer"),
        Type.Literal("followUp"),
      ], { description: "\"steer\" interrupts the target's current turn to deliver the message immediately. \"followUp\" (default) waits for the target to finish its current work." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      writeSelf(ctx);
      const message = createUserMessage(room, params.to, params.message, params.delivery);
      enqueueMessage(room, message);
      return {
        content: [{ type: "text", text: `Queued message ${message.id} to ${params.to} in room ${room} (delivery: ${params.delivery ?? "followUp"}).` }],
        details: { room, message },
      };
    },
  });

  pi.registerTool({
    name: "room_control_agent",
    label: "Room Control Agent",
    description: "Ask another room agent extension to run a local session control action: abort, compact, reload, or new_session. Requires control to be enabled on this agent via `/room control on`.",
    promptSnippet: "Request abort/compact/reload/new_session on another room agent. Requires /room control on.",
    promptGuidelines: [
      "Use room_control_agent sparingly; prefer room_send_message for normal delegation.",
      "Use action=\"abort\" to immediately cancel the target agent's current turn (like pressing Escape). This works even if the target is mid-tool-call.",
      "room_control_agent requires control permission. If it returns a permission error, ask the user to run `/room control on`.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      action: Type.Union([
        Type.Literal("abort"),
        Type.Literal("compact"),
        Type.Literal("reload"),
        Type.Literal("new_session"),
      ], { description: "Control action to run on the target agent. \"abort\" cancels the current turn immediately." }),
      instructions: Type.Optional(Type.String({ description: "Optional compaction instructions." })),
      kickoff: Type.Optional(Type.String({ description: "Optional first prompt after new_session." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      try {
        controlRequired();
      } catch (error) {
        return {
          content: [{ type: "text", text: `Permission denied: ${(error as Error).message}` }],
          details: { room, denied: true },
          isError: true,
        };
      }
      writeSelf(ctx);
      const message = createControlMessage(room, params.to, params.action as ControlAction, params.instructions, params.kickoff);
      enqueueMessage(room, message);
      return {
        content: [{ type: "text", text: `Queued control ${params.action} (${message.id}) to ${params.to} in room ${room}.` }],
        details: { room, control: message },
      };
    },
  });

  pi.registerTool({
    name: "room_read_agent_history",
    label: "Room Read Agent History",
    description: "Read the last (or first) N lines of another agent's session transcript. Requires control permission. Use to inspect what a subordinate agent has been doing before deciding to abort, compact, or intervene.",
    promptSnippet: "Read another agent's recent session history. Requires /room control on.",
    promptGuidelines: [
      "Use room_read_agent_history to inspect what a subordinate agent has been doing before deciding to intervene.",
      "room_read_agent_history requires control permission. If denied, ask the user to run `/room control on`.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      lines: Type.Optional(Type.Number({ description: "Number of lines to return. Default 50.", default: 50 })),
      mode: Type.Optional(Type.Union([
        Type.Literal("tail"),
        Type.Literal("head"),
      ], { description: "\"tail\" = last N lines (default), \"head\" = first N lines." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const room = roomRequired();
      try {
        controlRequired();
      } catch (error) {
        return {
          content: [{ type: "text", text: `Permission denied: ${(error as Error).message}` }],
          details: { room, denied: true },
          isError: true,
        };
      }
      writeSelf(ctx);

      const sessionFile = getTargetSessionFile(room, params.to);
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: `Agent ${params.to} has no session file (possibly in-memory or offline).` }],
          details: { room, target: params.to, error: "no_session_file" },
          isError: true,
        };
      }

      const entries = readSessionEntries(sessionFile);
      const formatted = entries
        .map((e) => formatEntryForHistory(e))
        .filter((s): s is string => s !== null);

      const count = Math.max(1, Math.min(params.lines ?? 50, 500));
      const mode = params.mode ?? "tail";
      const slice = mode === "head" ? formatted.slice(0, count) : formatted.slice(-count);

      return {
        content: [{ type: "text", text: slice.join("\n") || "(empty session)" }],
        details: { room, target: params.to, sessionFile, mode, linesRequested: count, linesReturned: slice.length, totalEntries: formatted.length },
      };
    },
  });

  pi.registerTool({
    name: "room_summarize_agent",
    label: "Room Summarize Agent",
    description: "Read the last N turns of another agent's session, send them through a model with a custom system prompt, and return the summary. Requires control permission. Use to get a compressed view of what a subordinate agent has been doing.",
    promptSnippet: "Summarize another agent's recent session via a model. Requires /room control on.",
    promptGuidelines: [
      "Use room_summarize_agent when you need a compact view of a subordinate agent's activity, not raw history lines.",
      "Provide a focused systemPrompt describing what to extract (e.g., 'Summarize what files were changed and any errors encountered').",
      "Optionally specify a cheaper/faster model for summarization (e.g., 'claude-haiku-4-5'). Defaults to the target agent's model.",
      "room_summarize_agent requires control permission. If denied, ask the user to run `/room control on`.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id from room_list_agents." }),
      turns: Type.Optional(Type.Number({ description: "Number of last turns to include. A turn = one user message + assistant response + tool results. Default 10.", default: 10 })),
      systemPrompt: Type.String({ description: "System prompt for the summarization model. Describe what to extract or focus on." }),
      model: Type.Optional(Type.String({ description: "Model to use for summarization (e.g., 'claude-haiku-4-5'). Defaults to target agent's model." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const room = roomRequired();
      try {
        controlRequired();
      } catch (error) {
        return {
          content: [{ type: "text", text: `Permission denied: ${(error as Error).message}` }],
          details: { room, denied: true },
          isError: true,
        };
      }
      writeSelf(ctx);

      const sessionFile = getTargetSessionFile(room, params.to);
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: `Agent ${params.to} has no session file (possibly in-memory or offline).` }],
          details: { room, target: params.to, error: "no_session_file" },
          isError: true,
        };
      }

      const entries = readSessionEntries(sessionFile);

      // Collect message entries and group into turns.
      // A turn starts at a user message and includes everything until the next user message.
      const messageEntries = entries.filter((e) => e.type === "message" && e.message);
      const turns: SessionEntry[][] = [];
      let currentTurn: SessionEntry[] = [];

      for (const entry of messageEntries) {
        if (entry.message.role === "user" && currentTurn.length > 0) {
          turns.push(currentTurn);
          currentTurn = [];
        }
        currentTurn.push(entry);
      }
      if (currentTurn.length > 0) turns.push(currentTurn);

      const turnsToTake = Math.max(1, Math.min(params.turns ?? 10, 50));
      const selectedTurns = turns.slice(-turnsToTake);

      // Build a readable transcript
      const transcriptLines: string[] = [
        `Summarize the following conversation transcript from agent ${params.to}.`,
        `Total turns in transcript: ${selectedTurns.length} (of ${turns.length} total).`,
        "",
      ];

      for (const turnEntries of selectedTurns) {
        for (const entry of turnEntries) {
          const line = formatEntryForHistory(entry, 1000);
          if (line) transcriptLines.push(line);
        }
      }

      const transcript = transcriptLines.join("\n");

      // Determine model: explicit param > target agent's model
      const targetRecord = readJson<AgentRecord>(agentFile(room, params.to));
      const model = params.model ?? targetRecord?.model;

      const targetCwd = targetRecord?.cwd ?? ctx.cwd;

      const result = await runSummarization(
        transcript,
        params.systemPrompt,
        model,
        targetCwd,
        signal,
      );

      if (result.exitCode !== 0 && !result.output) {
        return {
          content: [{ type: "text", text: `Summarization failed (exit ${result.exitCode}): ${result.error || result.output}` }],
          details: { room, target: params.to, sessionFile, model, turns: turnsToTake, totalTurns: turns.length, error: result.error },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: result.output }],
        details: {
          room,
          target: params.to,
          sessionFile,
          model: model ?? "default",
          turnsRequested: turnsToTake,
          turnsAvailable: turns.length,
          turnsUsed: selectedTurns.length,
          transcriptLength: transcript.length,
          summaryLength: result.output.length,
          stderr: result.error || undefined,
        },
      };
    },
  });
}