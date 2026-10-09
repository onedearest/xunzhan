import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const project = path.join(root, "android/app/src/main/assets/nodejs-project");
await mkdir(project, { recursive: true });

const built = spawnSync("npx", ["vite", "build", "--config", "phone/vite.config.ts"], {
  cwd: root,
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/server/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: path.join(project, "main.js"),
  alias: {
    "@": path.join(root, "src"),
  },
  logLevel: "info",
});

await writeFile(path.join(project, "VERSION"), `${Date.now()}\n`);
console.log("staged", project);
