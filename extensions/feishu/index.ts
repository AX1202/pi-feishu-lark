import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseModelActionValue } from "./cards.js";
import { CHILD_SESSION_ENV, CONFIG_PATH, DAEMON_LOG_PATH, DEBUG_LOG_PATH, DEDUPE_PATH, ensureRoot, loadConfig, mask, removePath, STATE_PATH, writeJson } from "./config.js";
import { ConversationManager } from "./conversation-manager.js";
import { acquireGatewayLock, gatewayLockPath, readGatewayOwner, type GatewayLockHandle, type GatewayOwner } from "./gateway-lock.js";
import { FeishuMessageHandler } from "./message-handler.js";
import { runSetup, uiConfirm } from "./setup.js";
import { BotUnavailableError, FeishuTransport } from "./transport.js";
import type { FeishuConfig, FeishuStatus } from "./types.js";

export default function feishuExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_SESSION_ENV] === "1") {
    return;
  }

  let transport: FeishuTransport | undefined;
  let gatewayLock: GatewayLockHandle | undefined;
  const conversations = new ConversationManager(process.cwd());
  const messageHandler = new FeishuMessageHandler(conversations, () => transport);

  const STATUS_KEY = "feishu-connection";
  let uiRef: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  let lastStatusText: string | undefined;

  function setStatusText(text: string | undefined) {
    if (lastStatusText === text) return;
    lastStatusText = text;
    uiRef?.setStatus?.(STATUS_KEY, text);
  }

  function updateStatus(status: FeishuStatus) {
    const cfg = loadConfig();
    const brand = cfg?.domain === "lark" ? "Lark" : "Feishu";
    setStatusText(`${brand}: ${status}`);
  }

  function clearStatus() {
    lastStatusText = undefined;
    uiRef?.setStatus?.(STATUS_KEY, undefined);
  }

  async function start(config?: FeishuConfig, options: { takeover?: boolean } = {}) {
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
    const lockResult = await acquireGatewayLock(process.cwd(), Boolean(options.takeover));
    if (lockResult.status === "busy") {
      updateStatus("owned");
      return { status: "owned" as const, owner: lockResult.owner };
    }
    gatewayLock = lockResult.handle;
    gatewayLock.setOnLost(async () => {
      await transport?.stop();
      transport = undefined;
      gatewayLock = undefined;
      updateStatus(loadConfig() ? "owned" : "not configured");
    });
    transport = new FeishuTransport(cfg, (msg) => messageHandler.handle(msg), async (action) => {
      const selected = parseModelActionValue(action.value);
      if (!selected) return;
      await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
    });
    try {
      await transport.start();
      gatewayLock.startHeartbeat();
      await gatewayLock.update("connected");
      updateStatus("connected");
      return "started";
    } catch (error) {
      updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
      await gatewayLock.release();
      gatewayLock = undefined;
      transport = undefined;
      throw error;
    }
  }

  async function stop() {
    await transport?.stop();
    transport = undefined;
    await gatewayLock?.release();
    gatewayLock = undefined;
    updateStatus(loadConfig() ? "disconnected" : "not configured");
  }

  function formatOwner(owner: GatewayOwner | undefined) {
    if (!owner) return "none";
    return `pid=${owner.pid}, status=${owner.status}, startedAt=${owner.startedAt}, heartbeatAt=${owner.heartbeatAt}, cwd=${owner.cwd}`;
  }

  function notifyStartResult(ctx: any, result: Awaited<ReturnType<typeof start>>) {
    if (result === "already") {
      ctx.ui.notify("Feishu already running in this Pi process / 当前 Pi 进程已在运行飞书 gateway", "info");
      return;
    }
    if (result === "started") {
      ctx.ui.notify("Feishu gateway started in this Pi process / 飞书 gateway 已在当前 Pi 进程启动", "info");
      return;
    }
    ctx.ui.notify(`Feishu gateway is already owned by another Pi process.\n${formatOwner(result.owner)}\n如需强制接管，请运行 /feishu takeover。`, "warning");
  }

  function notifyDaemonStartResult(ctx: any, result: Awaited<ReturnType<typeof startDaemon>>) {
    if (result.status === "busy") {
      ctx.ui.notify(`Feishu gateway is already running in background.\n${formatOwner(result.owner)}\n如需接管，请运行 /feishu daemon takeover。`, "info");
      return;
    }
    ctx.ui.notify(`Feishu gateway daemon starting. Spawn pid=${result.pid}.\nOwner: ${formatOwner(result.owner)}\nLog: ${DAEMON_LOG_PATH}`, "info");
  }

  function quoteShell(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function daemonCommand() {
    const extensionPath = fileURLToPath(import.meta.url);
    const piBin = process.env.PI_BIN || "pi";
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-builtin-tools",
      "-e", extensionPath,
    ];
    return `tail -f /dev/null | exec ${quoteShell(piBin)} ${args.map(quoteShell).join(" ")}`;
  }

  async function startDaemon(takeover = false) {
    return withDaemonSpawnLock(async () => {
      const cfg = loadConfig();
      if (!cfg) throw new Error(`Missing config. Run /feishu setup first. 配置不存在，请先运行 /feishu setup。`);

      let owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      if (owner?.pid === process.pid || transport?.isRunning()) {
        await stop();
      } else if (owner && takeover) {
        try { process.kill(owner.pid, "SIGTERM"); } catch {}
        await sleep(800);
      }

      // Re-check while holding the spawn lock. Another TUI may have started it
      // while this process was waiting for the lock.
      owner = readGatewayOwner();
      if (owner && owner.pid !== process.pid && !takeover) {
        return { status: "busy" as const, owner };
      }

      ensureRoot();
      const logFd = openSync(DAEMON_LOG_PATH, "a");
      const child = spawn("bash", ["-lc", daemonCommand()], {
        detached: true,
        cwd: process.cwd(),
        env: { ...process.env, PI_FEISHU_DAEMON: "1" },
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();

      await sleep(1500);
      return { status: "started" as const, pid: child.pid, owner: readGatewayOwner() };
    });
  }

  async function stopDaemon() {
    const owner = readGatewayOwner();
    if (!owner) return { status: "none" as const };
    if (owner.pid === process.pid) {
      await stop();
      return { status: "stopped-current" as const };
    }
    try {
      process.kill(owner.pid, "SIGTERM");
      await sleep(800);
      return { status: "stopped" as const, owner };
    } catch (error) {
      return { status: "error" as const, owner, error };
    }
  }

  pi.registerCommand("feishu", {
    description: "Feishu/Lark bridge: setup, start/stop background gateway, connect/disconnect local, status, debug, reset, autostart",
    handler: async (args, ctx) => {
      uiRef = ctx.ui as any;
      const [cmdRaw, argRaw] = args.trim().toLowerCase().split(/\s+/, 2);
      const cmd = cmdRaw || "status";
      const arg = argRaw || "";
      try {
        if (cmd === "setup") {
          const configToStart = await runSetup(ctx);
          if (configToStart) {
            writeJson(CONFIG_PATH, configToStart);
            notifyDaemonStartResult(ctx, await startDaemon(false));
          }
          return;
        }
        if (cmd === "start") {
          notifyDaemonStartResult(ctx, await startDaemon(false));
          return;
        }
        if (cmd === "connect") {
          notifyStartResult(ctx, await start());
          return;
        }
        if (cmd === "takeover") {
          await stop();
          notifyStartResult(ctx, await start(undefined, { takeover: true }));
          return;
        }
        if (cmd === "stop") {
          const result = await stopDaemon();
          if (result.status === "error") {
            ctx.ui.notify(`Failed to stop Feishu gateway daemon: ${result.error instanceof Error ? result.error.message : String(result.error)}\nOwner: ${formatOwner(result.owner)}`, "error");
            return;
          }
          ctx.ui.notify(`Feishu gateway daemon stop: ${result.status}`, "info");
          return;
        }
        if (cmd === "disconnect") {
          await stop();
          ctx.ui.notify("Feishu gateway stopped in this Pi process / 当前 Pi 进程内的飞书 gateway 已停止", "info");
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
          await stop();
          removePath(CONFIG_PATH);
          removePath(STATE_PATH);
          removePath(DEDUPE_PATH);
          removePath(`${DEDUPE_PATH}.lock`);
          conversations.resetMemory();
          messageHandler.reset();
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
          const owner = gatewayLock?.owner || readGatewayOwner();
          ctx.ui.notify(
            [
              `Status: ${lastStatusText || (loadConfig() ? "Feishu: disconnected" : "Feishu: not configured")}`,
              `Gateway owner: ${formatOwner(owner)}`,
              `Config: ${cfg ? `${cfg.domain}, appId=${mask(cfg.appId)}, groupPolicy=${cfg.groupPolicy}, autoStart=${cfg.autoStart !== false}` : "missing"}`,
              `Path: ${CONFIG_PATH}`,
              `Gateway lock: ${gatewayLockPath()}`,
              `Debug: ${DEBUG_LOG_PATH}`,
              `Daemon log: ${DAEMON_LOG_PATH}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "daemon") {
          if (arg === "start") {
            const result = await startDaemon(false);
            if (result.status === "busy") {
              ctx.ui.notify(`Feishu daemon already owned by another process.\n${formatOwner(result.owner)}\n如需接管，请运行 /feishu daemon takeover。`, "warning");
              return;
            }
            ctx.ui.notify(`Feishu daemon starting. Spawn pid=${result.pid}.\nOwner: ${formatOwner(result.owner)}\nLog: ${DAEMON_LOG_PATH}`, "info");
            return;
          }
          if (arg === "takeover") {
            const result = await startDaemon(true);
            ctx.ui.notify(`Feishu daemon takeover requested. Spawn pid=${result.status === "started" ? result.pid : "unknown"}.\nOwner: ${formatOwner(result.status === "started" ? result.owner : undefined)}\nLog: ${DAEMON_LOG_PATH}`, "info");
            return;
          }
          if (arg === "stop") {
            const result = await stopDaemon();
            if (result.status === "error") {
              ctx.ui.notify(`Failed to stop Feishu daemon: ${result.error instanceof Error ? result.error.message : String(result.error)}\nOwner: ${formatOwner(result.owner)}`, "error");
              return;
            }
            ctx.ui.notify(`Feishu daemon stop: ${result.status}`, "info");
            return;
          }
          if (arg === "logs") {
            if (!existsSync(DAEMON_LOG_PATH)) {
              ctx.ui.notify(`No daemon log yet: ${DAEMON_LOG_PATH}`, "info");
              return;
            }
            const lines = readFileSync(DAEMON_LOG_PATH, "utf8").trim().split("\n").slice(-40);
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          const owner = readGatewayOwner();
          ctx.ui.notify(
            [
              `Daemon owner: ${formatOwner(owner)}`,
              `Daemon log: ${DAEMON_LOG_PATH}`,
              "Usage: /feishu daemon start | stop | status | takeover | logs",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (cmd === "debug") {
          if (!existsSync(DEBUG_LOG_PATH)) {
            ctx.ui.notify("还没有飞书调试日志。请先在飞书里发一条消息给机器人。", "info");
            return;
          }
          const lines = readFileSync(DEBUG_LOG_PATH, "utf8").trim().split("\n").slice(-20);
          ctx.ui.notify(lines.join("\n"), "info");
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
        ctx.ui.notify("Usage: /feishu setup | start/stop | status | debug | reset | autostart on|off|status | connect/disconnect (local debug) | daemon takeover|logs", "info");
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
    } else {
      const owner = readGatewayOwner();
      if (owner?.status === "connected") {
        setStatusText("Feishu: connected (background)");
      } else if (owner) {
        setStatusText(`Feishu: ${owner.status} (background)`);
      } else if (bootConfig.autoStart === false) {
        updateStatus("disconnected");
      } else {
        updateStatus("connecting");
      }
    }
  });

  if (bootConfig?.autoStart !== false) {
    if (process.env.PI_FEISHU_DAEMON === "1") {
      start().then((result) => {
        if (typeof result === "object" && result.status === "owned") {
          console.error("[feishu] daemon found existing owner, exiting:", formatOwner(result.owner));
          process.exit(0);
        }
      }).catch((error) => {
        updateStatus(error instanceof BotUnavailableError ? "bot unavailable" : "disconnected");
        console.error("[feishu] daemon autoStart failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      });
    } else {
      startDaemon(false).catch((error) => {
        updateStatus("disconnected");
        console.error("[feishu] daemon spawn failed:", error instanceof Error ? error.message : error);
      });
    }
  }

  pi.on("session_shutdown", async () => {
    await stop();
    clearStatus();
  });
}

async function withDaemonSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${gatewayLockPath()}.spawn.lock`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (tryAcquireSpawnLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
    await sleep(25);
  }
  // Last resort: run without the spawn lock. The daemon-side gateway lock still
  // prevents duplicate live Feishu connections.
  return fn();
}

function tryAcquireSpawnLock(lockPath: string) {
  try {
    mkdirSync(lockPath, { recursive: false });
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > 30_000) rmSync(lockPath, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
