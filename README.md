# pi-feishu-lark

**Feishu/Lark bridge for Pi.** Chat with your Pi coding agent from Feishu (中国飞书) or Lark (国际版).
**飞书/Lark 桥接器。** 在飞书或 Lark 里和你的 Pi coding agent 对话。

Supports private chats, group chats and group topics, with an independent persistent Pi session for each conversation.
支持私聊、群聊、群话题，每个会话有独立的持久化 Pi session。

---

## Install / 安装

```bash
pi install npm:pi-feishu-lark
```

Or from git / 或通过 git 安装:

```bash
pi install git:github.com/AX1202/pi-feishu-lark
```

---

## Setup / 配置

### 1. Create a bot app / 创建机器人应用

**Option A — QR code (recommended) / 扫码自动创建（推荐）**

Run `/feishu setup` in Pi, select "扫码自动创建飞书助手", scan the QR code shown in the terminal. The app and credentials are created automatically.

在 Pi 里运行 `/feishu setup`，选择"扫码自动创建飞书助手"，扫描终端中显示的二维码即可。应用和凭证会自动创建。

**Option B — Manual / 手动配置**

1. Create a self-built app in [Feishu Developer Console](https://open.feishu.cn/app) or [Lark Developer Console](https://open.larkoffice.com/app)
2. Enable **Event** → `im.message.receive_v1` and `card.action.trigger`
3. Enable **Bot** ability / 启用机器人能力
4. Get the **App ID** and **App Secret** / 获取 App ID 和 App Secret
5. Run `/feishu setup`, select "手动填写已有应用", paste your credentials

### 2. Start the bridge / 启动桥接

```
/feishu start
```

Connects via WebSocket and begins receiving messages. Auto-starts by default on Pi session start.
通过 WebSocket 连接并开始接收消息。Pi 会话启动时默认自动启动。

### 3. Chat with Pi / 开始对话

Open a DM or group with your bot in Feishu/Lark and send a message. Pi replies in the same chat.
在飞书/Lark 中打开与机器人的私聊或群聊，发送消息即可。Pi 会在同一对话中回复。

---

## Pi Commands / Pi 命令

| Command / 命令 | Description / 说明 |
|---------|-------------|
| `/feishu setup` | Bilingual setup wizard / 中英双语配置向导 |
| `/feishu start` or `/feishu connect` | Start the single Feishu gateway / 启动单实例飞书 gateway |
| `/feishu stop` or `/feishu disconnect` | Stop the gateway if this Pi process owns it / 停止当前进程拥有的 gateway |
| `/feishu takeover` | Force this Pi process to become the gateway owner / 强制当前 Pi 进程接管 gateway |
| `/feishu status` | Show connection, owner and config / 查看连接、gateway owner 和配置 |
| `/feishu autostart on\|off` | Enable/disable auto-start / 开启/关闭自动启动 |
| `/feishu debug` | Show last 20 debug log lines / 显示最近 20 条调试日志 |
| `/feishu reset` | Clear config and mappings (keeps session history) / 清除配置和会话映射（保留会话历史） |

---

## Feishu Commands / 飞书内命令

Send these to the bot in Feishu/Lark / 在飞书/Lark 中发送给机器人:

| Command / 命令 | Description / 说明 |
|---------|-------------|
| `/new` | Start a fresh Pi session for this conversation / 为此对话创建新 Pi 会话 |
| `/model` | Show model selector card — tap to switch models / 显示模型选择卡片，点击切换模型 |

---

## Features / 功能

- **QR code app creation** — scan to create a Feishu/Lark bot automatically / 扫码自动创建飞书机器人
- **Private chats, group chats, group topics/threads** — each gets its own persistent Pi session / 私聊、群聊、话题各自独立持久化 Pi session
- **Group policy** — `open` (auto-reply, no @ required) or `mention` (reply only when @bot) / 群聊策略：`open` 无需 @ 自动回复，`mention` 仅 @ 时回复
- **Image attachments** — PNG, JPEG, WebP (sent to Pi if model supports images) / 图片附件，支持 PNG/JPEG/WebP（模型支持图片时发送给 Pi）
- **Text/code file attachments** — common source files, logs, JSON, CSV, Markdown, etc. / 文本/代码文件附件
- **Per-conversation model selection** — via `/model` interactive card / 每个对话独立选择模型
- **Single gateway ownership** — only one local Pi process connects to Feishu/Lark at a time / 单实例 gateway，避免多个本地 Pi 进程同时抢消息
- **Message deduplication** — 30s window / 30 秒消息去重
- **Debug log** — at `~/.pi/agent/feishu/debug.log` / 调试日志
- **Auto-start** — configurable, on by default / 可配置的自动启动，默认开启

---

## Config / 配置

Config is saved to `~/.pi/agent/feishu/config.json`. Can also use environment variables:
配置文件保存在 `~/.pi/agent/feishu/config.json`。也支持环境变量：

| Variable / 变量 | Description / 说明 |
|----------|-------------|
| `FEISHU_APP_ID` | App ID / 应用 ID |
| `FEISHU_APP_SECRET` | App Secret / 应用密钥 |
| `FEISHU_DOMAIN` | `feishu` (China / 中国) or `lark` (Global / 国际), default: `feishu` |
| `FEISHU_GROUP_POLICY` | `open` or `mention`, default: `open` |
| `FEISHU_LANGUAGE` | `zh` or `en` |
| `FEISHU_REACT_EMOJI` | Emoji reaction on received messages / 收到消息时的表情回应, default: `THUMBSUP` |
| `FEISHU_AUTO_START` | `1` or `0` |

---

## Files / 文件

| Path / 路径 | Content / 内容 |
|------|-------------|
| `~/.pi/agent/feishu/config.json` | Bot credentials and settings / 机器人凭证与设置 |
| `~/.pi/agent/feishu/state.json` | Conversation-to-session mappings / 会话映射 |
| `~/.pi/agent/feishu/debug.log` | Debug event log / 调试事件日志 |
| `~/.pi/agent/locks.json` | Gateway ownership lock / gateway owner 锁 |
| `~/.pi/agent/sessions/` | Pi session files (one per Feishu conversation) / Pi 会话文件（每个飞书对话一个） |

---

## Notes / 说明

- Replies are plain text (Markdown cards and streaming are planned for a future version).
  回复目前为纯文本（Markdown 卡片和流式更新计划后续版本加入）。
- `/feishu reset` clears config and mappings but keeps session history.
  `/feishu reset` 清除配置和映射，但保留会话历史。
- Image attachments are skipped if the current model doesn't support image input.
  如果当前模型不支持图片输入，图片附件会被跳过。
