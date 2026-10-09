export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeVault } = await import("./lib/vault/service");
    await resumeVault();
  }
}
