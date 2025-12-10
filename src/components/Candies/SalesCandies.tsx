// src/components/Candies/SalesCandiesPOS.tsx
// IMPORTANTE: ahora la venta descuenta del pedido del vendedor (inventory_candies_sellers)

import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import jsPDF from "jspdf";

type ClientType = "CONTADO" | "CREDITO";
type Status = "ACTIVO" | "BLOQUEADO";
type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

// Sucursal guardada en sellers_candies
type SellerBranchLabel = "Rivas" | "Isla Ometepe" | "San Jorge";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

const PLACES = [
  "Altagracia",
  "Taguizapa",
  "El paso",
  "Calaysa",
  "Urbaite",
  "Las Pilas",
] as const;
type Place = (typeof PLACES)[number];

interface Customer {
  id: string;
  name: string;
  phone: string;
  place: Place | "";
  status: Status;
  creditLimit?: number;
  balance?: number;
}

interface Product {
  id: string;
  name: string;
  sku?: string;
  unitsPerPackage: number;
  priceRivas: number;
  priceSanJorge: number;
  priceIsla: number;
}

// Catálogo de vendedores
interface Vendor {
  id: string;
  name: string;
  branch: Branch; // sucursal normalizada
  branchLabel: string; // label como se guarda en sellers_candies
  commissionPercent: number; // % comisión sobre la venta
}

/**
 * Item seleccionado en la venta (todo en PAQUETES a nivel visual).
 * - qtyPackages → cantidad vendida en paquetes
 * - availableUnits → stock real en unidades (del PEDIDO DEL VENDEDOR)
 * - unitsPerPackage → unidades por paquete
 * - pricePerPackage → precio POR PAQUETE según sucursal
 */
interface SelectedItem {
  productId: string;
  productName: string;
  sku?: string;
  unitsPerPackage: number;
  pricePerPackage: number; // precio por paquete
  availableUnits: number; // stock real (unidades)
  qtyPackages: number; // cantidad vendida (paquetes)
  discount: number; // entero (C$) aplicado a este ítem
}

interface VoucherItem {
  productName: string;
  qty: number; // paquetes
  unitPrice: number; // precio por paquete
  total: number;
}

function branchLabel(branch: Branch): string {
  switch (branch) {
    case "RIVAS":
      return "Rivas";
    case "SAN_JORGE":
      return "San Jorge";
    case "ISLA":
      return "Isla de Ometepe";
    default:
      return "";
  }
}

function sellerBranchLabelToBranch(label: string | undefined): Branch {
  switch (label) {
    case "Rivas":
      return "RIVAS";
    case "San Jorge":
      return "SAN_JORGE";
    case "Isla Ometepe":
      return "ISLA";
    default:
      return "RIVAS";
  }
}

/** Genera el PDF tipo voucher para la venta de dulces (sin autotable) */
function generateCandyVoucherPDF(args: {
  saleId: string;
  date: string;
  customerName: string;
  branch: Branch;
  items: VoucherItem[];
  total: number;
  vendorName?: string;
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number;
}) {
  const {
    saleId,
    date,
    customerName,
    branch,
    items,
    total,
    vendorName,
    vendorCommissionPercent,
    vendorCommissionAmount,
  } = args;

  const doc = new jsPDF();
  let y = 12;

  // Encabezado
  doc.setFontSize(14);
  doc.text("Multiservicios Ortiz", 10, y);
  y += 6;

  doc.setFontSize(12);
  doc.text("Recibo de venta certificada", 10, y);
  y += 8;

  doc.setFontSize(10);
  doc.text(`Fecha: ${date}`, 10, y);
  y += 5;
  doc.text(`Cliente: ${customerName || "Cliente Mostrador"}`, 10, y);
  y += 5;
  doc.text(`Sucursal: ${branchLabel(branch)}`, 10, y);
  y += 5;
  doc.text(`Autorizado: ${saleId}`, 10, y);
  y += 5;

  if (vendorName) {
    doc.text(`Vendedor: ${vendorName}`, 10, y);
    y += 5;
  }
  if (typeof vendorCommissionPercent === "number") {
    const amt = Number(vendorCommissionAmount || 0).toFixed(2);
    const pct = vendorCommissionPercent.toFixed(2);
    doc.text(`Comisión vendedor: ${pct}% — C$ ${amt}`, 10, y);
    y += 8;
  } else {
    y += 3;
  }

  // Encabezado de tabla simple
  doc.setFontSize(9);
  doc.text("Producto", 10, y);
  doc.text("Paquetes", 110, y, { align: "right" as any });
  doc.text("Precio.", 150, y, { align: "right" as any });
  doc.text("Subtotal", 200 - 10, y, { align: "right" as any });
  y += 4;
  doc.line(10, y, 200 - 10, y);
  y += 4;

  // Filas
  items.forEach((it) => {
    if (y > 270) {
      doc.addPage();
      y = 12;
    }

    const name =
      (it.productName || "").length > 50
        ? it.productName.slice(0, 47) + "..."
        : it.productName;

    doc.text(name, 10, y);
    doc.text(String(it.qty), 110, y, { align: "right" as any });
    doc.text(`C$ ${Number(it.unitPrice || 0).toFixed(2)}`, 150, y, {
      align: "right" as any,
    });
    doc.text(`C$ ${Number(it.total || 0).toFixed(2)}`, 200 - 10, y, {
      align: "right" as any,
    });
    y += 5;
  });

  y += 4;
  doc.line(10, y, 200 - 10, y);
  y += 6;

  // Total
  doc.setFontSize(11);
  doc.text(`Total: C$ ${Number(total || 0).toFixed(2)}`, 200 - 10, y, {
    align: "right" as any,
  });
  y += 6;

  doc.setFontSize(9);
  doc.text("Gracias por su compra.", 10, y);

  doc.save(`venta_dulces_${saleId}.pdf`);
}

// Helpers: AHORA lee stock desde el PEDIDO DEL VENDEDOR de forma más tolerante
async function getAvailableUnitsForCandyFromVendor(
  productId: string,
  vendorId: string
): Promise<number> {
  if (!productId || !vendorId) return 0;

  const qRef = query(
    collection(db, "inventory_candies_sellers"),
    where("sellerId", "==", vendorId),
    where("productId", "==", productId)
    // OJO: ya no filtramos aquí por remainingUnits > 0 para evitar problemas de índices
  );

  const snap = await getDocs(qRef);
  let available = 0;

  snap.forEach((d) => {
    const x = d.data() as any;
    // Tomamos el campo correcto según exista
    const rem = Number(x.remainingUnits ?? x.remaining ?? x.totalUnits ?? 0);
    if (rem > 0) {
      available += rem;
    }
  });

  return available;
}

// Descuenta unidades desde inventory_candies_sellers (pedido del vendedor) en FIFO
async function allocateSaleFIFOCandyFromVendor(args: {
  productId: string;
  vendorId: string;
  quantityUnits: number;
  saleDate: string;
  saleId: string;
}): Promise<{
  allocations: {
    inventorySellerId: string;
    productId: string;
    units: number;
    saleDate: string;
    saleId: string;
  }[];
}> {
  const { productId, vendorId, quantityUnits, saleDate, saleId } = args;
  let remaining = Math.max(0, Math.floor(Number(quantityUnits || 0)));
  const allocations: {
    inventorySellerId: string;
    productId: string;
    units: number;
    saleDate: string;
    saleId: string;
  }[] = [];

  if (!productId || !vendorId || remaining <= 0) {
    return { allocations: [] };
  }

  const qRef = query(
    collection(db, "inventory_candies_sellers"),
    where("sellerId", "==", vendorId),
    where("productId", "==", productId),
    where("remainingUnits", ">", 0),
    orderBy("date", "asc"),
    orderBy("createdAt", "asc")
  );

  const snap = await getDocs(qRef);

  for (const d of snap.docs) {
    if (remaining <= 0) break;
    const data = d.data() as any;
    const remUnits = Number(data.remainingUnits || 0);
    if (remUnits <= 0) continue;

    const take = Math.min(remUnits, remaining);
    const newRemUnits = remUnits - take;
    const unitsPerPackage = Math.max(
      1,
      Math.floor(Number(data.unitsPerPackage || 1))
    );
    const newRemPacks = Math.floor(newRemUnits / unitsPerPackage);

    await updateDoc(d.ref, {
      remainingUnits: newRemUnits,
      remainingPackages: newRemPacks,
    });

    allocations.push({
      inventorySellerId: d.id,
      productId,
      units: take,
      saleDate,
      saleId,
    });

    remaining -= take;
  }

  if (remaining > 0) {
    console.warn(
      "[allocateSaleFIFOCandyFromVendor] No alcanzó el inventario del vendedor, faltaron unidades.",
      { productId, vendorId, remaining }
    );
  }

  return { allocations };
}

function normalizePhone(input: string): string {
  const prefix = "+505 ";
  if (!input.startsWith(prefix)) {
    const digits = input.replace(/\D/g, "");
    return prefix + digits.slice(0, 8);
  }
  const rest = input.slice(prefix.length).replace(/\D/g, "");
  return prefix + rest.slice(0, 8);
}

// ===== NUEVO: Props opcionales para amarrar el vendedor al usuario logueado =====
// ===== NUEVO: Props opcionales para amarrar el vendedor al usuario logueado =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

interface SalesCandiesPOSProps {
  role?: RoleProp;
  sellerCandyId?: string; // id del vendedor de dulces asociado al usuario
  currentUserEmail?: string; // opcional, por si después lo usamos para algo más
}

export default function SalesCandiesPOS({
  role = "",
  sellerCandyId = "",
  currentUserEmail,
}: SalesCandiesPOSProps) {
  // Catálogos
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  // stockByProduct → stock en UNIDADES por productId DEL PEDIDO DEL VENDEDOR
  const [stockByProduct, setStockByProduct] = useState<Record<string, number>>(
    {}
  );

  // Generales
  const [clientType, setClientType] = useState<ClientType>("CONTADO");
  const [branch, setBranch] = useState<Branch>("RIVAS");
  const [customerId, setCustomerId] = useState<string>("");
  const [customerNameCash, setCustomerNameCash] = useState<string>("");
  const [saleDate, setSaleDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );

  // Vendedor seleccionado
  const [vendorId, setVendorId] = useState<string>("");
  const [lockVendor, setLockVendor] = useState<boolean>(false);

  // Selección de productos (múltiple)
  const [productId, setProductId] = useState<string>("");
  const [items, setItems] = useState<SelectedItem[]>([]);

  // Totales
  const totalPackages = useMemo(
    () => items.reduce((acc, it) => acc + (it.qtyPackages || 0), 0),
    [items]
  );
  const totalUnitsSold = useMemo(
    () =>
      items.reduce(
        (acc, it) => acc + (it.qtyPackages || 0) * (it.unitsPerPackage || 1),
        0
      ),
    [items]
  );
  const totalAmount = useMemo(() => {
    const sum = items.reduce((acc, it) => {
      const lineGross =
        (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
      const disc = Number(it.discount) || 0;
      const lineNet = Math.max(0, lineGross - disc);
      return acc + lineNet;
    }, 0);
    return Math.floor(sum * 100) / 100;
  }, [items]);

  const [downPayment, setDownPayment] = useState<number>(0);
  const [msg, setMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Modal cliente
  const [showModal, setShowModal] = useState(false);
  const [mName, setMName] = useState("");
  const [mPhone, setMPhone] = useState("+505 ");
  const [mPlace, setMPlace] = useState<Place | "">("");
  const [mNotes, setMNotes] = useState("");
  const [mStatus, setMStatus] = useState<Status>("ACTIVO");
  const [mCreditLimit, setMCreditLimit] = useState<number>(0);
  const resetModal = () => {
    setMName("");
    setMPhone("+505 ");
    setMPlace("");
    setMNotes("");
    setMStatus("ACTIVO");
    setMCreditLimit(0);
  };

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId]
  );
  const currentBalance = selectedCustomer?.balance || 0;
  const projectedBalance =
    clientType === "CREDITO"
      ? currentBalance +
        Math.max(0, Number(totalAmount || 0)) -
        Math.max(0, Number(downPayment || 0))
      : 0;

  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === vendorId) || null,
    [vendors, vendorId]
  );

  const vendorCommissionPercent = selectedVendor?.commissionPercent || 0;
  const vendorCommissionAmount = useMemo(() => {
    const total = Number(totalAmount || 0);
    const percent = Number(vendorCommissionPercent || 0);
    const result = (total * percent) / 100;

    return Number(result.toFixed(2)); // siempre con 2 decimales
  }, [totalAmount, vendorCommissionPercent]);

  // Cargar catálogos
  useEffect(() => {
    (async () => {
      // clientes (dulces)
      const qC = query(
        collection(db, "customers_candies"),
        orderBy("createdAt", "desc")
      );
      const cSnap = await getDocs(qC);
      const listC: Customer[] = [];
      cSnap.forEach((d) => {
        const x = d.data() as any;
        listC.push({
          id: d.id,
          name: x.name ?? "",
          phone: x.phone ?? "+505 ",
          place: x.place ?? "",
          status: (x.status as Status) ?? "ACTIVO",
          creditLimit: Number(x.creditLimit ?? 0),
          balance: 0,
        });
      });
      // saldos
      for (const c of listC) {
        try {
          const qMov = query(
            collection(db, "ar_movements"),
            where("customerId", "==", c.id)
          );
          const mSnap = await getDocs(qMov);
          let sum = 0;
          mSnap.forEach((m) => (sum += Number((m.data() as any).amount || 0)));
          c.balance = sum;
        } catch {
          c.balance = 0;
        }
      }
      setCustomers(listC);

      // productos (dulces)
      const qP = query(
        collection(db, "products_candies"),
        orderBy("createdAt", "desc")
      );
      const pSnap = await getDocs(qP);
      const listP: Product[] = [];
      pSnap.forEach((d) => {
        const x = d.data() as any;
        listP.push({
          id: d.id,
          name: x.name ?? "(sin nombre)",
          sku: x.sku ?? "",
          unitsPerPackage: Number(x.unitsPerPackage ?? 1),
          priceRivas: Number(x.unitPriceRivas ?? 0),
          priceSanJorge: Number(x.unitPriceSanJorge ?? 0),
          priceIsla: Number(x.unitPriceIsla ?? 0),
        });
      });
      setProducts(listP);

      // catálogo de vendedores (sellers_candies)
      try {
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const listV: Vendor[] = [];
        vSnap.forEach((d) => {
          const x = d.data() as any;
          const rawBranch: string = x.branch || "Rivas";
          const normalizedBranch = sellerBranchLabelToBranch(rawBranch);
          listV.push({
            id: d.id,
            name: x.name ?? "(sin nombre)",
            branch: normalizedBranch,
            branchLabel: rawBranch,
            commissionPercent: Number(x.commissionPercent ?? 0),
          });
        });
        setVendors(listV);
      } catch (e) {
        console.error("Error cargando vendedores:", e);
      }

      // OJO: stockByProduct se cargará por vendedor, no desde inventario general
      setStockByProduct({});
    })();
  }, []);

  // leer usuario logueado / vendedor asociado para autoseleccionar vendedor
  useEffect(() => {
    // 1) Si viene atado desde App (usuario vendedor de dulces)
    if (role === "vendedor_dulces" && sellerCandyId) {
      setVendorId(sellerCandyId);
      setLockVendor(true);
      // Opcional: mantener compat con lógica anterior de localStorage
      try {
        localStorage.setItem("pos_vendorId", sellerCandyId);
        localStorage.setItem("pos_role", "VENDEDOR");
      } catch {
        // ignorar errores de storage
      }
      return;
    }

    // 2) Comportamiento legacy: leer de localStorage
    try {
      const storedVendorId = localStorage.getItem("pos_vendorId") || "";
      const storedRole = localStorage.getItem("pos_role") || ""; // "ADMIN" | "VENDEDOR" | ...
      if (storedVendorId) {
        setVendorId(storedVendorId);
      }
      if (storedRole.toUpperCase() === "VENDEDOR") {
        setLockVendor(true); // el vendedor no puede cambiarse
      }
    } catch {
      // ignorar
    }
  }, [role, sellerCandyId]);

  // leer usuario logueado / vendedor asociado para autoseleccionar vendedor
  useEffect(() => {
    // 1) Si viene atado desde App (usuario vendedor de dulces)
    if (role === "vendedor_dulces" && sellerCandyId) {
      setVendorId(sellerCandyId);
      setLockVendor(true);
      // Opcional: mantener compat con lógica anterior de localStorage
      try {
        localStorage.setItem("pos_vendorId", sellerCandyId);
        localStorage.setItem("pos_role", "VENDEDOR");
      } catch {
        // ignorar errores de storage
      }
      return;
    }

    // 2) Comportamiento legacy: leer de localStorage (ej: kiosko fijo)
    try {
      const storedVendorId = localStorage.getItem("pos_vendorId") || "";
      const storedRole = localStorage.getItem("pos_role") || ""; // "ADMIN" | "VENDEDOR" | ...
      if (storedVendorId) {
        setVendorId(storedVendorId);
      }
      if (storedRole.toUpperCase() === "VENDEDOR") {
        setLockVendor(true); // el vendedor no puede cambiarse
      }
    } catch {
      // ignorar
    }
  }, [role, sellerCandyId]);

  // Cargar stock del pedido del vendedor seleccionado
  const reloadVendorStock = async (sellerId: string) => {
    if (!sellerId) {
      setStockByProduct({});
      return;
    }

    const qStockVendor = query(
      collection(db, "inventory_candies_sellers"),
      where("sellerId", "==", sellerId)
      // Igual que arriba: sin filtro de remainingUnits para evitar problemas de índice
    );

    const sSnap = await getDocs(qStockVendor);
    const map: Record<string, number> = {};

    sSnap.forEach((d) => {
      const b = d.data() as any;
      const pid = b.productId || "";
      if (!pid) return;

      const rem = Number(b.remainingUnits ?? b.remaining ?? b.totalUnits ?? 0);
      if (rem <= 0) return;

      map[pid] = (map[pid] || 0) + rem;
    });

    setStockByProduct(map);
  };

  // Cuando cambia el vendedor → setear sucursal y cargar sub-inventario
  useEffect(() => {
    if (!vendorId) {
      setStockByProduct({});
      return;
    }
    const v = vendors.find((vv) => vv.id === vendorId);
    if (v) {
      setBranch(v.branch); // sucursal viene del vendedor
    }
    reloadVendorStock(vendorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, vendors]);

  // Cuando cambia la sucursal (derivada del vendedor), actualizar precios por paquete
  useEffect(() => {
    setItems((prev) =>
      prev.map((it) => {
        const prod = products.find((p) => p.id === it.productId);
        if (!prod) return it;
        const price =
          branch === "RIVAS"
            ? prod.priceRivas
            : branch === "SAN_JORGE"
            ? prod.priceSanJorge
            : prod.priceIsla;
        return { ...it, pricePerPackage: Number(price) || 0 };
      })
    );
  }, [branch, products]);

  // Añadir producto (bloquea duplicados, usa stock del PEDIDO DEL VENDEDOR)
  const addProductToList = async (pid: string) => {
    if (!pid) return;
    if (!vendorId) {
      setMsg("Selecciona primero el vendedor para usar su inventario.");
      setProductId("");
      return;
    }
    if (items.some((it) => it.productId === pid)) {
      setProductId("");
      return;
    }

    const prod = products.find((p) => p.id === pid);
    if (!prod) {
      setProductId("");
      return;
    }

    // Stock del pedido del vendedor en UNIDADES
    const availableUnits = await getAvailableUnitsForCandyFromVendor(
      pid,
      vendorId
    );

    const price =
      branch === "RIVAS"
        ? prod.priceRivas
        : branch === "SAN_JORGE"
        ? prod.priceSanJorge
        : prod.priceIsla;

    const newItem: SelectedItem = {
      productId: pid,
      productName: prod.name || "",
      sku: prod.sku || "",
      unitsPerPackage: prod.unitsPerPackage || 1,
      pricePerPackage: Number(price) || 0,
      availableUnits: Number(availableUnits) || 0,
      qtyPackages: 0,
      discount: 0,
    };
    setItems((prev) => [...prev, newItem]);
    setProductId("");
  };

  const setItemQty = (pid: string, qtyRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (qtyRaw === "") return { ...it, qtyPackages: 0 };
        const n = Math.max(0, Math.floor(Number(qtyRaw)));
        return { ...it, qtyPackages: n };
      })
    );
  };

  // Actualizar descuento (entero)
  const setItemDiscount = (pid: string, discRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (discRaw === "") return { ...it, discount: 0 };
        const n = Math.max(0, Math.floor(Number(discRaw)));
        return { ...it, discount: n };
      })
    );
  };

  const removeItem = (pid: string) =>
    setItems((prev) => prev.filter((it) => it.productId !== pid));

  // Validaciones
  const validate = async (): Promise<string | null> => {
    if (!saleDate) return "Selecciona la fecha.";
    if (!vendorId) return "Selecciona el vendedor para esta venta.";
    if (items.length === 0) return "Agrega al menos un producto.";
    const itemsWithQty = items.filter((it) => (it.qtyPackages || 0) > 0);
    if (itemsWithQty.length === 0)
      return "Debes ingresar cantidades (> 0) en al menos un producto.";
    if (!(totalAmount > 0)) return "El total debe ser mayor a cero.";

    if (clientType === "CONTADO") {
      if (!customerNameCash.trim())
        return "Ingresa el nombre del cliente (contado).";
    } else {
      if (!customerId) return "Selecciona un cliente (crédito).";
      if (downPayment < 0) return "El pago inicial no puede ser negativo.";
      if (downPayment > totalAmount)
        return "El pago inicial no puede superar el total.";
      if (selectedCustomer?.status === "BLOQUEADO")
        return "El cliente está BLOQUEADO. No se puede facturar a crédito.";
    }

    // Stock y descuentos por ítem (contra PEDIDO DEL VENDEDOR)
    for (const it of itemsWithQty) {
      const unitsPerPackage = it.unitsPerPackage || 1;
      const qtyUnits = (it.qtyPackages || 0) * unitsPerPackage;

      const availableUnits = await getAvailableUnitsForCandyFromVendor(
        it.productId,
        vendorId
      );
      const availablePackages = Math.floor(availableUnits / unitsPerPackage);

      if (qtyUnits > availableUnits)
        return `Inventario insuficiente en el pedido del vendedor para "${it.productName}". Disponible: ${availablePackages} paquetes.`;

      const lineGross =
        (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
      const disc = Number(it.discount) || 0;
      if (!Number.isInteger(disc) || disc < 0)
        return `El descuento en "${it.productName}" debe ser entero y ≥ 0.`;
      if (disc > lineGross)
        return `El descuento en "${
          it.productName
        }" no puede exceder C$ ${lineGross.toFixed(2)}.`;
    }
    return null;
  };

  // Guardar
  const saveSale = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const err = await validate();
    if (err) {
      setMsg("❌ " + err);
      return;
    }

    try {
      setSaving(true);

      const itemsToSave = items
        .filter((it) => (it.qtyPackages || 0) > 0)
        .map((it) => {
          const unitsPerPackage = it.unitsPerPackage || 1;
          const qtyPaq = it.qtyPackages || 0;
          const qtyUnits = qtyPaq * unitsPerPackage;

          const lineGross = (Number(it.pricePerPackage) || 0) * (qtyPaq || 0);
          const disc = Math.max(0, Math.floor(Number(it.discount) || 0));
          const lineNet = Math.max(0, lineGross - disc);

          return {
            productId: it.productId,
            productName: it.productName,
            sku: it.sku || "",
            qty: qtyUnits, // UNIDADES (para inventario / restore)
            packages: qtyPaq, // paquetes visibles
            unitsPerPackage,
            branch,
            unitPricePackage: Number(it.pricePerPackage) || 0,
            discount: disc,
            total: Math.floor(lineNet * 100) / 100,
          };
        });

      const payload: any = {
        type: clientType,
        branch,
        date: saleDate,
        createdAt: Timestamp.now(),
        itemsTotal: Number(totalAmount) || 0,
        total: Number(totalAmount) || 0,
        quantity: Number(totalUnitsSold) || 0, // UNIDADES totales
        packagesTotal: Number(totalPackages) || 0,
        items: itemsToSave,
        vendorId,
      };

      const vendorObj = vendors.find((v) => v.id === vendorId);
      if (vendorObj) {
        payload.vendorName = vendorObj.name;
        payload.vendorBranch = vendorObj.branch;
        payload.vendorBranchLabel = vendorObj.branchLabel;
        payload.vendorCommissionPercent = vendorObj.commissionPercent || 0;
        payload.vendorCommissionAmount = vendorCommissionAmount || 0;
      }

      if (clientType === "CONTADO") {
        payload.customerName = customerNameCash.trim();
      } else {
        payload.customerId = customerId;
        payload.downPayment = Number(downPayment) || 0;
      }

      // 1) Crear venta (dulces)
      const saleRef = await addDoc(collection(db, "sales_candies"), payload);

      // 2) CxC crédito
      if (clientType === "CREDITO" && customerId) {
        const base = {
          customerId,
          date: saleDate,
          createdAt: Timestamp.now(),
          ref: { saleId: saleRef.id },
        };
        await addDoc(collection(db, "ar_movements"), {
          ...base,
          type: "CARGO",
          amount: Number(totalAmount) || 0,
        });
        if (Number(downPayment) > 0) {
          await addDoc(collection(db, "ar_movements"), {
            ...base,
            type: "ABONO",
            amount: -Number(downPayment),
          });
        }
      }

      // 3) FIFO por producto, PERO AHORA SOBRE EL PEDIDO DEL VENDEDOR
      const allocationsByItem: Record<
        string,
        {
          productId: string;
          vendorId: string;
          allocations: {
            inventorySellerId: string;
            productId: string;
            units: number;
            saleDate: string;
            saleId: string;
          }[];
        }
      > = {};

      for (const it of itemsToSave) {
        if (it.qty > 0) {
          const { allocations } = await allocateSaleFIFOCandyFromVendor({
            productId: it.productId,
            vendorId,
            quantityUnits: it.qty,
            saleDate,
            saleId: saleRef.id,
          });
          allocationsByItem[it.productId] = {
            productId: it.productId,
            vendorId,
            allocations,
          };
        }
      }

      // 4) Guardar allocations en la venta de dulces
      await updateDoc(doc(db, "sales_candies", saleRef.id), {
        allocationsByItem,
      });

      // 5) Generar voucher PDF
      try {
        const customerLabel =
          clientType === "CONTADO"
            ? customerNameCash.trim() || "Cliente Mostrador"
            : selectedCustomer?.name || "Cliente crédito";

        generateCandyVoucherPDF({
          saleId: saleRef.id,
          date: saleDate,
          customerName: customerLabel,
          branch,
          items: itemsToSave.map((it) => ({
            productName: it.productName,
            qty: it.packages,
            unitPrice: it.unitPricePackage,
            total: it.total,
          })),
          total: Number(totalAmount) || 0,
          vendorName: vendorObj?.name,
          vendorCommissionPercent: vendorObj?.commissionPercent || 0,
          vendorCommissionAmount,
        });
      } catch (e) {
        console.error("Error generando voucher PDF:", e);
      }

      // Reset
      setClientType("CONTADO");
      // branch se mantiene según el vendedor (no lo tocamos)
      setCustomerId("");
      setCustomerNameCash("");
      setSaleDate(new Date().toISOString().slice(0, 10));
      setItems([]);
      setDownPayment(0);
      // mantenemos vendorId (útil cuando es vendedor logueado)

      if (clientType === "CREDITO" && customerId) {
        setCustomers((prev) =>
          prev.map((c) =>
            c.id === customerId
              ? {
                  ...c,
                  balance:
                    (c.balance || 0) +
                    (Number(totalAmount) || 0) -
                    (Number(downPayment) || 0),
                }
              : c
          )
        );
      }

      setMsg("✅ Venta de dulces registrada");

      // Actualizar mapa de stock tras la venta (inventario del vendedor)
      if (vendorId) {
        await reloadVendorStock(vendorId);
      } else {
        setStockByProduct({});
      }
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar la venta de dulces");
    } finally {
      setSaving(false);
    }
  };

  // UI
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Ventas (Dulces)</h2>

      <form
        onSubmit={saveSale}
        className="bg-white p-4 rounded shadow border mb-6 grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        {/* Tipo de cliente */}
        <div>
          <label className="block text-sm font-semibold">Tipo de cliente</label>
          <select
            className="w-full border p-2 rounded"
            value={clientType}
            onChange={(e) => setClientType(e.target.value as ClientType)}
          >
            <option value="CONTADO">Contado</option>
            <option value="CREDITO">Crédito</option>
          </select>
        </div>

        {/* Cliente contado o crédito */}
        {clientType === "CONTADO" ? (
          <div>
            <label className="block text-sm font-semibold">
              Nombre del cliente (contado)
            </label>
            <input
              className="w-full border p-2 rounded"
              placeholder="Ej: Cliente Mostrador"
              value={customerNameCash}
              onChange={(e) => setCustomerNameCash(e.target.value)}
            />
          </div>
        ) : (
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold">
              Cliente (crédito)
            </label>
            <div className="flex gap-2">
              <select
                className="flex-1 border p-2 rounded"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Selecciona un cliente</option>
                {customers.map((c) => (
                  <option
                    key={c.id}
                    value={c.status === "ACTIVO" ? c.id : ""}
                    disabled={c.status === "BLOQUEADO"}
                  >
                    {c.name} | {c.phone} | Saldo: {money(c.balance || 0)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="px-20 py-2 rounded bg-green-600 text-white hover:bg-green-700"
                onClick={() => setShowModal(true)}
              >
                Crear Cliente
              </button>
            </div>

            {/* Saldos */}
            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-2 rounded bg-gray-50 border">
                <div className="text-xs text-gray-600">Saldo actual</div>
                <div className="text-lg font-semibold">
                  {money(currentBalance)}
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Pago inicial (opcional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={downPayment === 0 ? "" : downPayment}
                  onChange={(e) =>
                    setDownPayment(Math.max(0, Number(e.target.value || 0)))
                  }
                  placeholder="0.00"
                />
              </div>
              <div className="p-2 rounded bg-gray-50 border">
                <div className="text-xs text-gray-600">Saldo proyectado</div>
                <div className="text-lg font-semibold">
                  {money(projectedBalance)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Fecha */}
        <div>
          <label className="block text-sm font-semibold">Fecha de venta</label>
          <input
            type="date"
            className="w-full border p-2 rounded"
            value={saleDate}
            onChange={(e) => setSaleDate(e.target.value)}
          />
        </div>

        {/* Vendedor */}
        <div>
          <label className="block text-sm font-semibold">Vendedor</label>
          <select
            className="w-full border p-2 rounded"
            value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value);
              setItems([]); // por seguridad, si cambian de vendedor limpiamos los items
            }}
            disabled={lockVendor}
          >
            <option value="">Selecciona un vendedor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.branchLabel} — {v.commissionPercent.toFixed(2)}%
                {" comisión"}
              </option>
            ))}
          </select>
          {lockVendor && (
            <p className="text-xs text-gray-500 mt-1">
              Vendedor fijado por el usuario logueado.
            </p>
          )}
        </div>

        {/* Lista de precios / sucursal (derivada del vendedor, solo display) */}
        <div className="md:col-span-1">
          <label className="block text-sm font-semibold mb-1">
            Lista de precios / Sucursal
          </label>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                className="accent-blue-600"
                value="RIVAS"
                checked={branch === "RIVAS"}
                readOnly
                disabled
              />
              <span>Rivas</span>
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                className="accent-blue-600"
                value="SAN_JORGE"
                checked={branch === "SAN_JORGE"}
                readOnly
                disabled
              />
              <span>San Jorge</span>
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                className="accent-blue-600"
                value="ISLA"
                checked={branch === "ISLA"}
                readOnly
                disabled
              />
              <span>Isla de Ometepe</span>
            </label>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            La sucursal se toma automáticamente del vendedor seleccionado.
          </div>
        </div>

        {/* Selector de producto (agrega a lista) */}
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Producto</label>
          <select
            className="w-full border p-2 rounded"
            value={productId}
            onChange={async (e) => {
              const pid = e.target.value;
              setProductId(pid);
              await addProductToList(pid);
            }}
          >
            <option value="">Selecciona un producto</option>
            {products.map((p) => {
              const already = items.some((it) => it.productId === p.id);
              const stockUnits = stockByProduct[p.id] || 0; // stock del pedido del vendedor
              const stockPackages = p.unitsPerPackage
                ? Math.floor(stockUnits / p.unitsPerPackage)
                : stockUnits;
              const disabled = already || stockPackages <= 0;
              return (
                <option
                  key={p.id}
                  value={disabled ? "" : p.id}
                  disabled={disabled}
                >
                  {p.name} {p.sku ? `— ${p.sku}` : ""}{" "}
                  {stockPackages > 0
                    ? `(disp vendedor: ${stockPackages} paq.)`
                    : "(sin stock en pedido)"}
                  {already ? " (seleccionado)" : ""}
                </option>
              );
            })}
          </select>
          <div className="text-xs text-gray-500 mt-1">
            El stock mostrado es el disponible en el pedido del vendedor
            seleccionado.
          </div>
        </div>

        {/* Lista de productos seleccionados */}
        <div className="md:col-span-2">
          <div className="border rounded overflow-hidden">
            <div className="grid grid-cols-12 bg-gray-50 px-3 py-2 text-xs font-semibold border-b">
              <div className="col-span-4">Producto</div>
              <div className="col-span-2 text-right">Precio (paq.)</div>
              <div className="col-span-2 text-right">Existencias (paq.)</div>
              <div className="col-span-1 text-right">Cantidad (paq.)</div>
              <div className="col-span-1 text-right">Descuento</div>
              <div className="col-span-1 text-right">Monto</div>
              <div className="col-span-1 text-center">Quitar</div>
            </div>

            {items.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-500">
                No hay productos agregados.
              </div>
            ) : (
              items.map((it) => {
                const packagesAvailable = it.unitsPerPackage
                  ? Math.floor((it.availableUnits || 0) / it.unitsPerPackage)
                  : 0;
                const visualStock = Math.max(
                  0,
                  packagesAvailable - (it.qtyPackages || 0)
                );
                const lineGross =
                  (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
                const lineNet = Math.max(
                  0,
                  lineGross - (Number(it.discount) || 0)
                );

                return (
                  <div
                    key={it.productId}
                    className="grid grid-cols-12 items-center px-3 py-2 border-b text-sm gap-x-2"
                  >
                    <div className="col-span-4">
                      <div className="font-medium">
                        {it.productName}
                        {it.sku ? ` — ${it.sku}` : ""}
                      </div>
                    </div>

                    <div className="col-span-2 text-right">
                      {money(it.pricePerPackage)}
                    </div>
                    <div className="col-span-2 text-right">
                      {visualStock} paq.
                    </div>

                    <div className="col-span-1">
                      <input
                        type="number"
                        step="0"
                        min={0}
                        className="w-full border p-1 rounded text-right"
                        value={
                          Number.isNaN(it.qtyPackages) || it.qtyPackages === 0
                            ? ""
                            : it.qtyPackages
                        }
                        onChange={(e) =>
                          setItemQty(it.productId, e.target.value)
                        }
                        inputMode="numeric"
                        placeholder="0"
                        title="Cantidad de paquetes"
                      />
                    </div>

                    <div className="col-span-1">
                      <input
                        type="number"
                        step="1"
                        min={0}
                        className="w-full border p-1 rounded text-right"
                        value={
                          Number.isNaN(it.discount) || it.discount === 0
                            ? ""
                            : it.discount
                        }
                        onChange={(e) =>
                          setItemDiscount(it.productId, e.target.value)
                        }
                        inputMode="numeric"
                        placeholder="0"
                        title="Descuento entero (C$)"
                      />
                    </div>

                    <div className="col-span-1 text-right">
                      {money(lineNet)}
                    </div>

                    <div className="col-span-1 text-center">
                      <button
                        type="button"
                        className="px-2 py-1 rounded bg-red-100 hover:bg-red-200"
                        onClick={() => removeItem(it.productId)}
                        title="Quitar producto"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {items.length > 0 && (
            <div className="flex justify-end gap-6 mt-3 text-sm">
              <div>
                <span className="text-gray-600">Paquetes totales: </span>
                <span className="font-semibold">{totalPackages}</span>
              </div>
              <div>
                <span className="text-gray-600">Total: </span>
                <span className="font-semibold">{money(totalAmount)}</span>
              </div>
              {/* NUEVO: Comisión del vendedor */}
              <div>
                <span className="text-gray-600">Comisión vendedor: </span>
                <span className="font-semibold">
                  {money(vendorCommissionAmount)}{" "}
                  {vendorCommissionPercent
                    ? `(${vendorCommissionPercent.toFixed(2)}%)`
                    : ""}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Guardar */}
        <div className="md:col-span-2">
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
            disabled={saving}
          >
            {saving ? "Guardando..." : "Registrar venta"}
          </button>
        </div>
      </form>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal: Crear cliente rápido */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-xl p-4">
            <h3 className="text-lg font-bold mb-3">Nuevo cliente</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold">Nombre</label>
                <input
                  className="w-full border p-2 rounded"
                  value={mName}
                  onChange={(e) => setMName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">Teléfono</label>
                <input
                  className="w-full border p-2 rounded"
                  value={mPhone}
                  onChange={(e) => setMPhone(normalizePhone(e.target.value))}
                  placeholder="+505 88888888"
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">Lugar</label>
                <select
                  className="w-full border p-2 rounded"
                  value={mPlace}
                  onChange={(e) => setMPlace(e.target.value as Place)}
                >
                  <option value="">—</option>
                  {PLACES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Estado</label>
                <select
                  className="w-full border p-2 rounded"
                  value={mStatus}
                  onChange={(e) => setMStatus(e.target.value as Status)}
                >
                  <option value="ACTIVO">ACTIVO</option>
                  <option value="BLOQUEADO">BLOQUEADO</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Límite de crédito (opcional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={mCreditLimit === 0 ? "" : mCreditLimit}
                  onChange={(e) =>
                    setMCreditLimit(Math.max(0, Number(e.target.value || 0)))
                  }
                  placeholder="Ej: 2000"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-semibold">
                  Comentario
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-20"
                  value={mNotes}
                  onChange={(e) => setMNotes(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => {
                  resetModal();
                  setShowModal(false);
                }}
              >
                Cancelar
              </button>
              <button
                className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
                onClick={async () => {
                  setMsg("");
                  if (!mName.trim()) {
                    setMsg("Ingresa el nombre del nuevo cliente.");
                    return;
                  }
                  const cleanPhone = normalizePhone(mPhone);
                  try {
                    const ref = await addDoc(
                      collection(db, "customers_candies"),
                      {
                        name: mName.trim(),
                        phone: cleanPhone,
                        place: mPlace || "",
                        notes: mNotes || "",
                        status: mStatus,
                        creditLimit: Number(mCreditLimit || 0),
                        createdAt: Timestamp.now(),
                      }
                    );
                    const newC: Customer = {
                      id: ref.id,
                      name: mName.trim(),
                      phone: cleanPhone,
                      place: mPlace || "",
                      status: mStatus,
                      creditLimit: Number(mCreditLimit || 0),
                      balance: 0,
                    };
                    setCustomers((prev) => [newC, ...prev]);
                    setCustomerId(ref.id);
                    resetModal();
                    setShowModal(false);
                    setMsg("✅ Cliente creado");
                  } catch (e) {
                    console.error(e);
                    setMsg("❌ Error al crear cliente");
                  }
                }}
              >
                Guardar cliente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay de guardado */}
      {saving && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl border px-4 py-3 flex items-center gap-3">
            <svg
              className="h-5 w-5 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <span className="font-medium">Guardando venta…</span>
          </div>
        </div>
      )}
    </div>
  );
}
