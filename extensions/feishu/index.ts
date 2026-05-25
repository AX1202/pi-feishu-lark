import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import qrcode from "qrcode-terminal";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

type Domain = "feishu" | "lark";
type GroupPolicy = "open" | "mention";

type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  language?: "zh" | "en";
  reactEmoji?: string;
  autoStart?: boolean;
};

type FeishuState = {
  sessions: Record<string, string>;
};

type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  mentions?: unknown[];
};

const ROOT_DIR = join(homedir(), ".pi", "agent", "feishu");
const CONFIG_PATH = join(ROOT_DIR, "config.json");
const STATE_PATH = join(ROOT_DIR, "state.json");
const CHILD_SESSION_ENV = "PI_FEISHU_CHILD_SESSION";
const DEFAULT_CONFIG: Pick<FeishuConfig, "domain" | "groupPolicy" | "language" | "reactEmoji" | "autoStart"> = {
  domain: "feishu",
  groupPolicy: "open",
  language: "zh",
  reactEmoji: "THUMBSUP",
  autoStart: true,
};

function ensureRoot() {
  mkdirSync(ROOT_DIR, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try { chmodSync(path, 0o600); } catch {}
}

function removePath(path: string) {
  rmSync(path, { recursive: true, force: true });
}

function loadConfig(): FeishuConfig | undefined {
  const envAppId = process.env.FEISHU_APP_ID?.trim();
  const envSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (envAppId && envSecret) {
    return {
      appId: envAppId,
      appSecret: envSecret,
      domain: (process.env.FEISHU_DOMAIN as Domain) || DEFAULT_CONFIG.domain,
      groupPolicy: (process.env.FEISHU_GROUP_POLICY as GroupPolicy) || DEFAULT_CONFIG.groupPolicy,
      language: (process.env.FEISHU_LANGUAGE as "zh" | "en") || DEFAULT_CONFIG.language,
      reactEmoji: process.env.FEISHU_REACT_EMOJI || DEFAULT_CONFIG.reactEmoji,
      autoStart: process.env.FEISHU_AUTO_START ? process.env.FEISHU_AUTO_START !== "0" : DEFAULT_CONFIG.autoStart,
    };
  }
  if (!existsSync(CONFIG_PATH)) return undefined;
  const cfg = readJson<Partial<FeishuConfig>>(CONFIG_PATH, {});
  if (!cfg.appId || !cfg.appSecret) return undefined;
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain || DEFAULT_CONFIG.domain,
    groupPolicy: cfg.groupPolicy || DEFAULT_CONFIG.groupPolicy,
    language: cfg.language || DEFAULT_CONFIG.language,
    reactEmoji: cfg.reactEmoji || DEFAULT_CONFIG.reactEmoji,
    autoStart: cfg.autoStart ?? DEFAULT_CONFIG.autoStart,
  };
}

function mask(s: string) {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feishu transport
// ─────────────────────────────────────────────────────────────────────────────

class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

class FeishuTransport {
  private sdkClient: any;
  private wsClient: any;
  private running = false;
  private botOpenId: string | undefined;

  constructor(
    private readonly config: FeishuConfig,
    private readonly onMessage: (msg: FeishuMessage) => Promise<void>,
  ) {}

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      // Silence common events that Feishu may push by default.
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    this.running = true;
    this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop() {
    this.running = false;
    try { await this.wsClient?.stop?.(); } catch {}
  }

  isRunning() {
    return this.running;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      // The current @larksuiteoapi/node-sdk does not expose
      // `client.application.bot.info.get()`. Use the standard Feishu/Lark
      // endpoint directly instead: GET /open-apis/bot/v3/info.
      const res = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;
    if (sender?.sender_type === "bot") return;

    if (message.chat_type === "group" && this.config.groupPolicy === "mention") {
      if (!this.isMentioned(message)) return;
    }

    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      mentions: message.mentions,
    };

    if (this.config.reactEmoji) {
      void this.addReaction(msg.messageId, this.config.reactEmoji);
    }
    await this.onMessage(msg);
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  private async addReaction(messageId: string, emojiType: string) {
    try {
      await this.sdkClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {}
  }

  async replyText(messageId: string, text: string) {
    const chunks = splitText(text, 3500);
    let first = true;
    for (const chunk of chunks) {
      if (first) {
        await this.sdkClient.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
        });
        first = false;
      } else {
        await this.sdkClient.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
        });
      }
    }
  }
}

function splitText(text: string, max: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (rest.length > max) {
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  out.push(rest);
  return out;
}

function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pi sessions per Feishu conversation
// ─────────────────────────────────────────────────────────────────────────────

class ConversationManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<void>>();
  private state: FeishuState;

  constructor(private readonly cwd: string) {
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.then(async () => {
      const session = await this.getSession(key);
      await session.prompt(userText);
      const answer = extractLastAssistantText(session);
      await onReply(answer || "No response.");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  resetMemory() {
    this.sessions.clear();
    this.queues.clear();
    this.state = { sessions: {} };
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private async createSession(key: string): Promise<AgentSession> {
    const existingFile = this.state.sessions[key];
    const sessionManager = existingFile && existsSync(existingFile)
      ? SessionManager.open(existingFile, undefined, this.cwd)
      : SessionManager.create(this.cwd);

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: (base) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });

    const previousChildEnv = process.env[CHILD_SESSION_ENV];
    process.env[CHILD_SESSION_ENV] = "1";
    try {
      await loader.reload();
    } finally {
      if (previousChildEnv === undefined) delete process.env[CHILD_SESSION_ENV];
      else process.env[CHILD_SESSION_ENV] = previousChildEnv;
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      sessionManager,
      resourceLoader: loader,
    });

    // SDK-created sessions build the extension/tool registry in the constructor,
    // but extension lifecycle hooks such as `session_start` only run after
    // `bindExtensions()`. pi-memory opens its SQLite store during session_start;
    // without this, memory_* tools exist but return "Memory store not initialized".
    await session.bindExtensions({});

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    return session;
  }
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = [...(session.messages || [])].reverse();
  for (const msg of messages as any[]) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => p?.type === "text" ? p.text : "")
        .join("")
        .trim();
    }
  }
  return "";
}

function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  return `group:${msg.chatId}`;
}

function parseMessageText(msg: FeishuMessage, botOpenId?: string) {
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return text.trim();
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale: any = post.zh_cn || post.en_us || Object.values(post)[0];
      const parts: string[] = [];
      for (const para of locale?.content || []) {
        for (const elem of para) {
          if (elem.tag === "text" || elem.tag === "a") parts.push(elem.text || "");
          if (elem.tag === "at") parts.push(`@${elem.user_name || "user"}`);
        }
      }
      return parts.join("").trim();
    }
  } catch {}
  return msg.msgType === "text" ? msg.content : `[${msg.msgType}]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup wizard helpers
// ─────────────────────────────────────────────────────────────────────────────

async function uiSelect<T extends string>(ctx: ExtensionCommandContext, title: string, options: Array<{ value: T; label: string }>, initialValue?: T): Promise<T> {
  const ui: any = ctx.ui;
  if (typeof ui.select !== "function") {
    throw new Error("Current UI does not support select prompts.");
  }
  const labels = options.map((o) => o.label);
  const initialLabel = options.find((o) => o.value === initialValue)?.label;
  const selectedLabel = await ui.select(title, labels, initialLabel ? { initialValue: initialLabel } : undefined);
  const matched = options.find((o) => o.label === selectedLabel);
  if (!matched) {
    throw new Error("Selection cancelled.");
  }
  return matched.value;
}

async function uiInput(ctx: ExtensionCommandContext, title: string, defaultValue = ""): Promise<string> {
  const ui: any = ctx.ui;
  if (typeof ui.input === "function") return String(await ui.input(title, defaultValue) || "");
  if (typeof ui.prompt === "function") return String(await ui.prompt(title, defaultValue) || "");
  throw new Error("Current UI does not support input prompts.");
}

async function uiConfirm(ctx: ExtensionCommandContext, title: string, initial = true): Promise<boolean> {
  const ui: any = ctx.ui;
  if (typeof ui.confirm === "function") return Boolean(await ui.confirm(title, "", { initialValue: initial }));
  return initial;
}

async function runSetup(ctx: ExtensionCommandContext) {
  ensureRoot();
  const mode = await uiSelect(ctx,
    "配置方式 / Setup method",
    [
      { value: "auto", label: "扫码自动创建飞书助手 / Create by QR code" },
      { value: "manual", label: "手动填写已有应用 / Configure existing app" },
    ],
    "auto",
  );

  let appId = "";
  let appSecret = "";
  let domain: Domain = "feishu";

  if (mode === "auto") {
    const created = await registerFeishuApp(ctx);
    appId = created.appId;
    appSecret = created.appSecret;
    domain = created.domain;
  } else {
    domain = await uiSelect(ctx,
      "应用区域 / App region",
      [
        { value: "feishu", label: "Feishu 中国 / Feishu China" },
        { value: "lark", label: "Lark 国际 / Lark Global" },
      ],
      "feishu",
    );
    appId = (await uiInput(ctx, "App ID / 应用 ID")).trim();
    appSecret = (await uiInput(ctx, "App Secret / 应用密钥")).trim();
  }

  const groupPolicy = await uiSelect<GroupPolicy>(ctx,
    "群聊策略 / Group policy",
    [
      { value: "open", label: "open：不需要 @，群/话题消息自动回复 / auto reply without @ in groups/topics" },
      { value: "mention", label: "mention：只有 @ 机器人才回复 / reply only when mentioned" },
    ],
    "open",
  );

  const config: FeishuConfig = {
    appId,
    appSecret,
    domain,
    groupPolicy,
    language: "zh",
    reactEmoji: DEFAULT_CONFIG.reactEmoji,
    autoStart: true,
  };
  writeJson(CONFIG_PATH, config);

  ctx.ui.notify(
    `飞书配置已保存 / Feishu config saved\nPath: ${CONFIG_PATH}\nApp ID: ${mask(appId)}\n群聊策略 / Group policy: ${groupPolicy}`,
    "info",
  );

  if (await uiConfirm(ctx, "现在启动飞书连接？ / Start Feishu now?", true)) {
    return config;
  }
  return undefined;
}

async function registerFeishuApp(ctx: ExtensionCommandContext): Promise<{ appId: string; appSecret: string; domain: Domain }> {
  const lark = await import("@larksuiteoapi/node-sdk");
  ctx.ui.notify("正在准备飞书授权二维码... / Preparing Feishu authorization QR code...", "info");

  const result = await lark.registerApp({
    source: "pi-feishu-extension",
    onQRCodeReady(info: { url: string; expireIn: number }) {
      qrcode.generate(info.url, { small: true }, (qr) => {
        console.log("\n飞书/Lark 授权二维码 / Feishu/Lark authorization QR code");
        console.log(qr);
        console.log(info.url);
        console.log(`二维码 ${info.expireIn} 秒后过期 / QR code expires in ${info.expireIn} seconds.`);
      });
      ctx.ui.notify(
        "请在终端扫描二维码，或打开终端中显示的链接。 / Scan the QR code in terminal, or open the link printed there.",
        "info",
      );
    },
    onStatusChange(info: any) {
      if (info?.status === "domain_switched") {
        ctx.ui.notify("检测到 Lark 租户，正在切换区域。 / Detected Lark tenant; switching domain.", "info");
      }
    },
  });

  const domain: Domain = result?.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    domain,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry
// ─────────────────────────────────────────────────────────────────────────────

export default function feishuExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  let transport: FeishuTransport | undefined;
  const conversations = new ConversationManager(process.cwd());
  const seen = new Set<string>();
  const recentContent = new Map<string, number>();
  const CONTENT_DEDUPE_TTL_MS = 30_000;

  const STATUS_KEY = "feishu-connection";
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  let lastStatusText: string | undefined;

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  type FeishuStatus = "not configured" | "connecting" | "connected" | "bot unavailable" | "disconnected";

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(`${brand}: ${status}`);
  }

  function clearStatus() {
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  async function start(config?: FeishuConfig) {
    if (transport?.isRunning()) {
      updateStatus("connected");
      return "already";
    }
    const cfg = config || loadConfig();
    if (!cfg) {
      updateStatus("not configured");
      throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);
    }
    updateStatus("connecting");
    transport = new FeishuTransport(cfg, async (msg) => {
      if (seen.has(msg.messageId)) return;
      seen.add(msg.messageId);
      if (seen.size > 2000) seen.clear();

      const text = parseMessageText(msg, transport?.getBotOpenId());
      if (!text) return;
      const key = conversationKey(msg);

      const now = Date.now();
      const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text)].join("\u0000");
      const previousContentAt = recentContent.get(contentKey);
      if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return;
      recentContent.set(contentKey, now);
      if (recentContent.size > 2000) pruneRecentMap(recentContent, now, CONTENT_DEDUPE_TTL_MS);

      const prompt = msg.chatType === "group"
        ? `[Feishu group/topic: ${key}]\n${text}`
        : `[Feishu private chat]\n${text}`;

      await conversations.prompt(key, prompt, async (reply) => {
        await transport?.replyText(msg.messageId, reply);
      });
    });
    try {
      await transport.start();
      updateStatus("connected");
      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      throw error;
    }
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark bridge: setup, start, stop, status, reset, autostart",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const [cmdRaw, argRaw] = args.trim().toLowerCase().split(/\s+/, 2);
      const cmd = cmdRaw || "status";
      const arg = argRaw || "";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            const result = await start(configToStart);
            ctx.ui.notify(result === "already" ? "Feishu already running / 飞书已在运行" : "Feishu started / 飞书已启动", "info");
          }
          return;
        }
        if (cmd === "start") {
          const result = await start();
          ctx.ui.notify(result === "already" ? "Feishu already running / 飞书已在运行" : "Feishu started / 飞书已启动", "info");
          return;
        }
        if (cmd === "stop") {
          await transport?.stop();
          transport = undefined;
          updateStatus(loadConfig() ? "disconnected" : "not configured");
          ctx.ui.notify("Feishu stopped / 飞书已停止", "info");
          return;
        }
        if (cmd === "reset") {
          const ok = await uiConfirm(
            ctx,
            "确认重置飞书扩展？会删除配置和会话映射，但保留所有会话历史。 / Reset Feishu extension? This deletes config and conversation mappings, but keeps all session history.",
            false,
          );
          if (!ok) {
            ctx.ui.notify("Reset cancelled / 已取消重置", "info");
            return;
          }
          await transport?.stop();
          transport = undefined;
          removePath(CONFIG_PATH);
          removePath(STATE_PATH);
          conversations.resetMemory();
          seen.clear();
          recentContent.clear();
          ensureRoot();
          updateStatus("not configured");
          ctx.ui.notify(
            "Feishu extension reset. Session history was kept. Run /feishu setup. / 飞书扩展已重置，会话历史已保留，请运行 /feishu setup。",
            "info",
          );
          return;
        }
        if (cmd === "status") {
          const cfg = loadConfig();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "autostart") {
          const cfg = loadConfig();
          if (!cfg) {
            ctx.ui.notify("Missing config. Run /feishu setup first.", "warning");
            return;
          }
          if (arg === "on") {
            cfg.autoStart = true;
            writeJson(CONFIG_PATH, cfg);
            ctx.ui.notify("AutoStart enabled.", "info");
            return;
          }
          if (arg === "off") {
            cfg.autoStart = false;
            writeJson(CONFIG_PATH, cfg);
            ctx.ui.notify("AutoStart disabled.", "info");
            return;
          }
          ctx.ui.notify(`AutoStart: ${cfg.autoStart !== false}. Usage: /feishu autostart on|off|status`, "info");
          return;
        }
        ctx.ui.notify("Usage: /feishu setup | start | stop | status | reset | autostart on|off|status", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  const bootConfig = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    uiRef = ctx.ui as any;
    if (lastStatusText) {
      uiRef?.setStatus?.(STATUS_KEY, lastStatusText);
      return;
    }
    if (transport?.isRunning()) {
      updateStatus("connected");
    } else if (!bootConfig) {
      updateStatus("not configured");
    } else if (bootConfig.autoStart === false) {
      updateStatus("disconnected");
    } else {
      updateStatus("connecting");
    }
  });

  if (bootConfig?.autoStart !== false) {
    start().catch((error) => {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      console.error("[feishu] autoStart failed:", error instanceof Error ? error.message : error);
    });
  }

  pi.on("session_shutdown", async () => {
    await transport?.stop();
    clearStatus();
  });
}
