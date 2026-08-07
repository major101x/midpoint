// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {NaiveAmm} from "../src/demo/NaiveAmm.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Reproduces the attack the venue exists to prevent.
///
/// @dev The sandwich is not a bug in `NaiveAmm`. The pool is a correct
/// constant-product implementation and the attack works anyway, because the
/// pool's price is a public function of its reserves and the victim's trade is
/// legible before it executes. An attacker who can read a pending trade and act
/// on both sides of it extracts value with certainty, not probability.
///
/// Ordering: these tests execute the three transactions in the order a
/// successful searcher achieves. They do not model the race to obtain that
/// ordering, which on a public chain is won with fees, priority auctions or a
/// relationship with a builder. Granting the ordering is the honest assumption:
/// the claim under test is "an attacker who front-runs profits", not "an
/// attacker always wins the race".
contract SandwichTest is Test {
    NaiveAmm internal amm;
    MockERC20 internal fxrp;
    MockERC20 internal usdt;

    address internal lp = address(0x11D);
    address internal victim = address(0x1C71);
    address internal attacker = address(0xBAD);

    uint256 internal constant ONE = 1e6;

    /// @dev Seeded near the live Coston2 XRP/USD reading recorded in spec.md
    /// section 3, so the numbers in the demo look like the numbers on the feed.
    uint256 internal constant RESERVE_BASE = 1000 * ONE;
    uint256 internal constant RESERVE_QUOTE = 1064 * ONE;

    /// @dev 10% of the pool. Large enough to be worth attacking, which is the
    /// only kind of order this venue is built for. A one-FXRP trade is not
    /// worth anyone's gas.
    uint256 internal constant VICTIM_SIZE = 100 * ONE;

    function setUp() public {
        fxrp = new MockERC20("FXRP", "FTestXRP", 6, true);
        usdt = new MockERC20("USDT0 test", "USDT0", 6, false);
        amm = new NaiveAmm(address(fxrp), address(usdt), lp);

        _fund(lp, 10_000 * ONE, 10_000 * ONE);
        _fund(victim, 10_000 * ONE, 10_000 * ONE);
        _fund(attacker, 10_000 * ONE, 10_000 * ONE);

        vm.prank(lp);
        amm.addLiquidity(RESERVE_BASE, RESERVE_QUOTE);
    }

    function _fund(address who, uint256 base, uint256 quote) private {
        fxrp.mint(who, base);
        usdt.mint(who, quote);
        vm.startPrank(who);
        fxrp.approve(address(amm), type(uint256).max);
        usdt.approve(address(amm), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Sells `size` base and returns the quote received.
    function _sellBase(address who, uint256 size) private returns (uint256) {
        vm.prank(who);
        return amm.swapBaseForQuote(size, 0);
    }

    /// @dev Spends `amount` quote and returns the base received.
    function _buyBase(address who, uint256 amount) private returns (uint256) {
        vm.prank(who);
        return amm.swapQuoteForBase(amount, 0);
    }

    // --- the pool behaves correctly on its own --------------------------------

    function test_pool_pricesAtSpotBeforeAnyTrade() public view {
        assertEq(amm.spotPrice(), 1_064_000, "spot should be 1.064");
    }

    /// @dev Even alone, a large trade pays slippage. That cost is inherent to a
    /// constant-product pool and is not the attack. The attack is what an
    /// observer adds on top of it.
    function test_pool_largeTradeSlipsEvenUnattacked() public {
        uint256 got = _sellBase(victim, VICTIM_SIZE);
        uint256 price = amm.executionPrice(VICTIM_SIZE, got);
        assertLt(price, 1_064_000, "a large sell should move against itself");
    }

    function test_pool_conservesValueAcrossASwap() public {
        uint256 poolBefore = fxrp.balanceOf(address(amm)) + 0;
        uint256 got = _sellBase(victim, VICTIM_SIZE);
        assertEq(fxrp.balanceOf(address(amm)), poolBefore + VICTIM_SIZE);
        assertEq(amm.reserveBase(), RESERVE_BASE + VICTIM_SIZE);
        assertEq(amm.reserveQuote(), RESERVE_QUOTE - got);
    }

    // --- the sandwich ---------------------------------------------------------

    /// @notice The headline. Same order, same pool, same starting price. The
    /// only difference is that somebody read it first.
    function test_sandwich_victimGetsAWorsePriceAndTheAttackerKeepsTheDifference() public {
        // Baseline: the victim trades alone.
        uint256 snapshot = vm.snapshotState();
        uint256 aloneOut = _sellBase(victim, VICTIM_SIZE);
        uint256 alonePrice = amm.executionPrice(VICTIM_SIZE, aloneOut);
        vm.revertToState(snapshot);

        // Attacked: front-run, victim, back-run.
        uint256 attackerBaseBefore = fxrp.balanceOf(attacker);
        uint256 attackerQuoteBefore = usdt.balanceOf(attacker);

        uint256 frontRunSize = 200 * ONE;
        uint256 frontRunProceeds = _sellBase(attacker, frontRunSize);

        uint256 sandwichedOut = _sellBase(victim, VICTIM_SIZE);
        uint256 sandwichedPrice = amm.executionPrice(VICTIM_SIZE, sandwichedOut);

        // Buy back exactly what the front-run sold, spending only the proceeds.
        _buyBase(attacker, frontRunProceeds);

        int256 baseDelta = int256(fxrp.balanceOf(attacker)) - int256(attackerBaseBefore);
        int256 quoteDelta = int256(usdt.balanceOf(attacker)) - int256(attackerQuoteBefore);

        // The attacker exits holding more base than they started with, having
        // spent no quote at all: the back-run was funded entirely by the
        // front-run's proceeds.
        assertEq(quoteDelta, 0, "attacker should be flat in quote");
        assertGt(baseDelta, 0, "attacker should end up with more base");

        assertLt(sandwichedPrice, alonePrice, "the sandwich must worsen the victim's fill");

        uint256 victimLoss = aloneOut - sandwichedOut;
        console.log("victim alone      ", alonePrice);
        console.log("victim sandwiched ", sandwichedPrice);
        console.log("quote lost        ", victimLoss);
        console.log("attacker gained   ", uint256(baseDelta));
        assertGt(victimLoss, 0, "the victim must receive strictly less quote");
    }

    /// @dev The extraction scales with the attacker's capital, which is why a
    /// slippage tolerance is not a defence: it caps the loss at whatever the
    /// trader was willing to tolerate, and an attacker sizes the front-run to
    /// take exactly that much.
    function test_sandwich_biggerFrontRunHurtsMore() public {
        uint256 small = _victimOutAfterFrontRun(50 * ONE);
        uint256 large = _victimOutAfterFrontRun(400 * ONE);
        assertLt(large, small, "a larger front-run should extract more");
    }

    /// @dev A tight slippage bound does not save the victim, it just changes
    /// the failure mode from a bad fill to no fill. Either way the order does
    /// not execute on the victim's terms.
    function test_sandwich_slippageBoundConvertsALossIntoAFailedTrade() public {
        uint256 snapshot = vm.snapshotState();
        uint256 aloneOut = _sellBase(victim, VICTIM_SIZE);
        vm.revertToState(snapshot);

        // The victim demands within 1% of the unattacked outcome.
        uint256 minOut = (aloneOut * 99) / 100;

        _sellBase(attacker, 200 * ONE);

        vm.prank(victim);
        vm.expectRevert();
        amm.swapBaseForQuote(VICTIM_SIZE, minOut);
    }

    /// @dev Across a wide range of victim and attacker sizes, the sandwich never
    /// helps the victim. Bounded well inside the reserves, since a trade that
    /// consumes the pool is a different problem.
    function testFuzz_sandwich_neverImprovesTheVictimsFill(uint256 victimSize, uint256 frontRunSize)
        public
    {
        victimSize = bound(victimSize, ONE, 300 * ONE);
        frontRunSize = bound(frontRunSize, ONE, 500 * ONE);

        uint256 snapshot = vm.snapshotState();
        uint256 aloneOut = _sellBase(victim, victimSize);
        vm.revertToState(snapshot);

        _sellBase(attacker, frontRunSize);
        uint256 sandwichedOut = _sellBase(victim, victimSize);

        assertLe(sandwichedOut, aloneOut, "front-running must never improve the victim's fill");
    }

    /// @dev Front-running a buy works the same way, in the other direction. The
    /// attack is not specific to selling.
    function test_sandwich_worksAgainstABuyToo() public {
        uint256 spend = 100 * ONE;

        uint256 snapshot = vm.snapshotState();
        uint256 aloneOut = _buyBase(victim, spend);
        vm.revertToState(snapshot);

        _buyBase(attacker, 200 * ONE);
        uint256 sandwichedOut = _buyBase(victim, spend);

        assertLt(sandwichedOut, aloneOut, "a front-run buy should leave the victim less base");
    }

    // --- what the venue does differently --------------------------------------

    /// @notice The structural difference, stated as a property rather than a
    /// narrative: in a uniform-price call auction every filled order in a batch
    /// executes at one price, so a fill does not depend on trade size, and there
    /// is no size-dependent gap for an attacker to open up.
    ///
    /// @dev Deliberately checked against `NaiveAmm` rather than asserted about
    /// the venue in isolation, because the contrast is the claim. The venue's
    /// own clearing rule is tested in the extension's auction suite, and its
    /// settlement invariants in `Settlement.t.sol`.
    function test_contrast_ammPriceDependsOnSizeWhereasAUniformPriceDoesNot() public {
        uint256 snapshot = vm.snapshotState();
        uint256 smallOut = _sellBase(victim, 1 * ONE);
        uint256 smallPrice = amm.executionPrice(1 * ONE, smallOut);
        vm.revertToState(snapshot);

        uint256 largeOut = _sellBase(victim, 200 * ONE);
        uint256 largePrice = amm.executionPrice(200 * ONE, largeOut);

        // On the pool, two traders on the same side of the same block get
        // materially different prices purely because of size.
        assertLt(largePrice, smallPrice);
        assertGt(smallPrice - largePrice, 10_000, "the gap should be more than a rounding artifact");

        // In the venue, both would settle at the batch's single clearing price.
        // That is what `Settlement._checkConservation` enforces: every fill in a
        // batch is priced off one number, so there is no such gap to widen.
    }

    function _victimOutAfterFrontRun(uint256 frontRunSize) private returns (uint256 out) {
        uint256 snapshot = vm.snapshotState();
        _sellBase(attacker, frontRunSize);
        out = _sellBase(victim, VICTIM_SIZE);
        vm.revertToState(snapshot);
    }
}
