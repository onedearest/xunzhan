export type ChatKind = "group" | "supergroup" | "channel";

export type ChatPublic = {
  id: string;
  title: string;
  kind: ChatKind;
  username?: string;
  participantsCount?: number;
  canPost: boolean;
  reason?: string;
  slowmode?: boolean;
};

export type AccountPublic = {
  id: string;
  name: string;
  phone: string;
  username?: string;
  demo: boolean;
};

export type DeliveryStatus = "pending" | "sending" | "ok" | "error" | "skipped";

export type Delivery = {
  accountId: string;
  accountName: string;
  chatId: string;
  title: string;
  status: DeliveryStatus;
  error?: string;
  sentAt?: string;
};

export type JobStatus = "scheduled" | "running" | "done" | "stopped" | "failed";

export type Job = {
  id: string;
  message: string;
  intervalSec: number;
  status: JobStatus;
  createdAt: string;
  scheduledAt?: string;
  finishedAt?: string;
  deliveries: Delivery[];
};

export type PostPublic = {
  id: string;
  text: string;
  date: string;
  views?: number;
};

export type SettingsView = {
  apiId: number | null;
  apiHash: string;
  hasHash: boolean;
  demo: boolean;
};

export type Bootstrap = {
  settings: SettingsView;
  accounts: AccountPublic[];
  jobs: Job[];
};
