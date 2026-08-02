/**
 * Extension HTTP server.
 *
 * --- DO NOT MODIFY: infrastructure code. ---
 *
 * Implements docs/extension-contract.md §2 (HTTP surface), §4 (wire format),
 * §5 (dispatch and serialization). Your code lives in app/.
 */

import http from "node:http";

import { bytes32HexToString, hexToBytes, stringToBytes32Hex } from "./encoding.js";
import {
  Framework,
  type Action,
  type ActionResult,
  type DataFixed,
  type RegisterFunc,
  type ReportStateFunc,
  type StateResponse,
} from "./types.js";

export class Server {
  readonly extPort: number;
  readonly signPort: number;

  /**
   * ActionResult.version is the PLAIN string (contract §4.4); only
   * StateResponse.stateVersion is bytes32. This asymmetry is real — tee-node
   * declares `Version string` but `StateVersion common.Hash`.
   */
  readonly version: string;
  readonly stateVersionHex: string;

  readonly framework: Framework;
  private readonly reportState: ReportStateFunc;
  private server: http.Server | null = null;

  /** Handlers and state reads are serialized (contract §5). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    extPort: string | number,
    signPort: string | number,
    version: string,
    register: RegisterFunc,
    reportState: ReportStateFunc,
  ) {
    this.extPort = Number(extPort);
    this.signPort = Number(signPort);
    this.version = version;
    this.stateVersionHex = stringToBytes32Hex(version);
    this.framework = new Framework();
    this.reportState = reportState;
    register(this.framework);
  }

  // --- lifecycle ---------------------------------------------------------

  listenAndServe(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        void this.serve(req, res);
      });
      this.server.listen(this.extPort, () => {
        console.log(`extension listening on port ${this.extPort}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // --- routing -----------------------------------------------------------

  /**
   * Route a request. Exposed directly so tests and the conformance harness can
   * exercise the contract without binding a socket.
   */
  async handleRequest(
    method: string,
    path: string,
    body: string,
  ): Promise<[number, unknown]> {
    const clean = path.split("?")[0];

    if (clean === "/action") {
      if (method === "POST") return this.processAction(body);
      return [405, "method not allowed"];
    }
    if (clean === "/state") {
      if (method === "GET") return this.processState();
      return [405, "method not allowed"];
    }
    return [404, "not found"];
  }

  // --- handlers ----------------------------------------------------------

  private async processAction(body: string): Promise<[number, unknown]> {
    let action: Action;
    try {
      action = JSON.parse(body) as Action;
    } catch (e) {
      return [400, { error: `invalid action JSON: ${String(e)}` }];
    }
    if (!action || typeof action !== "object" || !action.data) {
      return [400, { error: "invalid action structure: missing data" }];
    }

    let msgBytes: Uint8Array;
    try {
      msgBytes = hexToBytes(action.data.message);
    } catch (e) {
      return [400, { error: `invalid hex in message: ${String(e)}` }];
    }

    let df: DataFixed;
    try {
      df = JSON.parse(Buffer.from(msgBytes).toString("utf-8")) as DataFixed;
    } catch (e) {
      return [400, { error: `invalid DataFixed JSON in message: ${String(e)}` }];
    }
    if (!df || typeof df !== "object" || !df.opType) {
      return [400, { error: "invalid DataFixed: missing opType" }];
    }

    const handler = this.framework.lookup(df.opType, df.opCommand ?? "");
    if (!handler) return [501, "unsupported op type"];

    const [data, status, err] = await this.serialize(() =>
      handler(df.originalMessage ?? "0x"),
    );

    // Log values are part of the contract (§4.6).
    let log: string;
    if (status === 0) log = err ? `error: ${err}` : "error: unknown";
    else if (status === 1) log = "ok";
    else log = "pending";

    // Serialized exactly as tee-node's Go ActionResult struct: every field is
    // always present. `data` and `additionalResultStatus` are hexutil.Bytes
    // with no omitempty, so they marshal as "0x" rather than being omitted.
    // Key order matches the Go struct.
    const result: ActionResult = {
      id: action.data.id,
      submissionTag: action.data.submissionTag,
      status,
      log,
      opType: df.opType,
      opCommand: df.opCommand,
      additionalResultStatus: "0x",
      version: this.version,
      data: data ?? "0x",
    };

    console.log(
      `action ${action.data.id}: opType=${bytes32HexToString(df.opType)} ` +
        `opCommand=${bytes32HexToString(df.opCommand)} status=${status}`,
    );

    return [200, result];
  }

  private async processState(): Promise<[number, unknown]> {
    const state = await this.serialize(() => this.reportState());
    const resp: StateResponse = {
      stateVersion: this.stateVersionHex,
      state,
    };
    return [200, resp];
  }

  /**
   * Run fn after all previously queued work, preserving order and preventing
   * overlap. The queue is advanced even when fn rejects, so one failing handler
   * cannot wedge the server.
   */
  private serialize<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --- transport ---------------------------------------------------------

  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body = "";
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "failed to read body" });
    }

    const [status, payload] = await this.handleRequest(
      req.method ?? "",
      req.url ?? "",
      body,
    );
    send(res, status, payload);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const isText = typeof payload === "string";
  const body = isText ? (payload as string) : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain" : "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
