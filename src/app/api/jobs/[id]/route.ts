import { HttpError, errorResponse, json } from "@/lib/http";
import { getJob } from "@/lib/jobs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const job = await getJob(id);
    if (!job) throw new HttpError(404, "找不到这个任务");
    return json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
