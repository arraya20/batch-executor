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

Gas comparison uses RPC estimates. A positive signed difference means the batch
estimate is lower; a negative difference means batching costs more gas. Missing
estimates remain unknown rather than being treated as zero. The report also
shows the action-call reduction (`N -> 1`); for state-changing actions, these
can correspond to fewer transaction submissions. Individual calls run directly
from the sender, while batched subcalls see Multicall3 as `msg.sender`; the
combined simulation is authoritative for batch outcomes. An unsigned
transaction is included only when the combined simulation succeeds.

Simulation is against current state and may differ by the time a transaction is
manually submitted. The demo supports zero-value `aggregate3` calls only;
native transfers and per-action value forwarding are not supported.

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
