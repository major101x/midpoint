/**
 * ★ Configuration: version and operation identifiers.
 *
 * These strings MUST match the bytes32 constants in the Midpoint OrderBook
 * contract exactly, or actions fall through to "unsupported op type" (501).
 *
 *   OrderBook.OP_TYPE_SEALED          = bytes32("SEALED")
 *   OrderBook.OP_COMMAND_SUBMIT_ORDER = bytes32("SUBMIT_ORDER")
 *   OrderBook.OP_COMMAND_RUN_MATCH    = bytes32("RUN_MATCH")
 */

export const VERSION = "0.2.0";

export const OP_TYPE_SEALED = "SEALED";
export const OP_COMMAND_SUBMIT_ORDER = "SUBMIT_ORDER";
export const OP_COMMAND_RUN_MATCH = "RUN_MATCH";
