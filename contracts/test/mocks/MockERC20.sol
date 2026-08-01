// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Test ERC20 with switchable non-standard behaviours.
/// @dev `returnsBool = false` reproduces the USDT lineage, where transfer and
/// transferFrom return no data at all. `feeBps > 0` reproduces a fee-on-transfer
/// token. Both exist to prove Vault survives them.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    bool public immutable returnsBool;
    uint16 public feeBps;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, bool returnsBool_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        returnsBool = returnsBool_;
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _transfer(msg.sender, to, amount);
        _ret();
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        _ret();
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[to] += amount - fee;
        if (fee != 0) totalSupply -= fee;
    }

    /// @dev Writes either a bool `true` or nothing at all into the return buffer.
    function _ret() private view {
        if (returnsBool) {
            assembly {
                mstore(0x00, 1)
                return(0x00, 0x20)
            }
        }
        assembly {
            return(0x00, 0x00)
        }
    }
}
