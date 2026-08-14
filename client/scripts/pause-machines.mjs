/**
 * Pause every registered TEE machine except the one actually running.
 *
 * TEE identity keys are ephemeral: a container restart regenerates the key
 * and registers a new machine, and the old ones linger in the registry as
 * zombies. `OrderBook._pinnedTee` draws with `getRandomTeeIds`, so while a
 * zombie is active a batch can pin a machine that can never sign again and
 * sit stuck until `voidDelay` runs out. Observed live on 2026-08-14: with
 * three machines registered, eight consecutive draws all returned a dead one.
 *
 * Pausing is the registry's own remedy, callable by the machine owner, which
 * is the same operator key that registered them. The live machine is the one
 * whose public key the proxy is serving right now; everything else active is
 * by definition unreachable.
 *
 * Usage: vite-node scripts/pause-machines.mjs
 * Keys and addresses load from `.secrets/` and `spec.md` section 3 via env.mjs.
 */

import "./env.mjs";

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const PROXY = "http://localhost:6674";

const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const BOOK = env("BOOK");

const bookAbi = parseAbi([
  "function TEE_MACHINE_REGISTRY() view returns (address)",
  "function extensionId() view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function getActiveTeeMachines(uint256) view returns (address[])",
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function pause(address)",
]);

const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const operator = createWalletClient({
  account: privateKeyToAccount(env("DEPLOYER_KEY")),
  chain: coston2,
  transport: http(RPC),
});

async function main() {
  // The registry and extension id come from the deployed OrderBook rather
  // than being repeated here, per the no-unrecorded-addresses rule.
  const registry = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "TEE_MACHINE_REGISTRY" });
  const extensionId = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: "extensionId" });

  // The live machine is whichever key the proxy is serving right now.
  const info = await (await fetch(`${PROXY}/info`)).json();
  const { x, y } = info.machineData.publicKey;
  const live = publicKeyToAddress(`0x04${x.slice(2)}${y.slice(2)}`);
  console.log("live machine ", live);

  const active = await pub.readContract({
    address: registry, abi: registryAbi, functionName: "getActiveTeeMachines", args: [extensionId],
  });
  console.log("active       ", active.join(", "));

  const zombies = active.filter((m) => m.toLowerCase() !== live.toLowerCase());
  if (!active.some((m) => m.toLowerCase() === live.toLowerCase())) {
    throw new Error("live machine is not in the active set; refusing to pause anything");
  }
  if (zombies.length === 0) {
    console.log("nothing to pause");
    return;
  }

  for (const m of zombies) {
    console.log("pausing      ", m);
    const hash = await operator.writeContract({
      address: registry, abi: registryAbi, functionName: "pause", args: [m],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`pause reverted: ${hash}`);
  }

  const after = await pub.readContract({
    address: registry, abi: registryAbi, functionName: "getActiveTeeMachines", args: [extensionId],
  });
  console.log("active now   ", after.join(", "));
  const draw = await pub.readContract({
    address: registry, abi: registryAbi, functionName: "getRandomTeeIds", args: [extensionId, 1n],
  });
  console.log("draw returns ", draw.join(", "));
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
