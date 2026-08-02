# InstructionSender Contract

## What It Is

The InstructionSender is the **only on-chain address allowed to submit instructions** to your extension's TEE machines. It acts as the gateway between end users and the TEE — users call functions on your InstructionSender, which routes those calls through the `TeeExtensionRegistry`.

This is enforced at the protocol level. When you register an extension, you provide your InstructionSender's address. From that point on, the registry rejects any `sendInstructions` call where `msg.sender` doesn't match that address. No EOA, no other contract — only your InstructionSender can submit instructions for your extension.

## How It Fits Into the System

```
User (EOA)
  │
  │  calls sendSayHello(message)
  ▼
InstructionSender Contract (your code)
  │
  │  1. Picks a random TEE machine via TeeMachineRegistry
  │  2. Calls sendInstructions() on TeeExtensionRegistry
  ▼
TeeExtensionRegistry (protocol contract)
  │
  │  Checks: msg.sender == registered InstructionSender? ✓
  │  Emits TeeInstructionsSent event
  ▼
TEE Machine picks up instruction off-chain and executes it
```

## Requirements

Any InstructionSender contract must:

1. **Know its extension ID** — needed to look up which TEE machines serve your extension. The scaffold handles this via `setExtensionId()`, which scans the registry after registration.

2. **Call `sendInstructions` on `TeeExtensionRegistry`** — this is the only way to submit instructions. The call must include:
   - `teeIds` — at least one TEE machine address (use `teeMachineRegistry.getRandomTeeIds()` to pick one)
   - `opType` — a `bytes32` identifying the action (must match your Go handler)
   - `opCommand` — a `bytes32` identifying the specific command within the operation type (e.g., `bytes32("SAY_HELLO")` or `bytes32("SAY_GOODBYE")`)
   - `message` — the payload (typically JSON-encoded, non-empty)
   - `cosigners` / `cosignersThreshold` — for multi-sig scenarios (usually empty/0)

3. **Forward `msg.value`** — the registry charges a fee per instruction. Your send functions should be `payable` and forward the full value.

4. **Be deployed before registration** — you register the extension by passing the InstructionSender's address to `TeeExtensionRegistry.register()`. The address must exist at registration time.

There are no other constraints. The registry doesn't inspect your contract's code, doesn't require specific function signatures, and doesn't care how you structure your internal logic. As long as the registered address calls `sendInstructions` with valid parameters, it works.

## Using the Scaffold

The provided `InstructionSender.sol` is a ready-to-use starting point. It handles all the boilerplate — registry references, extension ID discovery, TEE machine selection — and gives you a single place to define your actions:

**Define your operation types and commands** as `bytes32` constants:
```solidity
bytes32 constant OP_TYPE_GREETING = bytes32("GREETING");
bytes32 constant OP_COMMAND_SAY_HELLO = bytes32("SAY_HELLO");
bytes32 constant OP_COMMAND_SAY_GOODBYE = bytes32("SAY_GOODBYE");
```

**Add a send function per action:**
```solidity
function sendSayHello(bytes calldata _message) external payable {
    address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
    address[] memory cosigners = new address[](0);
    uint64 cosignersThreshold = 0;

    TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
        teeIds,
        OP_TYPE_GREETING,
        OP_COMMAND_SAY_HELLO,
        _message,
        cosigners,
        cosignersThreshold
    );
}

function sendSayGoodbye(string calldata _name, string calldata _reason) external payable {
    address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
    address[] memory cosigners = new address[](0);
    uint64 cosignersThreshold = 0;

    TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
        teeIds,
        OP_TYPE_GREETING,
        OP_COMMAND_SAY_GOODBYE,
        abi.encode(SayGoodbyeMessage(_name, _reason)),
        cosigners,
        cosignersThreshold
    );
}
```

Each `OP_TYPE` string must match what your Go extension expects. On the Go side, use `teeutils.ToHash("GREETING")` to produce the matching `bytes32`. The `opCommand` field lets you route multiple actions under the same operation type — your Go handler can switch on both values to dispatch to the right logic.

After modifying the contract, run `./scripts/generate-bindings.sh` to regenerate the Go bindings.

## Writing Your Own From Scratch

You don't have to use the scaffold. You can write an InstructionSender from scratch as long as it satisfies the requirements above. Some reasons you might want to:

- **Custom access control** — restrict who can submit instructions (e.g., only whitelisted callers, token holders, DAO governance)
- **On-chain validation** — verify message format, check balances, or enforce rate limits before submitting
- **Multi-TEE routing** — send the same instruction to multiple TEE machines (`getRandomTeeIds(extensionId, n)` with n > 1)
- **Cosigner workflows** — require multiple parties to co-sign an instruction before it's executed
- **Batching** — accept multiple instructions in one transaction

A minimal custom InstructionSender looks like this:

```solidity
contract MinimalInstructionSender {
    ITeeExtensionRegistry immutable registry;
    ITeeMachineRegistry immutable machines;
    uint256 extensionId;

    constructor(ITeeExtensionRegistry r, ITeeMachineRegistry m, uint256 extId) {
        registry = r;
        machines = m;
        extensionId = extId;
    }

    function send(bytes32 opType, bytes32 opCommand, bytes calldata message) external payable {
        address[] memory tees = machines.getRandomTeeIds(extensionId, 1);
        address[] memory cosigners = new address[](0);
        registry.sendInstructions{value: msg.value}(
            tees, opType, opCommand, message, cosigners, 0
        );
    }
}
```

This is valid — it will work as long as this contract's address is registered as the InstructionSender for the extension. The scaffold just adds the convenience of `setExtensionId()` (auto-discovers the ID from the registry) and typed send functions (one per action).
