/**
 * smart-wallet-watch.js
 *
 * Watches the tracked `holder` smart wallets for fresh token BUYS and emits a
 * signal when one of them apes into a token whose Meteora pool clears the
 * configured market cap. Polls the RPC in `RPC_URL` (the user's pump endpoint)
 * with throttle + backoff, like scripts/import-holder-wallets.js.
 *
 * Detection: for each new signature on a wallet, fetch the tx and compare
 * pre/post token balances for that wallet's owner. A mint whose balance went UP
 * (and isn't SOL/USDC/USDT) is treated as a buy/acquire.
 *
 * First time a wallet is seen, we baseline its latest signature WITHOUT emitting
 * (so we don't replay history) — only genuinely new activity fires a signal.
 *
 * State persisted to smart-wallet-watch.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { listSmartWallets } from "./smart-wallets.js";
import { searchPools } from "./tools/dlmm.js";
import { getPoolDetail } from "./tools/screening.js";
import { projectTradeProfit } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "smart-wallet-watch.json");

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  WRAPPED_SOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

const SEEN_MINT_TTL_MS = 10 * 60 * 1000; // dedup a freshly-signaled mint for 10m
const MAX_TX_FETCH_PER_TICK = 25;        // bound getTransaction calls per sweep
const SIG_LOOKBACK = 8;                   // signatures fetched per wallet per tick
const CONCURRENCY = 8;                    // ~407 wallets / 8 * 1.6s ≈ 80s per sweep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── State ────────────────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastSig: {}, seenMints: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastSig: {}, seenMints: {} };
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("smart_watch", `Failed to write state: ${e.message}`);
  }
}

// ─── RPC with retry/backoff ─────────────────────────────────────────────────
async function rpc(method, params) {
  const url = process.env.RPC_URL;
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(400 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const j = await res.json();
      if (j.error) return { error: j.error.message || "rpc error" };
      return { result: j.result };
    } catch (e) {
      lastErr = e.message;
      await sleep(400 * 2 ** attempt + Math.random() * 200);
    }
  }
  return { error: lastErr };
}

// Estimate SOL spent by `owner` in a tx: the larger of the native-SOL decrease
// on the wallet's account and its wrapped-SOL token-balance decrease. A decent
// proxy for "how big was the buy" without decoding the swap instruction.
function estimateSolSpent(tx, owner) {
  let native = 0;
  try {
    const keys = (tx?.transaction?.message?.accountKeys || []).map((k) =>
      typeof k === "string" ? k : k?.pubkey
    );
    const idx = keys.indexOf(owner);
    if (idx >= 0 && tx?.meta?.preBalances && tx?.meta?.postBalances) {
      native = (Number(tx.meta.preBalances[idx]) - Number(tx.meta.postBalances[idx])) / 1e9;
    }
  } catch { /* ignore */ }

  let wsol = 0;
  const pre = new Map();
  for (const b of tx?.meta?.preTokenBalances || []) {
    if (b.owner === owner && b.mint === WRAPPED_SOL) pre.set("w", Number(b.uiTokenAmount?.uiAmount || 0));
  }
  for (const b of tx?.meta?.postTokenBalances || []) {
    if (b.owner === owner && b.mint === WRAPPED_SOL) {
      wsol = (pre.get("w") || 0) - Number(b.uiTokenAmount?.uiAmount || 0);
    }
  }
  return Math.max(0, native, wsol);
}

// Detect mints this wallet ACQUIRED in a tx (post balance > pre balance).
function detectAcquiredMints(tx, owner) {
  const meta = tx?.meta;
  if (!meta) return [];
  const pre = new Map();
  for (const b of meta.preTokenBalances || []) {
    if (b.owner === owner) pre.set(b.mint, Number(b.uiTokenAmount?.uiAmount || 0));
  }
  const acquired = [];
  for (const b of meta.postTokenBalances || []) {
    if (b.owner !== owner) continue;
    if (STABLES.has(b.mint)) continue;
    const before = pre.get(b.mint) || 0;
    const after = Number(b.uiTokenAmount?.uiAmount || 0);
    if (after > before) acquired.push(b.mint);
  }
  return acquired;
}

// Resolve a mint to its best SOL-paired Meteora DLMM pool (highest TVL).
async function resolvePool(mint) {
  try {
    const { pools } = await searchPools({ query: mint, limit: 10 });
    const solPaired = pools.filter(
      (p) => p.token_x?.mint === WRAPPED_SOL || p.token_y?.mint === WRAPPED_SOL || p.token_x?.symbol === "SOL" || p.token_y?.symbol === "SOL"
    );
    const pick = (solPaired.length ? solPaired : pools)
      .filter((p) => p.pool)
      .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
    return pick || null;
  } catch (e) {
    log("smart_watch", `resolvePool ${mint.slice(0, 6)} failed: ${e.message}`);
    return null;
  }
}

/**
 * Run one sweep. Calls onSignal({ wallet, mint, pool, detail, projection })
 * for each fresh smart-wallet buy that clears minMcap.
 * @returns {Promise<{checked:number, newBuys:number, signals:number}>}
 */
export async function sweepSmartWallets(onSignal, { verbose = false } = {}) {
  const sd = config.semiDegen || {};
  const minMcap = sd.smartWalletMinMcap ?? 100_000;
  const minBuySol = sd.smartWalletMinBuySol ?? 10;
  const state = loadState();
  const now = Date.now();

  // prune old seenMints
  for (const [m, ts] of Object.entries(state.seenMints)) {
    if (now - ts > SEEN_MINT_TTL_MS) delete state.seenMints[m];
  }

  const wallets = listSmartWallets().wallets.filter((w) => w.type === "holder");
  let checked = 0;
  let txBudget = MAX_TX_FETCH_PER_TICK;
  const newBuys = []; // { wallet, mint }

  // Phase 1: collect new signatures per wallet (throttled concurrency)
  let i = 0;
  async function sigWorker() {
    while (i < wallets.length) {
      const w = wallets[i++];
      checked++;
      const until = state.lastSig[w.address];
      const params = [w.address, until ? { until, limit: SIG_LOOKBACK } : { limit: 1 }];
      const { result, error } = await rpc("getSignaturesForAddress", params);
      if (error || !Array.isArray(result)) continue;
      if (result.length === 0) continue;
      const newest = result[0].signature;
      const firstSeen = !until;
      // advance pointer regardless
      state.lastSig[w.address] = newest;
      if (firstSeen) continue; // baseline only — don't replay history
      // newest-first: these are sigs since `until`
      for (const s of result) {
        if (txBudget <= 0) break;
        newBuys.push({ wallet: w, sig: s.signature });
        txBudget--;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, sigWorker));

  // Phase 2: fetch txs, gate on buy size, detect acquired mints
  const candidateMints = new Map(); // mint -> { wallet, solSpent } (first finder)
  for (const { wallet, sig } of newBuys) {
    const { result: tx, error } = await rpc("getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0 },
    ]);
    if (error || !tx) continue;
    const solSpent = estimateSolSpent(tx, wallet.address);
    if (solSpent < minBuySol) {
      if (verbose && solSpent > 0) log("smart_watch", `skip ${wallet.name} buy ${solSpent.toFixed(2)} SOL < ${minBuySol}`);
      continue;
    }
    for (const mint of detectAcquiredMints(tx, wallet.address)) {
      if (state.seenMints[mint]) continue;
      if (!candidateMints.has(mint)) candidateMints.set(mint, { wallet, solSpent });
    }
  }

  // Phase 3: resolve pool, check mcap, project, emit
  let signals = 0;
  for (const [mint, { wallet, solSpent }] of candidateMints) {
    state.seenMints[mint] = now; // dedup even if it doesn't pass, avoid re-checking for 10m
    const pool = await resolvePool(mint);
    if (!pool) continue;
    let detail = null;
    try {
      detail = await getPoolDetail({ pool_address: pool.pool });
    } catch { /* skip */ }
    const mcap = detail?.mcap ?? null;
    if (mcap != null && mcap < minMcap) {
      if (verbose) log("smart_watch", `skip ${detail?.name || mint.slice(0, 6)} — mcap ${mcap} < ${minMcap}`);
      continue;
    }
    const projection = projectTradeProfit({
      feeTvlRatio: detail?.fee_active_tvl_ratio,
      volume5m: detail?.volume_window,
      tvl: detail?.tvl,
      activeTvl: detail?.active_tvl,
      mcap,
      smartWallet: true,
    });
    signals++;
    if (verbose) log("smart_watch", `SIGNAL ${wallet.name} bought ${solSpent.toFixed(1)} SOL → ${detail?.name || mint.slice(0, 8)} | mcap ${mcap} | ${projection.rationale}`);
    try {
      await onSignal?.({ wallet, mint, pool, detail, projection, solSpent });
    } catch (e) {
      log("smart_watch", `onSignal error: ${e.message}`);
    }
  }

  saveState(state);
  return { checked, newBuys: newBuys.length, signals };
}

let _watchTimer = null;
let _watchBusy = false;

/** Start the recurring watcher. Returns a stop() handle. */
export function startSmartWalletWatch(onSignal) {
  const sd = config.semiDegen || {};
  if (!sd.enabled || !sd.smartWalletWatch) {
    log("smart_watch", "Smart-wallet watch disabled in config.");
    return { stop() {} };
  }
  const intervalMs = Math.max(30, sd.smartWalletWatchIntervalSec ?? 90) * 1000;
  const tick = async () => {
    if (_watchBusy) return;
    _watchBusy = true;
    try {
      const r = await sweepSmartWallets(onSignal);
      if (r.signals > 0 || r.newBuys > 0) {
        log("smart_watch", `swept ${r.checked} wallets | ${r.newBuys} new tx | ${r.signals} signals`);
      }
    } catch (e) {
      log("smart_watch", `sweep failed: ${e.message}`);
    } finally {
      _watchBusy = false;
    }
  };
  _watchTimer = setInterval(tick, intervalMs);
  log("smart_watch", `Smart-wallet watch started (every ${intervalMs / 1000}s, mcap >= ${sd.smartWalletMinMcap}).`);
  // baseline sweep shortly after boot (won't emit on first sight of each wallet)
  setTimeout(tick, 5000);
  return {
    stop() {
      if (_watchTimer) clearInterval(_watchTimer);
      _watchTimer = null;
    },
  };
}
