import { listAccounts, settingsView } from "@/lib/accounts";
import { errorResponse, json } from "@/lib/http";
import { listJobs } from "@/lib/jobs";

export async function GET() {
  try {
    const [settings, accounts, jobs] = await Promise.all([
      settingsView(),
      listAccounts(),
      listJobs(),
    ]);
    return json({ settings, accounts, jobs });
  } catch (error) {
    return errorResponse(error);
  }
}
