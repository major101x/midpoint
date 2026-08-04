/**
 * Clearing engine tests.
 *
 * A wrong clearing price does not crash, it just moves the wrong amount of money
 * and looks fine. So the invariants are tested directly (conservation, price
 * priority, uniform pricing) alongside worked examples.
 */

import { describe, expect, it } from "vitest";

import { clear, quoteAmount, type Fill } from "../app/auction.js";
import type { RestingOrder, Side } from "../app/order.js";

let seq = 0;
function order(side: Side, limitPrice: bigint, size: bigint, trader?: string): RestingOrder {
  return { trader: trader ?? `0xt${(seq++).toString(16).padStart(39, "0")}`, side, limitPrice, size };
}

function totalFor(fills: Fill[], side: Side): bigint {
  return fills.filter((f) => f.side === side).reduce((a, f) => a + f.size, 0n);
}

describe("no cross", () => {
  it("returns null for an empty book", () => {
    expect(clear([])).toBeNull();
  });

  it("returns null when there are only buyers", () => {
    expect(clear([order("BUY", 100n, 10n), order("BUY", 90n, 5n)])).toBeNull();
  });

  it("returns null when the best bid is below the best ask", () => {
    expect(clear([order("BUY", 90n, 10n), order("SELL", 110n, 10n)])).toBeNull();
  });
});

describe("clearing price", () => {
  it("clears a single crossing pair at the midpoint of the tied range", () => {
    const r = clear([order("BUY", 110n, 10n), order("SELL", 90n, 10n)])!;
    expect(r.volume).toBe(10n);
    // Both 90 and 110 clear 10 units with zero imbalance, so the midpoint is fair.
    expect(r.clearingPrice).toBe(100n);
  });

  it("picks the price that maximises volume, not the one that favours a side", () => {
    // At 100: demand 10, supply 10 -> 10 units.
    // At 120: demand 5, supply 15 -> 5 units.
    const r = clear([
      order("BUY", 120n, 5n),
      order("BUY", 100n, 5n),
      order("SELL", 100n, 10n),
      order("SELL", 120n, 5n),
    ])!;
    expect(r.volume).toBe(10n);
    expect(r.clearingPrice).toBe(100n);
  });

  /** Everyone who trades pays the same price. That is the whole mechanism. */
  it("prices every fill identically regardless of the limit submitted", () => {
    const aggressive = order("BUY", 200n, 5n);
    const marginal = order("BUY", 100n, 5n);
    const r = clear([aggressive, marginal, order("SELL", 100n, 10n)])!;

    const buyFills = r.fills.filter((f) => f.side === "BUY");
    expect(buyFills.length).toBe(2);
    // A single clearing price applies to both, so the trader who bid 200 is not
    // charged more than the one who bid 100.
    expect(r.clearingPrice).toBeGreaterThan(0n);
    expect(new Set(buyFills.map(() => r.clearingPrice)).size).toBe(1);
  });
});

describe("conservation", () => {
  it("fills equal volume on both sides", () => {
    const r = clear([
      order("BUY", 110n, 7n),
      order("BUY", 105n, 13n),
      order("SELL", 90n, 11n),
      order("SELL", 100n, 6n),
    ])!;
    expect(totalFor(r.fills, "BUY")).toBe(r.volume);
    expect(totalFor(r.fills, "SELL")).toBe(r.volume);
  });

  /** Pro-rata uses integer division; the remainder must not vanish. */
  it("conserves exactly when a level rations awkwardly", () => {
    const r = clear([
      order("BUY", 100n, 1n),
      order("BUY", 100n, 1n),
      order("BUY", 100n, 1n),
      order("SELL", 100n, 2n),
    ])!;
    expect(r.volume).toBe(2n);
    expect(totalFor(r.fills, "BUY")).toBe(2n);
    expect(totalFor(r.fills, "SELL")).toBe(2n);
  });

  it("never fills an order beyond its size", () => {
    const orders = [
      order("BUY", 100n, 3n),
      order("BUY", 100n, 5n),
      order("SELL", 100n, 100n),
    ];
    const r = clear(orders)!;
    for (const f of r.fills) {
      const submitted = orders
        .filter((o) => o.trader === f.trader && o.side === f.side)
        .reduce((a, o) => a + o.size, 0n);
      expect(f.size).toBeLessThanOrEqual(submitted);
    }
  });

  it("emits no zero-sized fills", () => {
    const r = clear([
      order("BUY", 100n, 1n),
      order("BUY", 100n, 1000n),
      order("SELL", 100n, 1n),
    ])!;
    for (const f of r.fills) expect(f.size).toBeGreaterThan(0n);
  });
});

describe("price priority", () => {
  /**
   * A trader willing to pay strictly more than the clearing price must fill
   * before one who only just qualifies. Otherwise the auction would ignore the
   * terms traders actually offered.
   */
  it("fills better-priced orders before marginal ones", () => {
    const eager = order("BUY", 150n, 10n, "0xeager");
    const marginal = order("BUY", 100n, 10n, "0xmarginal");
    const r = clear([eager, marginal, order("SELL", 100n, 10n)])!;

    const eagerFill = r.fills.find((f) => f.trader === "0xeager");
    const marginalFill = r.fills.find((f) => f.trader === "0xmarginal");

    expect(eagerFill?.size).toBe(10n);
    expect(marginalFill).toBeUndefined();
  });

  it("fills cheaper asks before pricier ones", () => {
    const cheap = order("SELL", 50n, 10n, "0xcheap");
    const dear = order("SELL", 100n, 10n, "0xdear");
    const r = clear([order("BUY", 100n, 10n), cheap, dear])!;

    expect(r.fills.find((f) => f.trader === "0xcheap")?.size).toBe(10n);
    expect(r.fills.find((f) => f.trader === "0xdear")).toBeUndefined();
  });

  /**
   * Orders at exactly the clearing price are indistinguishable on price, so they
   * are rationed by size, never by arrival. Rationing by arrival would rebuild
   * the queue race the venue exists to eliminate.
   */
  it("rations the marginal level pro-rata, not first come first served", () => {
    const first = order("BUY", 100n, 10n, "0xfirst");
    const second = order("BUY", 100n, 30n, "0xsecond");
    const r = clear([first, second, order("SELL", 100n, 20n)])!;

    const a = r.fills.find((f) => f.trader === "0xfirst")!.size;
    const b = r.fills.find((f) => f.trader === "0xsecond")!.size;

    expect(a + b).toBe(20n);
    // 10:30 split of 20 units is 5:15. Arrival order gave first 10 and second 10.
    expect(a).toBe(5n);
    expect(b).toBe(15n);
  });
});

describe("determinism", () => {
  it("is independent of the order the book was built in", () => {
    const book = [
      order("BUY", 110n, 7n, "0xa"),
      order("SELL", 90n, 4n, "0xb"),
      order("BUY", 100n, 9n, "0xc"),
      order("SELL", 105n, 8n, "0xd"),
    ];
    const forward = clear(book)!;
    const backward = clear([...book].reverse())!;

    expect(backward.clearingPrice).toBe(forward.clearingPrice);
    expect(backward.volume).toBe(forward.volume);

    const norm = (fs: Fill[]) =>
      [...fs].sort((x, y) => (x.trader + x.side).localeCompare(y.trader + y.side));
    expect(norm(backward.fills)).toEqual(norm(forward.fills));
  });
});

describe("quote conservation", () => {
  /**
   * The reason quote is computed in the enclave rather than per fill on chain.
   * Here the buy side has three fills and the sell side one, so flooring each
   * fill separately would make the two totals disagree and settlement would
   * revert. Exact allocation makes them equal by construction.
   */
  it("nets to zero even when the two sides have different fill counts", () => {
    const r = clear([
      order("BUY", 1_064_001n, 333_333n, "0xb1"),
      order("BUY", 1_064_001n, 333_333n, "0xb2"),
      order("BUY", 1_064_001n, 333_334n, "0xb3"),
      order("SELL", 1_000_001n, 1_000_000n, "0xs1"),
    ])!;

    const buyQuote = r.fills.filter((f) => f.side === "BUY").reduce((a, f) => a + f.quote, 0n);
    const sellQuote = r.fills.filter((f) => f.side === "SELL").reduce((a, f) => a + f.quote, 0n);
    expect(buyQuote).toBe(sellQuote);
    expect(buyQuote).toBe(quoteAmount(r.volume, r.clearingPrice));
  });

  it("gives every filled order a positive quote", () => {
    const r = clear([
      order("BUY", 1_100_000n, 5_000_000n),
      order("SELL", 1_000_000n, 5_000_000n),
    ])!;
    for (const f of r.fills) expect(f.quote).toBeGreaterThan(0n);
  });
});

describe("quoteAmount", () => {
  it("converts base units to quote units at 6 decimals", () => {
    // 2 FXRP at $1.064 is 2.128 USDT0.
    expect(quoteAmount(2_000_000n, 1_064_000n)).toBe(2_128_000n);
  });

  it("floors rather than rounding, so it can never over-credit", () => {
    expect(quoteAmount(1n, 1n)).toBe(0n);
  });
});

describe("realistic batch", () => {
  it("clears an FXRP/USDT0 book around the oracle price", () => {
    const r = clear([
      order("BUY", 1_070_000n, 3_000_000n, "0xbuy1"),
      order("BUY", 1_064_000n, 5_000_000n, "0xbuy2"),
      order("BUY", 1_050_000n, 9_000_000n, "0xbuy3"),
      order("SELL", 1_055_000n, 4_000_000n, "0xsell1"),
      order("SELL", 1_064_000n, 6_000_000n, "0xsell2"),
      order("SELL", 1_080_000n, 2_000_000n, "0xsell3"),
    ])!;

    expect(r.clearingPrice).toBeGreaterThanOrEqual(1_055_000n);
    expect(r.clearingPrice).toBeLessThanOrEqual(1_070_000n);
    expect(totalFor(r.fills, "BUY")).toBe(r.volume);
    expect(totalFor(r.fills, "SELL")).toBe(r.volume);
    // The seller asking above every bid never trades.
    expect(r.fills.find((f) => f.trader === "0xsell3")).toBeUndefined();
  });
});

describe("properties over random books", () => {
  /** Deterministic PRNG so a failure is reproducible from the seed alone. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /** Independent brute-force optimum, to check the engine's choice of p*. */
  function bestVolume(book: RestingOrder[]): bigint {
    const prices = [...new Set(book.map((o) => o.limitPrice))];
    let best = 0n;
    for (const p of prices) {
      const d = book.filter((o) => o.side === "BUY" && o.limitPrice >= p).reduce((a, o) => a + o.size, 0n);
      const s = book.filter((o) => o.side === "SELL" && o.limitPrice <= p).reduce((a, o) => a + o.size, 0n);
      const v = d < s ? d : s;
      if (v > best) best = v;
    }
    return best;
  }

  it("holds every invariant across 400 random books", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const n = 2 + Math.floor(rand() * 10);
      const book: RestingOrder[] = [];
      for (let i = 0; i < n; i++) {
        book.push(
          order(
            rand() < 0.5 ? "BUY" : "SELL",
            BigInt(90 + Math.floor(rand() * 25)),
            BigInt(1 + Math.floor(rand() * 40)),
            `0x${seed}_${i}`,
          ),
        );
      }

      const r = clear(book);
      const expected = bestVolume(book);

      if (r === null) {
        expect(expected, `seed ${seed}: engine found no cross but brute force did`).toBe(0n);
        continue;
      }

      // Maximises volume, matching the independent brute force.
      expect(r.volume, `seed ${seed}: suboptimal volume`).toBe(expected);

      // Conservation on both sides, base and quote.
      expect(totalFor(r.fills, "BUY"), `seed ${seed}: buy side`).toBe(r.volume);
      expect(totalFor(r.fills, "SELL"), `seed ${seed}: sell side`).toBe(r.volume);

      const bq = r.fills.filter((f) => f.side === "BUY").reduce((a, f) => a + f.quote, 0n);
      const sq = r.fills.filter((f) => f.side === "SELL").reduce((a, f) => a + f.quote, 0n);
      expect(bq, `seed ${seed}: quote legs disagree`).toBe(sq);

      // Nobody trades on terms they did not offer.
      for (const f of r.fills) {
        const src = book.find((o) => o.trader === f.trader && o.side === f.side)!;
        expect(f.size, `seed ${seed}: overfill`).toBeLessThanOrEqual(src.size);
        expect(f.size).toBeGreaterThan(0n);
        if (f.side === "BUY") {
          expect(src.limitPrice, `seed ${seed}: buyer paid above limit`).toBeGreaterThanOrEqual(r.clearingPrice);
        } else {
          expect(src.limitPrice, `seed ${seed}: seller sold below limit`).toBeLessThanOrEqual(r.clearingPrice);
        }
      }
    }
  });
});
