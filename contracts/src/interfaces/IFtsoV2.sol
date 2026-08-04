// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal view of Flare's FTSO v2 feed reader.
/// @dev Declared `view` because that is how the Coston2 deployment behaves and
/// how Settlement calls it. Flare's production `FtsoV2Interface` marks the
/// equivalent methods payable so a fee can be charged; if that ever applies
/// here, this call becomes non-static and Settlement needs updating.
interface IFtsoV2 {
    /// @return value Feed value as an integer.
    /// @return decimals Power of ten to divide `value` by.
    /// @return timestamp When the feed was last updated.
    function getFeedById(bytes21 feedId)
        external
        view
        returns (uint256 value, int8 decimals, uint64 timestamp);
}
