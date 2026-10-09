import { errorResponse, json } from "@/lib/http";
import { pauseVault } from "@/lib/vault/service";

export async function POST() {
  try {
    return json(await pauseVault());
  } catch (error) {
    return errorResponse(error);
  }
}
