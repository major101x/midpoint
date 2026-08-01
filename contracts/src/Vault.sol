// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./SafeTransfer.sol";

/// @title Vault
/// @notice Holds trader balances for the Sealed venue.
///
/// @dev WHY THIS CONTRACT EXISTS.
///
/// The obvious venue design escrows funds per order. That is fatal here: the
/// escrowed amount *is* the order size, published on chain, which makes the
/// order encryption decorative. Sealed instead has traders pre-fund an internal
/// balance and draw orders against it, so the public act of depositing is
/// decoupled from the private act of ordering, in both time and amount.
///
/// A consequence is that the chain cannot know whether a trader's balance
/// covers their (encrypted) order. Locking the exact amount at submission time
/// is impossible without revealing it. Sealed therefore freezes withdrawals for
/// the duration of a settling batch rather than locking per-order amounts. See
/// `setFrozen`.
///
/// Balances are tracked in raw token units. The vault makes no assumption about
/// decimals; both Coston2 tokens happen to use 6, not the more common 18, and
/// nothing here depends on that.
contract Vault {
    using SafeTransfer for address;

    /// @notice Base asset. FXRP on Coston2.
    address public immutable BASE;
    /// @notice Quote asset. USDT0 on Coston2.
    address public immutable QUOTE;

    /// @notice Can set the settlement contract.
    address public owner;
    /// @notice The only address permitted to move balances between traders.
    address public settlement;
    /// @notice While true, withdrawals revert. Set for the duration of a batch.
    bool public frozen;

    mapping(address trader => uint256 amount) public baseBalanceOf;
    mapping(address trader => uint256 amount) public quoteBalanceOf;

    event Deposited(address indexed trader, bool isBase, uint256 amount);
    event Withdrawn(address indexed trader, bool isBase, uint256 amount);
    event Moved(address indexed from, address indexed to, bool isBase, uint256 amount);
    event SettlementSet(address indexed settlement);
    event FrozenSet(bool frozen);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error NotSettlement();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 requested);
    error WithdrawalsFrozen();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlySettlement() {
        if (msg.sender != settlement) revert NotSettlement();
        _;
    }

    constructor(address base_, address quote_, address owner_) {
        if (base_ == address(0) || quote_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        BASE = base_;
        QUOTE = quote_;
        owner = owner_;
        emit OwnerSet(owner_);
    }

    // --- trader entry points -------------------------------------------------

    /// @notice Pull `amount` of the chosen asset from the caller into their balance.
    /// @dev Credits the amount actually received rather than the amount requested,
    /// so a fee-on-transfer token cannot leave the vault crediting more than it holds.
    function deposit(bool isBase, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address token = isBase ? BASE : QUOTE;

        uint256 before = IERC20(token).balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        if (isBase) {
            baseBalanceOf[msg.sender] += received;
        } else {
            quoteBalanceOf[msg.sender] += received;
        }
        emit Deposited(msg.sender, isBase, received);
    }

    /// @notice Withdraw from the caller's balance back to their wallet.
    /// @dev Reverts while a batch is settling. Withdrawals cannot be permitted
    /// mid-batch because the chain does not know the size of the caller's
    /// pending encrypted order, so it cannot tell what is safe to release.
    function withdraw(bool isBase, uint256 amount) external nonReentrant {
        if (frozen) revert WithdrawalsFrozen();
        if (amount == 0) revert ZeroAmount();

        uint256 available = isBase ? baseBalanceOf[msg.sender] : quoteBalanceOf[msg.sender];
        if (available < amount) revert InsufficientBalance(available, amount);

        // Effects before interaction.
        if (isBase) {
            baseBalanceOf[msg.sender] = available - amount;
        } else {
            quoteBalanceOf[msg.sender] = available - amount;
        }

        (isBase ? BASE : QUOTE).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, isBase, amount);
    }

    // --- settlement ----------------------------------------------------------

    /// @notice Move an internal balance between two traders. No tokens leave the vault.
    /// @dev The only mutation path available to settlement. Composing fills out of
    /// primitive moves keeps this contract ignorant of auction mechanics.
    function move(address from, address to, bool isBase, uint256 amount) external onlySettlement {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (isBase) {
            uint256 available = baseBalanceOf[from];
            if (available < amount) revert InsufficientBalance(available, amount);
            baseBalanceOf[from] = available - amount;
            baseBalanceOf[to] += amount;
        } else {
            uint256 available = quoteBalanceOf[from];
            if (available < amount) revert InsufficientBalance(available, amount);
            quoteBalanceOf[from] = available - amount;
            quoteBalanceOf[to] += amount;
        }
        emit Moved(from, to, isBase, amount);
    }

    /// @notice Freeze or unfreeze withdrawals. Called around a settling batch.
    function setFrozen(bool frozen_) external onlySettlement {
        frozen = frozen_;
        emit FrozenSet(frozen_);
    }

    // --- admin ---------------------------------------------------------------

    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }
}
