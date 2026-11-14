import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256
} from "viem";
import {
  DEFAULT_MULTICALL3_ADDRESS,
  PHAROS_MAINNET_CHAIN_ID,
  PHAROS_MAINNET_CODE_HASH,
  PHAROS_MAINNET_RPC_URL,
  multicall3Abi,
  summarizeMulticallResults
} from "./bundler.mjs";
import { GasSavingsEstimator } from "./gas.mjs";

const RPC_TIMEOUT_MS = 15_000;
const MAX_RPC_CONCURRENCY = 4;
const MAX_RPC_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRY_BACKOFF_MS = 250;
const revertAbi = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }]
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }]
  }
];

function rpcFailure(error) {
  const message = String(error?.message || "RPC request failed.");
  const data =
    typeof error?.data === "string" ? error.data : error?.data?.data ?? null;
  const kind =
    error?.code === 3 || /execution reverted|revert/i.test(message)
      ? "REVERT"
      : "RPC_ERROR";

  return {
    ok: false,
    kind,
    error: { code: error?.code ?? null, message, data }
  };
}

function quantity(value, field) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    return {
      ok: false,
      kind: "MALFORMED",
      error: { code: null, message: `${field} returned a malformed quantity.` }
    };
  }
  return { ok: true, value: BigInt(value).toString() };
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const timestamp = Date.parse(retryAfter);
    const delay =
      Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Number.isFinite(timestamp)
          ? Math.max(timestamp - Date.now(), 0)
          : null;
    return delay !== null && delay <= MAX_RETRY_DELAY_MS ? delay : null;
  }
  return Math.min(RETRY_BACKOFF_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

export class SimulationError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "SimulationError";
    this.status = status;
  }
}

export function createRpcAdapter(
  url = PHAROS_MAINNET_RPC_URL,
  fetchImpl = fetch
) {
  let requestId = 0;
  let activeRequests = 0;
  const waitingRequests = [];

  async function limitedFetch(options) {
    if (activeRequests >= MAX_RPC_CONCURRENCY) {
      await new Promise((resolve) => waitingRequests.push(resolve));
    } else {
      activeRequests++;
    }

    try {
      return await fetchImpl(url, options);
    } finally {
      const next = waitingRequests.shift();
      if (next) next();
      else activeRequests--;
    }
  }

  async function raw(method, params) {
    const id = ++requestId;
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await limitedFetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
        });
      } catch (error) {
        return {
          ok: false,
          kind: "TRANSPORT",
          error: {
            code: error?.name ?? null,
            message: error?.message ?? "RPC transport failed."
          }
        };
      }

      const retryableStatus = response.status === 429 || response.status >= 500;
      const delay = retryableStatus ? retryDelay(response, attempt) : null;
      if (
        retryableStatus &&
        attempt < MAX_RPC_RETRIES &&
        delay !== null
      ) {
        await response.body?.cancel();
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          kind: "TRANSPORT",
          error: {
            code: response.status,
            message: `RPC returned HTTP ${response.status}.`
          }
        };
      }
      break;
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        kind: "MALFORMED",
        error: { code: null, message: "RPC returned invalid JSON." }
      };
    }

    if (!body || body.id !== id || body.jsonrpc !== "2.0") {
      return {
        ok: false,
        kind: "MALFORMED",
        error: { code: null, message: "RPC response did not match its request." }
      };
    }
    if (body.error) return rpcFailure(body.error);
    if (!Object.hasOwn(body, "result") || body.result == null) {
      return {
        ok: false,
        kind: "MALFORMED",
        error: { code: null, message: "RPC response omitted its result." }
      };
    }
    return { ok: true, result: body.result };
  }

  return {
    async chainId() {
      const result = await raw("eth_chainId", []);
      if (!result.ok) return result;
      const parsed = quantity(result.result, "eth_chainId");
      return parsed.ok ? { ok: true, chainId: Number(parsed.value) } : parsed;
    },

    async blockNumber() {
      const result = await raw("eth_blockNumber", []);
      if (!result.ok) return result;
      const parsed = quantity(result.result, "eth_blockNumber");
      return parsed.ok ? { ok: true, blockNumber: parsed.value } : parsed;
    },

    async code(address) {
      const result = await raw("eth_getCode", [address, "latest"]);
      if (!result.ok) return result;
      if (
        typeof result.result !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(result.result)
      ) {
        return {
          ok: false,
          kind: "MALFORMED",
          error: { code: null, message: "eth_getCode returned malformed bytecode." }
        };
      }

      const codeBytes = (result.result.length - 2) / 2;
      return {
        ok: true,
        verified: codeBytes > 0,
        codeBytes,
        codeHash: codeBytes > 0 ? keccak256(result.result) : null
      };
    },

    async call(transaction) {
      const result = await raw(
        "eth_call",
        [
          {
            from: transaction.from,
            to: transaction.to,
            value: transaction.value,
            data: transaction.data
          },
          "latest"
        ]
      );
      if (!result.ok) return result;
      if (
        typeof result.result !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(result.result)
      ) {
        return {
          ok: false,
          kind: "MALFORMED",
          error: { code: null, message: "eth_call returned malformed data." }
        };
      }
      return { ok: true, result: result.result };
    },

    async estimate(transaction) {
      const result = await raw("eth_estimateGas", [
        {
          from: transaction.from,
          to: transaction.to,
          value: transaction.value,
          data: transaction.data
        }
      ]);
      if (!result.ok) return result;
      const parsed = quantity(result.result, "eth_estimateGas");
      return parsed.ok ? { ok: true, gas: parsed.value } : parsed;
    }
  };
}

function callStatus(result) {
  if (result?.ok) return "SUCCESS";
  if (result?.kind === "REVERT") return "REVERT";
  return "UNKNOWN";
}

function diagnosticResult(observation) {
  return {
    callStatus: callStatus(observation.call),
    call: observation.call,
    estimate: observation.estimate
  };
}

function decodeRevertReason(data) {
  try {
    const decoded = decodeErrorResult({ abi: revertAbi, data });
    if (decoded.errorName === "Error" && typeof decoded.args[0] === "string") {
      return decoded.args[0];
    }
    if (decoded.errorName === "Panic") {
      return `Contract panicked with code ${decoded.args[0]}.`;
    }
  } catch {
    return null;
  }
  return null;
}

export async function simulateBatch(batch, adapter, now = Date.now()) {
  if (
    !batch ||
    !Array.isArray(batch.calls) ||
    batch.calls.length < 3 ||
    batch.calls.length > 12 ||
    batch.chainId !== PHAROS_MAINNET_CHAIN_ID ||
    batch.multicallTarget?.toLowerCase() !==
      DEFAULT_MULTICALL3_ADDRESS.toLowerCase() ||
    batch.transaction?.chainId !== PHAROS_MAINNET_CHAIN_ID ||
    batch.transaction?.to?.toLowerCase() !==
      DEFAULT_MULTICALL3_ADDRESS.toLowerCase() ||
    batch.transaction?.value !== "0x0" ||
    batch.calls.some((call) => call.allowFailure !== true)
  ) {
    throw new SimulationError(
      "Only a verified Pharos Mainnet aggregate3 transaction can be simulated.",
      400
    );
  }

  const chain = await adapter.chainId();
  if (!chain.ok) {
    throw new SimulationError(
      `Could not verify Pharos Mainnet RPC: ${chain.error.message}`
    );
  }
  if (chain.chainId !== PHAROS_MAINNET_CHAIN_ID) {
    throw new SimulationError(
      `RPC chain ID ${chain.chainId} does not match Pharos Mainnet (${PHAROS_MAINNET_CHAIN_ID}).`
    );
  }

  const code = await adapter.code(DEFAULT_MULTICALL3_ADDRESS);
  if (
    !code.ok ||
    !code.verified ||
    code.codeHash?.toLowerCase() !== PHAROS_MAINNET_CODE_HASH
  ) {
    throw new SimulationError(
      "The expected Multicall3 bytecode could not be verified on Pharos Mainnet."
    );
  }

  const targets = [...new Set(batch.calls.map((call) => call.target))];
  const targetCode = await Promise.all(
    targets.map(async (address) => ({ address, result: await adapter.code(address) }))
  );
  const unavailableTarget = targetCode.find((item) => !item.result.ok);
  if (unavailableTarget) {
    throw new SimulationError(
      `Could not verify action target bytecode for ${unavailableTarget.address}.`
    );
  }
  const emptyTarget = targetCode.find((item) => !item.result.verified);
  if (emptyTarget) {
    throw new SimulationError(
      `Action target ${emptyTarget.address} has no deployed contract bytecode.`,
      422
    );
  }

  const block = await adapter.blockNumber();
  const individual = await Promise.all(
    batch.calls.map(async (call) => {
      const transaction = {
        from: batch.transaction.from,
        to: call.target,
        value: "0x0",
        data: call.callData
      };
      const [callResult, estimate] = await Promise.all([
        adapter.call(transaction),
        adapter.estimate(transaction)
      ]);
      return { transaction, call: callResult, estimate };
    })
  );
  const [batchCall, batchEstimate] = await Promise.all([
    adapter.call(batch.transaction),
    adapter.estimate(batch.transaction)
  ]);

  let batchOutcome = "UNKNOWN";
  let decoded = null;
  let decodeError = null;
  if (batchCall.ok) {
    try {
      decoded = summarizeMulticallResults(batch.calls, batchCall.result);
      batchOutcome = "SUCCESS";
    } catch (error) {
      decodeError = error.message;
    }
  } else if (batchCall.kind === "REVERT") {
    batchOutcome = "REVERT";
  }

  const actions = batchOutcome === "SUCCESS"
    ? decoded.results.map((result, index) => ({
        ...result,
        status: result.success ? "SUCCESS" : "REVERT",
        reason: result.success
          ? null
          : decodeRevertReason(result.returnData) ??
            "Subcall reverted; see returnData.",
        diagnostic: diagnosticResult(individual[index])
      }))
    : batch.calls.map((call, index) => ({
        index: index + 1,
        id: call.id,
        description: call.description,
        target: call.target,
        status: "UNKNOWN",
        success: null,
        returnData: null,
        reason:
          decodeError ||
          "Combined simulation did not return a decodable batch result; individual diagnostics are not substituted for batch outcomes.",
        diagnostic: diagnosticResult(individual[index])
      }));

  const successfulIndices = actions
    .map((action, index) => (action.status === "SUCCESS" ? index : -1))
    .filter((index) => index >= 0);
  const hasPartialFailure =
    batchOutcome === "SUCCESS" && successfulIndices.length < batch.calls.length;
  let preparedTransaction = null;
  let preparedBatchOutcome =
    batchOutcome === "SUCCESS" && successfulIndices.length === 0
      ? "NO_SUCCESSFUL_ACTIONS"
      : "UNKNOWN";
  let preparedEstimate = null;

  if (batchOutcome === "SUCCESS" && !hasPartialFailure) {
    preparedTransaction = batch.transaction;
    preparedBatchOutcome = "SUCCESS";
    preparedEstimate = batchEstimate;
  } else if (hasPartialFailure && successfulIndices.length > 0) {
    const preparedCalls = successfulIndices.map((index) => ({
      target: batch.calls[index].target,
      allowFailure: true,
      callData: batch.calls[index].callData
    }));
    const candidateTransaction = {
      ...batch.transaction,
      data: encodeFunctionData({
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [preparedCalls]
      })
    };
    const [preparedCall, estimate] = await Promise.all([
      adapter.call(candidateTransaction),
      adapter.estimate(candidateTransaction)
    ]);

    preparedEstimate = estimate;
    if (preparedCall.ok) {
      try {
        const preparedResults = decodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          data: preparedCall.result
        });
        if (preparedResults.length !== preparedCalls.length) {
          preparedBatchOutcome = "UNKNOWN";
        } else if (preparedResults.every((result) => result.success)) {
          preparedTransaction = candidateTransaction;
          preparedBatchOutcome = "SUCCESS";
        } else {
          preparedBatchOutcome = "PARTIAL_FAILURE";
        }
      } catch {
        preparedBatchOutcome = "UNKNOWN";
      }
    } else if (preparedCall.kind === "REVERT") {
      preparedBatchOutcome = "REVERT";
    }
  }

  const batchEstimateForReport =
    preparedBatchOutcome === "SUCCESS"
      ? preparedEstimate
      : {
          ok: false,
          kind: "UNAVAILABLE",
          error: {
            message:
              "No verified transaction containing only successful actions is available."
          }
        };
  const gasComparison = GasSavingsEstimator.compare(
    successfulIndices.map((index) =>
      individual[index].estimate.ok ? individual[index].estimate.gas : null
    ),
    preparedBatchOutcome === "SUCCESS" && preparedEstimate?.ok
      ? preparedEstimate.gas
      : null
  );
  gasComparison.actionIndices =
    preparedBatchOutcome === "SUCCESS"
      ? successfulIndices.map((index) => index + 1)
      : [];
  gasComparison.unavailableActionIndices = successfulIndices
    .filter((index) => !individual[index].estimate.ok)
    .map((index) => index + 1);
  if (batchOutcome === "SUCCESS" && successfulIndices.length === 0) {
    gasComparison.reason = "No successful actions are available to compare.";
  }

  return {
    network: {
      name: "Pharos Pacific Mainnet",
      chainId: PHAROS_MAINNET_CHAIN_ID,
      rpcUrl: PHAROS_MAINNET_RPC_URL,
      blockTag: "latest",
      blockNumber: block.ok ? block.blockNumber : null,
      blockNumberError: block.ok ? null : block.error,
      observationPinned: false
    },
    contractVerification: {
      address: DEFAULT_MULTICALL3_ADDRESS,
      verified: true,
      codeHash: code.codeHash,
      codeBytes: code.codeBytes
    },
    simulatedAt: new Date(now).toISOString(),
    batchOutcome,
    batchError: batchCall.ok ? null : batchCall.error,
    continuation:
      decoded?.continuation ??
      "The combined call did not produce per-action results; continuation is unknown.",
    batchEstimate: batchEstimateForReport,
    originalBatchEstimate: batchEstimate,
    actions,
    gasComparison,
    preparedActionIndices: preparedTransaction
      ? successfulIndices.map((index) => index + 1)
      : [],
    preparedBatchOutcome,
    executionReduction: {
      individualCalls: batch.callCount,
      batchedCalls: preparedTransaction ? 1 : 0,
      reduction: preparedTransaction ? batch.callCount - 1 : 0
    },
    callerSemantics:
      "Individual diagnostics run directly from the sender; batched subcalls see Multicall3 as msg.sender. The combined simulation is authoritative for batch outcomes.",
    unsignedTransaction: preparedTransaction,
    note:
      "Gas values are RPC estimates, not measured gas used. Read-only simulation only; it does not sign, send, or guarantee a future transaction result."
  };
}
