import { getConfig } from "./store";
import { DEFAULT_API_HASH, DEFAULT_API_ID } from "./telegram-app";

export async function resolveCredentials() {
  const config = await getConfig();
  const fromEnv = Number(process.env.TELEGRAM_API_ID);
  const apiId =
    config.apiId || (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_API_ID);
  const apiHash = (config.apiHash || process.env.TELEGRAM_API_HASH || DEFAULT_API_HASH).trim();
  return { apiId, apiHash };
}
