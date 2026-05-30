import type { FeishuAttachment, FeishuMessage } from "./types.js";

export type BotCommand =
  | { name: "new" }
  | { name: "model" }
  | { name: "stop" }
  | { name: "workspace"; path?: string };

export function normalizeForDedupe(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function pruneRecentMap(map: Map<string, number>, now: number, ttlMs: number) {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

export function conversationKey(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return `p2p:${msg.senderOpenId}`;
  const threadId = msg.threadId || msg.rootId || msg.parentId;
  if (threadId) return `group:${msg.chatId}:thread:${threadId}`;
  if (msg.chatMode === "topic") return `group:${msg.chatId}:thread:${msg.messageId}`;
  return `group:${msg.chatId}`;
}

export function conversationLabel(msg: FeishuMessage) {
  if (msg.chatType === "p2p") return "[飞书私聊]";
  if (msg.rootId || msg.parentId || msg.threadId || msg.chatMode === "topic") return "[飞书话题]";
  return "[飞书群聊]";
}

export function parseMessageInput(msg: FeishuMessage, botOpenId?: string): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments };
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale: any = post.zh_cn || post.en_us || Object.values(post)[0];
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        for (const elem of para) {
          if (elem.tag === "text" || elem.tag === "a") parts.push(elem.text || "");
          if (elem.tag === "at") parts.push(`@${elem.user_name || "user"}`);
          if ((elem.tag === "img" || elem.tag === "image") && typeof elem.image_key === "string" && elem.image_key) {
            attachments.push({ kind: "image", fileKey: elem.image_key });
          }
        }
      }
      collectAttachments(json, attachments);
      return { text: parts.join("").trim(), attachments };
    }
    if (msg.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (msg.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments };
  } catch {}
  return { text: msg.msgType === "text" ? msg.content : `[${msg.msgType}]`, attachments };
}

export function parseBotCommand(text: string): BotCommand | undefined {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized === "/new") return { name: "new" };
  if (normalized === "/model") return { name: "model" };
  if (normalized === "/stop") return { name: "stop" };
  const workspaceMatch = trimmed.match(/^\/workspace(?:\s+(.+))?$/s);
  if (workspaceMatch) {
    return { name: "workspace", path: workspaceMatch[1]?.trim() };
  }
  return undefined;
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
