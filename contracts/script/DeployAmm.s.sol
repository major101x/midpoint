// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {NaiveAmm} from "../src/demo/NaiveAmm.sol";

/// @notice Deploys the comparison pool. Separate from `Deploy.s.sol` on
/// purpose: this contract is the baseline being argued against, and it must
/// never be mistaken for part of the venue or wired into it.
///
/// Liquidity is seeded from `client/scripts/sandwich.mjs` rather than here,
/// because the right amount depends on what the funding wallets actually hold
/// on the day, and a hardcoded figure would revert the deployment the first
/// time the faucet ran dry.
///
/// Usage:
///   forge script script/DeployAmm.s.sol --rpc-url coston2 --broadcast
contract DeployAmm is Script {
    address constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        NaiveAmm amm = new NaiveAmm(FXRP, USDT0, deployer);
        vm.stopBroadcast();

        console.log("deployer ", deployer);
        console.log("NaiveAmm ", address(amm));
        console.log("");
        console.log("Next: node client/scripts/sandwich.mjs, which seeds the pool");
        console.log("and runs the comparison.");
    }
}
