function parseEstimate(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string" || !/^(?:\d+|0x[0-9a-f]+)$/i.test(value)) {
    return null;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function formatPercent(difference, total) {
  if (total === 0n) return "UNKNOWN";
  const basisPoints = (difference * 10_000n) / total;
  if (basisPoints === 0n && difference !== 0n) {
    return `${difference > 0n ? "+" : "-"}<0.01%`;
  }
  const sign = basisPoints > 0n ? "+" : basisPoints < 0n ? "-" : "";
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}%`;
}

export class GasSavingsEstimator {
  static compare(individualGas, batchGas) {
    if (!Array.isArray(individualGas)) {
      throw new TypeError("Individual gas estimates must be an array.");
    }

    const parsedIndividual = individualGas.map(parseEstimate);
    const parsedBatch = parseEstimate(batchGas);
    const estimates = parsedIndividual.map((value) =>
      value === null ? null : value.toString()
    );
    const batchEstimate = parsedBatch === null ? null : parsedBatch.toString();

    if (parsedBatch === null || parsedIndividual.some((value) => value === null)) {
      return {
        available: false,
        estimated: true,
        basis: "eth_estimateGas",
        individualGas: estimates,
        batchGas: batchEstimate,
        reason:
          "One or more gas estimates are unavailable; unknown gas is never treated as zero."
      };
    }

    const individualGasTotal = parsedIndividual.reduce(
      (total, gas) => total + gas,
      0n
    );
    const difference = individualGasTotal - parsedBatch;

    return {
      available: true,
      estimated: true,
      basis: "eth_estimateGas",
      individualGas: estimates,
      individualGasTotal: individualGasTotal.toString(),
      batchGas: batchEstimate,
      difference: difference.toString(),
      percent: formatPercent(difference, individualGasTotal)
    };
  }
}
