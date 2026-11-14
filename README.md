# Pharos Mainnet Batch Executor

Run a read-only preflight for a batch of at least three independent contract
calls, then inspect the unsigned Multicall3 transaction. The app does not connect
to a wallet, sign, or broadcast transactions.

## Network

- Pharos Pacific Mainnet, chain ID `1672`
- RPC: `https://rpc.pharos.xyz`
- Multicall3: `0xcA11bde05977b3631167028862bE2a173976CA11`
- Expected Multicall3 runtime code hash:
  `0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891`

The RPC must report the expected chain ID and matching Multicall3 bytecode.
Action targets must also have deployed bytecode. The sender is only used as
simulation context; it does not prove account ownership.

## Run locally

```bash
npm ci
npm test
npm run dev
```

Set `RPC_URL` in the local Worker environment only when using a trusted,
mainnet-compatible RPC. The request cannot choose an RPC endpoint.

## Deploy with Cloudflare Pages

Configure the Pages project with the repository root as the root directory,
`npm run build` as the build command, and `public` as the build output
directory. The build command installs locked production dependencies, including
`viem`, which Cloudflare needs when bundling the Pages Functions. Leaving the
build command blank skips dependency installation and causes Functions bundling
to fail to resolve `viem`.

## Simulation

`POST /api/batch` accepts `action: "simulate"`, a sender address, an explicit
`independent: true` acknowledgement, and 3-12 actions:

```json
{
  "action": "simulate",
  "chainId": 1672,
  "from": "0x4444444444444444444444444444444444444444",
  "independent": true,
  "actions": [
    {
      "target": "0xcA11bde05977b3631167028862bE2a173976CA11",
      "data": "0x3408e470",
      "description": "Read Pharos chain ID"
    },
    {
      "target": "0xcA11bde05977b3631167028862bE2a173976CA11",
      "data": "0x42cbb15c",
      "description": "Read current block number"
    },
    {
      "target": "0xcA11bde05977b3631167028862bE2a173976CA11",
      "data": "0x4d2301cc0000000000000000000000004444444444444444444444444444444444444444",
      "description": "Read sample sender balance"
    }
  ]
}
```

The API verifies the chain and Multicall3 code, then calls `eth_call` and
`eth_estimateGas` for each action and the combined transaction at the latest
block. Calls use `allowFailure: true`; decoded results identify each successful
or reverted subcall and state that other calls continued. If the combined call
reverts or cannot be decoded, per-action outcomes are reported as `UNKNOWN`;
individual-call diagnostics are not treated as batch results.
For failed subcalls, standard `Error(string)` and `Panic(uint256)` revert data
is decoded when available; other errors retain their raw return data.

If some subcalls fail but the combined call returns results, the app removes
failed actions, simulates the remaining calls again, and only prepares an
unsigned transaction if that reduced batch succeeds. The report lists the
original per-action results, the indices included in the prepared transaction,
and the original and prepared batch estimates. If no reduced batch can be
verified, no transaction is included.

Gas comparisons are **estimates** from `eth_estimateGas`, not measured gas
consumption. When a partial failure occurs, the comparison includes only
successful actions and the estimate for the re-simulated reduced batch. A
positive signed difference means the batched estimate is lower; a negative
difference means it is higher. Missing estimates remain unknown rather than
being treated as zero; the report identifies action indices whose individual
estimates were unavailable. A nonzero difference smaller than 0.01% is
displayed as `+<0.01%` or `-<0.01%` so its direction is not lost to rounding.
The report also shows the action-call reduction (`N -> 1`). Individual
diagnostics run directly from the sender, while batched subcalls see Multicall3
as `msg.sender`, so their execution contexts are not identical.

Simulation is against current state and may differ by the time a transaction is
manually submitted. The demo supports zero-value `aggregate3` calls only;
native transfers and per-action value forwarding are not supported.
The UI includes a partial-failure example that replaces the action list with two
read calls and one intentional unknown-selector failure.

## Before public deployment

The API enforces the request-body limit while streaming and bounds concurrent
RPC requests, retrying short-lived upstream `429` and `5xx` responses. These
per-request safeguards do not limit repeated requests from the same visitor.
Configure an edge rate limit for `POST /api/batch` when deploying publicly, and
use a trusted RPC endpoint with a quota suitable for the expected traffic.

Do not use ordinary sender-owned token transfers or claims that depend on
`msg.sender` without confirming their Multicall3 semantics first. Batched
subcalls observe Multicall3 as `msg.sender`.

## Task

[Batch Executor](https://pharos-agent-arena.vercel.app/tasks/batch-executor)
