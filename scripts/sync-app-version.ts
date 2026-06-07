import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJsonPath = `${root}/package.json`;
const trustCenterPath = `${root}/config/trust-center.json`;

const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
const trustCenter = JSON.parse(await readFile(trustCenterPath, "utf8")) as {
  deploymentVersion: string;
  sourceCommit: string;
};

trustCenter.deploymentVersion = pkg.version;

try {
  trustCenter.sourceCommit = execSync("git rev-parse --short HEAD", {
    cwd: root,
    encoding: "utf8"
  }).trim();
} catch {
  console.warn("sync-app-version: git rev-parse failed; leaving sourceCommit unchanged");
}

await writeFile(trustCenterPath, `${JSON.stringify(trustCenter, null, 2)}\n`, "utf8");
console.log(
  `Synced trust-center: deploymentVersion=${trustCenter.deploymentVersion} sourceCommit=${trustCenter.sourceCommit}`
);