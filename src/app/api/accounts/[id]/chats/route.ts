import { errorResponse, json } from "@/lib/http";
import { listChats } from "@/lib/telegram";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const chats = await listChats(decodeURIComponent(id));
    return json({ chats });
  } catch (error) {
    return errorResponse(error);
  }
}
