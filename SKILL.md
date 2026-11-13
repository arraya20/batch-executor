# Skill: batch-executor

**Target platform:** Pharos Agent Arena / Pharos Pacific Mainnet
**Network:** Chain ID `1672`
**Multicall3:** `0xcA11bde05977b3631167028862bE2a173976CA11`

## Purpose

Run a read-only preflight for at least three independent, zero-value contract
calls and prepare an unsigned Multicall3 `aggregate3` transaction. The tool
never connects a wallet, signs, or broadcasts.

## Invocation

Send `POST /api/batch` with `action: "simulate"`:

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
      "description": "Read sender balance"
    }
  ]
}
```

## Behavior

- Verifies the RPC chain ID and the pinned Multicall3 runtime bytecode hash.
- Rejects batches outside 3-12 actions, malformed targets/calldata, targets
  without deployed code, nonzero per-action values, or missing independence
  confirmation.
- Simulates each action and the combined transaction with `eth_call`; estimates
  gas for both paths with `eth_estimateGas`.
- Uses `allowFailure: true` and maps decoded batch results to each action. If
  the combined call fails or cannot be decoded, action outcomes remain
  `UNKNOWN`; individual diagnostics are not substituted.
- Reports signed gas difference and action-call reduction (`N -> 1`). Missing
  gas estimates remain unknown, not zero.
- Includes unsigned transaction data only after the combined simulation
  succeeds. The sender is simulation context only and does not prove ownership.

Batched subcalls see Multicall3 as `msg.sender`, unlike direct individual-call
diagnostics. Simulation uses latest state and is not a guarantee of later
execution. Native transfers and transaction broadcasting are not supported.
