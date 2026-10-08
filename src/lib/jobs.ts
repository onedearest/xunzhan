import { listAccounts } from "./accounts";
import { finishStatus, parseSchedule, planBatch, runDeliveries, sleep } from "./policy";
import { readJobs, writeJobs } from "./store";
import { listChats, sendTo } from "./telegram";
import type { Job } from "./types";

type Runtime = {
  jobs: Job[];
  controllers: Map<string, AbortController>;
  loaded: boolean;
};

function runtime(): Runtime {
  const root = globalThis as { __xunzhanJobs?: Runtime };
  if (!root.__xunzhanJobs) {
    root.__xunzhanJobs = { jobs: [], controllers: new Map(), loaded: false };
  }
  return root.__xunzhanJobs;
}

let gate: Promise<void> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureLoaded() {
  const state = runtime();
  if (state.loaded) return;
  const stored = await readJobs();
  const now = new Date().toISOString();
  state.jobs = stored.map((job) => {
    if (job.status !== "running" && job.status !== "scheduled") return job;
    return {
      ...job,
      status: "stopped" as const,
      finishedAt: job.finishedAt ?? now,
      deliveries: job.deliveries.map((delivery) =>
        delivery.status === "pending" || delivery.status === "sending"
          ? { ...delivery, status: "skipped" as const, error: "服务重启，未继续发送" }
          : delivery,
      ),
    };
  });
  state.loaded = true;
  await writeJobs(state.jobs);
}

export async function listJobs(): Promise<Job[]> {
  await ensureLoaded();
  return runtime().jobs;
}

export async function getJob(id: string): Promise<Job | undefined> {
  await ensureLoaded();
  return runtime().jobs.find((job) => job.id === id);
}

function persist() {
  return writeJobs(runtime().jobs);
}

export function createJob(input: {
  message: string;
  intervalSec: number;
  confirmed: boolean;
  scheduledAt?: unknown;
  selections: { accountId: string; chatIds: string[] }[];
}): Promise<Job> {
  return exclusive(async () => {
    await ensureLoaded();
    if (runtime().jobs.some((job) => job.status === "running" || job.status === "scheduled")) {
      throw new Error("已有发送任务在进行，先等它完成或停止");
    }
    const schedule = parseSchedule(input.scheduledAt);
    if (!schedule.ok) throw new Error(schedule.error);
    const accounts = await listAccounts();
    const merged = new Map<string, string[]>();
    for (const selection of input.selections) {
      const current = merged.get(selection.accountId) ?? [];
      merged.set(selection.accountId, [...current, ...selection.chatIds]);
    }
    const selections = [...merged.entries()].map(([accountId, chatIds]) => {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) throw new Error("有选中的账号不存在");
      return {
        accountId: account.id,
        accountName: account.name,
        demo: account.demo,
        chatIds,
      };
    });
    const catalogs = Object.fromEntries(
      await Promise.all(
        selections.map(async (selection) => [selection.accountId, await listChats(selection.accountId)] as const),
      ),
    );
    const plan = planBatch({
      message: input.message,
      intervalSec: input.intervalSec,
      confirmed: input.confirmed,
      selections,
      catalogs,
    });
    if (!plan.ok) throw new Error(plan.error);

    const job: Job = {
      id: crypto.randomUUID(),
      message: plan.message,
      intervalSec: plan.intervalSec,
      status: schedule.at ? "scheduled" : "running",
      createdAt: new Date().toISOString(),
      scheduledAt: schedule.at,
      deliveries: plan.deliveries,
    };
    const controller = new AbortController();
    runtime().jobs = [job, ...runtime().jobs].slice(0, 20);
    runtime().controllers.set(job.id, controller);
    await persist();
    void execute(job, controller);
    return job;
  });
}

async function execute(job: Job, controller: AbortController) {
  try {
    if (job.scheduledAt) {
      const waitMs = new Date(job.scheduledAt).getTime() - Date.now();
      if (waitMs > 0) await sleep(waitMs, controller.signal);
      if (controller.signal.aborted) {
        for (const delivery of job.deliveries) {
          if (delivery.status === "pending" || delivery.status === "sending") {
            delivery.status = "skipped";
            delivery.error = "已停止";
          }
        }
        job.status = "stopped";
        return;
      }
      job.status = "running";
      await persist();
    }
    await runDeliveries({
      deliveries: job.deliveries,
      intervalMs: job.intervalSec * 1000,
      signal: controller.signal,
      send: (delivery) => sendTo(delivery.accountId, delivery.chatId, job.message),
      onUpdate: () => {
        void persist();
      },
    });
    job.status = finishStatus(job.deliveries, controller.signal.aborted);
  } catch (error) {
    job.status = "failed";
    for (const delivery of job.deliveries) {
      if (delivery.status === "pending" || delivery.status === "sending") {
        delivery.status = "error";
        delivery.error = error instanceof Error ? error.message : "发送失败";
      }
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    runtime().controllers.delete(job.id);
    await persist();
  }
}

export async function stopJob(id: string): Promise<Job> {
  await ensureLoaded();
  const job = runtime().jobs.find((item) => item.id === id);
  if (!job) throw new Error("找不到这个任务");
  runtime().controllers.get(id)?.abort();
  return job;
}
