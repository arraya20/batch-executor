import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress
} from "viem";

export const DEFAULT_MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const PHAROS_MAINNET_CHAIN_ID = 1672;
export const PHAROS_MAINNET_RPC_URL = "https://rpc.pharos.xyz";
export const PHAROS_MAINNET_CODE_HASH =
  "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
export const MAX_BATCH_ACTIONS = 12;
export const MAX_CALLDATA_BYTES = 16_384;

export const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" }
        ]
      }
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" }
        ]
      }
    ]
  }
];

export class BatchValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BatchValidationError";
  }
}

function normalizeAddress(value, fieldName) {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new BatchValidationError(`${fieldName} must be a valid EVM address.`);
  }

  return getAddress(value);
}

function normalizeValue(value) {
  if (value === undefined || value === null) return "0";

  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value === 0) return "0";
    throw new BatchValidationError("Action value must be zero.");
  }

  if (typeof value === "bigint") {
    if (value === 0n) return "0";
    throw new BatchValidationError(
      "Multicall3 aggregate3 cannot forward per-action native value."
    );
  }

  if (typeof value === "string") {
    if (/^(?:0+|0x0+)$/i.test(value)) return "0";
    if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(value)) {
      throw new BatchValidationError("Action value must be zero.");
    }
  } else {
    throw new BatchValidationError("Action value must be zero.");
  }

  throw new BatchValidationError(
    "Multicall3 aggregate3 cannot forward per-action native value."
  );
}

function normalizeAction(action, index) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new BatchValidationError(`Action ${index + 1} must be an object.`);
  }

  const target = normalizeAddress(action.target, `Action ${index + 1} target`);
  if (
    typeof action.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(action.data) ||
    action.data.length > 2 + MAX_CALLDATA_BYTES * 2
  ) {
    throw new BatchValidationError(
      `Action ${index + 1} data must be valid hex calldata under ${MAX_CALLDATA_BYTES / 1024} KB.`
    );
  }

  const description = action.description ?? `Action ${index + 1}`;
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > 120
  ) {
    throw new BatchValidationError(
      `Action ${index + 1} description must contain 1 to 120 characters.`
    );
  }

  return {
    id: `act_${index + 1}`,
    target,
    data: action.data,
    value: normalizeValue(action.value),
    description: description.trim()
  };
}

export class BatchExecutor {
  constructor(multicallAddress = DEFAULT_MULTICALL3_ADDRESS) {
    this.multicallAddress = normalizeAddress(
      multicallAddress,
      "Multicall3 address"
    );
    if (
      this.multicallAddress.toLowerCase() !==
      DEFAULT_MULTICALL3_ADDRESS.toLowerCase()
    ) {
      throw new BatchValidationError(
        "Only the verified Pharos Mainnet Multicall3 address is supported."
      );
    }
    this.queue = [];
  }

  addAction(action) {
    if (this.queue.length >= MAX_BATCH_ACTIONS) {
      throw new BatchValidationError(
        `A batch can contain at most ${MAX_BATCH_ACTIONS} actions.`
      );
    }

    const item = normalizeAction(action, this.queue.length);
    this.queue.push(item);
    return item;
  }

  clearQueue() {
    this.queue = [];
  }

  compileBatch(from) {
    if (this.queue.length < 3) {
      throw new BatchValidationError(
        "A batch must contain at least 3 independent actions."
      );
    }

    const sender = normalizeAddress(from, "Transaction sender");
    const calls = this.queue.map((action) => ({
      target: action.target,
      allowFailure: true,
      callData: action.data
    }));
    const actionCalls = this.queue.map((action) => ({
      ...action,
      allowFailure: true,
      callData: action.data
    }));
    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls]
    });

    return {
      multicallTarget: this.multicallAddress,
      chainId: PHAROS_MAINNET_CHAIN_ID,
      callCount: calls.length,
      calls: actionCalls,
      transaction: {
        from: sender,
        to: this.multicallAddress,
        data,
        value: "0x0",
        chainId: PHAROS_MAINNET_CHAIN_ID
      },
      failurePolicy: {
        allowFailure: true,
        description:
          "Each call is attempted independently; a failed call does not revert the other calls."
      },
      timestamp: Date.now()
    };
  }
}

export function summarizeMulticallResults(actions, resultData) {
  if (!Array.isArray(actions) || actions.length < 3) {
    throw new BatchValidationError(
      "Result reporting requires at least 3 batch actions."
    );
  }

  if (actions.length > MAX_BATCH_ACTIONS) {
    throw new BatchValidationError(
      `A batch can contain at most ${MAX_BATCH_ACTIONS} actions.`
    );
  }

  let decodedResults = resultData;
  if (typeof resultData === "string") {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(resultData)) {
      throw new BatchValidationError(
        "Encoded Multicall3 results must be a non-empty hex string."
      );
    }

    try {
      decodedResults = decodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        data: resultData
      });
    } catch {
      throw new BatchValidationError(
        "Could not decode the supplied Multicall3 result data."
      );
    }
  }

  if (!Array.isArray(decodedResults) || decodedResults.length !== actions.length) {
    throw new BatchValidationError(
      "The result count must match the number of batch actions."
    );
  }

  const results = decodedResults.map((result, index) => {
    if (
      !result ||
      typeof result.success !== "boolean" ||
      typeof result.returnData !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(result.returnData) ||
      result.returnData.length > 65_538
    ) {
      throw new BatchValidationError(
        `Result ${index + 1} must include a success flag and valid return data.`
      );
    }

    const action = actions[index];
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new BatchValidationError(`Action ${index + 1} is invalid.`);
    }

    return {
      index: index + 1,
      id: typeof action.id === "string" ? action.id : `act_${index + 1}`,
      description:
        typeof action.description === "string"
          ? action.description
          : `Action ${index + 1}`,
      target: typeof action.target === "string" ? action.target : null,
      status: result.success ? "succeeded" : "failed",
      success: result.success,
      returnData: result.returnData
    };
  });

  const failedCount = results.filter((result) => !result.success).length;
  const succeededCount = results.length - failedCount;

  return {
    callCount: results.length,
    succeededCount,
    failedCount,
    results,
    continuation:
      failedCount > 0
        ? "Other calls continued independently."
        : "All calls succeeded.",
    note:
      "These are per-call results, not proof that a transaction was mined."
  };
}
