import { HttpError, errorResponse, json, readBody } from "@/lib/http";
import { listThread, replyTo } from "@/lib/telegram";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const chatId = new URL(request.url).searchParams.get("chatId")?.trim() ?? "";
    if (!chatId) throw new HttpError(400, "先选择一个会话");
    const result = await listThread(decodeURIComponent(id), chatId);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = (await readBody(request)) as { chatId?: unknown; message?: unknown };
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    const message = typeof body.message === "string" ? body.message : "";
    if (!chatId) throw new HttpError(400, "先选择一个会话");
    const chat = await replyTo(decodeURIComponent(id), chatId, message);
    return json({ ok: true, chat });
  } catch (error) {
    return errorResponse(error);
  }
}
