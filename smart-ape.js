/**
 * smart-ape.js
 *
 * Telegram confirm flow for smart-wallet apes. When the watcher detects a
 * tracked wallet buying a token (mcap-checked + projected), this sends you an
 * "Ape / Skip" message. On ✅ Ape it opens a TOKEN-ONLY RIDE position so you
 * capture the upside.
 *
 * In DRY_RUN (and on this simulator branch) the ride is executed as a paper
 * position (paper-positions.js) tracked on real market data — no funds touched.
 * A live token-side deploy (swap SOL→token, then single-sided token deposit)
 * is the remaining money-path step and is intentionally NOT executed here.
 */

import { sendMessageWithButtons, editMessage, answerCallbackQuery } from "./telegram.js";
import { openPaperPosition } from "./paper-positions.js";
import { config, computeDeployAmount } from "./config.js";
import { getWalletBalances } from "./tools/wallet.js";
import { log } from "./logger.js";

const DATAPI = "https://dlmm.datapi.meteora.ag";
const PENDING_TTL_MS = 60 * 60 * 1000; // signals expire after 1h

const _pending = new Map();
let _seq = 0;

function fmtUsd(n) {
  return n != null && Number.isFinite(Number(n))
    ? `$${Math.round(Number(n)).toLocaleString()}`
    : "unknown";
}

function prune() {
  const now = Date.now();
  for (const [k, v] of _pending) if (now - v.ts > PENDING_TTL_MS) _pending.delete(k);
}

/** Watcher callback: present an Ape/Skip confirm with the profit vision. */
export async function onSmartWalletSignal({ wallet, mint, pool, detail, projection, solSpent }) {
  prune();
  const id = String(++_seq);
  _pending.set(id, { wallet, mint, pool, detail, projection, ts: Date.now() });

  const name = detail?.name || pool?.name || mint.slice(0, 8);
  const buyStr = solSpent != null ? ` (${Number(solSpent).toFixed(1)} SOL)` : "";
  const text =
    `🐋 Smart-wallet ape\n` +
    `${wallet.name} just bought ${name}${buyStr}\n` +
    `mcap: ${fmtUsd(detail?.mcap)}\n` +
    `${projection.rationale}\n\n` +
    `Deploy token-only ride? (paper-sim in dry-run)`;

  await sendMessageWithButtons(text, [[
    { text: "✅ Ape", callback_data: `ape:${id}` },
    { text: "❌ Skip", callback_data: `skip:${id}` },
  ]]);
  log("smart_ape", `Confirm sent: ${wallet.name} → ${name} (id ${id})`);
}

/** Telegram callback handler for ape:<id> / skip:<id>. */
export async function handleApeCallback(msg) {
  const [action, id] = String(msg.callbackData || msg.text || "").split(":");
  const sig = _pending.get(id);
  if (!sig) {
    await answerCallbackQuery(msg.callbackQueryId, "Expired").catch(() => {});
    await editMessage("⌛ Signal expired.", msg.messageId).catch(() => {});
    return;
  }
  const name = sig.detail?.name || sig.pool?.name || sig.mint.slice(0, 8);

  if (action === "skip") {
    _pending.delete(id);
    await answerCallbackQuery(msg.callbackQueryId, "Skipped").catch(() => {});
    await editMessage(`❌ Skipped ${name}.`, msg.messageId).catch(() => {});
    return;
  }

  // ── Ape ────────────────────────────────────────────────────────────────
  _pending.delete(id);
  await answerCallbackQuery(msg.callbackQueryId, "Aping…").catch(() => {});
  try {
    const res = await fetch(`${DATAPI}/pools/${sig.pool.pool}`);
    const d = await res.json();
    const price = Number(d?.current_price ?? d?.data?.current_price ?? 0);
    if (!price) throw new Error("could not read current price");

    const rideUpside = config.semiDegen?.smartWalletRideUpsidePct ?? 40;
    const lower = price * 0.95;             // small downside band
    const upper = price * (1 + rideUpside / 100); // wide upper range to ride the move

    const balance = await getWalletBalances().catch(() => ({ sol: 0 }));
    const deposit = computeDeployAmount(balance.sol || 0);

    const pos = await openPaperPosition({
      pool_address: sig.pool.pool,
      deposit_amount: deposit,
      lower_price: lower,
      upper_price: upper,
      strategy_type: "bid_ask",
    });

    await editMessage(
      `✅ Aped ${name} (paper ride)\n` +
      `Upper range: +${rideUpside}% | ${sig.projection.rationale}\n` +
      `Paper position: ${pos?.id || "opened"}`,
      msg.messageId,
    ).catch(() => {});
    log("smart_ape", `Aped ${name} → paper position ${pos?.id}`);
  } catch (e) {
    await editMessage(`❌ Ape failed for ${name}: ${e.message}`, msg.messageId).catch(() => {});
    log("smart_ape", `Ape failed for ${name}: ${e.message}`);
  }
}
