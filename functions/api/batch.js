import {
  BatchExecutor,
  BatchValidationError,
  DEFAULT_MULTICALL3_ADDRESS,
  MAX_BATCH_ACTIONS,
  PHAROS_MAINNET_CHAIN_ID,
  PHAROS_MAINNET_RPC_URL
} from "../../src/bundler.mjs";
import { createRpcAdapter, SimulationError, simulateBatch } from "../../src/rpc.mjs";

const MAX_REQUEST_BYTES = 512_000;
const RESPONSE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

class RequestBodyTooLargeError extends Error {}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: RESPONSE_HEADERS
  });
}

async function readRequestBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains the relevant response.
        }
        throw new RequestBodyTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function onRequestGet() {
  return jsonResponse({
    ok: true,
    service: "batch-executor",
    network: "Pharos Pacific Mainnet",
    chainId: PHAROS_MAINNET_CHAIN_ID,
    rpcUrl: PHAROS_MAINNET_RPC_URL,
    multicall3Address: DEFAULT_MULTICALL3_ADDRESS,
    minimumActions: 3,
    maximumActions: MAX_BATCH_ACTIONS,
    broadcastsTransactions: false
  });
}

export async function onRequestPost({ request, env = {} }) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      { ok: false, error: "Content-Type must be application/json." },
      415
    );
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return jsonResponse(
        { ok: false, error: "Content-Length must be a non-negative integer." },
        400
      );
    }
    if (Number(contentLength) > MAX_REQUEST_BYTES) {
      return jsonResponse({ ok: false, error: "Request body is too large." }, 413);
    }
  }

  let rawBody;
  try {
    rawBody = await readRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ ok: false, error: "Request body is too large." }, 413);
    }
    return jsonResponse({ ok: false, error: "Could not read request body." }, 400);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ ok: false, error: "Request body must be valid JSON." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: "Request body must be a JSON object." }, 400);
  }

  try {
    if (body.action !== "simulate") {
      throw new BatchValidationError('Action must be "simulate".');
    }
    if (body.independent !== true) {
      throw new BatchValidationError(
        "Confirm that all actions are independent before simulation."
      );
    }
    if (
      body.multicallAddress != null &&
      String(body.multicallAddress).toLowerCase() !==
        DEFAULT_MULTICALL3_ADDRESS.toLowerCase()
    ) {
      throw new BatchValidationError(
        "Only the verified Pharos Mainnet Multicall3 address is supported."
      );
    }
    if (
      body.chainId != null &&
      Number(body.chainId) !== PHAROS_MAINNET_CHAIN_ID
    ) {
      throw new BatchValidationError(
        `Only Pharos Mainnet chain ID ${PHAROS_MAINNET_CHAIN_ID} is supported.`
      );
    }
    if (!Array.isArray(body.actions) || body.actions.length > MAX_BATCH_ACTIONS) {
      throw new BatchValidationError(
        `Provide between 3 and ${MAX_BATCH_ACTIONS} actions.`
      );
    }

    const executor = new BatchExecutor();
    body.actions.forEach((action) => executor.addAction(action));
    const batch = executor.compileBatch(body.from);
    const rpcUrl = env.RPC_URL || PHAROS_MAINNET_RPC_URL;
    const report = await simulateBatch(batch, createRpcAdapter(rpcUrl));
    return jsonResponse({ ok: true, report });
  } catch (error) {
    if (error instanceof BatchValidationError) {
      return jsonResponse({ ok: false, error: error.message }, 400);
    }
    if (error instanceof SimulationError) {
      return jsonResponse({ ok: false, error: error.message }, error.status);
    }

    console.error(
      JSON.stringify({
        event: "batch_simulation_error",
        errorName: error instanceof Error ? error.name : "UnknownError"
      })
    );
    return jsonResponse(
      { ok: false, error: "Could not simulate the batch." },
      500
    );
  }
}
