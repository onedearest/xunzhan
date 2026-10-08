import { removeAccount } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    await removeAccount(decodeURIComponent(id));
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
