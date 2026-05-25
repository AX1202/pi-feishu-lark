export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  language?: "zh" | "en";
  reactEmoji?: string;
  autoStart?: boolean;
};

export type ModelSelection = {
  provider: string;
  id: string;
};

export type FeishuState = {
  sessions: Record<string, string>;
  models?: Record<string, ModelSelection>;
};

export type FeishuMessage = {
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

export type FeishuAttachment = {
  kind: "image" | "file";
  fileKey: string;
  fileName?: string;
};

export type FeishuCardAction = {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
};

export type FeishuStatus = "not configured" | "connecting" | "connected" | "owned" | "bot unavailable" | "disconnected";
