// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IFtsoV2} from "../../src/interfaces/IFtsoV2.sol";

/// @notice Settable FTSO feed, so band and rescaling behaviour can be driven.
contract MockFtso is IFtsoV2 {
    uint256 private _value;
    int8 private _decimals;
    uint64 private _timestamp;

    constructor(uint256 value_, int8 decimals_, uint64 timestamp_) {
        set(value_, decimals_, timestamp_);
    }

    function set(uint256 value_, int8 decimals_, uint64 timestamp_) public {
        _value = value_;
        _decimals = decimals_;
        _timestamp = timestamp_;
    }

    function getFeedById(bytes21) external view returns (uint256, int8, uint64) {
        return (_value, _decimals, _timestamp);
    }
}
