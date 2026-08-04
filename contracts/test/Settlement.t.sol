// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Settlement} from "../src/Settlement.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Vault} from "../src/Vault.sol";
import {IFtsoV2} from "../src/interfaces/IFtsoV2.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockExtensionRegistry, PinnedMachineRegistry} from "./mocks/MockTeeRegistry.sol";
import {MockFtso} from "./mocks/MockFtso.sol";

contract SettlementTest is Test {
    Settlement internal settlement;
    OrderBook internal book;
    Vault internal vault;
    MockERC20 internal fxrp;
    MockERC20 internal usdt;
    MockExtensionRegistry internal extReg;
    PinnedMachineRegistry internal machReg;
    MockFtso internal ftso;

    address internal owner = address(0xA11CE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);

    /// @dev The enclave's key. Tests sign with it exactly as tee-node would.
    uint256 internal teeKey = 0xBEEF;
    address internal tee;

    uint256 internal constant ONE = 1e6;
    uint64 internal constant MIN_BATCH = 60;
    uint16 internal constant BAND_BPS = 200; // 2%
    bytes21 internal constant XRP_USD = bytes21(0x015852502F55534400000000000000000000000000);

    /// @dev Roughly the live Coston2 reading recorded in spec.md section 3.
    uint256 internal constant ORACLE = 1_064_000;

    function setUp() public {
        tee = vm.addr(teeKey);

        fxrp = new MockERC20("FXRP", "FTestXRP", 6, true);
        usdt = new MockERC20("USDT0 test", "USDT0", 6, false);
        ftso = new MockFtso(ORACLE, 6, uint64(block.timestamp));

        vault = new Vault(address(fxrp), address(usdt), owner);
        extReg = new MockExtensionRegistry();
        machReg = new PinnedMachineRegistry(tee);

        book = new OrderBook(
            ITeeExtensionRegistry(address(extReg)),
            ITeeMachineRegistry(address(machReg)),
            vault,
            owner,
            MIN_BATCH
        );
        extReg.setSender(0x10003, address(book));
        book.setExtensionId();

        settlement = new Settlement(vault, book, IFtsoV2(address(ftso)), XRP_USD, owner, BAND_BPS);

        vm.startPrank(owner);
        vault.setSettlement(address(settlement));
        book.setSettlement(address(settlement));
        vm.stopPrank();

        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) private {
        fxrp.mint(who, 100 * ONE);
        usdt.mint(who, 100 * ONE);
        vm.startPrank(who);
        fxrp.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(true, 20 * ONE);
        vault.deposit(false, 20 * ONE);
        vm.stopPrank();
    }

    /// @dev Opens a batch and closes it, so settlement has something to apply.
    function _openAndCloseBatch() private {
        vm.prank(alice);
        book.submitOrder(hex"deadbeef");
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();
    }

    function _fills(uint256 size, uint256 quote)
        private
        view
        returns (Settlement.Fill[] memory fills)
    {
        fills = new Settlement.Fill[](2);
        fills[0] = Settlement.Fill({trader: alice, side: 0, size: size, quote: quote});
        fills[1] = Settlement.Fill({trader: bob, side: 1, size: size, quote: quote});
    }

    function _encode(uint256 batchId, uint256 price, Settlement.Fill[] memory fills)
        private
        pure
        returns (bytes memory)
    {
        return abi.encode(batchId, price, fills);
    }

    /// @dev Reproduces exactly what tee-node's POST /sign does: keccak of the
    /// message, then an EIP-191 personal-sign envelope over that 32 byte value.
    function _sign(uint256 key, bytes memory payload) private pure returns (bytes memory) {
        bytes32 digest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(payload)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- happy path ----------------------------------------------------------

    function test_settle_movesBalancesAndAdvances() public {
        _openAndCloseBatch();

        uint256 size = 2 * ONE;
        uint256 quote = 2_128_000; // 2 FXRP at 1.064
        bytes memory payload = _encode(1, ORACLE, _fills(size, quote));

        uint256 aliceBaseBefore = vault.baseBalanceOf(alice);
        uint256 bobQuoteBefore = vault.quoteBalanceOf(bob);

        settlement.settle(payload, _sign(teeKey, payload));

        // Alice bought base and paid quote; Bob is the mirror image.
        assertEq(vault.baseBalanceOf(alice), aliceBaseBefore + size);
        assertEq(vault.quoteBalanceOf(bob), bobQuoteBefore + quote);
        assertEq(settlement.lastSettledBatch(), 1);
        assertEq(book.currentBatchId(), 2);
    }

    /// @dev Value may move between traders but must never appear or vanish.
    function test_settle_conservesTotalBalances() public {
        _openAndCloseBatch();
        uint256 baseBefore = vault.baseBalanceOf(alice) + vault.baseBalanceOf(bob);
        uint256 quoteBefore = vault.quoteBalanceOf(alice) + vault.quoteBalanceOf(bob);

        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        settlement.settle(payload, _sign(teeKey, payload));

        assertEq(vault.baseBalanceOf(alice) + vault.baseBalanceOf(bob), baseBefore);
        assertEq(vault.quoteBalanceOf(alice) + vault.quoteBalanceOf(bob), quoteBefore);
        // The settlement account is a pass-through and keeps nothing.
        assertEq(vault.baseBalanceOf(address(settlement)), 0);
        assertEq(vault.quoteBalanceOf(address(settlement)), 0);
    }

    /// @dev A batch that did not cross still settles, so funds unfreeze.
    function test_settle_emptyBatchSkipsBandCheck() public {
        _openAndCloseBatch();
        ftso.set(999_999_999, 6, uint64(block.timestamp)); // absurd oracle

        Settlement.Fill[] memory none = new Settlement.Fill[](0);
        bytes memory payload = _encode(1, 0, none);
        settlement.settle(payload, _sign(teeKey, payload));

        assertEq(book.currentBatchId(), 2);
        assertFalse(vault.frozen());
    }

    function test_settle_unfreezesVaultAfterwards() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        settlement.settle(payload, _sign(teeKey, payload));
        assertFalse(vault.frozen());
    }

    // --- signature provenance ------------------------------------------------

    /// @dev The core security property. A signature from any other key, however
    /// well formed, must not settle: only the enclave that held the book can.
    function test_settle_wrongSigner_reverts() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));

        uint256 impostor = 0xDEAD;
        vm.expectRevert(
            abi.encodeWithSelector(Settlement.WrongSigner.selector, vm.addr(impostor), tee)
        );
        settlement.settle(payload, _sign(impostor, payload));
    }

    /// @dev Even the venue operator cannot settle a batch themselves.
    function test_settle_ownerCannotForge() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));

        vm.prank(owner);
        vm.expectRevert();
        settlement.settle(payload, _sign(0xC0FFEE, payload));
    }

    function test_settle_tamperedPayload_reverts() public {
        _openAndCloseBatch();
        bytes memory good = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        bytes memory sig = _sign(teeKey, good);

        // Same shape, larger fill. The signature no longer matches.
        bytes memory tampered = _encode(1, ORACLE, _fills(5 * ONE, 5_320_000));
        vm.expectRevert();
        settlement.settle(tampered, sig);
    }

    function test_settle_badSignatureLength_reverts() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        vm.expectRevert(abi.encodeWithSelector(Settlement.BadSignatureLength.selector, 64));
        settlement.settle(payload, new bytes(64));
    }

    /// @dev tee-node emits v as 0 or 1; ecrecover needs 27 or 28. Both accepted.
    function test_settle_acceptsRawRecoveryId() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));

        bytes memory sig = _sign(teeKey, payload);
        // Rewrite the trailing v from 27/28 down to 0/1, as tee-node sends it.
        sig[64] = bytes1(uint8(sig[64]) - 27);

        settlement.settle(payload, sig);
        assertEq(settlement.lastSettledBatch(), 1);
    }

    // --- replay --------------------------------------------------------------

    function test_settle_replay_reverts() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        bytes memory sig = _sign(teeKey, payload);
        settlement.settle(payload, sig);

        // The book has moved on, so the same payload no longer applies.
        vm.expectRevert(Settlement.BatchNotClosed.selector);
        settlement.settle(payload, sig);
    }

    function test_settle_wrongBatchId_reverts() public {
        _openAndCloseBatch();
        bytes memory payload = _encode(7, ORACLE, _fills(2 * ONE, 2_128_000));
        vm.expectRevert(abi.encodeWithSelector(Settlement.WrongBatch.selector, 1, 7));
        settlement.settle(payload, _sign(teeKey, payload));
    }

    function test_settle_openBatch_reverts() public {
        vm.prank(alice);
        book.submitOrder(hex"deadbeef");
        // Not closed yet.
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        vm.expectRevert(Settlement.BatchNotClosed.selector);
        settlement.settle(payload, _sign(teeKey, payload));
    }

    // --- conservation --------------------------------------------------------

    function test_settle_baseNotConserved_reverts() public {
        _openAndCloseBatch();
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        fills[0] = Settlement.Fill({trader: alice, side: 0, size: 3 * ONE, quote: 2_128_000});
        fills[1] = Settlement.Fill({trader: bob, side: 1, size: 2 * ONE, quote: 2_128_000});

        bytes memory payload = _encode(1, ORACLE, fills);
        vm.expectRevert(
            abi.encodeWithSelector(Settlement.BaseNotConserved.selector, 3 * ONE, 2 * ONE)
        );
        settlement.settle(payload, _sign(teeKey, payload));
    }

    /// @dev The failure mode that motivated computing quote inside the enclave.
    function test_settle_quoteNotConserved_reverts() public {
        _openAndCloseBatch();
        Settlement.Fill[] memory fills = new Settlement.Fill[](2);
        fills[0] = Settlement.Fill({trader: alice, side: 0, size: 2 * ONE, quote: 2_128_000});
        fills[1] = Settlement.Fill({trader: bob, side: 1, size: 2 * ONE, quote: 2_127_999});

        bytes memory payload = _encode(1, ORACLE, fills);
        vm.expectRevert(
            abi.encodeWithSelector(Settlement.QuoteNotConserved.selector, 2_128_000, 2_127_999)
        );
        settlement.settle(payload, _sign(teeKey, payload));
    }

    function test_settle_invalidSide_reverts() public {
        _openAndCloseBatch();
        Settlement.Fill[] memory fills = new Settlement.Fill[](1);
        fills[0] = Settlement.Fill({trader: alice, side: 3, size: ONE, quote: ONE});

        bytes memory payload = _encode(1, ORACLE, fills);
        vm.expectRevert(abi.encodeWithSelector(Settlement.InvalidSide.selector, 3));
        settlement.settle(payload, _sign(teeKey, payload));
    }

    // --- FTSO band -----------------------------------------------------------

    /// @dev The check that bounds a hidden engine. Whatever the enclave computes,
    /// it cannot print a price the public oracle disagrees with.
    function test_settle_priceAboveBand_reverts() public {
        _openAndCloseBatch();
        uint256 tooHigh = (ORACLE * 11) / 10; // 10% above, band is 2%
        bytes memory payload = _encode(1, tooHigh, _fills(2 * ONE, 2_128_000));

        vm.expectRevert(
            abi.encodeWithSelector(Settlement.PriceOutsideBand.selector, tooHigh, ORACLE, BAND_BPS)
        );
        settlement.settle(payload, _sign(teeKey, payload));
    }

    function test_settle_priceBelowBand_reverts() public {
        _openAndCloseBatch();
        uint256 tooLow = (ORACLE * 9) / 10;
        bytes memory payload = _encode(1, tooLow, _fills(2 * ONE, 2_128_000));
        vm.expectRevert();
        settlement.settle(payload, _sign(teeKey, payload));
    }

    function test_settle_priceAtBandEdge_isAccepted() public {
        _openAndCloseBatch();
        uint256 edge = ORACLE + (ORACLE * BAND_BPS) / 10_000;
        bytes memory payload = _encode(1, edge, _fills(2 * ONE, 2_128_000));
        settlement.settle(payload, _sign(teeKey, payload));
        assertEq(settlement.lastSettledBatch(), 1);
    }

    /// @dev Feeds are 6 decimals today, but the field exists because that can
    /// change. Assuming it silently would misprice by orders of magnitude.
    function test_settle_rescalesOracleDecimals() public {
        _openAndCloseBatch();
        // Same price expressed with 8 decimals.
        ftso.set(ORACLE * 100, 8, uint64(block.timestamp));

        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        settlement.settle(payload, _sign(teeKey, payload));
        assertEq(settlement.lastSettledBatch(), 1);
    }

    function test_settle_staleOracle_reverts() public {
        _openAndCloseBatch();
        ftso.set(ORACLE, 6, 0);
        bytes memory payload = _encode(1, ORACLE, _fills(2 * ONE, 2_128_000));
        vm.expectRevert(abi.encodeWithSelector(Settlement.StaleOracle.selector, uint64(0)));
        settlement.settle(payload, _sign(teeKey, payload));
    }

    // --- cross-language encoding ---------------------------------------------

    /**
     * THE RISKIEST SEAM IN THE SYSTEM. The enclave encodes the settlement
     * payload with viem and Solidity decodes it here. The signature covers those
     * exact bytes, so any disagreement about layout, even one that looks
     * cosmetic, makes every settlement fail verification.
     *
     * This payload was produced by the real extension code
     * (`encodeSettlement` in extension/typescript/src/app/abi.ts) for:
     *   batchId 1, price 1.064, alice BUY 2 FXRP for 2.128 USDT0, bob the seller.
     * If the two sides ever drift apart, this test fails rather than the demo.
     */
    function test_decodesPayloadEncodedByTheEnclave() public pure {
        bytes memory fromEnclave =
            hex"00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000103c400000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000a1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000002078800000000000000000000000000000000000000000000000000000000000000b0b000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000207880";

        (uint256 batchId, uint256 price, Settlement.Fill[] memory fills) =
            abi.decode(fromEnclave, (uint256, uint256, Settlement.Fill[]));

        assertEq(batchId, 1);
        assertEq(price, 1_064_000);
        assertEq(fills.length, 2);

        assertEq(fills[0].trader, address(0xA1));
        assertEq(fills[0].side, 0);
        assertEq(fills[0].size, 2_000_000);
        assertEq(fills[0].quote, 2_128_000);

        assertEq(fills[1].trader, address(0xB0B));
        assertEq(fills[1].side, 1);
        assertEq(fills[1].size, 2_000_000);
        assertEq(fills[1].quote, 2_128_000);
    }

    /// @dev And the same bytes must actually settle, not merely decode.
    function test_settlesAPayloadEncodedByTheEnclave() public {
        _openAndCloseBatch();
        bytes memory fromEnclave =
            hex"00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000103c400000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000a1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000002078800000000000000000000000000000000000000000000000000000000000000b0b000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000207880";

        settlement.settle(fromEnclave, _sign(teeKey, fromEnclave));
        assertEq(settlement.lastSettledBatch(), 1);
        assertEq(vault.baseBalanceOf(alice), 22 * ONE);
    }

    // --- admin ---------------------------------------------------------------

    function test_setBandBps_byNonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Settlement.NotOwner.selector);
        settlement.setBandBps(500);
    }

    function test_setBandBps_widensAcceptance() public {
        vm.prank(owner);
        settlement.setBandBps(2000); // 20%

        _openAndCloseBatch();
        uint256 high = (ORACLE * 11) / 10;
        bytes memory payload = _encode(1, high, _fills(2 * ONE, 2_128_000));
        settlement.settle(payload, _sign(teeKey, payload));
        assertEq(settlement.lastSettledBatch(), 1);
    }
}
