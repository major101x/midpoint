// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";
import {Vault} from "./Vault.sol";

/// @title OrderBook
/// @notice On-chain entry point for the Sealed venue. Relays encrypted orders
/// into the TEE and asks it to clear the batch.
///
/// @dev This contract deliberately learns nothing about orders. It sees a blob
/// of ciphertext and the address that submitted it. Side, limit price and size
/// are readable only inside the enclave.
///
/// Two properties are load-bearing and easy to get wrong:
///
/// 1. THE TEE IS PINNED FOR THE LIFETIME OF A BATCH. The order book lives in one
///    enclave's memory. `getRandomTeeIds` may return different machines on
///    different calls, so drawing per order would silently split a batch across
///    enclaves and produce a clearing price computed over half the orders. The
///    machine is drawn once, when the batch's first order arrives, and reused.
///
/// 2. THE SUBMITTER IS BOUND TO THE CIPHERTEXT. `msg.sender` and the batch id are
///    ABI-encoded alongside the ciphertext, so the enclave learns who actually
///    sent it rather than trusting the self-declared trader inside the encrypted
///    payload. The enclave rejects an order whose inner trader does not match,
///    which stops a bystander copying someone else's ciphertext out of a public
///    transaction and replaying it, in this batch or a later one.
contract OrderBook {
    // Op identifiers. These strings must match the extension's config exactly,
    // or the action falls through to "unsupported op type" inside the TEE.
    bytes32 public constant OP_TYPE_SEALED = bytes32("SEALED");
    bytes32 public constant OP_COMMAND_SUBMIT_ORDER = bytes32("SUBMIT_ORDER");
    bytes32 public constant OP_COMMAND_RUN_MATCH = bytes32("RUN_MATCH");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;
    Vault public immutable VAULT;

    /// @notice Registry reserves ids below this for system extensions.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;
    uint256 private _extensionId;

    /// @notice Address permitted to advance the batch after settlement.
    address public owner;
    address public settlement;

    /// @notice Monotonic batch counter. Batch 1 is the first.
    uint256 public currentBatchId = 1;
    /// @notice Enclave handling the current batch. Zero until the first order.
    address public batchTee;
    /// @notice When the current batch received its first order.
    uint64 public batchOpenedAt;
    /// @notice Orders submitted to the current batch. A count only, never sizes.
    uint32 public orderCount;
    /// @notice True once RUN_MATCH has been sent and before settlement lands.
    bool public batchClosed;

    /// @notice Shortest time a batch may stay open, in seconds.
    uint64 public minBatchDuration;

    /// @notice How long after a batch opens before anyone may abandon it.
    uint64 public voidDelay = 1 hours;

    event OrderSubmitted(
        address indexed trader, uint256 indexed batchId, address indexed tee, bytes32 instructionId
    );
    event BatchClosed(
        uint256 indexed batchId, address indexed tee, uint32 orderCount, bytes32 instructionId
    );
    event BatchAdvanced(uint256 indexed settledBatchId, uint256 indexed newBatchId);
    event BatchVoided(uint256 indexed voidedBatchId, uint256 indexed newBatchId);
    event VoidDelaySet(uint64 seconds_);
    event MinBatchDurationSet(uint64 seconds_);
    event SettlementSet(address indexed settlement);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error NotSettlement();
    error ZeroAddress();
    error ExtensionIdAlreadySet();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();
    error NoTeeAvailable();
    error EmptyCiphertext();
    error NoVaultBalance();
    error BatchAlreadyClosed();
    error BatchNotClosed();
    error BatchEmpty();
    error BatchTooYoung(uint64 openedAt, uint64 minDuration);
    error BatchNotVoidable(uint64 openedAt, uint64 voidDelay);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        ITeeExtensionRegistry teeExtensionRegistry_,
        ITeeMachineRegistry teeMachineRegistry_,
        Vault vault_,
        address owner_,
        uint64 minBatchDuration_
    ) {
        if (
            address(teeExtensionRegistry_) == address(0)
                || address(teeMachineRegistry_) == address(0) || address(vault_) == address(0)
                || owner_ == address(0)
        ) revert ZeroAddress();

        TEE_EXTENSION_REGISTRY = teeExtensionRegistry_;
        TEE_MACHINE_REGISTRY = teeMachineRegistry_;
        VAULT = vault_;
        owner = owner_;
        minBatchDuration = minBatchDuration_;

        emit OwnerSet(owner_);
        emit MinBatchDurationSet(minBatchDuration_);
    }

    /// @notice Finds and caches this contract's extension id. Callable once.
    /// @dev Copied verbatim from the Flare scaffold. Do not modify.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    function extensionId() external view returns (uint256) {
        return _extensionId;
    }

    // --- trading -------------------------------------------------------------

    /// @notice Submit an order encrypted to the enclave's public key.
    /// @param ciphertext Opaque blob. Only the enclave can read it.
    /// @dev Requires a non-zero vault balance. That is a spam guard which leaks
    /// nothing about the order: holding a balance says only that the caller is a
    /// participant, not what they intend to trade, in which direction, or how much.
    function submitOrder(bytes calldata ciphertext)
        external
        payable
        returns (bytes32 instructionId)
    {
        if (ciphertext.length == 0) revert EmptyCiphertext();
        if (batchClosed) revert BatchAlreadyClosed();
        if (VAULT.baseBalanceOf(msg.sender) == 0 && VAULT.quoteBalanceOf(msg.sender) == 0) {
            revert NoVaultBalance();
        }

        address tee = _pinnedTee();

        // Bind sender and batch to the payload so the enclave can reject a
        // replayed ciphertext rather than trusting the encrypted trader field.
        //
        // The balances travel with it because the enclave otherwise clears blind:
        // it can produce a perfectly valid, signed settlement that the vault
        // cannot execute, which reverts the whole batch and strands everyone in
        // it. Sending them leaks nothing, since vault balances are already public
        // on chain and anyone can read them directly.
        bytes memory message = abi.encode(
            msg.sender,
            currentBatchId,
            VAULT.baseBalanceOf(msg.sender),
            VAULT.quoteBalanceOf(msg.sender),
            ciphertext
        );

        instructionId = _send(tee, OP_COMMAND_SUBMIT_ORDER, message);

        unchecked {
            ++orderCount;
        }
        emit OrderSubmitted(msg.sender, currentBatchId, tee, instructionId);
    }

    /// @notice Ask the enclave to clear the current batch.
    /// @dev Permissionless by design. Anyone may close a batch that has run its
    /// minimum duration, so the venue does not depend on the operator staying
    /// online to make progress. Rate limited so a batch cannot be closed the
    /// instant it opens, which would let a caller isolate a single order into its
    /// own batch and infer its side from the settlement.
    function closeBatch() external payable returns (bytes32 instructionId) {
        if (batchClosed) revert BatchAlreadyClosed();
        if (orderCount == 0) revert BatchEmpty();
        if (block.timestamp < batchOpenedAt + minBatchDuration) {
            revert BatchTooYoung(batchOpenedAt, minBatchDuration);
        }

        address tee = batchTee;
        batchClosed = true;

        instructionId = _send(tee, OP_COMMAND_RUN_MATCH, abi.encode(currentBatchId));
        emit BatchClosed(currentBatchId, tee, orderCount, instructionId);
    }

    /// @notice Open the next batch. Called by Settlement once a batch is settled
    /// or voided.
    /// @dev Voiding matters because the enclave holds the book in memory: a batch
    /// whose enclave restarted cannot be settled, only abandoned.
    function advanceBatch() external {
        if (msg.sender != settlement) revert NotSettlement();
        if (!batchClosed) revert BatchNotClosed();

        uint256 settled = currentBatchId;
        unchecked {
            currentBatchId = settled + 1;
        }
        batchTee = address(0);
        batchOpenedAt = 0;
        orderCount = 0;
        batchClosed = false;

        emit BatchAdvanced(settled, currentBatchId);
    }

    /// @notice Abandon the current batch without asking the enclave to clear it.
    ///
    /// @dev THE RECOVERY PATH FOR A VANISHED ENCLAVE. `batchTee` is pinned for
    /// the batch's lifetime, and TEE machines are ephemeral: a rebuild registers
    /// a new machine and the old one is eventually paused or simply stops
    /// answering. Once that happens `closeBatch` reverts inside the registry,
    /// which refuses to route to a paused machine, and `advanceBatch` cannot run
    /// because the batch never closed. Without this function the batch is stuck
    /// permanently, and so are the balances frozen behind it.
    ///
    /// Deliberately permissionless with no owner shortcut. Letting the owner
    /// void immediately would let them cancel any batch whose outcome they
    /// disliked, which is precisely the discretion this venue exists to remove.
    /// Everyone waits out `voidDelay`, including the operator.
    ///
    /// Orders in a voided batch are never revealed and never settle. Traders
    /// keep their balances and may resubmit into the next batch.
    function voidBatch() external {
        if (orderCount == 0 && !batchClosed) revert BatchEmpty();
        if (block.timestamp < batchOpenedAt + voidDelay) {
            revert BatchNotVoidable(batchOpenedAt, voidDelay);
        }

        uint256 voided = currentBatchId;
        unchecked {
            currentBatchId = voided + 1;
        }
        batchTee = address(0);
        batchOpenedAt = 0;
        orderCount = 0;
        batchClosed = false;

        emit BatchVoided(voided, currentBatchId);
    }

    // --- internals -----------------------------------------------------------

    /// @dev Draws a machine on the batch's first order and reuses it thereafter.
    function _pinnedTee() private returns (address tee) {
        tee = batchTee;
        if (tee != address(0)) return tee;

        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_requireExtensionId(), 1);
        if (teeIds.length == 0 || teeIds[0] == address(0)) revert NoTeeAvailable();

        tee = teeIds[0];
        batchTee = tee;
        batchOpenedAt = uint64(block.timestamp);
    }

    function _send(address tee, bytes32 opCommand, bytes memory message) private returns (bytes32) {
        address[] memory teeIds = new address[](1);
        teeIds[0] = tee;

        ITeeExtensionRegistry.TeeInstructionParams memory params =
            ITeeExtensionRegistry.TeeInstructionParams({
                opType: OP_TYPE_SEALED,
                opCommand: opCommand,
                message: message,
                cosigners: new address[](0),
                cosignersThreshold: 0,
                claimBackAddress: msg.sender
            });

        return TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    function _requireExtensionId() private view returns (uint256) {
        if (_extensionId == 0) revert ExtensionIdNotSet();
        return _extensionId;
    }

    // --- admin ---------------------------------------------------------------

    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert ZeroAddress();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function setMinBatchDuration(uint64 seconds_) external onlyOwner {
        minBatchDuration = seconds_;
        emit MinBatchDurationSet(seconds_);
    }

    /// @dev Lowering this shortens how long a stuck batch holds funds hostage;
    /// raising it gives a healthy enclave more room before anyone can abandon a
    /// batch it is still working on.
    function setVoidDelay(uint64 seconds_) external onlyOwner {
        voidDelay = seconds_;
        emit VoidDelaySet(seconds_);
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnerSet(owner_);
    }
}
