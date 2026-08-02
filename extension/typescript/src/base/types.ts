/**
 * Wire types and the handler registry.
 *
 * --- DO NOT MODIFY: infrastructure code. ---
 *
 * Field names and encodings are fixed by docs/extension-contract.md §4.
 */

import { stringToBytes32Hex } from "./encoding.js";

/**
 * A handler receives the raw originalMessage hex and returns
 * [dataHexOrNull, status, errorOrNull]. May be async.
 */
export type HandlerResult = [string | null, number, string | null];
export type HandlerFunc = (msg: string) => HandlerResult | Promise<HandlerResult>;

/** Returns any JSON-serializable snapshot of extension state. */
export type ReportStateFunc = () => unknown;

/** Called once at startup to register handlers. */
export type RegisterFunc = (framework: Framework) => void;

export const EMPTY_BYTES32 = stringToBytes32Hex("");

/** The `data` field of an Action (contract §4.2). */
export interface ActionData {
  id: string;
  type: string;
  submissionTag: string;
  /** Hex-encoded UTF-8 JSON that decodes to a DataFixed. */
  message: string;
}

/** Request body of POST /action (contract §4.1). */
export interface Action {
  data: ActionData;
  additionalVariableMessages?: string[];
  timestamps?: number[];
  additionalActionData?: string;
  signatures?: string[];
}

/** Decoded from ActionData.message (contract §4.3). */
export interface DataFixed {
  instructionId: string;
  teeId?: string;
  timestamp?: number;
  rewardEpochId?: number;
  opType: string;
  opCommand: string;
  cosigners?: string[];
  cosignersThreshold?: number;
  originalMessage?: string;
  additionalFixedMessage?: string;
}

/**
 * Response body of POST /action (contract §4.4).
 *
 * Every field is required: tee-node's Go struct has no omitempty tags, so all
 * of them always appear on the wire. `data` and `additionalResultStatus` are
 * hexutil.Bytes and marshal as "0x" when empty.
 */
export interface ActionResult {
  id: string;
  submissionTag: string;
  status: number;
  log: string;
  opType: string;
  opCommand: string;
  additionalResultStatus: string;
  /** Plain version string, NOT bytes32 — see contract §4.4. */
  version: string;
  data: string;
}

/**
 * Response body of GET /state (contract §4.5).
 * Note the asymmetry with ActionResult: stateVersion IS bytes32 hex.
 */
export interface StateResponse {
  stateVersion: string;
  state: unknown;
}

/** Maps (opType, opCommand) bytes32 pairs to handlers (contract §5). */
export class Framework {
  private handlers: Array<[string, string, HandlerFunc]> = [];

  /**
   * Register a handler. Both identifiers are given as plain strings and
   * converted to bytes32. Pass "" for opCommand to make this the default for
   * every command under opType.
   */
  handle(opType: string, opCommand: string, handler: HandlerFunc): void {
    this.handlers.push([
      stringToBytes32Hex(opType),
      stringToBytes32Hex(opCommand),
      handler,
    ]);
  }

  /** Exact (opType, opCommand) match first, then the opCommand wildcard. */
  lookup(opType: string, opCommand: string): HandlerFunc | null {
    const t = normalize(opType);
    const c = normalize(opCommand);

    for (const [regType, regCmd, handler] of this.handlers) {
      if (regType === t && regCmd === c) return handler;
    }
    for (const [regType, regCmd, handler] of this.handlers) {
      if (regType === t && regCmd === EMPTY_BYTES32) return handler;
    }
    return null;
  }
}

/** Lowercase and 0x-prefix a hex identifier so comparisons are stable. */
function normalize(h: string): string {
  if (!h) return EMPTY_BYTES32;
  const lower = h.toLowerCase();
  return lower.startsWith("0x") ? lower : `0x${lower}`;
}
