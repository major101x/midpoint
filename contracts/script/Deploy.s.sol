// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys Vault and OrderBook to Coston2.
///
/// @dev Deliberately lives here rather than in the Flare scaffold. The scaffold's
/// `register-extension` tool accepts any address as the instructions sender, so
/// our contracts never have to be copied into the vendored tree and can never
/// drift from the tested versions in `contracts/src`.
///
/// Addresses are the verified ones from spec.md section 3. Both registry
/// arguments are the FlareTeeManager diamond: it routes ExtensionManager and
/// MachineManager calls to the right facets.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url coston2 --broadcast
contract Deploy is Script {
    address constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;
    address constant FLARE_TEE_MANAGER = 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE;

    /// @dev Long enough that a batch cannot be closed the instant it opens,
    /// short enough to demo. Tunable later via setMinBatchDuration.
    uint64 constant MIN_BATCH_DURATION = 60;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        Vault vault = new Vault(FXRP, USDT0, deployer);
        OrderBook book = new OrderBook(
            ITeeExtensionRegistry(FLARE_TEE_MANAGER),
            ITeeMachineRegistry(FLARE_TEE_MANAGER),
            vault,
            deployer,
            MIN_BATCH_DURATION
        );

        // Settlement.sol does not exist yet (spec day 8). Point both at the
        // deployer so the flow is exercisable now, and re-point on day 8.
        vault.setSettlement(deployer);
        book.setSettlement(deployer);

        vm.stopBroadcast();

        console.log("deployer  ", deployer);
        console.log("Vault     ", address(vault));
        console.log("OrderBook ", address(book));
        console.log("");
        console.log("Next: register OrderBook as the extension instructions sender:");
        console.log("  cd fce-extension-scaffold/tools && go run ./cmd/register-extension \\");
        console.log("    -a ../config/coston2/deployed-addresses.json \\");
        console.log("    -c https://coston2-api.flare.network/ext/C/rpc \\");
        console.log("    --instructionSender", address(book));
        console.log("Then call setExtensionId() on OrderBook.");
    }
}
