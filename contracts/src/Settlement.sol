// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IFtsoV2} from "./interfaces/IFtsoV2.sol";
import {OrderBook} from "./OrderBook.sol";
import {Vault} from "./Vault.sol";

/// @title Settlement
/// @notice Verifies a batch result produced inside the TEE and moves balances.
///
/// @dev This contract is the only thing standing between a hidden matching
/// engine and everyone's money, so it assumes the payload is hostile until four
/// independent checks pass:
///
///  1. SIGNED BY THE RIGHT ENCLAVE. The signature must recover to the exact TEE
///     machine that `OrderBook` pinned for this batch. Not "a" registered TEE,
///     and not an address an admin typed in: the enclave that actually held the
///     book. Nobody else can produce that signature, including the operator.
///  2. NOT A REPLAY. Only the batch `OrderBook` currently has closed can settle,
///     and settling advances it, so a payload can never be applied twice.
///  3. PRICED SANELY. The clearing price must sit within a band around the FTSO
///     oracle. This is what stops a compromised or buggy enclave printing an
///     arbitrary price, and it is the reason the venue does not require blind
///     trust in the TEE.
///  4. CONSERVATIVE. Base bought must equal base sold, and quote paid must equal
///     quote received. Settlement can move value between traders but can never
///     create or destroy it.
///
/// Only after all four does it touch the vault.
contract Settlement {
    /// @dev Matches the digest tee-node produces: it signs
    /// `crypto.Sign(accounts.TextHash(keccak256(message)), teeKey)`, and
    /// `TextHash` is EIP-191 over a 32 byte value.
    bytes private constant EIP191_PREFIX = "\x19Ethereum Signed Message:\n32";

    /// @notice Price scale. Both Coston2 tokens and the FTSO feed use 6 decimals.
    uint256 public constant PRICE_SCALE = 1e6;
    uint256 private constant BPS = 10_000;

    Vault public immutable VAULT;
    OrderBook public immutable ORDER_BOOK;
    IFtsoV2 public immutable FTSO;
    bytes21 public immutable FEED_ID;

    address public owner;

    /// @notice Allowed deviation from the oracle price, in basis points.
    uint16 public bandBps;

    /// @notice Highest batch id already settled. Guards against replay.
    uint256 public lastSettledBatch;

    struct Fill {
        address trader;
        /// @dev 0 = BUY, 1 = SELL.
        uint8 side;
        uint256 size;
        uint256 quote;
    }

    event Settled(
        uint256 indexed batchId, uint256 clearingPrice, uint256 volume, uint256 fillCount
    );
    event BandSet(uint16 bandBps);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error ZeroAddress();
    error BatchNotClosed();
    error WrongBatch(uint256 expected, uint256 provided);
    error AlreadySettled(uint256 batchId);
    error BadSignatureLength(uint256 length);
    error NoEnclavePinned();
    error WrongSigner(address recovered, address expected);
    error BaseNotConserved(uint256 bought, uint256 sold);
    error QuoteNotConserved(uint256 paid, uint256 received);
    error PriceOutsideBand(uint256 clearingPrice, uint256 oraclePrice, uint16 bandBps);
    error StaleOracle(uint64 timestamp);
    error InvalidSide(uint8 side);
    error ZeroFill();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        Vault vault_,
        OrderBook orderBook_,
        IFtsoV2 ftso_,
        bytes21 feedId_,
        address owner_,
        uint16 bandBps_
    ) {
        if (
            address(vault_) == address(0) || address(orderBook_) == address(0)
                || address(ftso_) == address(0) || owner_ == address(0)
        ) revert ZeroAddress();

        VAULT = vault_;
        ORDER_BOOK = orderBook_;
        FTSO = ftso_;
        FEED_ID = feedId_;
        owner = owner_;
        bandBps = bandBps_;

        emit OwnerSet(owner_);
        emit BandSet(bandBps_);
    }

    /// @notice Apply a batch result signed inside the enclave.
    /// @param payload `abi.encode(uint256 batchId, uint256 clearingPrice, Fill[])`,
    /// exactly as the enclave encoded and signed it.
    /// @param signature 65 bytes, `r || s || v`, from the sign port.
    /// @dev Permissionless. The caller is an untrusted relayer: it can delay
    /// settlement or refuse to act, but it cannot forge or alter a batch, so
    /// liveness degrades gracefully while safety does not.
    function settle(bytes calldata payload, bytes calldata signature) external {
        address enclave = _verifySigner(payload, signature);

        (uint256 batchId, uint256 clearingPrice, Fill[] memory fills) =
            abi.decode(payload, (uint256, uint256, Fill[]));

        // --- replay and sequencing ---
        if (!ORDER_BOOK.batchClosed()) revert BatchNotClosed();
        uint256 expected = ORDER_BOOK.currentBatchId();
        if (batchId != expected) revert WrongBatch(expected, batchId);
        if (batchId <= lastSettledBatch) revert AlreadySettled(batchId);

        // --- provenance ---
        address pinned = ORDER_BOOK.batchTee();
        if (pinned == address(0)) revert NoEnclavePinned();
        if (enclave != pinned) revert WrongSigner(enclave, pinned);

        // --- conservation ---
        uint256 volume = _checkConservation(fills);

        // --- price sanity ---
        // Skipped when nothing traded: an empty batch has no price to check, and
        // demanding one would strand batches that simply did not cross.
        if (volume > 0) _checkBand(clearingPrice);

        lastSettledBatch = batchId;

        // Freeze withdrawals only while balances are in flux, then release.
        VAULT.setFrozen(true);
        _applyFills(fills);
        VAULT.setFrozen(false);

        ORDER_BOOK.advanceBatch();

        emit Settled(batchId, clearingPrice, volume, fills.length);
    }

    // --- verification --------------------------------------------------------

    /// @dev Rebuilds the EIP-191 digest the enclave signed and recovers the signer.
    function _verifySigner(bytes calldata payload, bytes calldata signature)
        private
        pure
        returns (address)
    {
        if (signature.length != 65) revert BadSignatureLength(signature.length);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // tee-node emits the recovery id as 0 or 1; ecrecover wants 27 or 28.
        if (v < 27) v += 27;

        bytes32 digest = keccak256(abi.encodePacked(EIP191_PREFIX, keccak256(payload)));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert WrongSigner(address(0), address(0));
        return recovered;
    }

    /// @dev Both legs must net to zero. The enclave allocates quote exactly for
    /// this reason: flooring each fill separately would make the totals diverge
    /// whenever one side has more fills than the other.
    function _checkConservation(Fill[] memory fills) private pure returns (uint256 volume) {
        uint256 bought;
        uint256 sold;
        uint256 paid;
        uint256 received;

        for (uint256 i = 0; i < fills.length; ++i) {
            Fill memory f = fills[i];
            if (f.size == 0) revert ZeroFill();
            if (f.side == 0) {
                bought += f.size;
                paid += f.quote;
            } else if (f.side == 1) {
                sold += f.size;
                received += f.quote;
            } else {
                revert InvalidSide(f.side);
            }
        }

        if (bought != sold) revert BaseNotConserved(bought, sold);
        if (paid != received) revert QuoteNotConserved(paid, received);
        return bought;
    }

    /// @dev The clearing price must sit within `bandBps` of the FTSO oracle.
    /// This is the check that bounds a hidden engine's discretion: whatever the
    /// enclave computes, it cannot print a price the public oracle disagrees with.
    function _checkBand(uint256 clearingPrice) private view {
        (uint256 value, int8 decimals, uint64 timestamp) = FTSO.getFeedById(FEED_ID);
        if (timestamp == 0) revert StaleOracle(timestamp);

        uint256 oracle = _rescale(value, decimals);
        uint256 delta = clearingPrice > oracle ? clearingPrice - oracle : oracle - clearingPrice;

        if (delta * BPS > oracle * bandBps) {
            revert PriceOutsideBand(clearingPrice, oracle, bandBps);
        }
    }

    /// @dev Normalise a feed value to PRICE_SCALE. Feeds are 6 decimals today,
    /// but the field exists precisely because that can change, and silently
    /// assuming it would misprice by orders of magnitude.
    function _rescale(uint256 value, int8 decimals) private pure returns (uint256) {
        if (decimals == 6) return value;
        if (decimals > 6) return value / (10 ** uint256(uint8(decimals) - 6));
        return value * (10 ** (6 - uint256(uint8(decimals))));
    }

    // --- application ---------------------------------------------------------

    /// @dev Two passes through this contract's own vault account. Collect
    /// everything first, then distribute, so the intermediate account can never
    /// pay out value it has not yet received. Conservation was already checked,
    /// so the account nets to exactly zero across the two passes.
    function _applyFills(Fill[] memory fills) private {
        for (uint256 i = 0; i < fills.length; ++i) {
            Fill memory f = fills[i];
            if (f.side == 0) {
                // Buyer pays quote.
                if (f.quote > 0) VAULT.move(f.trader, address(this), false, f.quote);
            } else {
                // Seller delivers base.
                VAULT.move(f.trader, address(this), true, f.size);
            }
        }

        for (uint256 i = 0; i < fills.length; ++i) {
            Fill memory f = fills[i];
            if (f.side == 0) {
                VAULT.move(address(this), f.trader, true, f.size);
            } else {
                if (f.quote > 0) VAULT.move(address(this), f.trader, false, f.quote);
            }
        }
    }

    // --- admin ---------------------------------------------------------------

    function setBandBps(uint16 bandBps_) external onlyOwner {
        bandBps = bandBps_;
        emit BandSet(bandBps_);
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }
}
