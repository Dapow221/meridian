/**
 * projection.js — "the vision"
 *
 * Estimate a trade's expected profit % BEFORE entry. This is a transparent,
 * bounded heuristic — not a precise model. Every number that goes into the
 * estimate is echoed back in `rationale` so it can be calibrated against real
 * closed-position data (lessons.json performance) over time.
 *
 * Used for two things:
 *   1. The entry gate — skip any trade that can't "see" >= minProjectedProfitPct.
 *   2. Human-readable alert text ("vision ~7% …") on screening + smart-wallet apes.
 */

import { config } from "./config.js";

const HOLD_MINUTES_DEFAULT = 120; // assumed average hold used for the projection

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * @param {object} input
 * @param {number} input.feeTvlRatio   fee / active-TVL ratio (fraction, e.g. 0.05)
 * @param {number} input.volume5m      USD volume in the last 5m
 * @param {number} input.tvl           pool TVL (USD)
 * @param {number} input.activeTvl     active-bin TVL (USD)
 * @param {number} input.mcap          token market cap (USD)
 * @param {boolean} input.narrowBins   volume-burst tight range (concentrates fees)
 * @param {boolean} input.smartWallet  a tracked smart wallet is in this token
 * @param {number} input.holdMinutes   assumed hold window
 */
export function projectTradeProfit(input = {}) {
  const {
    feeTvlRatio,
    volume5m,
    tvl,
    activeTvl,
    mcap,
    narrowBins = false,
    smartWallet = false,
    holdMinutes = HOLD_MINUTES_DEFAULT,
  } = input;

  const tvlUsd = num(activeTvl) || num(tvl) || 0;
  const feeRatioPct = num(feeTvlRatio) * 100; // express ratio as %
  const holdHours = Math.max(0.25, num(holdMinutes) / 60);

  // ── Fee component ────────────────────────────────────────────────────────
  // Concentrating liquidity in narrow bins raises our share of fees; a balanced
  // range spreads it thinner. High recent volume relative to TVL = more swaps
  // through our bins = more fees.
  const concentration = narrowBins ? 1.4 : 0.7;
  const volTurnover = tvlUsd > 0 ? Math.min(3, num(volume5m) / tvlUsd) : 0;
  let projectedFeePct =
    feeRatioPct * concentration * (0.5 + volTurnover) * Math.min(2, holdHours);
  projectedFeePct = Math.max(0, Math.min(20, projectedFeePct));

  // ── Upside component ─────────────────────────────────────────────────────
  // We do not predict price. Use conservative, bounded momentum proxies: a
  // smart-wallet buy signals conviction; a volume burst signals a move underway;
  // a smaller mcap has more room to run. Clearly an estimate.
  let projectedUpsidePct = 0;
  if (smartWallet) projectedUpsidePct += 5;
  if (narrowBins) projectedUpsidePct += 3; // riding a volume burst
  if (num(mcap) > 0 && mcap < 500_000) projectedUpsidePct += 3; // micro-cap room
  projectedUpsidePct = Math.min(25, projectedUpsidePct);

  const projectedTotalPct = Number((projectedFeePct + projectedUpsidePct).toFixed(2));

  const rationale =
    `vision ~${projectedTotalPct}% (fees ~${projectedFeePct.toFixed(1)}% + ` +
    `upside ~${projectedUpsidePct.toFixed(1)}%) | feeTvl ${feeRatioPct.toFixed(2)}% ` +
    `× conc ${concentration} × turnover ${(0.5 + volTurnover).toFixed(2)} ` +
    `× ${Math.min(2, holdHours).toFixed(1)}h` +
    (smartWallet ? " | smart-wallet" : "") +
    (narrowBins ? " | vol-burst" : "");

  return {
    projectedFeePct: Number(projectedFeePct.toFixed(2)),
    projectedUpsidePct: Number(projectedUpsidePct.toFixed(2)),
    projectedTotalPct,
    rationale,
  };
}

/**
 * Entry gate: does the projected profit clear the configured floor?
 * Returns { pass, floor, projectedTotalPct, ... }.
 */
export function passesProfitGate(input = {}) {
  const floor = config.semiDegen?.minProjectedProfitPct ?? 4;
  const projection = projectTradeProfit(input);
  return {
    pass: projection.projectedTotalPct >= floor,
    floor,
    ...projection,
  };
}
