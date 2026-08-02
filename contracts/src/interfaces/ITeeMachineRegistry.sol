// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

/// @notice Minimal view of Flare's TEE machine registry.
/// @dev Mirrors the interface shipped in fce-extension-scaffold.
interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 _extensionId, uint256 _count)
        external
        view
        returns (address[] memory);
}
