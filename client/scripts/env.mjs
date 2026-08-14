/**
 * Loads operator and trader keys from `.secrets/` into `process.env`, plus
 * the deployed Coston2 addresses, so the operational scripts can be run
 * without a wall of `VAR=...` prefixes.
 *
 * The addresses are the ones recorded in `spec.md` section 3 and
 * `PROGRESS.md`; do not add one here that is not recorded there first.
 * Values already present in the environment win, so a caller can still
 * override any of this the old way.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // missing file is fine; the script will fail on the missing var
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=("?)(.*)\2$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[3];
  }
}

loadEnvFile(resolve(ROOT, ".secrets/deployer.env"));
loadEnvFile(resolve(ROOT, ".secrets/traders.env"));

// The deployer key doubles as the relayer/operator key in the demo scripts.
if (!process.env.DEPLOYER_KEY && process.env.PRIVATE_KEY) {
  process.env.DEPLOYER_KEY = process.env.PRIVATE_KEY;
}

const ADDRESSES = {
  FXRP: "0x0b6a3645c240605887a5532109323a3e12273dc7",
  USDT0: "0xc1a5b41512496b80903d1f32d6dea3a73212e71f",
  VAULT: "0x38F182C65415C9bBCA03420E256E8A9E957B72b2",
  BOOK: "0xDC1F76dD480EE9A3B4383a29a1C956E11E5326d4",
  SETTLEMENT: "0xd064e426F10a8DC00E9892722c468C8A41e9Cb45",
};

for (const [k, v] of Object.entries(ADDRESSES)) {
  if (!(k in process.env)) process.env[k] = v;
}
