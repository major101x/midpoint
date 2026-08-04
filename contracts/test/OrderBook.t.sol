// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Vault} from "../src/Vault.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {
    MockExtensionRegistry,
    RotatingMachineRegistry,
    EmptyMachineRegistry
} from "./mocks/MockTeeRegistry.sol";

contract OrderBookTest is Test {
    OrderBook internal book;
    Vault internal vault;
    MockExtensionRegistry internal extReg;
    RotatingMachineRegistry internal machReg;
    MockERC20 internal fxrp;
    MockERC20 internal usdt;

    address internal owner = address(0xA11CE);
    address internal settlement = address(0x5E77);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal eve = address(0xEE);

    uint64 internal constant MIN_BATCH = 60;
    uint256 internal constant ONE = 1e6;

    bytes internal constant CIPHERTEXT = hex"deadbeefcafe";

    function setUp() public {
        fxrp = new MockERC20("FXRP", "FTestXRP", 6, true);
        usdt = new MockERC20("USDT0 test", "USDT0", 6, false);

        vault = new Vault(address(fxrp), address(usdt), owner);
        vm.prank(owner);
        vault.setSettlement(settlement);

        extReg = new MockExtensionRegistry();
        machReg = new RotatingMachineRegistry();

        book = new OrderBook(
            ITeeExtensionRegistry(address(extReg)),
            ITeeMachineRegistry(address(machReg)),
            vault,
            owner,
            MIN_BATCH
        );

        vm.startPrank(owner);
        book.setSettlement(settlement);
        vm.stopPrank();

        // Register the book so setExtensionId can find it.
        extReg.setSender(0x10003, address(book));
        book.setExtensionId();

        // Fund Alice and Bob so they pass the spam guard. Eve stays unfunded.
        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) private {
        fxrp.mint(who, 100 * ONE);
        vm.startPrank(who);
        fxrp.approve(address(vault), type(uint256).max);
        vault.deposit(true, 10 * ONE);
        vm.stopPrank();
    }

    // --- extension id --------------------------------------------------------

    function test_setExtensionId_findsSelf() public view {
        assertEq(book.extensionId(), 0x10003);
    }

    function test_setExtensionId_twice_reverts() public {
        vm.expectRevert(OrderBook.ExtensionIdAlreadySet.selector);
        book.setExtensionId();
    }

    function test_setExtensionId_notRegistered_reverts() public {
        OrderBook fresh = new OrderBook(
            ITeeExtensionRegistry(address(extReg)),
            ITeeMachineRegistry(address(machReg)),
            vault,
            owner,
            MIN_BATCH
        );
        vm.expectRevert(OrderBook.ExtensionIdNotFound.selector);
        fresh.setExtensionId();
    }

    // --- submitOrder ---------------------------------------------------------

    function test_submitOrder_sendsSealedSubmitOrder() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        assertEq(extReg.sentCount(), 1);
        MockExtensionRegistry.Sent memory s = extReg.sentAt(0);
        assertEq(s.opType, bytes32("SEALED"));
        assertEq(s.opCommand, bytes32("SUBMIT_ORDER"));
        assertEq(s.teeIds.length, 1);
        assertEq(s.claimBackAddress, alice);
    }

    /// @dev The enclave must learn the real sender, not the self-declared one
    /// inside the ciphertext, or anyone could replay a copied blob.
    function test_submitOrder_bindsSenderAndBatchToPayload() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        MockExtensionRegistry.Sent memory s = extReg.sentAt(0);
        (address trader, uint256 batchId, bytes memory ct) =
            abi.decode(s.message, (address, uint256, bytes));

        assertEq(trader, alice);
        assertEq(batchId, 1);
        assertEq(ct, CIPHERTEXT);
    }

    /// @dev The whole point of the venue: nothing about the order is legible here.
    function test_submitOrder_leaksOnlyCiphertext() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        MockExtensionRegistry.Sent memory s = extReg.sentAt(0);
        (,, bytes memory ct) = abi.decode(s.message, (address, uint256, bytes));
        // The contract stores a count, never a size, price or side.
        assertEq(book.orderCount(), 1);
        assertEq(ct, CIPHERTEXT);
    }

    function test_submitOrder_withoutVaultBalance_reverts() public {
        vm.prank(eve);
        vm.expectRevert(OrderBook.NoVaultBalance.selector);
        book.submitOrder(CIPHERTEXT);
    }

    function test_submitOrder_emptyCiphertext_reverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBook.EmptyCiphertext.selector);
        book.submitOrder("");
    }

    function test_submitOrder_quoteOnlyBalance_isAccepted() public {
        address carol = address(0xCA);
        usdt.mint(carol, 10 * ONE);
        vm.startPrank(carol);
        usdt.approve(address(vault), type(uint256).max);
        vault.deposit(false, 10 * ONE);
        book.submitOrder(CIPHERTEXT);
        vm.stopPrank();

        assertEq(book.orderCount(), 1);
    }

    function test_submitOrder_afterClose_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        vm.prank(bob);
        vm.expectRevert(OrderBook.BatchAlreadyClosed.selector);
        book.submitOrder(CIPHERTEXT);
    }

    function test_submitOrder_noTeeAvailable_reverts() public {
        OrderBook lonely = new OrderBook(
            ITeeExtensionRegistry(address(extReg)),
            ITeeMachineRegistry(address(new EmptyMachineRegistry())),
            vault,
            owner,
            MIN_BATCH
        );
        extReg.setSender(0x10004, address(lonely));
        lonely.setExtensionId();

        vm.prank(alice);
        vm.expectRevert(OrderBook.NoTeeAvailable.selector);
        lonely.submitOrder(CIPHERTEXT);
    }

    // --- TEE pinning ---------------------------------------------------------

    /// @dev Sanity check that the mock really does rotate between blocks. Without
    /// this, the pinning tests below could pass against a registry that always
    /// returned the same machine, proving nothing.
    function test_pinning_registryRotatesBetweenBlocks() public {
        address[] memory a = machReg.getRandomTeeIds(1, 1);
        vm.roll(block.number + 1);
        address[] memory b = machReg.getRandomTeeIds(1, 1);
        assertTrue(a[0] != b[0], "mock is not adversarial");
    }

    /// @dev THE critical property. A batch spans many blocks and the registry's
    /// answer changes between blocks, so drawing per order would scatter one
    /// batch across enclaves and clear against a partial book.
    function test_pinning_allOrdersInBatchGoToSameTee() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        vm.roll(block.number + 5);
        vm.prank(bob);
        book.submitOrder(CIPHERTEXT);

        vm.roll(block.number + 5);
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        address pinned = book.batchTee();
        assertTrue(pinned != address(0));
        assertEq(extReg.sentCount(), 3);
        for (uint256 i = 0; i < extReg.sentCount(); ++i) {
            assertEq(extReg.sentAt(i).teeIds[0], pinned, "order routed to a different enclave");
        }
        // And the registry would now answer differently, so pinning is what held.
        assertTrue(machReg.getRandomTeeIds(1, 1)[0] != pinned, "registry did not move on");
    }

    function test_pinning_closeBatchUsesSameTee() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        address pinned = book.batchTee();

        vm.warp(block.timestamp + MIN_BATCH);
        vm.roll(block.number + 10);
        book.closeBatch();

        MockExtensionRegistry.Sent memory closeSent = extReg.sentAt(extReg.sentCount() - 1);
        assertEq(closeSent.opCommand, bytes32("RUN_MATCH"));
        assertEq(closeSent.teeIds[0], pinned, "match ran on a different enclave than the book");
    }

    function test_pinning_newBatchDrawsFreshTee() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        address first = book.batchTee();

        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();
        vm.prank(settlement);
        book.advanceBatch();

        vm.roll(block.number + 1);
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        address second = book.batchTee();

        assertTrue(first != second, "expected a fresh draw for the new batch");
    }

    // --- closeBatch ----------------------------------------------------------

    function test_closeBatch_isPermissionless() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);

        // A total stranger closes it. Liveness must not depend on the operator.
        vm.prank(address(0xDEAD));
        book.closeBatch();
        assertTrue(book.batchClosed());
    }

    /// @dev Closing instantly would let a caller isolate one order into its own
    /// batch and read its side off the settlement.
    function test_closeBatch_beforeMinDuration_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.BatchTooYoung.selector, uint64(block.timestamp), MIN_BATCH
            )
        );
        book.closeBatch();
    }

    function test_closeBatch_empty_reverts() public {
        vm.warp(block.timestamp + MIN_BATCH);
        vm.expectRevert(OrderBook.BatchEmpty.selector);
        book.closeBatch();
    }

    function test_closeBatch_twice_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        vm.expectRevert(OrderBook.BatchAlreadyClosed.selector);
        book.closeBatch();
    }

    function test_closeBatch_carriesBatchId() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        MockExtensionRegistry.Sent memory s = extReg.sentAt(extReg.sentCount() - 1);
        assertEq(abi.decode(s.message, (uint256)), 1);
    }

    // --- advanceBatch --------------------------------------------------------

    function test_advanceBatch_resetsState() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        vm.prank(settlement);
        book.advanceBatch();

        assertEq(book.currentBatchId(), 2);
        assertEq(book.orderCount(), 0);
        assertEq(book.batchTee(), address(0));
        assertFalse(book.batchClosed());
    }

    function test_advanceBatch_byNonSettlement_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        vm.prank(alice);
        vm.expectRevert(OrderBook.NotSettlement.selector);
        book.advanceBatch();
    }

    function test_advanceBatch_whileOpen_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        vm.prank(settlement);
        vm.expectRevert(OrderBook.BatchNotClosed.selector);
        book.advanceBatch();
    }

    // --- voidBatch: recovery from a vanished enclave --------------------------

    /**
     * The scenario this exists for, reproduced: a batch is pinned to an enclave
     * that later disappears. `closeBatch` would revert inside the registry and
     * `advanceBatch` needs a closed batch, so without `voidBatch` the batch and
     * every balance frozen behind it are stuck permanently.
     */
    function test_voidBatch_recoversAStuckBatch() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        assertEq(book.orderCount(), 1);

        vm.warp(block.timestamp + book.voidDelay());
        vm.prank(address(0xDEAD)); // a stranger, not the operator
        book.voidBatch();

        assertEq(book.currentBatchId(), 2);
        assertEq(book.orderCount(), 0);
        assertEq(book.batchTee(), address(0));
        assertFalse(book.batchClosed());
    }

    function test_voidBatch_beforeDelay_reverts() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBook.BatchNotVoidable.selector, uint64(block.timestamp), book.voidDelay()
            )
        );
        book.voidBatch();
    }

    /**
     * No owner shortcut, on purpose. If the operator could void immediately they
     * could cancel any batch whose outcome they disliked, which is exactly the
     * discretion this venue exists to remove.
     */
    function test_voidBatch_ownerHasNoShortcut() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);

        vm.prank(owner);
        vm.expectRevert();
        book.voidBatch();
    }

    function test_voidBatch_worksAfterCloseFails() public {
        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        vm.warp(block.timestamp + MIN_BATCH);
        book.closeBatch();

        // Closed but never settled: the enclave went away mid-batch.
        vm.warp(block.timestamp + book.voidDelay());
        book.voidBatch();
        assertEq(book.currentBatchId(), 2);
    }

    function test_voidBatch_emptyBatch_reverts() public {
        vm.warp(block.timestamp + book.voidDelay());
        vm.expectRevert(OrderBook.BatchEmpty.selector);
        book.voidBatch();
    }

    function test_setVoidDelay_byNonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBook.NotOwner.selector);
        book.setVoidDelay(1);
    }

    // --- admin ---------------------------------------------------------------

    function test_setMinBatchDuration_byNonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(OrderBook.NotOwner.selector);
        book.setMinBatchDuration(1);
    }

    function test_setMinBatchDuration_takesEffect() public {
        vm.prank(owner);
        book.setMinBatchDuration(0);

        vm.prank(alice);
        book.submitOrder(CIPHERTEXT);
        book.closeBatch();
        assertTrue(book.batchClosed());
    }
}
