import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import Button from "../common/Button";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerDetailDlCard,
  DrawerMoneyStrip,
  DrawerSectionTitle,
} from "../common/DrawerContentCards";

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const round2 = (n: number) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/** Paquetes siempre enteros en UI (las atribuciones internas pueden ser fracción). */
const fmtPacks = (n: unknown) =>
  String(Math.round(Number(n) || 0));

const safeInt = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));

function getBaseUnitsFromInvDoc(data: Record<string, unknown>): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = safeInt(data.totalUnits || 0);
  const quantity = safeInt(data.quantity || 0);
  const packages = safeInt(data.packages || 0);
  if (totalUnits > 0) return totalUnits;
  if (quantity > 0) return quantity;
  if (packages > 0) return packages * unitsPerPackage;
  return 0;
}

function getRemainingPackagesFromInvDoc(data: Record<string, unknown>): number {
  const rp = Number(data.remainingPackages);
  if (Number.isFinite(rp)) return Math.max(0, Math.floor(rp));
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.max(0, Math.floor(remainingField / unitsPerPackage));
  }
  return Math.max(
    0,
    Math.floor(getBaseUnitsFromInvDoc(data) / unitsPerPackage),
  );
}

function getInitialPackagesFromInvDoc(data: Record<string, unknown>): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = getBaseUnitsFromInvDoc(data);
  return Math.max(0, Math.floor(totalUnits / unitsPerPackage));
}

type SaleAttrib = {
  packages: number;
  monto: number;
  uBruta: number;
  inversorGain: number;
  vendorGain: number;
};

const emptyAttrib = (): SaleAttrib => ({
  packages: 0,
  monto: 0,
  uBruta: 0,
  inversorGain: 0,
  vendorGain: 0,
});

/**
 * Monto por ítem igual que {@link CierreVentasDulces} al aplanar ventas:
 * `lineFinal`, o precio×paquetes − descuento, o `total` como respaldo.
 */
function lineFinalFromItem(it: Record<string, unknown>): number {
  const qtyPacks = Number(it.packages ?? it.qty ?? it.quantity ?? 0);
  const explicit = Number(it.lineFinal ?? 0);
  if (explicit > 0) return round2(explicit);
  const unit = Number(it.unitPricePackage || it.unitPrice || 0);
  const fromPrice = Math.max(
    0,
    unit * qtyPacks - Number(it.discount || 0),
  );
  if (fromPrice > 0) return round2(fromPrice);
  return round2(Number(it.total || 0));
}

/**
 * Comisión por ítem alineada con Cierre: si la venta trae `vendorCommissionAmount`,
 * se prorratea por (monto línea / total venta), como cada fila en cierre.
 * Si no, mismo orden que KPI de cierre: vendorGain → margenVendedor → uvXpaq×paq.
 */
function lineCommissionFromItem(
  it: Record<string, unknown>,
  sale: Record<string, unknown>,
  lineFinal: number,
): number {
  const saleTotalRoot =
    Number(
      sale.total ??
        sale.itemsTotal ??
        sale.amount ??
        sale.amountCharged ??
        0,
    ) || 0;
  const saleCommissionRoot = Number(sale.vendorCommissionAmount ?? 0) || 0;
  if (saleCommissionRoot > 0 && saleTotalRoot > 0 && lineFinal > 0) {
    return round2((saleCommissionRoot * lineFinal) / saleTotalRoot);
  }
  const vg = Number(it.vendorGain ?? NaN);
  if (Number.isFinite(vg) && vg !== 0) return round2(vg);
  const mv = round2(Number(it.margenVendedor ?? 0));
  if (mv !== 0) return mv;
  const uv = Number(it.uvXpaq ?? it.upaquete ?? NaN);
  const qtyPacks = Number(it.packages ?? it.qty ?? it.quantity ?? 0);
  if (Number.isFinite(uv) && qtyPacks > 0) return round2(uv * qtyPacks);
  return 0;
}

function accumulateSalesByMaster(
  sale: Record<string, unknown>,
  sellersById: Map<string, Record<string, unknown>>,
  intoMaster: Record<string, SaleAttrib>,
  intoPair: Record<string, SaleAttrib>,
  contadoOnly: boolean,
) {
  const typ = String(sale.type || "CONTADO").toUpperCase();
  if (contadoOnly && typ !== "CONTADO") return;

  const items = Array.isArray(sale.items) ? (sale.items as Record<string, unknown>[]) : [];
  const allocRoot = sale.allocationsByItem as
    | Record<string, { allocations?: unknown[] }>
    | undefined;

  for (const it of items) {
    const productId = String(it.productId || "").trim();
    if (!productId) continue;
    const itemQty = Math.max(0, Number(it.qty ?? it.quantity ?? 0));
    const itemPk = Math.max(0, Number(it.packages || 0));
    const lineFinal = lineFinalFromItem(it);
    const itemUb = Number(it.uBruta || 0);
    const itemInv = Number(it.inversorGain || 0);
    const itemVend = lineCommissionFromItem(it, sale, lineFinal);

    const entry = allocRoot?.[productId];
    const allocs = Array.isArray(entry?.allocations)
      ? (entry!.allocations as Record<string, unknown>[])
      : [];
    if (allocs.length === 0) continue;

    for (const a of allocs) {
      const sid = String(a.inventorySellerId || "").trim();
      if (!sid) continue;
      const au = Math.max(0, Number(a.units || 0));
      const seller = sellersById.get(sid);
      if (!seller) continue;

      const mas = Array.isArray(seller.masterAllocations)
        ? (seller.masterAllocations as { masterOrderId?: string; units?: number }[])
        : [];
      const totalMu = mas.reduce(
        (s, m) => s + Math.max(0, Number(m.units || 0)),
        0,
      );
      const fracFromItem =
        itemQty > 0 ? au / itemQty : 1 / Math.max(1, allocs.length);

      for (const m of mas) {
        const mid = String(m.masterOrderId || "").trim();
        if (!mid) continue;
        const mu = Math.max(0, Number(m.units || 0));
        const wMaster =
          totalMu > 0 ? mu / totalMu : 1 / Math.max(1, mas.length);
        const c = fracFromItem * wMaster;

        if (!intoMaster[mid]) intoMaster[mid] = emptyAttrib();
        const M = intoMaster[mid];
        M.packages += itemPk * c;
        M.monto += lineFinal * c;
        M.uBruta += itemUb * c;
        M.inversorGain += itemInv * c;
        M.vendorGain += itemVend * c;

        const pairKey = `${mid}__${sid}`;
        if (!intoPair[pairKey]) intoPair[pairKey] = emptyAttrib();
        const P = intoPair[pairKey];
        P.packages += itemPk * c;
        P.monto += lineFinal * c;
        P.uBruta += itemUb * c;
        P.inversorGain += itemInv * c;
        P.vendorGain += itemVend * c;
      }
    }
  }
}

export type MasterOrderUtilRow = {
  id: string;
  name: string;
  date: string;
  totalPackages: number;
  subtotal: number;
  totalIsla: number;
  uBrutaGlobal: number;
  logisticsCost: number;
  remainingMasterPacks: number;
  initialMasterPacks: number;
  /** Paquetes asignados a órdenes de vendedor (prorrateo por maestra). */
  dispersAsignada: number;
  /** Paquetes vendidos atribuidos a esta maestra (ventas + allocations). */
  vendidoPacks: number;
  ventasEfectivas: number;
  ubEfectiva: number;
  sellerGrossProfit: number;
  sellerUVendor: number;
  sellerUNeta: number;
  sellerLogistic: number;
};

type SaleRowLite = {
  id: string;
  date: string;
  type: string;
  vendorName: string;
  total: number;
  packagesTotal: number;
  data: Record<string, unknown>;
};

type Props = {
  from: string;
  to: string;
  refreshKey: number;
  onRefresh: () => void;
};

export default function CandiesUtilidadesPanel({
  from,
  to,
  refreshKey,
  onRefresh,
}: Props): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<MasterOrderUtilRow[]>([]);
  const [sellersById, setSellersById] = useState<
    Map<string, Record<string, unknown>>
  >(() => new Map());
  const [attribPair, setAttribPair] = useState<Record<string, SaleAttrib>>({});
  const [salesList, setSalesList] = useState<SaleRowLite[]>([]);
  const [snapshotMsg, setSnapshotMsg] = useState("");
  const [savingSnap, setSavingSnap] = useState(false);
  const [drawerRow, setDrawerRow] = useState<MasterOrderUtilRow | null>(null);
  const [drawerTab, setDrawerTab] = useState<"vendedores" | "ventas">(
    "vendedores",
  );
  const [ventasAtribFilter, setVentasAtribFilter] = useState<
    "todos" | "contado"
  >("todos");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fromK = String(from || "").slice(0, 10);
      const toK = String(to || "").slice(0, 10);
      const contadoOnly = ventasAtribFilter === "contado";

      const qOrders = query(
        collection(db, "candy_main_orders"),
        orderBy("createdAt", "desc"),
      );
      const snapO = await getDocs(qOrders);

      const invSnap = await getDocs(collection(db, "inventory_candies"));
      const invAgg: Record<string, { initial: number; remaining: number }> = {};
      invSnap.forEach((d) => {
        const x = d.data() as Record<string, unknown>;
        const orderId = String(x.orderId || "").trim();
        if (!orderId) return;
        const ini = getInitialPackagesFromInvDoc(x);
        const rem = getRemainingPackagesFromInvDoc(x);
        if (!invAgg[orderId]) invAgg[orderId] = { initial: 0, remaining: 0 };
        invAgg[orderId].initial += ini;
        invAgg[orderId].remaining += rem;
      });

      const sellerSnap = await getDocs(
        collection(db, "inventory_candies_sellers"),
      );
      const sMap = new Map<string, Record<string, unknown>>();
      sellerSnap.forEach((d) => {
        sMap.set(d.id, d.data() as Record<string, unknown>);
      });
      setSellersById(new Map(sMap));

      type SellerAgg = {
        packages: number;
        remaining: number;
        gross: number;
        uVendor: number;
        uNeta: number;
        logistic: number;
      };
      const byMaster: Record<string, SellerAgg> = {};

      sellerSnap.forEach((d) => {
        const x = d.data() as Record<string, unknown>;
        const allocs = Array.isArray(x.masterAllocations)
          ? (x.masterAllocations as { masterOrderId?: string; units?: number }[])
          : [];
        if (allocs.length === 0) return;

        const totalUnits = allocs.reduce(
          (s, a) => s + Math.max(0, Number(a.units || 0)),
          0,
        );

        const pk = safeInt(x.packages);
        const rem = safeInt(x.remainingPackages);
        const gross = Number(x.grossProfit || 0);
        const uv = Number(x.uVendor ?? x.vendorProfit ?? 0);
        const un = Number(x.uNeta ?? x.uInvestor ?? 0);
        const log = Number(x.logisticAllocated || 0);

        for (const a of allocs) {
          const mid = String(a.masterOrderId || "").trim();
          if (!mid) continue;
          const u = Math.max(0, Number(a.units || 0));
          const w =
            totalUnits > 0 ? u / totalUnits : 1 / Math.max(1, allocs.length);

          if (!byMaster[mid]) {
            byMaster[mid] = {
              packages: 0,
              remaining: 0,
              gross: 0,
              uVendor: 0,
              uNeta: 0,
              logistic: 0,
            };
          }
          byMaster[mid].packages += round2(pk * w);
          byMaster[mid].remaining += round2(rem * w);
          byMaster[mid].gross += round2(gross * w);
          byMaster[mid].uVendor += round2(uv * w);
          byMaster[mid].uNeta += round2(un * w);
          byMaster[mid].logistic += round2(log * w);
        }
      });

      const attribMaster: Record<string, SaleAttrib> = {};
      const pair: Record<string, SaleAttrib> = {};
      const salesLite: SaleRowLite[] = [];

      const pushSale = (id: string, s: Record<string, unknown>) => {
        const d = String(s.date || "").slice(0, 10);
        if (!d || d < fromK || d > toK) return;
        accumulateSalesByMaster(s, sMap, attribMaster, pair, contadoOnly);
        salesLite.push({
          id,
          date: d,
          type: String(s.type || "CONTADO"),
          vendorName: String(s.vendorName || "—"),
          total: Number(s.total || s.itemsTotal || 0),
          packagesTotal: Number(s.packagesTotal || 0),
          data: s,
        });
      };

      try {
        const qSales = query(
          collection(db, "sales_candies"),
          where("date", ">=", fromK),
          where("date", "<=", toK),
        );
        const sSnap = await getDocs(qSales);
        sSnap.forEach((doc) => pushSale(doc.id, doc.data() as Record<string, unknown>));
      } catch {
        const fallback = query(
          collection(db, "sales_candies"),
          orderBy("createdAt", "desc"),
          limit(500),
        );
        const sSnap = await getDocs(fallback);
        sSnap.forEach((doc) => pushSale(doc.id, doc.data() as Record<string, unknown>));
      }

      setAttribPair(pair);
      salesLite.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      setSalesList(salesLite);

      const list: MasterOrderUtilRow[] = [];
      snapO.forEach((d) => {
        const x = d.data() as Record<string, unknown>;
        const dateStr = String(x.date || "").slice(0, 10);
        if (!dateStr || dateStr < fromK || dateStr > toK) return;

        const id = d.id;
        const inv = invAgg[id] || { initial: 0, remaining: 0 };
        const docPk = safeInt(x.totalPackages);
        const remainingM = inv.remaining;
        const initialM = inv.initial > 0 ? inv.initial : docPk;
        const sg = byMaster[id] || {
          packages: 0,
          remaining: 0,
          gross: 0,
          uVendor: 0,
          uNeta: 0,
          logistic: 0,
        };
        const att = attribMaster[id] || emptyAttrib();

        list.push({
          id,
          name: String(x.name || "—"),
          date: dateStr,
          totalPackages: docPk,
          subtotal: Number(x.subtotal || 0),
          totalIsla: Number(x.totalIsla || 0),
          uBrutaGlobal: Number(x.uBrutaGlobal || 0),
          logisticsCost: Number(x.logisticsCost || 0),
          remainingMasterPacks: remainingM,
          initialMasterPacks: initialM,
          dispersAsignada: round2(sg.packages),
          vendidoPacks: round2(att.packages),
          ventasEfectivas: round2(att.monto),
          ubEfectiva: round2(att.uBruta),
          sellerGrossProfit: round2(sg.gross),
          sellerUVendor: round2(sg.uVendor),
          sellerUNeta: round2(sg.uNeta),
          sellerLogistic: round2(sg.logistic),
        });
      });

      list.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
      setRows(list);
    } catch (e) {
      console.error("CandiesUtilidadesPanel load:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, refreshKey, ventasAtribFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    return rows.reduce(
      (a, r) => ({
        subtotal: a.subtotal + r.subtotal,
        totalIsla: a.totalIsla + r.totalIsla,
        uBruta: a.uBruta + r.uBrutaGlobal,
        log: a.log + r.logisticsCost,
        dispA: a.dispA + r.dispersAsignada,
        vend: a.vend + r.vendidoPacks,
        ve: a.ve + r.ventasEfectivas,
        ube: a.ube + r.ubEfectiva,
        remM: a.remM + r.remainingMasterPacks,
      }),
      {
        subtotal: 0,
        totalIsla: 0,
        uBruta: 0,
        log: 0,
        dispA: 0,
        vend: 0,
        ve: 0,
        ube: 0,
        remM: 0,
      },
    );
  }, [rows]);

  const drawerDetail = useMemo(() => {
    if (!drawerRow) return null;
    const mid = drawerRow.id;
    const rowM = rows.find((r) => r.id === mid);
    const pkV = rowM?.vendidoPacks ?? 0;
    const montoV = rowM?.ventasEfectivas ?? 0;
    const ubV = rowM?.ubEfectiva ?? 0;

    let invGain = 0;
    let vendGain = 0;
    for (const [k, v] of Object.entries(attribPair)) {
      if (k.startsWith(`${mid}__`)) {
        invGain += v.inversorGain;
        vendGain += v.vendorGain;
      }
    }
    invGain = round2(invGain);
    vendGain = round2(vendGain);

    const contado = ventasAtribFilter === "contado";
    const salesForMasterFiltered = salesList.filter((sl) => {
      const probe: Record<string, SaleAttrib> = {};
      accumulateSalesByMaster(sl.data, sellersById, probe, {}, contado);
      return (
        (probe[mid]?.monto || 0) > 0.001 || (probe[mid]?.packages || 0) > 0.001
      );
    });

    const faltaParaMetaIsla = round2(drawerRow.totalIsla - montoV);

    type VCard = {
      sellerDocId: string;
      sellerName: string;
      marginPct: number;
      orderKey: string;
      orderName: string;
      pkAsign: number;
      pkRest: number;
      pkVendInv: number;
      esperadoVentas: number;
      ventasEfectivas: number;
      comisionEsperada: number;
      comisionEfectiva: number;
      uNetaEsperada: number;
      uNetaEfectiva: number;
    };
    const lineCards: VCard[] = [];
    sellersById.forEach((x, docId) => {
      const allocs = Array.isArray(x.masterAllocations)
        ? (x.masterAllocations as { masterOrderId?: string; units?: number }[])
        : [];
      const totalMu = allocs.reduce(
        (s, m) => s + Math.max(0, Number(m.units || 0)),
        0,
      );
      const mine = allocs.find((m) => String(m.masterOrderId || "") === mid);
      if (!mine || totalMu <= 0) return;
      const w =
        totalMu > 0
          ? Math.max(0, Number(mine.units || 0)) / totalMu
          : 0;
      if (w <= 0) return;

      const pk = safeInt(x.packages);
      const rem = safeInt(x.remainingPackages);
      const te = Number(x.totalExpected || x.totalIsla || 0);
      const uv = Number(x.uVendor ?? x.vendorProfit ?? 0);
      const un = Number(x.uNeta ?? x.uInvestor ?? 0);
      const pairKey = `${mid}__${docId}`;
      const peff = attribPair[pairKey] || emptyAttrib();

      lineCards.push({
        sellerDocId: docId,
        sellerName: String(x.sellerName || "—"),
        marginPct: Number(x.vendorMarginPercent ?? 0),
        orderKey: String(x.orderId || "").trim() || "—",
        orderName: String(x.orderName || "—").trim() || "—",
        pkAsign: round2(pk * w),
        pkRest: round2(rem * w),
        pkVendInv: round2(Math.max(0, pk - rem) * w),
        esperadoVentas: round2(te * w),
        ventasEfectivas: round2(peff.monto),
        comisionEsperada: round2(uv * w),
        comisionEfectiva: round2(peff.vendorGain),
        uNetaEsperada: round2(un * w),
        uNetaEfectiva: round2(peff.inversorGain),
      });
    });

    const byOrder = new Map<string, VCard[]>();
    for (const c of lineCards) {
      const groupKey =
        c.orderKey !== "—" ? `id:${c.orderKey}` : `doc:${c.sellerDocId}`;
      if (!byOrder.has(groupKey)) byOrder.set(groupKey, []);
      byOrder.get(groupKey)!.push(c);
    }
    const cards: VCard[] = [];
    for (const [, arr] of byOrder) {
      const sellerNames = [...new Set(arr.map((x) => x.sellerName))];
      const margins = arr.map((x) => x.marginPct).filter((m) => m > 0);
      const marginPct =
        margins.length > 0
          ? round2(margins.reduce((s, m) => s + m, 0) / margins.length)
          : arr[0]?.marginPct ?? 0;
      const first = arr[0]!;
      cards.push({
        sellerDocId: arr.map((x) => x.sellerDocId).join(","),
        sellerName: sellerNames.join(" · "),
        marginPct,
        orderKey: first.orderKey,
        orderName: first.orderName,
        pkAsign: round2(arr.reduce((s, x) => s + x.pkAsign, 0)),
        pkRest: round2(arr.reduce((s, x) => s + x.pkRest, 0)),
        pkVendInv: round2(arr.reduce((s, x) => s + x.pkVendInv, 0)),
        esperadoVentas: round2(arr.reduce((s, x) => s + x.esperadoVentas, 0)),
        ventasEfectivas: round2(arr.reduce((s, x) => s + x.ventasEfectivas, 0)),
        comisionEsperada: round2(arr.reduce((s, x) => s + x.comisionEsperada, 0)),
        comisionEfectiva: round2(arr.reduce((s, x) => s + x.comisionEfectiva, 0)),
        uNetaEsperada: round2(arr.reduce((s, x) => s + x.uNetaEsperada, 0)),
        uNetaEfectiva: round2(arr.reduce((s, x) => s + x.uNetaEfectiva, 0)),
      });
    }
    cards.sort((a, b) =>
      a.orderName.localeCompare(b.orderName) ||
      a.sellerName.localeCompare(b.sellerName),
    );

    const sumCards = cards.reduce(
      (a, c) => ({
        esperadoVentas: a.esperadoVentas + c.esperadoVentas,
        ventasEfectivas: a.ventasEfectivas + c.ventasEfectivas,
        comisionEsperada: a.comisionEsperada + c.comisionEsperada,
        comisionEfectiva: a.comisionEfectiva + c.comisionEfectiva,
        uNetaEsperada: a.uNetaEsperada + c.uNetaEsperada,
        uNetaEfectiva: a.uNetaEfectiva + c.uNetaEfectiva,
        pkAsign: a.pkAsign + c.pkAsign,
        pkRest: a.pkRest + c.pkRest,
        pkVendInv: a.pkVendInv + c.pkVendInv,
      }),
      {
        esperadoVentas: 0,
        ventasEfectivas: 0,
        comisionEsperada: 0,
        comisionEfectiva: 0,
        uNetaEsperada: 0,
        uNetaEfectiva: 0,
        pkAsign: 0,
        pkRest: 0,
        pkVendInv: 0,
      },
    );

    let ventasTabPk = 0;
    let ventasTabMonto = 0;
    let ventasTabCom = 0;
    let ventasTabUn = 0;
    for (const sl of salesForMasterFiltered) {
      const probe: Record<string, SaleAttrib> = {};
      accumulateSalesByMaster(sl.data, sellersById, probe, {}, contado);
      const a = probe[mid] || emptyAttrib();
      ventasTabPk += a.packages;
      ventasTabMonto += a.monto;
      ventasTabCom += a.vendorGain;
      ventasTabUn += a.inversorGain;
    }

    return {
      pkVendidos: pkV,
      montoVendido: montoV,
      ubVendida: ubV,
      faltaParaMetaIsla,
      inversionMaestra: drawerRow.subtotal,
      metaVentaIsla: drawerRow.totalIsla,
      invGain,
      vendGain,
      cards,
      sumCards,
      salesForMaster: salesForMasterFiltered,
      ventasTab: {
        pk: round2(ventasTabPk),
        monto: round2(ventasTabMonto),
        com: round2(ventasTabCom),
        un: round2(ventasTabUn),
      },
    };
  }, [
    drawerRow,
    rows,
    salesList,
    sellersById,
    attribPair,
    ventasAtribFilter,
  ]);

  useEffect(() => {
    if (drawerRow) setDrawerTab("vendedores");
  }, [drawerRow?.id]);

  const saveSnapshot = async () => {
    setSavingSnap(true);
    setSnapshotMsg("");
    try {
      await addDoc(collection(db, "managementAccount"), {
        type: "candies_utilidades",
        scope: "period",
        branchFocus: "ISLA",
        from: String(from).slice(0, 10),
        to: String(to).slice(0, 10),
        ventasAtrib: ventasAtribFilter,
        createdAt: serverTimestamp(),
        totals: {
          inversionMaestras: round2(totals.subtotal),
          ventaEsperadaIsla: round2(totals.totalIsla),
          uBrutaMaestra: round2(totals.uBruta),
          logisticaMaestras: round2(totals.log),
          paquetesAsignadosVendedor: round2(totals.dispA),
          paquetesVendidosAtrib: round2(totals.vend),
          ventasEfectivas: round2(totals.ve),
          ubEfectiva: round2(totals.ube),
          masterOrdersInRange: rows.length,
        },
      });
      setSnapshotMsg("✅ Resumen guardado en managementAccount.");
    } catch (e) {
      console.error(e);
      setSnapshotMsg("❌ No se pudo guardar. ¿Índices Firestore?");
    } finally {
      setSavingSnap(false);
    }
  };

  const chipCls = (on: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
      on
        ? "bg-slate-800 text-white border-slate-800"
        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
    }`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600 max-w-3xl">
          <strong>Dispers.</strong> = paquetes asignados a órdenes de vendedor
          (desde esta maestra). <strong>Vendido</strong> = paquetes de ventas
          vinculadas por <code className="text-xs">allocationsByItem</code>.{" "}
          <strong>Ventas efectivas</strong> y <strong>comisión atribuida</strong>{" "}
          usan el mismo monto de línea y la misma regla de comisión que{" "}
          <strong>Cierre de ventas dulces</strong> (precio×paq − desc., comisión
          prorrateada desde <code className="text-xs">vendorCommissionAmount</code>
          ). <strong>UB Efectiva</strong> sigue viniendo de los ítems. Las
          utilidades “esperadas” de vendedor están en el drawer, no en la fila de
          la maestra.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <RefreshButton onClick={onRefresh} loading={loading} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="!rounded-xl"
            disabled={savingSnap || loading}
            onClick={() => void saveSnapshot()}
          >
            {savingSnap ? "Guardando…" : "Registrar snapshot"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Atribución ventas:</span>
        <button
          type="button"
          className={chipCls(ventasAtribFilter === "todos")}
          onClick={() => setVentasAtribFilter("todos")}
        >
          Todas (cash + crédito)
        </button>
        <button
          type="button"
          className={chipCls(ventasAtribFilter === "contado")}
          onClick={() => setVentasAtribFilter("contado")}
        >
          Solo CONTADO
        </button>
      </div>
      <p className="text-xs text-slate-500 -mt-2">
        Crédito factura utilidad antes de cobrar; usá “Solo CONTADO” para ver lo
        más cercano al efectivo cobrado.
      </p>

      {snapshotMsg ? (
        <div className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {snapshotMsg}
        </div>
      ) : null}

      <DrawerMoneyStrip
        items={[
          {
            label: "Inversión maestras (periodo)",
            value: money(totals.subtotal),
            tone: "slate",
          },
          {
            label: "Ventas efectivas (atrib.)",
            value: money(totals.ve),
            tone: "blue",
          },
          {
            label: "UB Efectiva (atrib.)",
            value: money(totals.ube),
            tone: "emerald",
          },
        ]}
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <p className="px-3 py-2 text-[10px] text-slate-500 border-b border-slate-100 bg-slate-50/90 whitespace-nowrap">
          Deslizá horizontalmente para ver el texto completo. Paquetes = números enteros.
        </p>
        <table className="min-w-max w-full text-[15px] leading-snug text-slate-800">
          <thead className="bg-slate-100 text-left">
            <tr>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold whitespace-nowrap">
                Fecha
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold whitespace-nowrap">
                Orden
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                P. Ingresados
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                P. Restantes
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                Dispers.
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                Vendido
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                Inversión
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                Venta Isla
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap bg-violet-50/90">
                U.Bruta Maestra
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap bg-sky-50/90">
                Ventas efectivas
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap bg-emerald-50/90">
                UB Efectiva
              </th>
              <th className="px-2 py-1.5 border-b border-slate-200 font-semibold text-right whitespace-nowrap">
                Logística
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={12} className="p-6 text-center text-slate-500 border-b border-slate-100">
                  No hay órdenes maestras en este rango.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  className="border-b border-slate-100 hover:bg-slate-50/80 cursor-pointer"
                  onClick={() => setDrawerRow(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setDrawerRow(r);
                  }}
                >
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.date}</td>
                  <td className="px-2 py-1.5 font-medium text-left whitespace-nowrap">
                    {r.name}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {fmtPacks(r.totalPackages)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {fmtPacks(r.remainingMasterPacks)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {fmtPacks(r.dispersAsignada)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-900 whitespace-nowrap">
                    {fmtPacks(r.vendidoPacks)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {money(r.subtotal)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {money(r.totalIsla)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums bg-violet-50/50 whitespace-nowrap">
                    {money(r.uBrutaGlobal)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums bg-sky-50/50 whitespace-nowrap">
                    {money(r.ventasEfectivas)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums bg-emerald-50/50 whitespace-nowrap">
                    {money(r.ubEfectiva)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {money(r.logisticsCost)}
                  </td>
                </tr>
              ))
            )}
            {rows.length > 0 ? (
              <tr className="bg-slate-200/60 font-semibold">
                <td className="px-2 py-1.5 border-t border-slate-300 whitespace-nowrap" colSpan={2}>
                  Totales
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  —
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {fmtPacks(totals.remM)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {fmtPacks(totals.dispA)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {fmtPacks(totals.vend)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.subtotal)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.totalIsla)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.uBruta)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.ve)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.ube)}
                </td>
                <td className="px-2 py-1.5 border-t border-slate-300 text-right tabular-nums whitespace-nowrap">
                  {money(totals.log)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <SlideOverDrawer
        open={drawerRow !== null}
        onClose={() => setDrawerRow(null)}
        title={drawerRow?.name ?? "Orden maestra"}
        subtitle={drawerRow ? `${drawerRow.date} · ISLA` : undefined}
        titleId="drawer-candies-util-maestra"
        panelMaxWidthClassName="max-w-2xl"
      >
        {drawerRow && drawerDetail ? (
          <>
            <DrawerSectionTitle className="mt-0">
              1 · Lo que invertiste y la meta de la maestra
            </DrawerSectionTitle>
            <DrawerMoneyStrip
              items={[
                {
                  label: "Inversión (costo maestra)",
                  value: money(drawerDetail.inversionMaestra),
                  tone: "slate",
                },
                {
                  label: "Venta Isla (meta si liquidás todo)",
                  value: money(drawerDetail.metaVentaIsla),
                  tone: "blue",
                },
                {
                  label: "U.Bruta maestra (plan)",
                  value: money(drawerRow.uBrutaGlobal),
                  tone: "slate",
                },
              ]}
            />

            <DrawerSectionTitle>2 · Ventas ya atribuidas a esta maestra</DrawerSectionTitle>
            <DrawerMoneyStrip
              items={[
                {
                  label: "Paquetes vendidos (atrib.)",
                  value: fmtPacks(drawerDetail.pkVendidos),
                  tone: "slate",
                },
                {
                  label: "Monto vendido (atrib.)",
                  value: money(drawerDetail.montoVendido),
                  tone: "blue",
                },
                {
                  label: "Falta $ para meta Venta Isla",
                  value: money(drawerDetail.faltaParaMetaIsla),
                  tone: "emerald",
                },
              ]}
            />
            <p className="text-[10px] text-slate-500 mt-1 leading-snug">
              <strong>Falta $ para meta</strong> = Venta Isla de la maestra menos
              monto ya vendido atribuido. Negativo = ya superaste esa meta en
              ventas atribuidas.
            </p>

            <DrawerSectionTitle>3 · Lo que ya ganaste (solo vendido atribuido)</DrawerSectionTitle>
            <DrawerMoneyStrip
              items={[
                {
                  label: "UB efectiva",
                  value: money(drawerDetail.ubVendida),
                  tone: "blue",
                },
                {
                  label: "U. Neta efectiva",
                  value: money(drawerDetail.invGain),
                  tone: "emerald",
                },
                {
                  label: "Comisión vendedor (efectiva)",
                  value: money(drawerDetail.vendGain),
                  tone: "slate",
                },
              ]}
            />

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={chipCls(drawerTab === "vendedores")}
                onClick={() => setDrawerTab("vendedores")}
              >
                Órdenes vendedor
              </button>
              <button
                type="button"
                className={chipCls(drawerTab === "ventas")}
                onClick={() => setDrawerTab("ventas")}
              >
                Ventas
              </button>
            </div>

            {drawerTab === "vendedores" ? (
              <div className="mt-3 space-y-4">
                <p className="text-[11px] text-slate-500 leading-snug">
                  Una tarjeta por <strong>orden de vendedor</strong> (si hay
                  varias líneas de inventario para la misma orden, se suman
                  aquí).
                </p>
                {drawerDetail.cards.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Sin órdenes de vendedor enlazadas a esta maestra.
                  </p>
                ) : (
                  drawerDetail.cards.map((c) => (
                    <div
                      key={
                        c.orderKey !== "—"
                          ? `ord-${c.orderKey}`
                          : `doc-${c.sellerDocId}`
                      }
                      className="overflow-hidden rounded-2xl border border-slate-200/90 bg-gradient-to-br from-white via-white to-slate-50/90 shadow-sm ring-1 ring-slate-100/80"
                    >
                      <div className="border-l-[5px] border-violet-500 pl-3 pr-3 py-3 sm:pl-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-violet-700/90">
                              Orden vendedor
                            </p>
                            <h4 className="mt-0.5 text-[15px] font-bold leading-tight text-slate-900">
                              {c.orderName}
                            </h4>
                            <p className="mt-1 text-xs text-slate-600">
                              {c.sellerName}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <span className="inline-flex rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-bold text-violet-900">
                              Margen {c.marginPct}%
                            </span>
                            {c.orderKey !== "—" ? (
                              <p
                                className="mt-1.5 max-w-[10rem] truncate text-[10px] text-slate-400 font-mono sm:max-w-none"
                                title={c.orderKey}
                              >
                                {c.orderKey}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-2">
                          {[
                            {
                              lab: "Asignados",
                              val: fmtPacks(c.pkAsign),
                              sub: "desde maestra",
                            },
                            {
                              lab: "Restantes",
                              val: fmtPacks(c.pkRest),
                              sub: "en inventario",
                            },
                            {
                              lab: "Salidos inv.",
                              val: fmtPacks(c.pkVendInv),
                              sub: "mov. inventario",
                            },
                          ].map((x) => (
                            <div
                              key={x.lab}
                              className="rounded-xl border border-slate-100 bg-white/90 px-2 py-2 text-center shadow-[0_1px_0_0_rgba(15,23,42,0.04)]"
                            >
                              <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                {x.lab}
                              </p>
                              <p className="mt-0.5 text-base font-bold tabular-nums text-slate-900">
                                {x.val}
                              </p>
                              <p className="text-[9px] text-slate-400 leading-tight">
                                {x.sub}
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3">
                            <p className="text-[10px] font-bold uppercase text-slate-500">
                              Esperado (toda la orden)
                            </p>
                            <ul className="mt-2 space-y-1.5 text-[14px]">
                              <li className="flex justify-between gap-2">
                                <span className="text-slate-500">Ventas</span>
                                <span className="font-semibold tabular-nums text-slate-800">
                                  {money(c.esperadoVentas)}
                                </span>
                              </li>
                              <li className="flex justify-between gap-2">
                                <span className="text-slate-500">Comisión vendedor</span>
                                <span className="tabular-nums text-slate-700">
                                  {money(c.comisionEsperada)}
                                </span>
                              </li>
                              <li className="flex justify-between gap-2 border-t border-slate-200/60 pt-1.5">
                                <span className="text-slate-600 font-medium">
                                  Tu U. Neta esperada
                                </span>
                                <span className="font-bold tabular-nums text-slate-900">
                                  {money(c.uNetaEsperada)}
                                </span>
                              </li>
                            </ul>
                          </div>
                          <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/50 p-3">
                            <p className="text-[10px] font-bold uppercase text-emerald-800">
                              Efectivo (ya vendido)
                            </p>
                            <ul className="mt-2 space-y-1.5 text-[14px]">
                              <li className="flex justify-between gap-2">
                                <span className="text-emerald-900/70">Ventas</span>
                                <span className="font-semibold tabular-nums text-emerald-950">
                                  {money(c.ventasEfectivas)}
                                </span>
                              </li>
                              <li className="flex justify-between gap-2">
                                <span className="text-emerald-900/70">Comisión</span>
                                <span className="tabular-nums text-emerald-900">
                                  {money(c.comisionEfectiva)}
                                </span>
                              </li>
                              <li className="flex justify-between gap-2 border-t border-emerald-200/60 pt-1.5">
                                <span className="font-medium text-emerald-900">
                                  Tu U. Neta efectiva
                                </span>
                                <span className="font-bold tabular-nums text-emerald-900">
                                  {money(c.uNetaEfectiva)}
                                </span>
                              </li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}

                <DrawerSectionTitle>Resumen (todas las líneas)</DrawerSectionTitle>
                <DrawerDetailDlCard
                  title="Esperado vs efectivo"
                  rows={[
                    {
                      label: "Esperado ventas",
                      value: money(drawerDetail.sumCards.esperadoVentas),
                    },
                    {
                      label: "Ventas efectivas",
                      value: money(drawerDetail.sumCards.ventasEfectivas),
                    },
                    {
                      label: "Comisión esperada",
                      value: money(drawerDetail.sumCards.comisionEsperada),
                    },
                    {
                      label: "Comisión efectiva",
                      value: money(drawerDetail.sumCards.comisionEfectiva),
                    },
                    {
                      label: "U.Neta esperada",
                      value: money(drawerDetail.sumCards.uNetaEsperada),
                    },
                    {
                      label: "U.Neta efectiva",
                      value: money(drawerDetail.sumCards.uNetaEfectiva),
                      ddClassName: "font-bold text-emerald-800 tabular-nums",
                    },
                    {
                      label: "Σ Paq. asignados",
                      value: fmtPacks(drawerDetail.sumCards.pkAsign),
                    },
                    {
                      label: "Σ Paq. restantes",
                      value: fmtPacks(drawerDetail.sumCards.pkRest),
                    },
                    {
                      label: "Σ Paq. salidos inv.",
                      value: fmtPacks(drawerDetail.sumCards.pkVendInv),
                    },
                  ]}
                />
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <DrawerMoneyStrip
                  items={[
                    {
                      label: "Paq. vendidos (atrib.)",
                      value: fmtPacks(drawerDetail.ventasTab.pk),
                      tone: "slate",
                    },
                    {
                      label: "Monto",
                      value: money(drawerDetail.ventasTab.monto),
                      tone: "blue",
                    },
                    {
                      label: "Comisión",
                      value: money(drawerDetail.ventasTab.com),
                      tone: "slate",
                    },
                  ]}
                />
                <div className="rounded-lg border border-emerald-100 bg-emerald-50/80 px-3 py-2">
                  <div className="text-[11px] text-emerald-800 uppercase font-semibold">
                    Utilidad neta (vendido)
                  </div>
                  <div className="text-lg font-bold tabular-nums text-emerald-900">
                    {money(drawerDetail.ventasTab.un)}
                  </div>
                </div>

                <DrawerSectionTitle className="mt-0">
                  Ventas del periodo (documento completo, no por paquete){" "}
                  {ventasAtribFilter === "contado" ? "· solo CONTADO" : "· todas"}
                </DrawerSectionTitle>
                {drawerDetail.salesForMaster.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Ninguna venta con allocations a esta maestra en el periodo.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1">
                    {drawerDetail.salesForMaster.map((sl) => {
                      const t = String(sl.type || "").toUpperCase();
                      return (
                        <div
                          key={sl.id}
                          title={sl.id}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-slate-200/90 bg-white px-2.5 py-2 text-[11px] hover:bg-slate-50/80"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="font-semibold text-slate-800 whitespace-nowrap">
                              {sl.date}
                            </span>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${
                                t === "CONTADO"
                                  ? "border-green-200 bg-green-50 text-green-800"
                                  : "border-amber-200 bg-amber-50 text-amber-900"
                              }`}
                            >
                              {t === "CONTADO" ? "CONTADO" : "CRÉDITO"}
                            </span>
                            <span className="truncate text-slate-600 max-w-[12rem] sm:max-w-[18rem]">
                              {sl.vendorName}
                            </span>
                          </div>
                          <span className="shrink-0 font-bold tabular-nums text-slate-900">
                            {money(sl.total)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}
      </SlideOverDrawer>
    </div>
  );
}
