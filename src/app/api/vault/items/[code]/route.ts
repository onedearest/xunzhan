import { errorResponse, json } from "@/lib/http";
import { deleteVaultItem } from "@/lib/vault/service";

type Context = { params: Promise<{ code: string }> };

export async function DELETE(_request: Request, context: Context) {
  try {
    const { code } = await context.params;
    return json(await deleteVaultItem(decodeURIComponent(code)));
  } catch (error) {
    return errorResponse(error);
  }
}
