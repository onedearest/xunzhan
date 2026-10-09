import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = process.env.XUNZHAN_DIST || ".next";
const source = path.join(root, dist, "standalone");
const app = path.join(root, "release", "payload", "app");

await rm(path.join(root, "release"), { recursive: true, force: true });
await mkdir(app, { recursive: true });
await cp(source, app, { recursive: true, dereference: true });
await cp(path.join(root, dist, "static"), path.join(app, dist, "static"), {
  recursive: true,
  dereference: true,
});
await cp(path.join(root, "public"), path.join(app, "public"), {
  recursive: true,
  dereference: true,
});
await rm(path.join(app, "data"), { recursive: true, force: true });
