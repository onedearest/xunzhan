import { HttpError, errorResponse, json, readBody } from "@/lib/http";
import { createJob, listJobs } from "@/lib/jobs";

export async function GET() {
  try {
    return json({ jobs: await listJobs() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as {
      message?: unknown;
      intervalSec?: unknown;
      confirmed?: unknown;
      scheduledAt?: unknown;
      selections?: unknown;
    };
    if (typeof body.message !== "string") throw new HttpError(400, "先写好要发送的内容");
    if (typeof body.intervalSec !== "number" || typeof body.confirmed !== "boolean") {
      throw new HttpError(400, "发送参数不完整");
    }
    if (!Array.isArray(body.selections)) throw new HttpError(400, "还没有选择群");
    const selections = body.selections.map((selection) => {
      if (!selection || typeof selection !== "object") throw new HttpError(400, "还没有选择群");
      const record = selection as { accountId?: unknown; chatIds?: unknown };
      if (typeof record.accountId !== "string" || !Array.isArray(record.chatIds)) {
        throw new HttpError(400, "还没有选择群");
      }
      const chatIds = record.chatIds.filter((id): id is string => typeof id === "string");
      return { accountId: record.accountId, chatIds };
    });
    const job = await createJob({
      message: body.message,
      intervalSec: body.intervalSec,
      confirmed: body.confirmed,
      scheduledAt: body.scheduledAt,
      selections,
    });
    return json({ job }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
