import { spawnSync } from "node:child_process";
import { access, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const home = process.env.HOME || "/home/ubuntu";
const sdk = path.join(home, "android-sdk");
const libnode = path.join(root, "android/app/libnode");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} failed`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const sdkmanager = path.join(sdk, "cmdline-tools/latest/bin/sdkmanager");
if (!(await exists(sdkmanager))) {
  await mkdir(path.join(sdk, "cmdline-tools"), { recursive: true });
  run("unzip", ["-q", "-o", "/tmp/android-dl/cmdtools.zip", "-d", "/tmp/android-cmdtools"]);
  await cp("/tmp/android-cmdtools/cmdline-tools", path.join(sdk, "cmdline-tools/latest"), {
    recursive: true,
  });
}

const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
spawnSync("bash", ["-lc", `yes | "${sdkmanager}" --sdk_root="${sdk}" --licenses`], {
  stdio: "inherit",
  env,
});
run(
  sdkmanager,
  [
    `--sdk_root=${sdk}`,
    "platforms;android-35",
    "build-tools;35.0.0",
    "platform-tools",
    "ndk;26.1.10909125",
    "cmake;3.22.1",
  ],
  env,
);

await mkdir(libnode, { recursive: true });
await cp("/tmp/nodejs-mobile/include", path.join(libnode, "include"), { recursive: true });
for (const abi of ["arm64-v8a", "x86_64"]) {
  await cp(path.join("/tmp/nodejs-mobile/bin", abi), path.join(libnode, "bin", abi), {
    recursive: true,
  });
}

await writeFile(path.join(root, "android/local.properties"), `sdk.dir=${sdk}\n`);

const gradleBin = path.join(home, "gradle-8.7/bin/gradle");
if (!(await exists(gradleBin))) {
  run("curl", [
    "-fL",
    "--retry",
    "3",
    "-o",
    "/tmp/android-dl/gradle.zip",
    "https://services.gradle.org/distributions/gradle-8.7-bin.zip",
  ]);
  run("unzip", ["-q", "-o", "/tmp/android-dl/gradle.zip", "-d", home]);
}
run(gradleBin, ["-p", path.join(root, "android"), "wrapper", "--gradle-version", "8.7"]);
console.log("android sdk ready", sdk);
