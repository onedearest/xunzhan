import { HttpError, errorResponse, json } from "@/lib/http";
import { listPosts } from "@/lib/telegram";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const chatId = new URL(request.url).searchParams.get("chatId")?.trim() ?? "";
    if (!chatId) throw new HttpError(400, "先选择一个频道");
    const result = await listPosts(decodeURIComponent(id), chatId);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
