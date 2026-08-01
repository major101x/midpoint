// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice ERC20 transfer helpers that tolerate non-standard tokens.
/// @dev USDT0 on Coston2 is in the USDT lineage. Tokens in that family may omit
/// the bool return value entirely, which makes a strictly typed
/// `IERC20(token).transfer(...)` revert on ABI decoding even when the transfer
/// succeeded. These helpers accept either no return data or a return value that
/// decodes to true, and reject everything else.
library SafeTransfer {
    error TransferFailed();
    error TransferFromFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok || !_succeeded(data)) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount)); // transferFrom(address,address,uint256)
        if (!ok || !_succeeded(data)) revert TransferFromFailed();
    }

    /// @dev Empty return data is treated as success, matching how non-standard
    /// tokens behave. Any other length must decode to exactly `true`.
    function _succeeded(bytes memory data) private pure returns (bool) {
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
