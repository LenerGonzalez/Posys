/*
Backfill script for existing docs in `sales_candies`.
Adds/updates these root fields per sale:
  - totalCost
  - totalUneta
  - totalVendorGain

Usage:
  Set GOOGLE_APPLICATION_CREDENTIALS to a valid service account JSON path.
  node scripts/backfill_sales_totals.js [--dry-run] [--yes] [--limit=N]

Options:
  --dry-run : scan and report, do not write
  --yes     : skip interactive confirmation
  --limit=N : process only first N docs (useful for testing)
*/

const admin = require("firebase-admin");
const fs = require("fs");

function exitWith(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round(toNumber(v) * 100) / 100;
}

function pickPackages(it) {
  const direct = toNumber(it?.packages ?? it?.qtyPackages ?? it?.packagesTotal);
  if (direct > 0) return direct;

  const qtyUnits = toNumber(it?.qty ?? it?.quantity);
  const upp = Math.max(1, Math.floor(toNumber(it?.unitsPerPackage || 1)));
  if (qtyUnits > 0) return qtyUnits / upp;

  return 0;
}

function computeTotalsFromItem(it) {
  const packages = pickPackages(it);

  const vendorGainDirect = toNumber(it?.vendorGain);
  const vendorGainByPack = toNumber(it?.uvXpaq ?? it?.uVendorPorPaquete);
  const vendorGain =
    vendorGainDirect !== 0
      ? vendorGainDirect
      : vendorGainByPack !== 0 && packages > 0
        ? vendorGainByPack * packages
        : 0;

  const uNetaDirect = toNumber(it?.uNeta);
  const uNetaByPack = toNumber(
    it?.uNetaPorPaquete ?? it?.uNetaPorPack ?? it?.upaquete,
  );
  const totalUneta =
    uNetaDirect !== 0
      ? uNetaDirect
      : uNetaByPack !== 0 && packages > 0
        ? uNetaByPack * packages
        : 0;

  const totalCostDirect = toNumber(
    it?.totalCost ?? it?.costTotal ?? it?.lineCost,
  );
  const providerCostByPack = toNumber(
    it?.providerPricePerPackage ??
      it?.provider_price_per_package ??
      it?.providerPrice ??
      it?.provider_price,
  );
  const totalCost =
    totalCostDirect !== 0
      ? totalCostDirect
      : providerCostByPack !== 0 && packages > 0
        ? providerCostByPack * packages
        : 0;

  return {
    totalCost: round2(totalCost),
    totalUneta: round2(totalUneta),
    totalVendorGain: round2(vendorGain),
  };
}

function getSaleItems(data) {
  if (Array.isArray(data?.items) && data.items.length > 0) return data.items;
  if (data?.item) return [data.item];
  // Some docs keep fields directly at root as a single-line sale.
  return [data || {}];
}

function computeSaleTotals(data) {
  const items = getSaleItems(data);

  const sums = items.reduce(
    (acc, it) => {
      const perItem = computeTotalsFromItem(it);
      acc.totalCost += perItem.totalCost;
      acc.totalUneta += perItem.totalUneta;
      acc.totalVendorGain += perItem.totalVendorGain;
      return acc;
    },
    { totalCost: 0, totalUneta: 0, totalVendorGain: 0 },
  );

  return {
    totalCost: round2(sums.totalCost),
    totalUneta: round2(sums.totalUneta),
    totalVendorGain: round2(sums.totalVendorGain),
  };
}

(async () => {
  try {
    const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!saPath || !fs.existsSync(saPath)) {
      exitWith(
        "ERROR: GOOGLE_APPLICATION_CREDENTIALS must point to a valid service account JSON file.",
      );
    }

    const serviceAccount = require(saPath);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const db = admin.firestore();

    const dryRun = process.argv.includes("--dry-run");
    const assumeYes = process.argv.includes("--yes");
    const limitArg = process.argv.find((a) => a.startsWith("--limit="));
    const limit = limitArg
      ? Math.max(0, Number(limitArg.split("=")[1]) || 0)
      : 0;

    console.log(
      `Backfill sales_candies totals - dryRun=${dryRun} limit=${limit || "ALL"}`,
    );

    if (!assumeYes) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ans = await new Promise((res) =>
        rl.question(
          "Proceed to scan and update sales_candies? (yes/no) ",
          (a) => {
            rl.close();
            res(a);
          },
        ),
      );
      if (String(ans || "").toLowerCase() !== "yes") {
        console.log("Aborted by user.");
        process.exit(0);
      }
    }

    const batchSize = 400;
    let lastDoc = null;
    let read = 0;
    let updated = 0;
    let unchanged = 0;

    while (true) {
      let q = db
        .collection("sales_candies")
        .orderBy("__name__")
        .limit(batchSize);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      let writes = 0;

      for (const saleDoc of snap.docs) {
        if (limit > 0 && read >= limit) break;

        read += 1;
        const data = saleDoc.data() || {};
        const computed = computeSaleTotals(data);

        const currentCost = round2(toNumber(data.totalCost));
        const currentUNeta = round2(toNumber(data.totalUneta));
        const currentVendorGain = round2(toNumber(data.totalVendorGain));

        const changed =
          currentCost !== computed.totalCost ||
          currentUNeta !== computed.totalUneta ||
          currentVendorGain !== computed.totalVendorGain;

        if (changed) {
          updated += 1;
          if (!dryRun) {
            batch.update(saleDoc.ref, {
              totalCost: computed.totalCost,
              totalUneta: computed.totalUneta,
              totalVendorGain: computed.totalVendorGain,
              updatedAt: admin.firestore.Timestamp.now(),
            });
            writes += 1;
          }
        } else {
          unchanged += 1;
        }

        lastDoc = saleDoc;
      }

      if (!dryRun && writes > 0) {
        await batch.commit();
      }

      console.log(
        `Processed=${read} Updated=${updated} Unchanged=${unchanged} (batchWrites=${writes})`,
      );

      if (limit > 0 && read >= limit) break;
    }

    console.log("Done.");
    console.log(`Read: ${read}`);
    console.log(`Updated: ${updated}`);
    console.log(`Unchanged: ${unchanged}`);

    process.exit(0);
  } catch (e) {
    console.error("Error running backfill_sales_totals:", e);
    process.exit(2);
  }
})();
