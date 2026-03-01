/*
Backfill script for `upaquete` field on inventory_candies_sellers.
Usage:
  Set environment variable GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.
  node scripts/backfill_upaquete.js [--dry-run] [--yes]
Options:
  --dry-run  : run without writing (reports what would change)
  --yes      : skip interactive confirmation
*/

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function exitWith(msg, code = 1) {
  console.error(msg);
  process.exit(code);
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

    console.log(`Backfill upaquete - dryRun=${dryRun}`);

    if (!assumeYes) {
      const readline = require("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ans = await new Promise((res) =>
        rl.question("Proceed to scan and update documents? (yes/no) ", (a) => {
          rl.close();
          res(a);
        }),
      );
      if (String(ans || "").toLowerCase() !== "yes") {
        console.log("Aborted by user.");
        process.exit(0);
      }
    }

    const batchSize = 500;
    let lastDoc = null;
    let totalRead = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    while (true) {
      let q = db
        .collection("inventory_candies_sellers")
        .orderBy("__name__")
        .limit(batchSize);
      if (lastDoc) q = q.startAfter(lastDoc);
      const snap = await q.get();
      if (snap.empty) break;

      const batch = db.batch();
      let writes = 0;

      snap.forEach((doc) => {
        totalRead += 1;
        const data = doc.data() || {};
        const grossProfit =
          Number(data.grossProfit ?? data.gainVendor ?? 0) || 0;
        const packages =
          Number(data.packages ?? data.remainingPackages ?? 0) || 0;
        const computed =
          packages > 0 ? Math.round((grossProfit / packages) * 100) / 100 : 0;
        const existing =
          data.upaquete ?? data.uPaquete ?? data.u_per_package ?? null;

        if (existing === null || Number(existing) !== Number(computed)) {
          totalUpdated += 1;
          if (!dryRun) {
            batch.update(doc.ref, {
              upaquete: computed,
              updatedAt: admin.firestore.Timestamp.now(),
            });
            writes += 1;
          }
        } else {
          totalSkipped += 1;
        }

        lastDoc = doc;
      });

      if (!dryRun && writes > 0) {
        await batch.commit();
        console.log(
          `Committed ${writes} updates (processed ${totalRead} docs so far)`,
        );
      } else {
        console.log(
          `Scanned ${totalRead} docs (pending updates: ${totalUpdated - totalSkipped})`,
        );
      }

      // short sleep to avoid bursts
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log("Done.");
    console.log(`Read: ${totalRead}`);
    console.log(`ToUpdate: ${totalUpdated}`);
    console.log(`Skipped (already matching): ${totalSkipped}`);

    process.exit(0);
  } catch (e) {
    console.error("Error running backfill:", e);
    process.exit(2);
  }
})();
