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
  workspaces?: Record<string, string>;
};

export type FeishuRoute = {
  sessionKey: string;
  sessionId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadMessageId?: string;
  lastMessageId: string;
  updatedAt: number;
};

export type FeishuJobRoute = FeishuRoute & {
  jobId: string;
  jobName?: string;
  createdAt: number;
};

export type FeishuBridgeState = {
  version: 1;
  routes: Record<string, FeishuRoute>;
  jobs: Record<string, FeishuJobRoute>;
  sent: Record<string, number>;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatMode?: "p2p" | "group" | "topic";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
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
  token?: string;
  value: unknown;
};

export type FeishuCopyMarkdownAction = {
  copySourceId: string;
};

export type FeishuStatus = "not configured" | "connecting" | "connected" | "owned" | "bot unavailable" | "disconnected";
