/** Probe: submit an order larger than the trader's vault balance. */
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicKeyFromInfo } from "../src/ecies.ts";
import { sealOrder } from "../src/order.ts";
import { awaitResult } from "../src/relayer.ts";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const coston2 = { id: 114, name: "Coston2", nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain: coston2, transport: http(RPC) });
const trader = createWalletClient({ account: privateKeyToAccount(process.env.MAKER_KEY), chain: coston2, transport: http(RPC) });

const bookAbi = parseAbi([
  "function submitOrder(bytes) payable returns (bytes32)",
  "function currentBatchId() view returns (uint256)",
  "event OrderSubmitted(address indexed trader, uint256 indexed batchId, address indexed tee, bytes32 instructionId)",
]);
const vaultAbi = parseAbi(["function baseBalanceOf(address) view returns (uint256)"]);

const bal = await pub.readContract({ address: process.env.VAULT, abi: vaultAbi, functionName: "baseBalanceOf", args: [trader.account.address] });
console.log(`vault base balance: ${(Number(bal) / 1e6).toFixed(6)} FXRP`);

const info = await (await fetch("http://localhost:6674/info")).json();
const teePub = publicKeyFromInfo(info.machineData.publicKey.x, info.machineData.publicKey.y);
const batchId = await pub.readContract({ address: process.env.BOOK, abi: bookAbi, functionName: "currentBatchId" });

const ct = sealOrder(teePub, { trader: trader.account.address, batchId, side: "SELL", limitPrice: 1_000_000n, size: 5_000_000n });
console.log("submitting SELL of 5.000000 FXRP, which the balance cannot cover");

const hash = await trader.writeContract({ address: process.env.BOOK, abi: bookAbi, functionName: "submitOrder", args: [ct], value: 1_000_000n });
const rc = await pub.waitForTransactionReceipt({ hash });
const [ev] = parseEventLogs({ abi: bookAbi, eventName: "OrderSubmitted", logs: rc.logs });
console.log(`on chain: accepted (the chain cannot see the size), instruction ${ev.args.instructionId}`);

const env = await awaitResult("http://localhost:6674", ev.args.instructionId);
console.log(`enclave verdict: status=${env.result.status}  log="${env.result.log}"`);
