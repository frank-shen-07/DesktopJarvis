// Re-signs the built app with the local certificate from scripts/make-signing-cert.sh,
// when it exists. Without it the build keeps electron-builder's ad-hoc signature, which
// differs on every build, so macOS stops the new build reading keys an older one saved.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const NAME = "DesktopJarvis Local Signing";
const APP = "release/mac-arm64/DesktopJarvis.app";

const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
if (!identities.includes(NAME)) {
  console.info(
    `No "${NAME}" certificate, so the app keeps its ad-hoc signature. Run scripts/make-signing-cert.sh once to keep saved keys across builds.`,
  );
} else if (!existsSync(APP)) {
  console.warn(`${APP} was not found, so it was not re-signed.`);
} else {
  execFileSync("codesign", ["--force", "--deep", "--sign", NAME, APP], { stdio: "inherit" });
  console.info(`Signed ${APP} with "${NAME}".`);
}
