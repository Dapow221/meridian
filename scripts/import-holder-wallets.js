// Import tracked trader wallets into smart-wallets.json as type:"holder".
// Filter: only wallets with on-chain activity in the last N days. Sort by last-active desc.
//
// Usage: node scripts/import-holder-wallets.js <input.json> [--days 14] [--write]
//   (omit --write for a dry run that only prints what WOULD be imported)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith("--"));
const DAYS = Number((args.find((a) => a.startsWith("--days")) || "--days=14").split("=")[1] || 14);
const WRITE = args.includes("--write");

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : process.env.RPC_URL;

const OWN_WALLET = "DZqJvxdnMhYsFzeVKSnyTkqjPrd9ddhS9sizokeq7iXp"; // bot trading wallet — exclude
const CUTOFF = Math.floor(Date.now() / 1000) - DAYS * 86400;
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!inputPath || !fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const list = Array.isArray(raw) ? raw : raw.wallets || [];

// Dedupe by address, drop own wallet
const byAddr = new Map();
for (const w of list) {
  const address = w.trackedWalletAddress || w.address;
  if (!address || address === OWN_WALLET) continue;
  if (!byAddr.has(address)) byAddr.set(address, { address, name: w.name || address.slice(0, 6) });
}
const unique = [...byAddr.values()];
console.error(`Parsed ${list.length} entries -> ${unique.length} unique addresses (own wallet excluded).`);

async function lastActive(address) {
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress",
          params: [address, { limit: 1 }],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(500 * 2 ** attempt + Math.random() * 300); // backoff
        continue;
      }
      if (!res.ok) return { address, blockTime: null, err: `HTTP ${res.status}` };
      const j = await res.json();
      if (j.error) { lastErr = j.error.message || "rpc error"; await sleep(500 * 2 ** attempt); continue; }
      const sig = j.result?.[0];
      return { address, blockTime: sig?.blockTime ?? null };
    } catch (e) {
      lastErr = e.message;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    }
  }
  return { address, blockTime: null, err: lastErr };
}

// Throttled concurrency
const results = [];
let i = 0, done = 0;
async function worker() {
  while (i < unique.length) {
    const idx = i++;
    const w = unique[idx];
    const r = await lastActive(w.address);
    results.push({ ...w, ...r });
    if (++done % 50 === 0) console.error(`  checked ${done}/${unique.length}...`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const active = results
  .filter((r) => r.blockTime && r.blockTime >= CUTOFF)
  .sort((a, b) => b.blockTime - a.blockTime);
const inactive = results.filter((r) => !r.blockTime || r.blockTime < CUTOFF);
const errored = results.filter((r) => r.err);

console.error(`\nActive (<= ${DAYS}d): ${active.length} | inactive/old: ${inactive.length} | lookup errors: ${errored.length}`);

const wallets = active.map((r) => ({
  name: r.name,
  address: r.address,
  category: "alpha",
  type: "holder",
  lastActive: new Date(r.blockTime * 1000).toISOString(),
  addedAt: new Date().toISOString(),
}));

if (!WRITE) {
  console.error("\n[DRY RUN] Top 10 by last-active:");
  for (const w of wallets.slice(0, 10)) console.error(`  ${w.lastActive}  ${w.name}  ${w.address}`);
  console.error(`\nRe-run with --write to save ${wallets.length} wallets to smart-wallets.json`);
  process.exit(0);
}

const outPath = path.join(REPO, "smart-wallets.json");
fs.writeFileSync(outPath, JSON.stringify({ wallets }, null, 2));
console.error(`\nWrote ${wallets.length} holder wallets to ${outPath}`);
