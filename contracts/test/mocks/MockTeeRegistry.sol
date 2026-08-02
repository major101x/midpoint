// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "../../src/interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "../../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Machine registry whose answer changes from block to block.
///
/// @dev Faithful to the real thing in the way that matters. `getRandomTeeIds` is
/// `view`, so it compiles to a STATICCALL and cannot mutate storage; Flare's
/// randomness therefore has to come from block state, which means the selected
/// machine is stable within a block and free to change between blocks. A batch
/// spans many blocks, so an OrderBook that re-drew per order would scatter one
/// batch across several enclaves. Tests advance the block between orders to
/// expose exactly that bug.
contract RotatingMachineRegistry is ITeeMachineRegistry {
    function getRandomTeeIds(uint256, uint256 count) external view returns (address[] memory ids) {
        ids = new address[](count);
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = address(uint160(0x7EE0 + block.number + i));
        }
    }
}

/// @notice Registry with no machines available.
contract EmptyMachineRegistry is ITeeMachineRegistry {
    function getRandomTeeIds(uint256, uint256) external pure returns (address[] memory ids) {
        ids = new address[](0);
    }
}

/// @notice Records the instructions an OrderBook sends, so tests can assert on
/// op codes and on the exact bytes handed to the enclave.
contract MockExtensionRegistry is ITeeExtensionRegistry {
    struct Sent {
        address[] teeIds;
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address claimBackAddress;
        uint256 value;
    }

    Sent[] internal _sent;

    uint256 public nextPublicExtensionId = 0x10005;
    mapping(uint256 => address) public senderOf;

    function setSender(uint256 extensionId, address sender) external {
        senderOf[extensionId] = sender;
    }

    function getTeeExtensionInstructionsSender(uint256 extensionId)
        external
        view
        returns (address)
    {
        return senderOf[extensionId];
    }

    function sendInstructions(address[] calldata teeIds, TeeInstructionParams calldata p)
        external
        payable
        returns (bytes32)
    {
        _sent.push(
            Sent({
                teeIds: teeIds,
                opType: p.opType,
                opCommand: p.opCommand,
                message: p.message,
                claimBackAddress: p.claimBackAddress,
                value: msg.value
            })
        );
        return keccak256(abi.encode(_sent.length, p.opCommand));
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sentAt(uint256 i) external view returns (Sent memory) {
        return _sent[i];
    }
}
