// src/components/Candies/CustomersCandy.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";

const PLACES = [
  "Altagracia",
  "Taguizapa",
  "El paso",
  "Calaysa",
  "Urbaite",
  "Las Pilas",
] as const;

type Place = (typeof PLACES)[number];
type Status = "ACTIVO" | "BLOQUEADO";

interface CustomerRow {
  id: string;
  name: string;
  phone: string; // formato +505 88888888
  place: Place | "";
  notes?: string;
  status: Status;
  creditLimit?: number;
  createdAt: Timestamp;
  balance?: number; // calculado
  sellerId?: string;

  // ✅ NUEVO
  vendorId?: string; // vendedor asociado
  vendorName?: string; // nombre vendedor (histórico/visual)
  initialDebt?: number; // deuda inicial fija
}

interface MovementRow {
  id: string;
  date: string; // yyyy-MM-dd
  type: "CARGO" | "ABONO";
  amount: number; // CARGO > 0, ABONO < 0
  ref?: { saleId?: string };
  comment?: string;
  createdAt?: Timestamp;
}

interface SellerRow {
  id: string;
  name: string;
  status?: string;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// Enforce "+505 " prefijo y solo dígitos luego
function normalizePhone(input: string): string {
  const prefix = "+505 ";
  if (!input.startsWith(prefix)) {
    const digits = input.replace(/\D/g, "");
    return prefix + digits.slice(0, 8);
  }
  const rest = input.slice(prefix.length).replace(/\D/g, "");
  return prefix + rest.slice(0, 8);
}

// ==== helpers CxC ====
// Eliminar movimientos de CxC ligados a una venta específica
async function deleteARMovesBySaleId(saleId: string) {
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId)
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id)))
  );
}

// ===== NUEVO: Props para restringir por vendedor / rol =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

interface CustomersCandyProps {
  role?: RoleProp;
  sellerCandyId?: string; // id del vendedor de dulces asociado al usuario
  currentUserEmail?: string;
}

export default function CustomersCandy({
  role = "",
  sellerCandyId = "",
  currentUserEmail,
}: CustomersCandyProps) {
  // ✅ FIX: normalizar role + sellerCandyId para que no “caiga” en modo admin por espacios/formatos
  const roleSafe = String(role || "")
    .trim()
    .toLowerCase();
  const sellerIdSafe = String(sellerCandyId || "").trim();

  const isVendor = roleSafe === "vendedor_dulces";
  const isAdmin = roleSafe === "admin";

  // ✅ lista de vendedores activos
  const [sellers, setSellers] = useState<SellerRow[]>([]);

  // ===== Modal Detalle de Ítems (venta) =====
  const [itemsModalOpen, setItemsModalOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number;
      unitPrice: number;
      discount?: number;
      total: number;
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);
    try {
      const snap = await getDocs(
        query(collection(db, "sales_candies"), where("__name__", "==", saleId))
      );
      const docSnap = snap.docs[0];
      const data = docSnap?.data() as any;
      const arr = Array.isArray(data?.items)
        ? data.items
        : data?.item
        ? [data.item]
        : [];
      const rows = arr.map((it: any) => ({
        productName: String(it.productName || ""),
        qty: Number(it.qty || 0),
        unitPrice: Number(it.unitPrice || 0),
        discount: Number(it.discount || 0),
        total: Number(it.total || 0),
      }));
      setItemsModalRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // ===== Formulario (crear) =====
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+505 ");
  const [place, setPlace] = useState<Place | "">("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<Status>("ACTIVO");
  const [creditLimit, setCreditLimit] = useState<number>(0);

  // ✅ NUEVO crear: vendedor + deuda inicial
  const [vendorId, setVendorId] = useState<string>("");
  const [initialDebt, setInitialDebt] = useState<number>(0);

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // ===== Edición inline =====
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [ePhone, setEPhone] = useState("+505 ");
  const [ePlace, setEPlace] = useState<Place | "">("");
  const [eNotes, setENotes] = useState("");
  const [eStatus, setEStatus] = useState<Status>("ACTIVO");
  const [eCreditLimit, setECreditLimit] = useState<number>(0);

  // ✅ NUEVO editar: vendedor (deuda inicial NO se edita)
  const [eVendorId, setEVendorId] = useState<string>("");

  // ===== Estado de cuenta (modal) =====
  const [showStatement, setShowStatement] = useState(false);
  const [stCustomer, setStCustomer] = useState<CustomerRow | null>(null);
  const [stLoading, setStLoading] = useState(false);
  const [stRows, setStRows] = useState<MovementRow[]>([]);
  const [stKpis, setStKpis] = useState({
    saldoActual: 0,
    totalAbonado: 0,
    totalCargos: 0,
  });

  // ===== Modal Abonar =====
  const [showAbono, setShowAbono] = useState(false);
  const [abonoAmount, setAbonoAmount] = useState<number>(0);
  const [abonoDate, setAbonoDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [abonoComment, setAbonoComment] = useState<string>("");
  const [savingAbono, setSavingAbono] = useState(false);

  // ===== Editar / Eliminar movimiento =====
  const [editMovId, setEditMovId] = useState<string | null>(null);
  const [eMovDate, setEMovDate] = useState<string>("");
  const [eMovAmount, setEMovAmount] = useState<number>(0);
  const [eMovComment, setEMovComment] = useState<string>("");

  // 👉 Modal Crear Cliente
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Cargar vendedores + clientes y saldos
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);

        // ✅ FIX: si es vendedor y no hay sellerCandyId, no cargar para que NO aparezcan clientes “generales”
        if (isVendor && !sellerIdSafe) {
          setRows([]);
          setMsg(
            "❌ Este usuario no tiene vendedor asociado (sellerCandyId vacío)."
          );
          return;
        }

        // ✅ vendedores (solo activos)
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const vList: SellerRow[] = [];
        vSnap.forEach((d) => {
          const x = d.data() as any;
          const st = String(x.status || "ACTIVO"); // si no existe, asumimos ACTIVO
          if (st !== "ACTIVO") return;
          vList.push({ id: d.id, name: String(x.name || ""), status: st });
        });
        setSellers(vList);

        // ✅ clientes (filtrado por vendedor si aplica)
        const qC = isVendor
          ? query(
              collection(db, "customers_candies"),
              where("vendorId", "==", sellerIdSafe),
              orderBy("createdAt", "desc")
            )
          : query(
              collection(db, "customers_candies"),
              orderBy("createdAt", "desc")
            );

        const snap = await getDocs(qC);
        const list: CustomerRow[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name ?? "",
            phone: x.phone ?? "+505 ",
            place: (x.place as Place) ?? "",
            notes: x.notes ?? "",
            status: (x.status as Status) ?? "ACTIVO",
            creditLimit: Number(x.creditLimit ?? 0),
            createdAt: x.createdAt ?? Timestamp.now(),
            balance: 0,
            sellerId: x.sellerId || "",

            vendorId: x.vendorId || "",
            vendorName: x.vendorName || "",
            initialDebt: Number(x.initialDebt || 0),
          });
        });

        // Saldos
        for (const c of list) {
          try {
            const qMov = query(
              collection(db, "ar_movements"),
              where("customerId", "==", c.id)
            );
            const mSnap = await getDocs(qMov);
            let sum = 0;
            mSnap.forEach(
              (m) => (sum += Number((m.data() as any).amount || 0))
            );
            c.balance = sum;
          } catch {
            c.balance = 0;
          }
        }

        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando clientes.");
      } finally {
        setLoading(false);
      }
    })();
  }, [isVendor, sellerIdSafe]);

  const resetForm = () => {
    setName("");
    setPhone("+505 ");
    setPlace("");
    setNotes("");
    setStatus("ACTIVO");
    setCreditLimit(0);

    // ✅ NUEVO
    setVendorId("");
    setInitialDebt(0);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!name.trim()) {
      setMsg("Ingresa el nombre.");
      return;
    }
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 6) {
      setMsg("Teléfono incompleto.");
      return;
    }

    // ✅ vendor final
    const finalVendorId = isVendor
      ? sellerIdSafe
      : String(vendorId || "").trim();
    const finalVendorName = finalVendorId
      ? sellers.find((s) => s.id === finalVendorId)?.name || ""
      : "";

    try {
      const ref = await addDoc(collection(db, "customers_candies"), {
        name: name.trim(),
        phone: cleanPhone,
        place: place || "",
        notes: notes || "",
        status,
        creditLimit: Number(creditLimit || 0),

        // ✅ NUEVO
        vendorId: finalVendorId,
        vendorName: finalVendorName,
        initialDebt: Number(initialDebt || 0),

        createdAt: Timestamp.now(),
      });

      setRows((prev) => [
        {
          id: ref.id,
          name: name.trim(),
          phone: cleanPhone,
          place: place || "",
          notes: notes || "",
          status,
          creditLimit: Number(creditLimit || 0),

          // ✅ NUEVO
          vendorId: finalVendorId,
          vendorName: finalVendorName,
          initialDebt: Number(initialDebt || 0),

          createdAt: Timestamp.now(),
          balance: 0,
        },
        ...prev,
      ]);

      resetForm();
      setShowCreateModal(false);
      setMsg("✅ Cliente creado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al crear cliente");
    }
  };

  const startEdit = (c: CustomerRow) => {
    // ✅ FIX: vendedores NO pueden editar clientes desde listado
    if (isVendor) {
      setMsg(
        "❌ No permitido: vendedores no editan clientes desde el listado."
      );
      return;
    }

    setEditingId(c.id);
    setEName(c.name);
    setEPhone(c.phone || "+505 ");
    setEPlace(c.place || "");
    setENotes(c.notes || "");
    setEStatus(c.status || "ACTIVO");
    setECreditLimit(Number(c.creditLimit || 0));

    // ✅ NUEVO
    setEVendorId(String(c.vendorId || ""));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEName("");
    setEPhone("+505 ");
    setEPlace("");
    setENotes("");
    setEStatus("ACTIVO");
    setECreditLimit(0);

    // ✅ NUEVO
    setEVendorId("");
  };

  const saveEdit = async () => {
    // ✅ FIX: vendedores NO pueden editar clientes desde listado
    if (isVendor) {
      setMsg("❌ No permitido.");
      return;
    }

    if (!editingId) return;

    const cleanPhone = normalizePhone(ePhone);
    if (!eName.trim()) {
      setMsg("Ingresa el nombre.");
      return;
    }

    // ✅ reglas de asociación
    const current = rows.find((x) => x.id === editingId);
    const currentVendor = String(current?.vendorId || "");
    const nextVendor = isVendor ? sellerIdSafe : String(eVendorId || "");

    // vendedor NO puede tocar clientes de otros
    if (isVendor && currentVendor && currentVendor !== sellerIdSafe) {
      setMsg("❌ Este cliente pertenece a otro vendedor.");
      return;
    }

    // admin: no permitir reasignar directo si ya tiene vendedor (solo desasociar primero)
    if (
      isAdmin &&
      currentVendor &&
      nextVendor &&
      currentVendor !== nextVendor
    ) {
      setMsg(
        "❌ Este cliente ya está asociado a otro vendedor. Primero desasocia (deja vendedor en —) y guarda; luego lo puedes asignar."
      );
      return;
    }

    const finalVendorId = isVendor ? sellerIdSafe : String(eVendorId || "");
    const finalVendorName = finalVendorId
      ? sellers.find((s) => s.id === finalVendorId)?.name || ""
      : "";

    try {
      await updateDoc(doc(db, "customers_candies", editingId), {
        name: eName.trim(),
        phone: cleanPhone,
        place: ePlace || "",
        notes: eNotes || "",
        status: eStatus,
        creditLimit: Number(eCreditLimit || 0),

        // ✅ NUEVO
        vendorId: finalVendorId,
        vendorName: finalVendorName,
      });

      setRows((prev) =>
        prev.map((x) =>
          x.id === editingId
            ? {
                ...x,
                name: eName.trim(),
                phone: cleanPhone,
                place: ePlace || "",
                notes: eNotes || "",
                status: eStatus,
                creditLimit: Number(eCreditLimit || 0),

                vendorId: finalVendorId,
                vendorName: finalVendorName,
              }
            : x
        )
      );

      cancelEdit();
      setMsg("✅ Cliente actualizado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al actualizar");
    }
  };

  // ===== Eliminar cliente (+ devolver dulces de TODAS sus compras) =====
  const handleDelete = async (row: CustomerRow) => {
    const ok = confirm(
      `¿Eliminar al cliente "${row.name}"?\nSe devolverán al inventario todos los dulces de sus compras y se borrarán sus movimientos.`
    );
    if (!ok) return;

    try {
      setLoading(true);

      // 1) Ventas del cliente (dulces)
      const qSales = query(
        collection(db, "sales_candies"),
        where("customerId", "==", row.id)
      );
      const sSnap = await getDocs(qSales);

      // 2) Por cada venta -> restaurar inventario y borrar venta + movimientos
      for (const d of sSnap.docs) {
        const saleId = d.id;
        try {
          await restoreSaleAndDeleteCandy(saleId);
        } catch (e) {
          console.warn("restoreSaleAndDeleteCandy error", e);
          try {
            await deleteDoc(doc(db, "sales_candies", saleId));
          } catch {}
        }
        await deleteARMovesBySaleId(saleId);
      }

      // 3) Movimientos sueltos del cliente (sin saleId)
      const qMov = query(
        collection(db, "ar_movements"),
        where("customerId", "==", row.id)
      );
      const mSnap = await getDocs(qMov);
      await Promise.all(
        mSnap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id)))
      );

      // 4) Borrar cliente
      await deleteDoc(doc(db, "customers_candies", row.id));

      // 5) UI
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      setMsg("🗑️ Cliente eliminado y dulces devueltos al inventario");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar el cliente.");
    } finally {
      setLoading(false);
    }
  };

  // ===== Abrir estado de cuenta =====
  const openStatement = async (customer: CustomerRow) => {
    setStCustomer(customer);
    setStRows([]);
    setStKpis({ saldoActual: 0, totalAbonado: 0, totalCargos: 0 });
    setShowStatement(true);
    setShowAbono(false);
    setAbonoAmount(0);
    setAbonoDate(new Date().toISOString().slice(0, 10));
    setAbonoComment("");
    setEditMovId(null);
    setStLoading(true);
    try {
      const qMov = query(
        collection(db, "ar_movements"),
        where("customerId", "==", customer.id)
      );
      const snap = await getDocs(qMov);
      const list: MovementRow[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          date:
            x.date ??
            (x.createdAt?.toDate?.()
              ? x.createdAt.toDate().toISOString().slice(0, 10)
              : ""),
          type: (x.type as "CARGO" | "ABONO") ?? "CARGO",
          amount: Number(x.amount || 0),
          ref: x.ref || {},
          comment: x.comment || "",
          createdAt: x.createdAt,
        });
      });
      list.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });

      setStRows(list);
      recomputeKpis(list);
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el estado de cuenta");
    } finally {
      setStLoading(false);
    }
  };

  const recomputeKpis = (list: MovementRow[]) => {
    const total = list.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);
    const totalAbonos = list
      .filter((x) => Number(x.amount) < 0)
      .reduce((acc, it) => acc + Math.abs(Number(it.amount) || 0), 0);
    const totalCargos = list
      .filter((x) => Number(x.amount) > 0)
      .reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    setStKpis({
      saldoActual: total,
      totalAbonado: totalAbonos,
      totalCargos,
    });
  };

  // ===== Registrar ABONO =====
  const saveAbono = async () => {
    if (!stCustomer) return;
    setMsg("");

    const amt = Number(abonoAmount || 0);
    if (!(amt > 0)) {
      setMsg("Ingresa un monto de abono mayor a 0.");
      return;
    }
    const safeAmt = parseFloat(amt.toFixed(2));
    if (!abonoDate) {
      setMsg("Selecciona la fecha del abono.");
      return;
    }

    try {
      setSavingAbono(true);
      const payload = {
        customerId: stCustomer.id,
        type: "ABONO",
        amount: -safeAmt, // ABONO negativo
        date: abonoDate, // yyyy-MM-dd
        comment: abonoComment || "",
        createdAt: Timestamp.now(),
      };
      const ref = await addDoc(collection(db, "ar_movements"), payload);

      const newRow: MovementRow = {
        id: ref.id,
        date: abonoDate,
        type: "ABONO",
        amount: -safeAmt,
        comment: abonoComment || "",
        createdAt: Timestamp.now(),
      };
      const newList = [...stRows, newRow].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });
      setStRows(newList);
      recomputeKpis(newList);

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? { ...c, balance: (c.balance || 0) - safeAmt }
            : c
        )
      );
      setStCustomer((prev) =>
        prev ? { ...prev, balance: (prev.balance || 0) - safeAmt } : prev
      );

      setAbonoAmount(0);
      setAbonoComment("");
      setAbonoDate(new Date().toISOString().slice(0, 10));
      setShowAbono(false);
      setMsg("✅ Abono registrado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al registrar el abono");
    } finally {
      setSavingAbono(false);
    }
  };

  // ===== Editar movimiento =====
  const startEditMovement = (m: MovementRow) => {
    setEditMovId(m.id);
    setEMovDate(m.date || new Date().toISOString().slice(0, 10));
    setEMovAmount(Math.abs(Number(m.amount || 0)));
    setEMovComment(m.comment || "");
  };

  const cancelEditMovement = () => {
    setEditMovId(null);
    setEMovDate("");
    setEMovAmount(0);
    setEMovComment("");
  };

  const saveEditMovement = async () => {
    if (!editMovId) return;
    const idx = stRows.findIndex((x) => x.id === editMovId);
    if (idx === -1) return;
    const old = stRows[idx];

    const entered = Number(eMovAmount || 0);
    if (!(entered > 0)) {
      setMsg("El monto debe ser mayor a 0.");
      return;
    }
    const signed =
      old.type === "ABONO"
        ? -parseFloat(entered.toFixed(2))
        : +parseFloat(entered.toFixed(2));

    try {
      await updateDoc(doc(db, "ar_movements", editMovId), {
        date: eMovDate,
        amount: signed,
        comment: eMovComment || "",
      });

      const newList = [...stRows];
      newList[idx] = {
        ...old,
        date: eMovDate,
        amount: signed,
        comment: eMovComment || "",
      };
      newList.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });

      setStRows(newList);
      recomputeKpis(newList);

      const nuevoSaldo = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0
      );
      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer?.id ? { ...c, balance: nuevoSaldo } : c
        )
      );
      setStCustomer((prev) => (prev ? { ...prev, balance: nuevoSaldo } : prev));

      cancelEditMovement();
      setMsg("✅ Movimiento actualizado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al actualizar movimiento");
    }
  };

  // ===== Eliminar movimiento =====
  const deleteMovement = async (m: MovementRow) => {
    const ok = confirm(
      `¿Eliminar este movimiento (${
        m.type === "ABONO" ? "Abono" : "Compra"
      }) del ${m.date}?${
        m.type === "CARGO" && m.ref?.saleId
          ? "\nSe devolverán al inventario los dulces de esa venta."
          : ""
      }`
    );
    if (!ok) return;

    try {
      setLoading(true);

      if (m.type === "CARGO" && m.ref?.saleId) {
        try {
          await restoreSaleAndDeleteCandy(m.ref.saleId);
        } catch (e) {
          console.warn("restoreSaleAndDeleteCandy error", e);
          setLoading(false);
          setMsg("❌ No se pudo devolver inventario de la venta.");
          return;
        }
        await deleteARMovesBySaleId(m.ref.saleId);
      } else {
        await deleteDoc(doc(db, "ar_movements", m.id));
      }

      const newList = stRows.filter((x) => {
        if (m.type === "CARGO" && m.ref?.saleId) {
          return x.ref?.saleId !== m.ref.saleId;
        }
        return x.id !== m.id;
      });
      setStRows(newList);
      recomputeKpis(newList);

      const nuevoSaldo = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0
      );
      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer?.id ? { ...c, balance: nuevoSaldo } : c
        )
      );
      setStCustomer((prev) => (prev ? { ...prev, balance: nuevoSaldo } : prev));

      setMsg("🗑️ Movimiento eliminado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar movimiento");
    } finally {
      setLoading(false);
    }
  };

  // Orden pequeño: primero activos, bloqueados al final
  const orderedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.status !== b.status) return a.status === "BLOQUEADO" ? 1 : -1;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });
  }, [rows]);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Clientes (Dulces)</h2>
        <button
          className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
          onClick={() => {
            setShowCreateModal(true);
            if (isVendor) setVendorId(sellerIdSafe);
          }}
          type="button"
        >
          Crear Cliente
        </button>
      </div>

      {/* ===== Lista ===== */}
      <div className="bg-white p-2 rounded shadow border w-full">
        {/* ===================== WEB (NO CAMBIAR UI) ===================== */}
        <div className="hidden md:block">
          <table className="min-w-full w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Fecha</th>
                <th className="p-2 border">Nombre</th>
                <th className="p-2 border">Teléfono</th>
                <th className="p-2 border">Vendedor</th>
                <th className="p-2 border">Lugar</th>
                <th className="p-2 border">Estado</th>
                <th className="p-2 border">Límite</th>
                <th className="p-2 border">Saldo</th>
                <th className="p-2 border">Comentario</th>
                <th className="p-2 border">Acciones</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td className="p-4 text-center" colSpan={10}>
                    Cargando…
                  </td>
                </tr>
              ) : orderedRows.length === 0 ? (
                <tr>
                  <td className="p-4 text-center" colSpan={10}>
                    Sin clientes
                  </td>
                </tr>
              ) : (
                orderedRows.map((c) => {
                  const isEditing = editingId === c.id;
                  return (
                    <tr key={c.id} className="text-center">
                      <td className="p-2 border">
                        {c.createdAt?.toDate
                          ? c.createdAt.toDate().toISOString().slice(0, 10)
                          : "—"}
                      </td>

                      <td className="p-2 border text-left">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={eName}
                            onChange={(e) => setEName(e.target.value)}
                          />
                        ) : (
                          <div className="font-medium">{c.name}</div>
                        )}
                      </td>

                      <td className="p-2 border">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={ePhone}
                            onChange={(e) =>
                              setEPhone(normalizePhone(e.target.value))
                            }
                          />
                        ) : (
                          c.phone
                        )}
                      </td>

                      {/* ✅ FIX: esta celda AHORA es “Vendedor” de verdad */}
                      <td className="p-2 border">
                        {isEditing ? (
                          <select
                            className="w-full border p-1 rounded text-xs"
                            value={isVendor ? sellerIdSafe : eVendorId}
                            onChange={(e) => setEVendorId(e.target.value)}
                            disabled={isVendor}
                            title="Vendedor asociado"
                          >
                            <option value="">— Sin vendedor —</option>
                            {sellers.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          c.vendorName || "—"
                        )}
                      </td>

                      {/* ✅ Lugar (antes estaba ocupando la columna “Vendedor”) */}
                      <td className="p-2 border">
                        {isEditing ? (
                          <select
                            className="w-full border p-1 rounded"
                            value={ePlace}
                            onChange={(e) => setEPlace(e.target.value as Place)}
                          >
                            <option value="">—</option>
                            {PLACES.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        ) : (
                          c.place || "—"
                        )}
                      </td>

                      {/* ✅ Estado */}
                      <td className="p-2 border">
                        {isEditing ? (
                          <select
                            className="w-full border p-1 rounded"
                            value={eStatus}
                            onChange={(e) =>
                              setEStatus(e.target.value as Status)
                            }
                          >
                            <option value="ACTIVO">ACTIVO</option>
                            <option value="BLOQUEADO">BLOQUEADO</option>
                          </select>
                        ) : (
                          <span
                            className={`px-2 py-0.5 rounded text-xs ${
                              c.status === "ACTIVO"
                                ? "bg-green-100 text-green-700"
                                : "bg-red-100 text-red-700"
                            }`}
                          >
                            {c.status}
                          </span>
                        )}
                      </td>

                      {/* ✅ Límite */}
                      <td className="p-2 border">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="w-full border p-1 rounded text-right"
                            value={
                              Number.isNaN(eCreditLimit) ? "" : eCreditLimit
                            }
                            onChange={(e) =>
                              setECreditLimit(
                                Math.max(0, Number(e.target.value || 0))
                              )
                            }
                          />
                        ) : (
                          money(c.creditLimit || 0)
                        )}
                      </td>

                      {/* ✅ Saldo */}
                      <td className="p-2 border font-semibold">
                        {money(c.balance || 0)}
                      </td>

                      {/* ✅ Comentario */}
                      <td className="p-2 border">
                        {isEditing ? (
                          <textarea
                            className="w-full border p-1 rounded resize-y min-h-12"
                            value={eNotes}
                            onChange={(e) => setENotes(e.target.value)}
                            maxLength={500}
                          />
                        ) : (
                          <span title={c.notes || ""}>
                            {(c.notes || "").length > 40
                              ? (c.notes || "").slice(0, 40) + "…"
                              : c.notes || "—"}
                          </span>
                        )}
                      </td>

                      {/* ✅ Acciones */}
                      <td className="p-2 border">
                        <div className="flex gap-2 justify-center">
                          {isEditing ? (
                            <>
                              <button
                                className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                                onClick={saveEdit}
                              >
                                Guardar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                                onClick={cancelEdit}
                              >
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                                onClick={() => startEdit(c)}
                              >
                                Editar
                              </button>

                              {/* vendedor no debería borrar clientes si no es admin */}
                              <button
                                className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                                onClick={() => handleDelete(c)}
                                disabled={!isAdmin}
                                title={!isAdmin ? "Solo admin" : "Borrar"}
                              >
                                Borrar
                              </button>

                              <button
                                className="px-2 py-1 rounded text-white bg-indigo-600 hover:bg-indigo-700"
                                onClick={() => openStatement(c)}
                                title="Ver compras y abonos"
                              >
                                Estado de cuenta
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ===================== MOBILE (RESPONSIVE, SIN QUITAR ELEMENTOS) ===================== */}
        <div className="md:hidden">
          {loading ? (
            <div className="p-4 text-center text-sm">Cargando…</div>
          ) : orderedRows.length === 0 ? (
            <div className="p-4 text-center text-sm">Sin clientes</div>
          ) : (
            <div className="space-y-3">
              {orderedRows.map((c) => {
                const isEditing = editingId === c.id;
                const fecha = c.createdAt?.toDate
                  ? c.createdAt.toDate().toISOString().slice(0, 10)
                  : "—";

                return (
                  <div
                    key={c.id}
                    className="border rounded-2xl shadow-sm bg-white p-3"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-gray-500">Nombre</div>
                        <div className="font-semibold truncate">
                          {isEditing ? (
                            <input
                              className="w-full border p-2 rounded"
                              value={eName}
                              onChange={(e) => setEName(e.target.value)}
                            />
                          ) : (
                            c.name
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-xs text-gray-500">Estado</div>
                        <div>
                          {isEditing ? (
                            <select
                              className="border p-2 rounded text-sm"
                              value={eStatus}
                              onChange={(e) =>
                                setEStatus(e.target.value as Status)
                              }
                            >
                              <option value="ACTIVO">ACTIVO</option>
                              <option value="BLOQUEADO">BLOQUEADO</option>
                            </select>
                          ) : (
                            <span
                              className={`inline-flex px-2 py-0.5 rounded text-xs ${
                                c.status === "ACTIVO"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {c.status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Grid fields */}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-gray-500">Fecha</div>
                        <div className="font-medium">{fecha}</div>
                      </div>

                      <div>
                        <div className="text-xs text-gray-500">Teléfono</div>
                        <div className="font-medium">
                          {isEditing ? (
                            <input
                              className="w-full border p-2 rounded"
                              value={ePhone}
                              onChange={(e) =>
                                setEPhone(normalizePhone(e.target.value))
                              }
                            />
                          ) : (
                            c.phone
                          )}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-xs text-gray-500">Vendedor</div>
                        <div className="font-medium">
                          {isEditing ? (
                            <select
                              className="w-full border p-2 rounded text-sm"
                              value={isVendor ? sellerIdSafe : eVendorId}
                              onChange={(e) => setEVendorId(e.target.value)}
                              disabled={isVendor}
                              title="Vendedor asociado"
                            >
                              <option value="">— Sin vendedor —</option>
                              {sellers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            c.vendorName || "—"
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-gray-500">Lugar</div>
                        <div className="font-medium">
                          {isEditing ? (
                            <select
                              className="w-full border p-2 rounded text-sm"
                              value={ePlace}
                              onChange={(e) =>
                                setEPlace(e.target.value as Place)
                              }
                            >
                              <option value="">—</option>
                              {PLACES.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          ) : (
                            c.place || "—"
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-gray-500">Límite</div>
                        <div className="font-medium">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-full border p-2 rounded text-right"
                              value={
                                Number.isNaN(eCreditLimit) ? "" : eCreditLimit
                              }
                              onChange={(e) =>
                                setECreditLimit(
                                  Math.max(0, Number(e.target.value || 0))
                                )
                              }
                            />
                          ) : (
                            money(c.creditLimit || 0)
                          )}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-xs text-gray-500">Saldo</div>
                        <div className="font-semibold">
                          {money(c.balance || 0)}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-xs text-gray-500">Comentario</div>
                        <div className="font-medium">
                          {isEditing ? (
                            <textarea
                              className="w-full border p-2 rounded resize-y min-h-20"
                              value={eNotes}
                              onChange={(e) => setENotes(e.target.value)}
                              maxLength={500}
                            />
                          ) : (
                            <div title={c.notes || ""}>
                              {(c.notes || "").trim() ? c.notes : "—"}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="mt-3">
                      {isEditing ? (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            className="px-3 py-2 rounded-xl text-white bg-blue-600 hover:bg-blue-700"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-3 py-2 rounded-xl bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            className="px-3 py-2 rounded-xl text-white bg-yellow-600 hover:bg-yellow-700"
                            onClick={() => startEdit(c)}
                          >
                            Editar
                          </button>

                          <button
                            className="px-3 py-2 rounded-xl text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                            onClick={() => handleDelete(c)}
                            disabled={!isAdmin}
                            title={!isAdmin ? "Solo admin" : "Borrar"}
                          >
                            Borrar
                          </button>

                          <button
                            className="px-3 py-2 rounded-xl text-white bg-indigo-600 hover:bg-indigo-700"
                            onClick={() => openStatement(c)}
                          >
                            Estado
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* ===== Modal: Form Crear Cliente ===== */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-3xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">Crear Cliente</h3>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              <form
                onSubmit={handleCreate}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                <div>
                  <label className="block text-sm font-semibold">Nombre</label>
                  <input
                    className="w-full border p-2 rounded"
                    placeholder="Ej: María López"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Teléfono
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    value={phone}
                    onChange={(e) => setPhone(normalizePhone(e.target.value))}
                    placeholder="+505 88888888"
                    inputMode="numeric"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">Lugar</label>
                  <select
                    className="w-full border p-2 rounded"
                    value={place}
                    onChange={(e) => setPlace(e.target.value as Place)}
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
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Status)}
                  >
                    <option value="ACTIVO">ACTIVO</option>
                    <option value="BLOQUEADO">BLOQUEADO</option>
                  </select>
                </div>

                {/* ✅ NUEVO: Vendedor asociado */}
                <div>
                  <label className="block text-sm font-semibold">
                    Vendedor asociado
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={isVendor ? sellerIdSafe : vendorId}
                    onChange={(e) => setVendorId(e.target.value)}
                    disabled={isVendor}
                  >
                    <option value="">— Sin vendedor —</option>
                    {sellers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* ✅ NUEVO: Deuda inicial */}
                <div>
                  <label className="block text-sm font-semibold">
                    Deuda inicial
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={initialDebt === 0 ? "" : initialDebt}
                    onChange={(e) =>
                      setInitialDebt(Math.max(0, Number(e.target.value || 0)))
                    }
                    placeholder="Ej: 1500"
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    Este valor queda fijo (no cambia).
                  </div>
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
                    value={creditLimit === 0 ? "" : creditLimit}
                    onChange={(e) =>
                      setCreditLimit(Math.max(0, Number(e.target.value || 0)))
                    }
                    placeholder="Ej: 2000"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Comentario
                  </label>
                  <textarea
                    className="w-full border p-2 rounded resize-y min-h-24"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={500}
                    placeholder="Notas del cliente…"
                  />
                  <div className="text-xs text-gray-500 text-right">
                    {notes.length}/500
                  </div>
                </div>

                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cancelar
                  </button>
                  <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                    Guardar cliente
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* ===== Modal: Estado de cuenta ===== */}
      {showStatement && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-5xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Estado de cuenta — {stCustomer?.name || ""}
              </h3>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                  onClick={() => {
                    setAbonoAmount(0);
                    setAbonoDate(new Date().toISOString().slice(0, 10));
                    setAbonoComment("");
                    setShowAbono(true);
                  }}
                >
                  Abonar
                </button>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowStatement(false)}
                >
                  Cerrar
                </button>
              </div>
            </div>

            {/* ✅ KPI +1: deuda inicial */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Deuda inicial</div>
                <div className="text-xl font-semibold">
                  {money(Number(stCustomer?.initialDebt || 0))}
                </div>
              </div>

              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Saldo actual</div>
                <div className="text-xl font-semibold">
                  {money(stKpis.saldoActual)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Total abonado</div>
                <div className="text-xl font-semibold">
                  {money(stKpis.totalAbonado)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Saldo restante</div>
                <div className="text-xl font-semibold">
                  {money(stKpis.saldoActual)}
                </div>
              </div>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Tipo</th>
                    <th className="p-2 border">Referencia</th>
                    <th className="p-2 border">Comentario</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {stLoading ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : stRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
                        Sin movimientos
                      </td>
                    </tr>
                  ) : (
                    stRows.map((m) => {
                      const isEditing = editMovId === m.id;
                      return (
                        <tr key={m.id} className="text-center">
                          <td className="p-2 border">
                            {isEditing ? (
                              <input
                                type="date"
                                className="w-full border p-1 rounded"
                                value={eMovDate}
                                onChange={(e) => setEMovDate(e.target.value)}
                              />
                            ) : (
                              m.date || "—"
                            )}
                          </td>
                          <td className="p-2 border">
                            {m.amount >= 0 ? (
                              m.ref?.saleId ? (
                                <button
                                  type="button"
                                  className="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700 underline"
                                  title="Ver dulces de esta compra"
                                  onClick={() => openItemsModal(m.ref!.saleId!)}
                                >
                                  COMPRA (CARGO)
                                </button>
                              ) : (
                                <span className="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700">
                                  COMPRA (CARGO)
                                </span>
                              )
                            ) : (
                              <span className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">
                                ABONO
                              </span>
                            )}
                          </td>
                          <td className="p-2 border">
                            {m.ref?.saleId ? `Venta #${m.ref.saleId}` : "—"}
                          </td>
                          <td className="p-2 border">
                            {isEditing ? (
                              <input
                                className="w-full border p-1 rounded"
                                value={eMovComment}
                                onChange={(e) => setEMovComment(e.target.value)}
                                placeholder="Comentario"
                              />
                            ) : (
                              <span title={m.comment || ""}>
                                {(m.comment || "").length > 40
                                  ? (m.comment || "").slice(0, 40) + "…"
                                  : m.comment || "—"}
                              </span>
                            )}
                          </td>
                          <td className="p-2 border font-semibold">
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.01"
                                inputMode="decimal"
                                className="w-full border p-1 rounded text-right"
                                value={
                                  Number.isNaN(eMovAmount) ? "" : eMovAmount
                                }
                                onChange={(e) => {
                                  const num = Number(e.target.value || 0);
                                  const safe = Number.isFinite(num)
                                    ? Math.max(0, parseFloat(num.toFixed(2)))
                                    : 0;
                                  setEMovAmount(safe);
                                }}
                                placeholder="0.00"
                                title={
                                  m.type === "ABONO"
                                    ? "Se guardará como negativo"
                                    : "Se guardará como positivo"
                                }
                              />
                            ) : (
                              money(m.amount)
                            )}
                          </td>
                          <td className="p-2 border">
                            {isEditing ? (
                              <div className="flex gap-2 justify-center">
                                <button
                                  className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                                  onClick={saveEditMovement}
                                >
                                  Guardar
                                </button>
                                <button
                                  className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                                  onClick={cancelEditMovement}
                                >
                                  Cancelar
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-2 justify-center">
                                <button
                                  className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                                  onClick={() => startEditMovement(m)}
                                >
                                  Editar
                                </button>
                                <button
                                  className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                                  onClick={() => deleteMovement(m)}
                                >
                                  Borrar
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===== Modal: Abonar ===== */}
      {showAbono && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-2xl border w-[95%] max-w-md p-4">
            <h3 className="text-lg font-bold">
              Registrar abono — {stCustomer?.name || ""}
            </h3>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-semibold">Fecha</label>
                <input
                  type="date"
                  className="w-full border p-2 rounded"
                  value={abonoDate}
                  onChange={(e) => setAbonoDate(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold">
                  Monto del abono
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={abonoAmount === 0 ? "" : abonoAmount}
                  onChange={(e) => {
                    const num = Number(e.target.value || 0);
                    const safe = Number.isFinite(num)
                      ? Math.max(0, parseFloat(num.toFixed(2)))
                      : 0;
                    setAbonoAmount(safe);
                  }}
                  placeholder="0.00"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Se guarda con 2 decimales (se registrará como ABONO negativo).
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold">
                  Comentario (opcional)
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-20"
                  value={abonoComment}
                  onChange={(e) => setAbonoComment(e.target.value)}
                  maxLength={250}
                  placeholder="Ej: Abono en efectivo"
                />
                <div className="text-xs text-gray-500 text-right">
                  {abonoComment.length}/250
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setShowAbono(false)}
                disabled={savingAbono}
              >
                Cancelar
              </button>
              <button
                className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                onClick={saveAbono}
                disabled={savingAbono}
              >
                {savingAbono ? "Guardando..." : "Guardar abono"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Detalle de piezas de la venta (dulces) */}
      {itemsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[65]">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Dulces vendidos{" "}
                {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setItemsModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border text-right">Cantidad</th>
                    <th className="p-2 border text-right">Precio</th>
                    <th className="p-2 border text-right">Descuento</th>
                    <th className="p-2 border text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsModalLoading ? (
                    <tr>
                      <td colSpan={5} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : itemsModalRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-4 text-center">
                        Sin ítems en esta venta.
                      </td>
                    </tr>
                  ) : (
                    itemsModalRows.map((it, idx) => (
                      <tr key={idx} className="text-center">
                        <td className="p-2 border text-left">
                          {it.productName}
                        </td>
                        <td className="p-2 border text-right">{it.qty}</td>
                        <td className="p-2 border text-right">
                          {money(it.unitPrice)}
                        </td>
                        <td className="p-2 border text-right">
                          {money(it.discount || 0)}
                        </td>
                        <td className="p-2 border text-right">
                          {money(it.total)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
