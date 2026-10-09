import { errorResponse, json } from "@/lib/http";
import { forgetVault } from "@/lib/vault/service";

export async function POST() {
  try {
    return json(await forgetVault());
  } catch (error) {
    return errorResponse(error);
  }
}
