/**
 * backfill_sales_uvxpaq.js
 *
 * Usage:
 *   node scripts/backfill_sales_uvxpaq.js --dry       (preview changes)
 *   node scripts/backfill_sales_uvxpaq.js --apply     (apply changes)
 *
 * Requires a Firebase service account JSON path in env var `GOOGLE_APPLICATION_CREDENTIALS`
 * or `FIREBASE_SERVICE_ACCOUNT`.
 */

const admin = require("firebase-admin");
const path = require("path");

function normKey(v) {
  return String(v || "").trim().toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry") && !args.includes("--apply");
  const apply = args.includes("--apply");

  const acctPath = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!acctPath) {
    console.error("Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.");
    process.exit(1);
  }

  const serviceAccount = require(path.resolve(acctPath));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log("Building uvxpaq map from inventory_candies_sellers...");
  const uvxpaqMap = {}; // sellerId -> { key -> uv }
  const invSnap = await db.collection("inventory_candies_sellers").get();
  invSnap.forEach((doc) => {
    const d = doc.data();
    const sid = String(d.sellerId || "").trim();
    if (!sid) return;
    uvxpaqMap[sid] = uvxpaqMap[sid] || {};
    const pname = String(d.productName || d.productId || "");
    const key = pname ? normKey(pname) : String(d.productId || "");
    const explicit = Number(d.uvXpaq ?? d.uvxpaq ?? d.uVxPaq ?? NaN);
    let val = NaN;
    if (Number.isFinite(explicit)) val = explicit;
    else {
      const gross = Number(d.grossProfit ?? d.gainVendor ?? 0);
      const packs = Math.max(1, Number(d.packages ?? d.unitsPerPackage ?? 1));
      val = packs > 0 ? gross / packs : 0;
    }
    uvxpaqMap[sid][key] = Number(val || 0);
  });

  console.log("uvxpaqMap built for sellers:", Object.keys(uvxpaqMap).length);

  console.log("Querying sales_candies (this may be slow for large collections)...");
  const salesSnap = await db.collection("sales_candies").get();
  console.log("Sales fetched:", salesSnap.size);

  const batch = db.batch();
  let ops = 0;
  let updated = 0;
  const samples = [];

  for (const doc of salesSnap.docs) {
    const d = doc.data();
    const id = doc.id;
    // skip if sale already has uv at sale-level
    const saleUv = Number(d.uvXpaq ?? d.uvxpaq ?? d.upaquete ?? NaN);
    const items = Array.isArray(d.items) ? d.items : d.item ? [d.item] : [];
    const vendorId = String(d.vendorId || d.vendor || "").trim();

    const upd = {};
    let anyItemUpdated = false;

    if (items.length === 1) {
      const it = items[0];
      const itemUv = Number(it.uvXpaq ?? it.uvxpaq ?? it.upaquete ?? NaN);
      let uv = Number.isFinite(itemUv) ? itemUv : undefined;
      if (uv === undefined) {
        // try sale-level
        if (Number.isFinite(saleUv)) uv = saleUv;
        else {
          // try map lookup
          try {
            const key = normKey(it.productName || it.name || it.productId || "");
            const mapForVendor = uvxpaqMap[vendorId] || {};
            if (mapForVendor[key] !== undefined) uv = Number(mapForVendor[key]);
            else {
              const match = Object.keys(mapForVendor).find((k) => k.replace(/\s+/g, "") === key.replace(/\s+/g, ""));
              if (match) uv = Number(mapForVendor[match]);
            }
          } catch (e) {
            /* ignore */
          }
        }
      }

      if (uv !== undefined && Number.isFinite(uv)) {
        if (!Number.isFinite(saleUv)) {
          upd.uvXpaq = uv;
          upd.uvxpaq = uv;
          upd.upaquete = uv;
        }
        // ensure item has uvXpaq
        if (!Number.isFinite(itemUv)) {
          const newItems = items.slice();
          newItems[0] = Object.assign({}, it, { uvXpaq: uv, uvxpaq: uv, upaquete: uv });
          upd.items = newItems;
          anyItemUpdated = true;
        }
      }
    } else if (items.length > 1) {
      // per-item backfill
      const newItems = items.slice();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const itemUv = Number(it.uvXpaq ?? it.uvxpaq ?? it.upaquete ?? NaN);
        if (!Number.isFinite(itemUv)) {
          let uv = undefined;
          // try map lookup
          try {
            const key = normKey(it.productName || it.name || it.productId || "");
            const mapForVendor = uvxpaqMap[vendorId] || {};
            if (mapForVendor[key] !== undefined) uv = Number(mapForVendor[key]);
            else {
              const match = Object.keys(mapForVendor).find((k) => k.replace(/\s+/g, "") === key.replace(/\s+/g, ""));
              if (match) uv = Number(mapForVendor[match]);
            }
          } catch (e) {}

          if (uv !== undefined && Number.isFinite(uv)) {
            newItems[i] = Object.assign({}, it, { uvXpaq: uv, uvxpaq: uv, upaquete: uv });
            anyItemUpdated = true;
          } else {
            // fallback: if item has vendorGain and packages, compute uv = vendorGain / packages
            const vendorGain = Number(it.vendorGain ?? it.margenVendedor ?? NaN);
            const packs = Math.max(1, Number(it.packages ?? it.qty ?? it.quantity ?? 1));
            if (Number.isFinite(vendorGain) && vendorGain !== 0) {
              const uv2 = Math.round((vendorGain / packs) * 100) / 100;
              newItems[i] = Object.assign({}, it, { uvXpaq: uv2, uvxpaq: uv2, upaquete: uv2 });
              anyItemUpdated = true;
            }
          }
        }
      }
      if (anyItemUpdated) upd.items = newItems;
    }

    if (Object.keys(upd).length > 0) {
      ops++;
      if (!dry && apply) {
        batch.update(db.collection("sales_candies").doc(id), upd);
      }
      updated++;
      if (samples.length < 5) samples.push({ id, upd });
      // commit batch per 400 ops
      if (!dry && apply && ops >= 400) {
        await batch.commit();
        ops = 0;
      }
    }
  }

  if (!dry && apply && ops > 0) {
    await batch.commit();
  }

  console.log(`Processed sales: ${salesSnap.size}. Documents to update: ${updated}`);
  console.log("Sample updates:", samples);
  if (dry) console.log("Dry run — no changes applied. Rerun with --apply to write updates.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
