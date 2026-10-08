import { errorResponse, json } from "@/lib/http";
import { stopJob } from "@/lib/jobs";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const job = await stopJob(id);
    return json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
