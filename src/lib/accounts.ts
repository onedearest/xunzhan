import { demoAccounts } from "./demo-data";
import { getConfig, listStoredAccounts, saveConfig } from "./store";
import { logoutAccount } from "./telegram";
import type { AccountPublic, SettingsView } from "./types";

export async function settingsView(): Promise<SettingsView> {
  const config = await getConfig();
  const apiHash = config.apiHash || process.env.TELEGRAM_API_HASH || "";
  const apiId = config.apiId || Number(process.env.TELEGRAM_API_ID) || null;
  return {
    apiId,
    apiHash,
    hasHash: Boolean(apiId && apiHash),
    demo: Boolean(config.demo),
  };
}

export async function listAccounts(): Promise<AccountPublic[]> {
  const config = await getConfig();
  const stored = await listStoredAccounts();
  const real: AccountPublic[] = stored.map((account) => ({
    id: account.id,
    name: account.name,
    phone: account.phone,
    username: account.username,
    demo: false,
  }));
  return config.demo ? [...real, ...demoAccounts] : real;
}

export async function removeAccount(id: string) {
  const accounts = await listAccounts();
  if (!accounts.some((account) => account.id === id)) {
    throw new Error("找不到这个账号");
  }
  if (id.startsWith("demo-")) {
    await saveConfig({ demo: false });
    return;
  }
  await logoutAccount(id);
}
