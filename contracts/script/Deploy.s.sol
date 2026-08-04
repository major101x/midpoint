// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {Vault} from "../src/Vault.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Settlement} from "../src/Settlement.sol";
import {IFtsoV2} from "../src/interfaces/IFtsoV2.sol";
import {ITeeExtensionRegistry} from "../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys the whole venue to Coston2 and wires it together.
///
/// @dev Deployment lives here rather than in the vendored scaffold. The
/// scaffold's `register-extension` accepts any address as the instructions
/// sender, so our contracts are never copied into that tree and cannot drift
/// from the tested versions in `contracts/src`.
///
/// Addresses are the verified ones from spec.md section 3. Both TEE registry
/// arguments are the FlareTeeManager diamond, which routes ExtensionManager and
/// MachineManager calls to the right facets.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url coston2 --broadcast
contract Deploy is Script {
    address constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    address constant USDT0 = 0xC1A5B41512496B80903D1f32d6dEa3a73212E71F;
    address constant FLARE_TEE_MANAGER = 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE;
    address constant FTSO_V2 = 0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d;

    /// @dev bytes21: 0x01 (crypto) then ASCII "XRP/USD" right-padded to 20 bytes.
    bytes21 constant XRP_USD_FEED = bytes21(0x015852502F55534400000000000000000000000000);

    /// @dev Short enough to demo, long enough that a batch cannot be closed the
    /// instant it opens, which would isolate a single order and leak its side.
    uint64 constant MIN_BATCH_DURATION = 60;

    /// @dev Recovery window before anyone may abandon a stuck batch. Deliberately
    /// short here; a production venue would want longer.
    uint64 constant VOID_DELAY = 300;

    /// @dev 2% around the FTSO price.
    uint16 constant BAND_BPS = 200;

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

        Settlement settlement =
            new Settlement(vault, book, IFtsoV2(FTSO_V2), XRP_USD_FEED, deployer, BAND_BPS);

        // Settlement is the only contract allowed to move balances or advance
        // the batch. Neither the deployer nor anyone else can do either.
        vault.setSettlement(address(settlement));
        book.setSettlement(address(settlement));
        book.setVoidDelay(VOID_DELAY);

        vm.stopBroadcast();

        console.log("deployer   ", deployer);
        console.log("Vault      ", address(vault));
        console.log("OrderBook  ", address(book));
        console.log("Settlement ", address(settlement));
        console.log("");
        console.log("Next: register OrderBook as the extension instructions sender,");
        console.log("then call setExtensionId() on it.");
    }
}
