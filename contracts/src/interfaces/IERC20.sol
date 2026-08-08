// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Minimal ERC20 surface used by Midpoint.
/// @dev Transfers are performed through low-level calls in SafeTransfer rather
/// than through this interface, because tokens in the USDT lineage do not
/// return a bool and would revert a strictly typed call. This interface is kept
/// for the view functions only.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function allowance(address owner, address spender) external view returns (uint256);
}
