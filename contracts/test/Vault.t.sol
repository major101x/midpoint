// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract VaultTest is Test {
    Vault internal vault;
    MockERC20 internal fxrp; // 6 decimals, standard
    MockERC20 internal usdt; // 6 decimals, returns no bool (USDT lineage)

    address internal owner = address(0xA11CE);
    address internal settlement = address(0x5E77);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);

    // Both Coston2 tokens use 6 decimals. One unit of each, spelled out so a
    // future change to 18 breaks loudly rather than silently.
    uint256 internal constant ONE_FXRP = 1e6;
    uint256 internal constant ONE_USDT = 1e6;

    function setUp() public {
        fxrp = new MockERC20("FXRP", "FTestXRP", 6, true);
        usdt = new MockERC20("USDT0 test", "USDT0", 6, false);

        vault = new Vault(address(fxrp), address(usdt), owner);
        vm.prank(owner);
        vault.setSettlement(settlement);

        fxrp.mint(alice, 100 * ONE_FXRP);
        usdt.mint(alice, 100 * ONE_USDT);
        fxrp.mint(bob, 100 * ONE_FXRP);
        usdt.mint(bob, 100 * ONE_USDT);

        vm.startPrank(alice);
        fxrp.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        fxrp.approve(address(vault), type(uint256).max);
        usdt.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // --- deposit -------------------------------------------------------------

    function test_deposit_base_creditsBalance() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        assertEq(vault.baseBalanceOf(alice), 10 * ONE_FXRP);
        assertEq(fxrp.balanceOf(address(vault)), 10 * ONE_FXRP);
        assertEq(fxrp.balanceOf(alice), 90 * ONE_FXRP);
    }

    /// @dev The quote token returns no bool. A strictly typed call would revert here.
    function test_deposit_quote_worksWithNonStandardToken() public {
        vm.prank(alice);
        vault.deposit(false, 25 * ONE_USDT);

        assertEq(vault.quoteBalanceOf(alice), 25 * ONE_USDT);
        assertEq(usdt.balanceOf(address(vault)), 25 * ONE_USDT);
    }

    /// @dev Vault must credit what it actually received, not what was requested,
    /// or its accounting would exceed the tokens it holds.
    function test_deposit_feeOnTransfer_creditsReceivedNotRequested() public {
        usdt.setFeeBps(100); // 1%

        vm.prank(alice);
        vault.deposit(false, 100 * ONE_USDT);

        uint256 expected = 99 * ONE_USDT;
        assertEq(vault.quoteBalanceOf(alice), expected);
        assertEq(usdt.balanceOf(address(vault)), expected);
    }

    function test_deposit_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(true, 0);
    }

    function test_deposit_withoutApproval_reverts() public {
        address carol = address(0xC0);
        fxrp.mint(carol, ONE_FXRP);
        vm.prank(carol);
        vm.expectRevert();
        vault.deposit(true, ONE_FXRP);
    }

    // --- withdraw ------------------------------------------------------------

    function test_withdraw_returnsTokens() public {
        vm.startPrank(alice);
        vault.deposit(true, 10 * ONE_FXRP);
        vault.withdraw(true, 4 * ONE_FXRP);
        vm.stopPrank();

        assertEq(vault.baseBalanceOf(alice), 6 * ONE_FXRP);
        assertEq(fxrp.balanceOf(alice), 94 * ONE_FXRP);
    }

    function test_withdraw_moreThanBalance_reverts() public {
        vm.startPrank(alice);
        vault.deposit(true, ONE_FXRP);
        vm.expectRevert(
            abi.encodeWithSelector(Vault.InsufficientBalance.selector, ONE_FXRP, 2 * ONE_FXRP)
        );
        vault.withdraw(true, 2 * ONE_FXRP);
        vm.stopPrank();
    }

    /// @dev One trader must never be able to withdraw against another's balance.
    function test_withdraw_isolatedPerTrader() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Vault.InsufficientBalance.selector, 0, ONE_FXRP));
        vault.withdraw(true, ONE_FXRP);
    }

    // --- freeze --------------------------------------------------------------

    function test_withdraw_whileFrozen_reverts() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        vm.prank(settlement);
        vault.setFrozen(true);

        vm.prank(alice);
        vm.expectRevert(Vault.WithdrawalsFrozen.selector);
        vault.withdraw(true, ONE_FXRP);
    }

    /// @dev Deposits stay open while frozen. Freezing exists to stop value
    /// leaving mid-batch, and blocking inflows would be gratuitous.
    function test_deposit_whileFrozen_stillAllowed() public {
        vm.prank(settlement);
        vault.setFrozen(true);

        vm.prank(alice);
        vault.deposit(true, ONE_FXRP);
        assertEq(vault.baseBalanceOf(alice), ONE_FXRP);
    }

    function test_unfreeze_restoresWithdrawals() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        vm.startPrank(settlement);
        vault.setFrozen(true);
        vault.setFrozen(false);
        vm.stopPrank();

        vm.prank(alice);
        vault.withdraw(true, ONE_FXRP);
        assertEq(vault.baseBalanceOf(alice), 9 * ONE_FXRP);
    }

    function test_setFrozen_byNonSettlement_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.NotSettlement.selector);
        vault.setFrozen(true);
    }

    // --- move ----------------------------------------------------------------

    function test_move_transfersInternalBalance() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        vm.prank(settlement);
        vault.move(alice, bob, true, 3 * ONE_FXRP);

        assertEq(vault.baseBalanceOf(alice), 7 * ONE_FXRP);
        assertEq(vault.baseBalanceOf(bob), 3 * ONE_FXRP);
        // No tokens left the vault.
        assertEq(fxrp.balanceOf(address(vault)), 10 * ONE_FXRP);
    }

    function test_move_byNonSettlement_reverts() public {
        vm.prank(alice);
        vault.deposit(true, 10 * ONE_FXRP);

        vm.prank(alice);
        vm.expectRevert(Vault.NotSettlement.selector);
        vault.move(alice, bob, true, ONE_FXRP);
    }

    function test_move_beyondBalance_reverts() public {
        vm.prank(settlement);
        vm.expectRevert(abi.encodeWithSelector(Vault.InsufficientBalance.selector, 0, ONE_FXRP));
        vault.move(alice, bob, true, ONE_FXRP);
    }

    /// @dev Conservation: moves must never create or destroy value.
    function test_move_conservesTotal() public {
        vm.prank(alice);
        vault.deposit(false, 50 * ONE_USDT);
        vm.prank(bob);
        vault.deposit(false, 20 * ONE_USDT);

        uint256 totalBefore = vault.quoteBalanceOf(alice) + vault.quoteBalanceOf(bob);

        vm.prank(settlement);
        vault.move(alice, bob, false, 17 * ONE_USDT);

        assertEq(vault.quoteBalanceOf(alice) + vault.quoteBalanceOf(bob), totalBefore);
    }

    // --- admin ---------------------------------------------------------------

    function test_setSettlement_byNonOwner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.NotOwner.selector);
        vault.setSettlement(alice);
    }

    function test_constructor_zeroAddress_reverts() public {
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(address(0), address(usdt), owner);
    }

    // --- invariants ----------------------------------------------------------

    /// @dev The vault must always hold at least what it says traders own.
    /// Deposits and withdrawals of arbitrary size must not break that.
    function testFuzz_solvency(uint96 depositAmount, uint96 withdrawAmount) public {
        vm.assume(depositAmount > 0);
        fxrp.mint(alice, depositAmount);

        vm.startPrank(alice);
        vault.deposit(true, depositAmount);
        uint256 credited = vault.baseBalanceOf(alice);
        if (withdrawAmount > 0 && withdrawAmount <= credited) {
            vault.withdraw(true, withdrawAmount);
        }
        vm.stopPrank();

        assertGe(fxrp.balanceOf(address(vault)), vault.baseBalanceOf(alice));
    }
}
