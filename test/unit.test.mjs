import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256
} from "viem";
import { test, run, assert, equal, throws } from "./harness.mjs";
import {
  BatchExecutor,
  MAX_BATCH_ACTIONS,
  PHAROS_MAINNET_CHAIN_ID,
  PHAROS_MAINNET_CODE_HASH,
  multicall3Abi
} from "../src/bundler.mjs";
import { GasSavingsEstimator } from "../src/gas.mjs";
import { onRequestPost } from "../functions/api/batch.js";

const sampleActions = [
  {
    target: "0x1111111111111111111111111111111111111111",
    data: "0x095ea7b3",
    description: "Approve token"
  },
  {
    target: "0x2222222222222222222222222222222222222222",
    data: "0xa9059cbb",
    description: "Transfer token"
  },
  {
    target: "0x3333333333333333333333333333333333333333",
    data: "0x12345678",
    description: "Claim reward"
  }
];

const sender = "0x4444444444444444444444444444444444444444";

function createBatch() {
  const executor = new BatchExecutor();
  sampleActions.forEach((action) => executor.addAction(action));
  return executor.compileBatch(sender);
}

const unitTests = [
  test("BatchExecutor creates a mainnet aggregate3 transaction for three actions", () => {
    const batch = createBatch();
    const decoded = decodeFunctionData({
      abi: multicall3Abi,
      data: batch.transaction.data
    });

    equal(MAX_BATCH_ACTIONS, 12);
    equal(batch.chainId, PHAROS_MAINNET_CHAIN_ID);
    equal(batch.transaction.chainId, 1672);
    equal(batch.transaction.from, sender);
    equal(batch.transaction.to, "0xcA11bde05977b3631167028862bE2a173976CA11");
    equal(batch.transaction.value, "0x0");
    equal(decoded.functionName, "aggregate3");
    equal(decoded.args[0].length, 3);
    assert(decoded.args[0].every((call) => call.allowFailure));
  }),

  test("BatchExecutor rejects fewer than three actions and invalid senders", () => {
    const executor = new BatchExecutor();
    executor.addAction(sampleActions[0]);
    executor.addAction(sampleActions[1]);
    throws(() => executor.compileBatch(sender), "at least 3");
    throws(() => createBatchWithSender("not-an-address"), "sender");
  }),

  test("BatchExecutor rejects Multicall addresses other than the verified mainnet contract", () => {
    throws(
      () => new BatchExecutor("0x1111111111111111111111111111111111111111"),
      "verified"
    );
  }),

  test("BatchExecutor rejects per-action native value", () => {
    const executor = new BatchExecutor();
    throws(
      () => executor.addAction({ ...sampleActions[0], value: "1" }),
      "cannot forward"
    );
  }),

  test("GasSavingsEstimator compares actual estimates and preserves negative savings", () => {
    const saved = GasSavingsEstimator.compare(
      ["30000", "40000", "50000"],
      "90000"
    );
    equal(saved.individualGasTotal, "120000");
    equal(saved.difference, "30000");
    equal(saved.percent, "+25.00%");

    const extraCost = GasSavingsEstimator.compare(
      ["21000", "21000", "21000"],
      "101286"
    );
    equal(extraCost.difference, "-38286");
    equal(extraCost.percent, "-60.77%");
  }),

  test("GasSavingsEstimator marks missing RPC estimates unavailable instead of zero", () => {
    const report = GasSavingsEstimator.compare(
      ["30000", null, "50000"],
      "90000"
    );
    equal(report.available, false);
    assert(report.reason.includes("unknown gas"));
  }),

  test("GasSavingsEstimator preserves the direction of sub-cent differences", () => {
    const report = GasSavingsEstimator.compare(
      ["300000", "300000"],
      "600010"
    );

    equal(report.difference, "-10");
    equal(report.percent, "-<0.01%");
  }),

  test("Multicall result summary identifies failed calls and continued calls", async () => {
    const { summarizeMulticallResults } = await import("../src/bundler.mjs");
    const summary = summarizeMulticallResults(sampleActions, [
      { success: true, returnData: "0x" },
      { success: false, returnData: "0xdeadbeef" },
      { success: true, returnData: "0x" }
    ]);

    equal(summary.failedCount, 1);
    equal(summary.results[1].description, "Transfer token");
    equal(summary.results[1].target, sampleActions[1].target);
    equal(summary.results[1].status, "failed");
    equal(summary.results[2].status, "succeeded");
    equal(summary.continuation, "Other calls continued independently.");
  }),

  test("Mainnet simulation verifies contract and reports actual call and gas results", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    const batch = createBatch();
    const revertData = encodeErrorResult({
      abi: [
        {
          type: "error",
          name: "Error",
          inputs: [{ name: "message", type: "string" }]
        }
      ],
      errorName: "Error",
      args: ["Insufficient balance"]
    });
    const batchResult = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x" },
        { success: false, returnData: revertData },
        { success: true, returnData: "0x" }
      ]
    });
    const estimates = new Map([
      [sampleActions[0].target, "30000"],
      [sampleActions[1].target, "40000"],
      [sampleActions[2].target, "50000"]
    ]);
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 1672 }),
      blockNumber: async () => ({ ok: true, blockNumber: "12345" }),
      code: async () => ({
        ok: true,
        verified: true,
        codeHash: PHAROS_MAINNET_CODE_HASH,
        codeBytes: 3808
      }),
      call: async (transaction) => {
        if (transaction.to !== batch.transaction.to) {
          return { ok: true, result: "0x" };
        }
        const { args } = decodeFunctionData({
          abi: multicall3Abi,
          data: transaction.data
        });
        return {
          ok: true,
          result:
            args[0].length === 3
              ? batchResult
              : encodeFunctionResult({
                  abi: multicall3Abi,
                  functionName: "aggregate3",
                  result: [
                    { success: true, returnData: "0x" },
                    { success: true, returnData: "0x" }
                  ]
                })
        };
      },
      estimate: async (transaction) => {
        if (transaction.to !== batch.transaction.to) {
          return { ok: true, gas: estimates.get(transaction.to) };
        }
        const { args } = decodeFunctionData({
          abi: multicall3Abi,
          data: transaction.data
        });
        return { ok: true, gas: args[0].length === 3 ? "90000" : "60000" };
      }
    };

    const report = await simulateBatch(batch, adapter, 123456);

    equal(report.network.chainId, 1672);
    equal(report.network.blockNumber, "12345");
    equal(report.contractVerification.verified, true);
    equal(report.batchOutcome, "SUCCESS");
    equal(report.actions[1].status, "REVERT");
    equal(report.actions[1].target, sampleActions[1].target);
    equal(report.actions[1].reason, "Insufficient balance");
    equal(report.actions[2].status, "SUCCESS");
    equal(report.continuation, "Other calls continued independently.");
    equal(report.gasComparison.difference, "20000");
    equal(report.executionReduction.reduction, 2);
    equal(report.unsignedTransaction.from, sender);
    equal(report.gasComparison.basis, "eth_estimateGas");
    equal(report.gasComparison.estimated, true);
  }),

  test("Mainnet simulation prepares and estimates only successful subcalls", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    const batch = createBatch();
    const failedResult = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x" },
        { success: false, returnData: "0xdeadbeef" },
        { success: true, returnData: "0x" }
      ]
    });
    const successfulSubsetResult = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x" },
        { success: true, returnData: "0x" }
      ]
    });
    let preparedBatchFails = false;
    let preparedSubsetHasFailure = false;
    let allActionsFail = false;
    let successfulIndividualEstimatesUnavailable = false;
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 1672 }),
      blockNumber: async () => ({ ok: true, blockNumber: "12345" }),
      code: async () => ({
        ok: true,
        verified: true,
        codeHash: PHAROS_MAINNET_CODE_HASH,
        codeBytes: 3808
      }),
      call: async (transaction) => {
        if (transaction.to !== batch.transaction.to) {
          return transaction.to === sampleActions[1].target
            ? {
                ok: false,
                kind: "REVERT",
                error: { message: "execution reverted", data: "0xdeadbeef" }
              }
            : { ok: true, result: "0x" };
        }

        const { args } = decodeFunctionData({
          abi: multicall3Abi,
          data: transaction.data
        });
        if (args[0].length === 2 && preparedBatchFails) {
          return {
            ok: false,
            kind: "REVERT",
            error: { message: "execution reverted", data: "0xdeadbeef" }
          };
        }
        if (args[0].length === 2 && preparedSubsetHasFailure) {
          return {
            ok: true,
            result: encodeFunctionResult({
              abi: multicall3Abi,
              functionName: "aggregate3",
              result: [
                { success: true, returnData: "0x" },
                { success: false, returnData: "0xdeadbeef" }
              ]
            })
          };
        }
        if (args[0].length === 3 && allActionsFail) {
          return {
            ok: true,
            result: encodeFunctionResult({
              abi: multicall3Abi,
              functionName: "aggregate3",
              result: args[0].map(() => ({
                success: false,
                returnData: "0xdeadbeef"
              }))
            })
          };
        }
        return {
          ok: true,
          result: args[0].length === 3 ? failedResult : successfulSubsetResult
        };
      },
      estimate: async (transaction) => {
        if (transaction.to !== batch.transaction.to) {
          if (
            transaction.to !== sampleActions[1].target &&
            successfulIndividualEstimatesUnavailable
          ) {
            return {
              ok: false,
              kind: "TRANSPORT",
              error: { message: "RPC returned HTTP 429." }
            };
          }
          return transaction.to === sampleActions[1].target
            ? {
                ok: false,
                kind: "REVERT",
                error: { message: "execution reverted", data: "0xdeadbeef" }
              }
            : { ok: true, gas: "30000" };
        }
        const { args } = decodeFunctionData({
          abi: multicall3Abi,
          data: transaction.data
        });
        return { ok: true, gas: args[0].length === 3 ? "100000" : "70000" };
      }
    };

    const report = await simulateBatch(batch, adapter, 123456);
    const preparedCall = decodeFunctionData({
      abi: multicall3Abi,
      data: report.unsignedTransaction.data
    });

    equal(report.actions[1].status, "REVERT");
    equal(preparedCall.args[0].length, 2);
    equal(preparedCall.args[0][0].target, sampleActions[0].target);
    equal(preparedCall.args[0][1].target, sampleActions[2].target);
    equal(report.preparedActionIndices.join(","), "1,3");
    equal(report.gasComparison.individualGasTotal, "60000");
    equal(report.gasComparison.batchGas, "70000");
    equal(report.gasComparison.available, true);
    equal(report.batchEstimate.gas, "70000");
    equal(report.originalBatchEstimate.gas, "100000");

    preparedBatchFails = true;
    const unsafeReport = await simulateBatch(batch, adapter, 123456);
    equal(unsafeReport.preparedBatchOutcome, "REVERT");
    equal(unsafeReport.unsignedTransaction, null);

    preparedBatchFails = false;
    successfulIndividualEstimatesUnavailable = true;
    const unavailableEstimateReport = await simulateBatch(batch, adapter, 123456);
    equal(unavailableEstimateReport.gasComparison.available, false);
    equal(
      unavailableEstimateReport.gasComparison.unavailableActionIndices.join(","),
      "1,3"
    );
    assert(unavailableEstimateReport.unsignedTransaction);

    successfulIndividualEstimatesUnavailable = false;
    preparedBatchFails = false;
    preparedSubsetHasFailure = true;
    const stillPartialReport = await simulateBatch(batch, adapter, 123456);
    equal(stillPartialReport.preparedBatchOutcome, "PARTIAL_FAILURE");
    equal(stillPartialReport.unsignedTransaction, null);

    preparedSubsetHasFailure = false;
    allActionsFail = true;
    const noSuccessfulCallsReport = await simulateBatch(batch, adapter, 123456);
    equal(noSuccessfulCallsReport.preparedBatchOutcome, "NO_SUCCESSFUL_ACTIONS");
    equal(noSuccessfulCallsReport.unsignedTransaction, null);
  }),

  test("Mainnet simulation fails closed when the RPC reports another chain", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    let codeChecks = 0;
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 50002 }),
      code: async () => {
        codeChecks++;
        return { ok: true, codeHash: PHAROS_MAINNET_CODE_HASH, codeBytes: 3808 };
      }
    };

    let message = "";
    try {
      await simulateBatch(createBatch(), adapter);
    } catch (error) {
      message = error.message;
    }

    assert(message.includes("1672"));
    equal(codeChecks, 0);
  }),

  test("Mainnet simulation fails closed when Multicall3 bytecode hash differs", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 1672 }),
      code: async () => ({
        ok: true,
        verified: true,
        codeHash: `0x${"0".repeat(64)}`,
        codeBytes: 3808
      })
    };

    let message = "";
    try {
      await simulateBatch(createBatch(), adapter);
    } catch (error) {
      message = error.message;
    }

    assert(message.includes("bytecode could not be verified"));
  }),

  test("Mainnet simulation rejects action targets without deployed code", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 1672 }),
      code: async (address) =>
        address.toLowerCase() ===
        "0xca11bde05977b3631167028862be2a173976ca11"
          ? {
              ok: true,
              verified: true,
              codeHash: PHAROS_MAINNET_CODE_HASH,
              codeBytes: 3808
            }
          : { ok: true, verified: false, codeBytes: 0 }
    };

    let status;
    let message = "";
    try {
      await simulateBatch(createBatch(), adapter);
    } catch (error) {
      status = error.status;
      message = error.message;
    }

    equal(status, 422);
    assert(message.includes("no deployed contract bytecode"));
  }),

  test("Mainnet batch revert does not infer individual batch outcomes", async () => {
    const { simulateBatch } = await import("../src/rpc.mjs");
    const batch = createBatch();
    const adapter = {
      chainId: async () => ({ ok: true, chainId: 1672 }),
      blockNumber: async () => ({ ok: true, blockNumber: "12345" }),
      code: async () => ({
        ok: true,
        verified: true,
        codeHash: PHAROS_MAINNET_CODE_HASH,
        codeBytes: 3808
      }),
      call: async (transaction) =>
        transaction.to === batch.transaction.to
          ? {
              ok: false,
              kind: "REVERT",
              error: { message: "execution reverted", data: "0xdeadbeef" }
            }
          : { ok: true, result: "0x" },
      estimate: async () => ({ ok: true, gas: "30000" })
    };

    const report = await simulateBatch(batch, adapter);

    equal(report.batchOutcome, "REVERT");
    assert(report.actions.every((action) => action.status === "UNKNOWN"));
    equal(report.actions[0].target, sampleActions[0].target);
    assert(report.actions.every((action) => action.diagnostic.call.ok));
    equal(
      report.continuation,
      "The combined call did not produce per-action results; continuation is unknown."
    );
    assert(report.gasComparison.reason.includes("unknown gas"));
    equal(report.unsignedTransaction, null);
  }),

  test("RPC adapter parses mainnet JSON-RPC responses", async () => {
    const { createRpcAdapter } = await import("../src/rpc.mjs");
    const methods = [];
    const adapter = createRpcAdapter(
      "https://rpc.example.test",
      async (_url, init) => {
        const request = JSON.parse(init.body);
        methods.push(request.method);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x688" }),
          { status: 200 }
        );
      }
    );

    const result = await adapter.chainId();

    equal(result.chainId, 1672);
    equal(methods[0], "eth_chainId");
  }),

  test("RPC adapter retries a rate-limited request", async () => {
    const { createRpcAdapter } = await import("../src/rpc.mjs");
    let attempts = 0;
    const adapter = createRpcAdapter(
      "https://rpc.example.test",
      async (_url, init) => {
        attempts++;
        if (attempts === 1) {
          return new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "0" }
          });
        }

        const request = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x688" }),
          { status: 200 }
        );
      }
    );

    const result = await adapter.chainId();

    equal(result.chainId, 1672);
    equal(attempts, 2);
  }),

  test("RPC adapter limits concurrent upstream requests", async () => {
    const { createRpcAdapter } = await import("../src/rpc.mjs");
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    const adapter = createRpcAdapter(
      "https://rpc.example.test",
      async (_url, init) => {
        activeRequests++;
        maximumConcurrentRequests = Math.max(
          maximumConcurrentRequests,
          activeRequests
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests--;
        const request = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x688" }),
          { status: 200 }
        );
      }
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => adapter.chainId())
    );

    assert(results.every((result) => result.ok));
    assert(maximumConcurrentRequests > 1);
    assert(maximumConcurrentRequests <= 4);
  }),

  test("RPC adapter hashes deployed bytecode before contract verification", async () => {
    const { createRpcAdapter } = await import("../src/rpc.mjs");
    const bytecode = "0x60006000fd";
    const adapter = createRpcAdapter(
      "https://rpc.example.test",
      async (_url, init) => {
        const request = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: bytecode }),
          { status: 200 }
        );
      }
    );

    const result = await adapter.code(sender);

    equal(result.codeBytes, 5);
    equal(result.codeHash, keccak256(bytecode));
    equal(result.verified, true);
  }),

  test("Batch API returns a gateway error when its RPC is on the wrong chain", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: "0xc352"
        }),
        { status: 200 }
      );
    };

    try {
      const response = await onRequestPost({
        request: new Request("https://example.test/api/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "simulate",
            independent: true,
            from: sender,
            chainId: 1672,
            actions: sampleActions
          })
        }),
        env: { RPC_URL: "https://rpc.example.test" }
      });
      const payload = await response.json();

      equal(response.status, 502);
      assert(payload.error.includes("1672"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),

  test("Batch API requires an explicit independence confirmation", async () => {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "simulate",
          independent: false,
          from: sender,
          actions: sampleActions
        })
      })
    });
    const payload = await response.json();

    equal(response.status, 400);
    assert(payload.error.includes("independent"));
  }),

  test("Batch API enforces the request byte cap without Content-Length", async () => {
    const body = JSON.stringify({
      action: "simulate",
      chainId: 50002,
      from: sender,
      independent: true,
      actions: [],
      padding: "x".repeat(600_000)
    });
    const request = new Request("https://example.test/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });

    equal(request.headers.get("Content-Length"), null);
    const response = await onRequestPost({ request });

    equal(response.status, 413);
  }),

  test("BatchExecutor rejects empty and undersized batches", () => {
    throws(() => new BatchExecutor().compileBatch(sender), "at least 3");
  })
];

function createBatchWithSender(from) {
  const executor = new BatchExecutor();
  sampleActions.forEach((action) => executor.addAction(action));
  return executor.compileBatch(from);
}

run(unitTests);
