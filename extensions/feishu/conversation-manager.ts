import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FeishuBridgeRuntime } from "./bridge-runtime.js";
import { CHILD_SESSION_ENV, ensureRoot, readJson, STATE_PATH, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import type { FeishuState } from "./types.js";

type ActiveRun = {
  session: AgentSession;
  stopped: boolean;
};

export class ConversationManager {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private defaultProvider: string | undefined;
  private defaultModelId: string | undefined;
  private state: FeishuState;

  constructor(
    private readonly cwd: string,
    private readonly bridge?: FeishuBridgeRuntime,
  ) {
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.loadSettingsDefault();
  }

  /** Read global settings default model for fallback in getSelectedModel. */
  private loadSettingsDefault() {
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.defaultProvider && settings.defaultModel) {
        this.defaultProvider = settings.defaultProvider;
        this.defaultModelId = settings.defaultModel;
      }
    } catch {}
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>) {
    return this.promptWithImages(key, userText, [], onReply);
  }

  async promptWithImages(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
  ) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
      const session = await this.getSession(key);
      const run: ActiveRun = { session, stopped: false };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(session.sessionId);
      try {
        try {
          await withTimeout(
            session.prompt(userText, images.length ? { images } : undefined),
            180_000,
            "Pi 模型处理超时，请稍后重试；如果是图片消息，可以先切换到明确支持图片的模型。",
          );
        } catch (error) {
          if (run.stopped) {
            debugLog("feishu.prompt.stopped", { key });
            return;
          }
          throw error;
        }
      } finally {
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(session.sessionId);
      }
      if (run.stopped) return;
      const answer = extractLastAssistantText(session);
      debugLog("feishu.prompt.done", { key, answerLength: answer.length });
      await onReply(answer || "No response.");
    }).catch(async (error) => {
      debugLog("feishu.prompt.error", { key, error: error instanceof Error ? error.message : String(error) });
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async stopConversation(key: string, onReply: (text: string) => Promise<void>) {
    const active = this.activeRuns.get(key);
    if (!active) {
      await onReply("当前没有进行中的处理。");
      return;
    }

    active.stopped = true;
    try {
      await active.session.abort();
      debugLog("feishu.prompt.abort", { key });
      await onReply("已停止当前处理。");
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      await onReply("停止失败，请重试。");
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const model = this.modelRegistry.find(provider, modelId);
      if (!model || !this.modelRegistry.hasConfiguredAuth(model)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      this.state.models![key] = { provider, id: modelId };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getAvailableModels() {
    return this.modelRegistry.getAvailable().sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.id.localeCompare(b.id);
    });
  }

  getSelectedModel(key: string) {
    const selected = this.state.models?.[key];
    if (selected) {
      const model = this.modelRegistry.find(selected.provider, selected.id);
      if (model && this.modelRegistry.hasConfiguredAuth(model)) return model;
    }
    const cached = this.sessions.get(key);
    if (cached) {
      return cached.then((session) => session.model);
    }
    // Check settings default model before falling back to first available
    if (this.defaultProvider && this.defaultModelId) {
      const defaultModel = this.modelRegistry.find(this.defaultProvider, this.defaultModelId);
      if (defaultModel && this.modelRegistry.hasConfiguredAuth(defaultModel)) {
        return defaultModel;
      }
    }
    const available = this.getAvailableModels();
    return available[0];
  }

  resetMemory() {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.queues.clear();
    this.state = { sessions: {}, models: {} };
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private previousTurn(key: string) {
    const previous = this.queues.get(key) || Promise.resolve();
    return withTimeout(previous, 120_000, "上一条飞书消息处理超时，已跳过等待。")
      .catch((error) => {
        debugLog("feishu.queue.previous_timeout", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async createSession(key: string): Promise<AgentSession> {
    const existingFile = this.state.sessions[key];
    const selected = this.state.models?.[key];
    const model = selected ? this.modelRegistry.find(selected.provider, selected.id) : undefined;
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
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      sessionManager,
      resourceLoader: loader,
    });

    await session.bindExtensions({});
    this.bridge?.attachSession(key, session.sessionId);
    session.subscribe((event) => {
      if (event.type === "message_end") {
        this.bridge?.handleMessageEnd(session.sessionId, key, event.message);
      }
    });

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    return session;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
