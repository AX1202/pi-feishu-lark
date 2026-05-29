# pi-feishu-lark

目前功能最强，最易用的 Pi 连接 飞书/Lark 的扩展包！！

<p align="center">
  <a href="#zh">中文</a> · <a href="#en">English</a>
</p>

<a id="zh"></a>

## 中文

Pi Agent飞书交流反馈群：<https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=57dvecbb-95d3-4d01-b689-6ebc3d17c867>

扩展有什么问题可以加群反馈。

## 我的媒体平台 关注我第一时间了解最新AI工具

全平台账号名称：AX阿煊

B站：<https://space.bilibili.com/4489397>

小红书号：269094344

抖音号：191531443

## 主要能力

- 通过扫码快速创建飞书/Lark 机器人，减少手动配置
- 支持私聊、群聊、群话题分别维护独立的 Pi 会话
- 支持群聊策略：
  - `open`：群里和话题里可直接回复，不需要 @，还需手动在飞书开发者后台开启机器人“**获取群组中所有消息”的权限**
  - `mention`：只有 `@` 机器人时才回复
- 支持图片、代码文件、文本文件等附件发送
- 支持飞书内切换对话模型
- 支持显示实时 Pi 任务执行状态
- 支持渲染显示 Markdown 格式内容
- Pi agent 关闭后，仍有后台常驻服务可以对话，pi agent无需前台运行。

<br />

***

## 快速开始

### 1. 安装

```bash
pi install npm:pi-feishu-lark
```

也可以从 Git 安装：

```bash
pi install git:github.com/AX1202/pi-feishu-lark
```

### 2. 初始化配置

在 Pi 里运行：

```bash
/feishu setup
```

推荐选择“扫码自动创建飞书助手”，按提示扫描终端里的二维码即可。

如果你已经有现成的飞书/Lark 应用，也可以选择手动填写 App ID 和 App Secret。

### 3. 启动桥接

```bash
/feishu start
```

如果开启了自动启动，Pi 会话启动时会自动连上飞书/Lark。


# Windows 上运行 Pi Agent 飞书插件配置方法

## 解决方法

### 1. 先安装 Git for Windows

安装后一般会有这个文件：

```text
C:\Program Files\Git\bin\bash.exe
```

这个就是 Windows 上给 Pi 使用的 Bash 环境。

---

### 2. 配置 Pi 的 settings.json

打开：

```text
C:\Users\你的用户名\.pi\agent\settings.json
```

在大括号里加这一行：

```json
"shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
```

注意：如果你原来文件里还有其他配置，不要删掉，只加这一行即可。

这个配置主要是告诉 **Pi 主程序** 使用哪个 Bash。

---

### 3. 把 Git Bash 加到 Windows PATH

有些插件会直接调用：

```text
bash
```

它不一定读取 Pi 的 `shellPath` 配置，所以还需要把 Git Bash 加到系统 PATH。

在 PowerShell 里执行：

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Program Files\Git\bin",
  "User"
)
```

---

### 4. 重启 PowerShell

执行完上面的命令后，要关闭 PowerShell，再重新打开。

然后验证：

```powershell
where.exe bash
```

如果输出：

```text
C:\Program Files\Git\bin\bash.exe
```

说明修复成功。

---

### 5. 再运行 Pi

```powershell
pi
```

---

## 总结

最稳的配置是两个都做：

```text
settings.json 配置 shellPath
+
Windows PATH 加入 C:\Program Files\Git\bin
```

前者给 Pi 主程序用，后者给插件或子进程直接调用 `bash` 用。



### 4. 开始聊天

在飞书/Lark 里打开机器人，直接发消息即可。

- 私聊：直接发消息
- 群聊：根据群聊策略决定是否需要 `@` 机器人
- 话题：每个话题会独立对应一个 Pi 会话

***

## 飞书里怎么用

发送给机器人的常用命令：

| 命令       | 作用                   |
| -------- | -------------------- |
| `/new`   | 为当前会话新建一个 Pi 会话      |
| `/model` | 打开模型选择卡片，切换当前会话使用的模型 |
| `/stop`  | 停止当前这条回复的处理          |

***

## Pi 里怎么管理

| 命令                  | 作用                  |
| ------------------- | ------------------- |
| `/feishu setup`     | 打开初始化配置             |
| `/feishu start`     | 启动飞书桥接              |
| `/feishu stop`      | 停止飞书桥接              |
| `/feishu restart`   | 重启桥接，并重新加载最新代码和配置   |
| `/feishu status`    | 查看连接状态、当前 owner 和配置 |
| `/feishu autostart` | 开关自动启动              |
| `/feishu debug`     | 查看最近 20 条调试日志       |
| `/feishu reset`     | 清除配置和映射，但保留会话历史     |

***

## 配置

配置默认保存在：

```text
~/.pi/agent/feishu/config.json
```

也可以通过环境变量配置：

| 变量                    | 说明                            |
| --------------------- | ----------------------------- |
| `FEISHU_APP_ID`       | 飞书/Lark 应用 ID                 |
| `FEISHU_APP_SECRET`   | 飞书/Lark 应用密钥                  |
| `FEISHU_DOMAIN`       | `feishu` 或 `lark`，默认 `feishu` |
| `FEISHU_GROUP_POLICY` | `open` 或 `mention`，默认 `open`  |
| `FEISHU_LANGUAGE`     | `zh` 或 `en`                   |
| `FEISHU_REACT_EMOJI`  | 收到消息时的表情回应，默认 `THUMBSUP`      |
| `FEISHU_AUTO_START`   | `1` 或 `0`                     |
| `FEISHU_EXT_DEV`      | `1` 时显示本地开发标识 `DEV`           |

***

## 会保存哪些文件

| 路径                               | 内容                |
| -------------------------------- | ----------------- |
| `~/.pi/agent/feishu/config.json` | 机器人凭证和基础配置        |
| `~/.pi/agent/feishu/state.json`  | 飞书会话和 Pi 会话的映射    |
| `~/.pi/agent/feishu/bridge.json` | 从飞书发起的 Pi 任务路由信息  |
| `~/.pi/agent/feishu/debug.log`   | 调试日志              |
| `~/.pi/agent/locks.json`         | 当前飞书连接的 owner 锁   |
| `~/.pi/agent/sessions/`          | 每个飞书会话对应的 Pi 会话文件 |

***

## 常见说明

- 图片能不能被识别，取决于当前选中的模型是否支持图片输入。
- `/feishu reset` 只会清掉配置和映射，不会删除会话历史。
- 从 TUI、CLI 或其他渠道创建的任务，不会主动发到飞书。

***

## 常见问题

### 为什么机器人没回复？

先看三件事：

- 飞书机器人是否已经创建并配置好
- `/feishu start` 是否已经运行
- 群聊策略是否要求 `@` 机器人

### 为什么我在群里发了消息，机器人没有理我？

如果你把群聊策略设成了 `mention`，就需要 `@` 机器人后它才会回复。\
`open`模式下：群里和话题里可直接回复，不需要 @，但还需手动在飞书开发者后台开启机器人“获取群组中所有消息”权限才能生效。

### 还没有实现后台服务开机自启动功能，目前需要电脑开机后手动启动一次 Pi agent 才能正常工作。启动后，Pi agent 无需前台运行，关闭后，仍可以在飞书/Lark 里对话。

<a id="en"></a>

## English

Pi-feishu-lark is a bridge between Pi and Feishu/Lark for chat-based workflows.

### Highlights

- Create a Feishu/Lark bot quickly with QR-code setup
- Keep separate Pi sessions for DMs, group chats, and group topics
- Support attachments such as images, code files, and text files
- Switch models inside Feishu/Lark
- Show live Pi task status
- Render Markdown replies
- Keep Pi running in the background after the agent UI is closed

### Quick Start

1. Install:

```bash
pi install npm:pi-feishu-lark
```

1. Set up:

```bash
/feishu setup
```

1. Start the bridge:

```bash
/feishu start
```

1. Chat in Feishu/Lark.

### Common Commands

| Command  | Meaning                                     |
| -------- | ------------------------------------------- |
| `/new`   | Start a new Pi session for the current chat |
| `/model` | Open the model picker                       |
| `/stop`  | Stop the current reply generation           |

### Config

| Variable              | Meaning                |
| --------------------- | ---------------------- |
| `FEISHU_APP_ID`       | Feishu/Lark app ID     |
| `FEISHU_APP_SECRET`   | Feishu/Lark app secret |
| `FEISHU_DOMAIN`       | `feishu` or `lark`     |
| `FEISHU_GROUP_POLICY` | `open` or `mention`    |
| `FEISHU_LANGUAGE`     | `zh` or `en`           |
| `FEISHU_REACT_EMOJI`  | Reaction emoji         |
| `FEISHU_AUTO_START`   | `1` or `0`             |

### Notes

- Image understanding depends on the selected model.
- `/feishu reset` clears config and mappings, but keeps session history.
- Tasks created from TUI, CLI, or other channels will not be pushed to Feishu automatically.

