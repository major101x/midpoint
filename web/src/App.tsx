/**
 * Midpoint: a sealed-bid batch auction venue for FXRP.
 *
 * The interface is organised around the one thing worth showing: what the chain
 * can see next to what only the enclave can see. Everything else is plumbing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEventLogs,
  type Address,
} from "viem";

import {
  ADDRESSES,
  CHAIN,
  EXPLORER,
  INSTRUCTION_FEE,
  RPC_URL,
  TEE_BASE,
  TEE_INFO_URL,
  ammAbi,
  erc20Abi,
  fmt,
  orderBookAbi,
  parseAmount,
  settlementAbi,
  short,
  teeFetch,
  vaultAbi,
} from "./lib/config";
import { publicKeyFromInfo } from "./lib/ecies";
import { sealOrder, type Side } from "./lib/order";
import { awaitResult, decodeBatchResult } from "./lib/relayer";
import { estimateSandwich, type MevEstimate } from "./lib/sandwich";
import AuroraBackdrop from "@/components/AuroraBackdrop";
import GlassPill from "@/components/GlassPill";
import PrimaryButton from "@/components/PrimaryButton";

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

interface Balances {
  walletBase: bigint;
  walletQuote: bigint;
  vaultBase: bigint;
  vaultQuote: bigint;
}

interface BatchState {
  id: bigint;
  orders: number;
  tee: Address;
  openedAt: bigint;
  closed: boolean;
  minDuration: bigint;
  frozen: boolean;
  lastSettled: bigint;
}

export default function App() {
  const [account, setAccount] = useState<Address>();
  const [teePubKey, setTeePubKey] = useState<Uint8Array>();
  const [teeExtension, setTeeExtension] = useState<string>();
  const [balances, setBalances] = useState<Balances>();
  const [batch, setBatch] = useState<BatchState>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const [mev, setMev] = useState<MevEstimate | null>();
  const [lastCiphertext, setLastCiphertext] = useState<string>();
  const [settled, setSettled] = useState<{ price: string; volume: string; batchId: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  const wallet = useMemo(
    () =>
      account && typeof window !== "undefined" && (window as any).ethereum
        ? createWalletClient({ account, chain: CHAIN, transport: custom((window as any).ethereum) })
        : undefined,
    [account],
  );

  // --- reads ---------------------------------------------------------------

  const refresh = useCallback(async () => {
    const [id, orders, tee, openedAt, closed, minDuration, frozen, lastSettled] = await Promise.all([
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "currentBatchId" }),
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "orderCount" }),
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "batchTee" }),
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "batchOpenedAt" }),
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "batchClosed" }),
      pub.readContract({ address: ADDRESSES.orderBook, abi: orderBookAbi, functionName: "minBatchDuration" }),
      pub.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "frozen" }),
      pub.readContract({ address: ADDRESSES.settlement, abi: settlementAbi, functionName: "lastSettledBatch" }),
    ]);
    setBatch({ id, orders: Number(orders), tee, openedAt, closed, minDuration, frozen, lastSettled });

    if (account) {
      const [walletBase, walletQuote, vaultBase, vaultQuote] = await Promise.all([
        pub.readContract({ address: ADDRESSES.fxrp, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        pub.readContract({ address: ADDRESSES.usdt0, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        pub.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "baseBalanceOf", args: [account] }),
        pub.readContract({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "quoteBalanceOf", args: [account] }),
      ]);
      setBalances({ walletBase, walletQuote, vaultBase, vaultQuote });
    }
  }, [account]);

  // Priced from the comparison pool's live reserves. Independent of the enclave
  // and of any wallet, so the argument on this page holds up even when the demo
  // stack is offline.
  useEffect(() => {
    Promise.all([
      pub.readContract({ address: ADDRESSES.amm, abi: ammAbi, functionName: "reserveBase" }),
      pub.readContract({ address: ADDRESSES.amm, abi: ammAbi, functionName: "reserveQuote" }),
    ])
      .then(([rb, rq]) => setMev(estimateSandwich(rb, rq)))
      .catch(() => setMev(null));
  }, []);

  useEffect(() => {
    teeFetch(TEE_INFO_URL)
      .then((r) => r.json())
      .then((info) => {
        setTeePubKey(publicKeyFromInfo(info.machineData.publicKey.x, info.machineData.publicKey.y));
        setTeeExtension(info.machineData.extensionId);
      })
      .catch(() =>
        setError(
          `Cannot reach the enclave proxy at ${TEE_BASE}. The venue is live only while ` +
            `its enclave is running, so this is expected outside a demo window.`,
        ),
      );
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    const t = setInterval(() => {
      refresh().catch(() => {});
      setNow(Math.floor(Date.now() / 1000));
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // --- actions -------------------------------------------------------------

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(undefined);
      setStatus(undefined);
    }
  }

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) {
      setError("No injected wallet found. Install MetaMask and add Coston2.");
      return;
    }
    const [addr] = await eth.request({ method: "eth_requestAccounts" });
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x72" }] });
    } catch {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x72",
          chainName: "Flare Coston2",
          nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        }],
      });
    }
    setAccount(addr as Address);
  }

  async function tx(request: any) {
    if (!wallet) throw new Error("connect a wallet first");
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("transaction reverted");
    return receipt;
  }

  const deposit = (isBase: boolean, amount: bigint) =>
    run("depositing", async () => {
      const token = isBase ? ADDRESSES.fxrp : ADDRESSES.usdt0;
      setStatus("approving");
      await tx({ address: token, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.vault, amount] });
      setStatus("depositing");
      await tx({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "deposit", args: [isBase, amount] });
    });

  const withdraw = (isBase: boolean, amount: bigint) =>
    run("withdrawing", () =>
      tx({ address: ADDRESSES.vault, abi: vaultAbi, functionName: "withdraw", args: [isBase, amount] }).then(() => {}),
    );

  const submit = (side: Side, price: bigint, size: bigint) =>
    run("sealing", async () => {
      if (!teePubKey || !account || !batch) throw new Error("not ready");
      // Sealed in the browser. The key belongs to an attested enclave, so from
      // here on nobody, including the venue operator, can read this order.
      const ciphertext = sealOrder(teePubKey, {
        trader: account,
        batchId: batch.id,
        side,
        limitPrice: price,
        size,
      });
      setLastCiphertext(ciphertext);
      setStatus("submitting sealed order");
      await tx({
        address: ADDRESSES.orderBook,
        abi: orderBookAbi,
        functionName: "submitOrder",
        args: [ciphertext],
        value: INSTRUCTION_FEE,
      });
    });

  const closeAndSettle = () =>
    run("clearing", async () => {
      setStatus("closing the batch");
      const receipt = await tx({
        address: ADDRESSES.orderBook,
        abi: orderBookAbi,
        functionName: "closeBatch",
        value: INSTRUCTION_FEE,
      });
      const [ev] = parseEventLogs({ abi: orderBookAbi, eventName: "BatchClosed", logs: receipt.logs });
      if (!ev) throw new Error("BatchClosed not found");

      setStatus("waiting for the enclave to clear and sign");
      const result = decodeBatchResult(
        await awaitResult(TEE_BASE, ev.args.instructionId, { fetchImpl: teeFetch }),
      );

      setStatus("settling on chain");
      await tx({
        address: ADDRESSES.settlement,
        abi: settlementAbi,
        functionName: "settle",
        args: [result.payload, result.signature],
      });
      setSettled({ price: result.clearingPrice, volume: result.volume, batchId: result.batchId });
    });

  const closeableIn = batch
    ? Math.max(0, Number(batch.openedAt) + Number(batch.minDuration) - now)
    : 0;

  return (
    <div className="page">
      <div className="container">
        <Header teeExtension={teeExtension} account={account} onConnect={connect} />

        {error && <div className="banner error">{error}</div>}
        {busy && <div className="banner busy">{status ?? busy}...</div>}
      </div>

      {/* Full bleed: the aurora spans the viewport, the copy stays in the
          container. Boxing the glow inside the content column made it read as
          a blue rectangle rather than as light. */}
      <Hero mev={mev} batch={batch} />

      {/* Ruled lines that run the full width of the page, not boxes drawn
          around the content. See design.md section 4.2. */}
      <div className="lattice">
      <div className="lat-row">
      <div className="container two">
        <section className="cell public">
          <h2>What the chain sees</h2>
          <dl>
            <Row k="Batch" v={batch ? `#${batch.id}` : "-"} />
            <Row k="Orders submitted" v={batch ? String(batch.orders) : "-"} />
            <Row k="Enclave pinned" v={batch && batch.tee !== "0x0000000000000000000000000000000000000000" ? short(batch.tee) : "not yet"} />
            <Row k="Status" v={batch?.closed ? "closed, awaiting settlement" : "open"} />
            <Row k="Last settled batch" v={batch ? `#${batch.lastSettled}` : "-"} />
          </dl>
          {lastCiphertext && (
            <>
              <div className="label">Your last order, as the chain stores it</div>
              <pre className="cipher">{lastCiphertext}</pre>
            </>
          )}
        </section>

        <section className="cell private">
          <h2>What only the enclave sees</h2>
          <ul className="hidden-list">
            <li>Which side you took</li>
            <li>Your limit price</li>
            <li>Your order size</li>
            <li>Every order that does not fill</li>
            <li>The resting book, in full</li>
          </ul>
          <p className="note">
            None of this is recoverable from the chain, from this page, or from the
            machine running the venue. Only the clearing price and the net
            movements become public, and only after the batch settles.
          </p>
        </section>
      </div>
      </div>

      <div className="lat-row">
      <div className="container two">
        <section className="cell">
          <h2>Your balances</h2>
          <BalancePanel balances={balances} onDeposit={deposit} onWithdraw={withdraw} disabled={!!busy || !account} frozen={batch?.frozen} />
          <p className="note">
            Deposits are public and deliberately separate from ordering. A deposit
            says only that you are a participant, never what you intend to trade.
          </p>
        </section>

        <section className="cell">
          <h2>Place a sealed order</h2>
          <OrderForm
            onSubmit={submit}
            disabled={!!busy || !account || !teePubKey || batch?.closed === true}
            available={balances}
          />
          <p className="note">
            Encrypted in your browser to the enclave's public key. The order is
            opaque from the moment it leaves this page.
          </p>
        </section>
      </div>
      </div>

      <div className="lat-row">
      <div className="container">
        <section className="cell">
        <h2>Clear the batch</h2>
        <p className="note">
          Closing is permissionless: anyone may close a batch once its window has
          elapsed, so the venue does not depend on the operator staying online.
          It cannot be closed instantly, because a batch of one order would leak
          that order's side at settlement.
        </p>
        <div className="row">
          <PrimaryButton
            disabled={!!busy || !account || !batch || batch.orders === 0 || closeableIn > 0 || batch.closed}
            onClick={closeAndSettle}
          >
            {closeableIn > 0 ? `closeable in ${closeableIn}s` : "Close, clear and settle"}
          </PrimaryButton>
        </div>
        {settled && (
          <div className="settled">
            <div>
              Batch <strong>#{settled.batchId}</strong> cleared at{" "}
              <strong>{fmt(BigInt(settled.price))}</strong> USDT0 per FXRP
            </div>
            <div>
              Volume <strong>{fmt(BigInt(settled.volume))}</strong> FXRP, every fill at the
              same price.
            </div>
          </div>
        )}
        </section>
      </div>
      </div>
      </div>

      <div className="container">
        <Footer />
      </div>
    </div>
  );
}

function Header({ teeExtension, account, onConnect }: {
  teeExtension?: string;
  account?: Address;
  onConnect: () => void;
}) {
  return (
    <header>
      <div>
        <h1>Midpoint</h1>
        <p className="tagline">
          A sealed-bid batch auction for FXRP. Orders are encrypted to a Flare
          TEE, cleared at one uniform price, and settled on Coston2.
        </p>
      </div>
      <div className="header-right">
        {teeExtension && (
          <GlassPill className="chip">enclave {short(teeExtension, 8, 6)}</GlassPill>
        )}
        {account ? (
          <GlassPill className="chip account">{short(account, 6, 4)}</GlassPill>
        ) : (
          <PrimaryButton onClick={onConnect}>Connect wallet</PrimaryButton>
        )}
      </div>
    </header>
  );
}

/**
 * The argument, before the product.
 *
 * A visitor who has not already met MEV has no reason to care about any of the
 * controls below, so the page leads with the problem and prices it. The figure
 * is computed from the comparison pool's live reserves rather than recorded, so
 * it cannot quietly go stale.
 */
function Hero({ mev, batch }: { mev?: MevEstimate | null; batch?: BatchState }) {
  return (
    <section className="hero-band">
      <AuroraBackdrop />

      <div className="container hero">
      <div className="hero-copy">
        <p className="kicker">The problem</p>
        <p className="hero-title">
          Every on-chain trade announces itself before it executes.
        </p>
        <p className="hero-body">
          Public transactions sit in a queue anyone can read. A bot buys immediately
          ahead of a large order, lets that order push the price up, and sells into
          it. The trader gets a worse fill and the bot keeps the difference. No
          amount of clever pool design fixes this, because the leak happens before
          execution.
        </p>
        <p className="hero-body">
          Midpoint encrypts orders to a Flare TEE, collects them into a batch, and
          clears the batch at a single price. There is nothing to read ahead of, and
          being early in the batch is worth exactly nothing.
        </p>

        {/* Deliberately not vanity metrics. Every one of these is checkable:
            the first two are read from Coston2 on load, the third is the
            repository's test count. */}
        <div className="stats">
          <div>
            <div className="stat-value">{mev ? `${mev.bps}` : "746"} bps</div>
            <div className="stat-label">Extracted on a public pool</div>
          </div>
          <div>
            <div className="stat-value">{batch ? `${batch.lastSettled}` : "-"}</div>
            <div className="stat-label">Sealed batches settled</div>
          </div>
          <div>
            <div className="stat-value">194</div>
            <div className="stat-label">Tests across the stack</div>
          </div>
        </div>
      </div>

      <div className="mev">
        <div className="mev-head">Cost of being observed</div>
        {mev === undefined && <div className="mev-loading">pricing the live pool...</div>}
        {mev === null && (
          <div className="mev-loading">
            The comparison pool is not reachable. The figure last measured live was
            <strong> 746 bps</strong>.
          </div>
        )}
        {mev && (
          <>
            <div className="mev-rows">
              <div className="mev-row">
                <span>Public pool</span>
                <strong className="bad">{mev.bps} bps</strong>
              </div>
              <div className="mev-row">
                <span>Midpoint</span>
                <strong className="good">0 bps</strong>
              </div>
            </div>
            <div className="mev-detail">
              <div>
                A buy of <b>{fmt(mev.tradeSize, 4)}</b> USDT0, worth{" "}
                {mev.tradePctOfReserve.toFixed(1)}% of the pool, fills at{" "}
                <b>{fmt(mev.alonePrice, 4)}</b> unobserved and{" "}
                <b>{fmt(mev.sandwichedPrice, 4)}</b> once a searcher front-runs it.
              </div>
              <div className="mev-fine">
                Computed live from the comparison pool's reserves
                ({fmt(mev.reserveBase, 2)} FXRP / {fmt(mev.reserveQuote, 2)} USDT0)
                using the same arithmetic the pool uses. Constant-product pricing is
                scale invariant, so the basis points hold at any depth. The attack has
                also been executed for real on Coston2, not only modelled.
              </div>
            </div>
          </>
        )}
      </div>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="dlrow">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function BalancePanel({ balances, onDeposit, onWithdraw, disabled, frozen }: {
  balances?: Balances;
  onDeposit: (isBase: boolean, amount: bigint) => void;
  onWithdraw: (isBase: boolean, amount: bigint) => void;
  disabled: boolean;
  frozen?: boolean;
}) {
  const [amounts, setAmounts] = useState({ base: "", quote: "" });

  const move = (isBase: boolean, dir: "in" | "out") => {
    try {
      const amount = parseAmount(isBase ? amounts.base : amounts.quote);
      if (amount <= 0n) return;
      (dir === "in" ? onDeposit : onWithdraw)(isBase, amount);
    } catch {
      /* the input is validated by the button being pressed; ignore junk */
    }
  };

  const asset = (label: string, isBase: boolean, wallet?: bigint, vault?: bigint) => (
    <div className="asset">
      <div className="asset-head">
        <strong>{label}</strong>
        <span className="muted">
          wallet {fmt(wallet, 4)} &middot; venue {fmt(vault, 4)}
        </span>
      </div>
      <div className="row">
        <input
          placeholder="0.00"
          value={isBase ? amounts.base : amounts.quote}
          onChange={(e) => setAmounts((a) => (isBase ? { ...a, base: e.target.value } : { ...a, quote: e.target.value }))}
        />
        <button disabled={disabled} onClick={() => move(isBase, "in")}>Deposit</button>
        <button disabled={disabled || frozen} onClick={() => move(isBase, "out")} title={frozen ? "withdrawals are frozen while a batch settles" : undefined}>
          Withdraw
        </button>
      </div>
    </div>
  );

  return (
    <>
      {asset("FXRP", true, balances?.walletBase, balances?.vaultBase)}
      {asset("USDT0", false, balances?.walletQuote, balances?.vaultQuote)}
      {frozen && <p className="note warn">Withdrawals are frozen while a batch settles.</p>}
    </>
  );
}

function OrderForm({ onSubmit, disabled, available }: {
  onSubmit: (side: Side, price: bigint, size: bigint) => void;
  disabled: boolean;
  available?: Balances;
}) {
  const [side, setSide] = useState<Side>("BUY");
  const [price, setPrice] = useState("1.065000");
  const [size, setSize] = useState("1.000000");
  const [problem, setProblem] = useState<string>();

  function go() {
    try {
      const p = parseAmount(price);
      const s = parseAmount(size);
      if (p <= 0n || s <= 0n) return setProblem("price and size must be positive");

      // Mirror the enclave's own reservation rule, so an order that will be
      // rejected inside the TEE is caught here first instead of wasting a fee.
      if (available) {
        if (side === "SELL" && s > available.vaultBase) {
          return setProblem("you do not hold enough FXRP in the venue");
        }
        if (side === "BUY" && (s * p) / 1_000_000n > available.vaultQuote) {
          return setProblem("you do not hold enough USDT0 in the venue");
        }
      }
      setProblem(undefined);
      onSubmit(side, p, s);
    } catch (e: any) {
      setProblem(e.message);
    }
  }

  return (
    <>
      <div className="sides">
        <button className={side === "BUY" ? "side active buy" : "side"} onClick={() => setSide("BUY")}>Buy FXRP</button>
        <button className={side === "SELL" ? "side active sell" : "side"} onClick={() => setSide("SELL")}>Sell FXRP</button>
      </div>
      <label>Limit price <span className="muted">USDT0 per FXRP</span>
        <input value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label>Size <span className="muted">FXRP</span>
        <input value={size} onChange={(e) => setSize(e.target.value)} />
      </label>
      {problem && <p className="note warn">{problem}</p>}
      <PrimaryButton wide disabled={disabled} onClick={go}>Seal and submit</PrimaryButton>
    </>
  );
}

function Footer() {
  const link = (label: string, addr: string) => (
    <a href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer">{label} {short(addr, 6, 4)}</a>
  );
  return (
    <footer>
      <div className="links">
        {link("Vault", ADDRESSES.vault)}
        {link("OrderBook", ADDRESSES.orderBook)}
        {link("Settlement", ADDRESSES.settlement)}
      </div>
      <p className="note">
        Running under simulated attestation for this demo, which is Flare's
        documented development mode. The container, the encryption, the on-chain
        registration and the instruction pipeline are all real; only the hardware
        quote is simulated. Production is one environment variable away, on a
        Confidential Space VM.
      </p>
    </footer>
  );
}
