// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Fork tests against the real Coston2 tokens.
///
/// @dev A mock can only prove Vault survives the non-standard behaviour we
/// thought to write. This proves it against the actual FXRP and USDT0
/// deployments, which is the claim that matters. Addresses are the verified
/// ones recorded in spec.md section 3.
///
/// Run with: forge test --match-contract VaultForkTest --fork-url coston2
/// Skipped automatically when no fork is active, so `forge test` stays offline.
contract VaultForkTest is Test {
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address internal constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;

    /// @dev Funded from the faucet during day 1. Holds real FXRP and USDT0.
    address internal constant WHALE = 0x2382CCa5073a6fd18AD8e94F9B412ebAC120Cb15;

    Vault internal vault;
    address internal owner = address(0xA11CE);
    address internal settlement = address(0x5E77);

    modifier onlyForked() {
        if (block.chainid != 114) return;
        _;
    }

    function setUp() public {
        if (block.chainid != 114) return;
        vault = new Vault(FXRP, USDT0, owner);
        vm.prank(owner);
        vault.setSettlement(settlement);
    }

    function test_fork_bothTokensAreSixDecimals() public view onlyForked {
        assertEq(IERC20(FXRP).decimals(), 6, "FXRP decimals changed");
        assertEq(IERC20(USDT0).decimals(), 6, "USDT0 decimals changed");
    }

    function test_fork_depositAndWithdrawRealFXRP() public onlyForked {
        uint256 amount = 1e6; // 1 FXRP
        assertGe(IERC20(FXRP).balanceOf(WHALE), amount, "whale underfunded, refill from faucet");

        vm.startPrank(WHALE);
        IApprove(FXRP).approve(address(vault), amount);
        vault.deposit(true, amount);
        assertEq(vault.baseBalanceOf(WHALE), amount);
        vault.withdraw(true, amount);
        assertEq(vault.baseBalanceOf(WHALE), 0);
        vm.stopPrank();
    }

    /// @dev The reason SafeTransfer exists. If USDT0 omits the bool return,
    /// a strictly typed transfer would revert here and this test would catch it.
    function test_fork_depositAndWithdrawRealUSDT0() public onlyForked {
        uint256 amount = 1e6; // 1 USDT0
        assertGe(IERC20(USDT0).balanceOf(WHALE), amount, "whale underfunded, refill from faucet");

        vm.startPrank(WHALE);
        IApprove(USDT0).approve(address(vault), amount);
        vault.deposit(false, amount);
        assertEq(vault.quoteBalanceOf(WHALE), amount);
        vault.withdraw(false, amount);
        assertEq(vault.quoteBalanceOf(WHALE), 0);
        vm.stopPrank();
    }
}
