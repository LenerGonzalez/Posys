// // src/components/Externos/SaldosPendientesExternos.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import ActionMenu from "../common/ActionMenu";
import { FiMenu } from "react-icons/fi";

type RecordType = "CUENTA_NUEVA" | "ABONO";

interface ExternalClient {
  id: string;
  name: string;
  phone: string;
  description: string;
  createdAt?: any;
  updatedAt?: any;
}

interface ExternalRecord {
  id: string;
  clientId: string;
  clientName: string;
  type: RecordType;
  date: string; // fecha de venta o fecha de abono
  amount: number; // cuenta nueva suma, abono resta
  notes?: string;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: any;
  updatedBy?: any;
}

interface ClientSummary {
  clientId: string;
  clientName: string;
  phone: string;
  description: string;
  totalCuentas: number;
  totalAbonos: number;
  saldoActual: number;
  registros: number;
  lastSaleDate: string;
  lastAbonoDate: string;
}

const today = () => format(new Date(), "yyyy-MM-dd");

const firstDayOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$ ${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const toNum = (v: unknown) => Number(v || 0) || 0;

const decimalInputOk = (value: string) =>
  /^(\d+(\.\d{0,2})?|\.\d{0,2}|)$/.test(value);

export default function SaldosPendientesExternos(): React.ReactElement {
  const [loading, setLoading] = useState(true);

  const [clients, setClients] = useState<ExternalClient[]>([]);
  const [records, setRecords] = useState<ExternalRecord[]>([]);

  // filtros resumen
  const [clientFilter, setClientFilter] = useState("ALL");
  const [lastSaleFrom, setLastSaleFrom] = useState("");
  const [lastSaleTo, setLastSaleTo] = useState("");
  const [lastAbonoFrom, setLastAbonoFrom] = useState("");
  const [lastAbonoTo, setLastAbonoTo] = useState("");
  // filtros collapsed by default
  const [filtersCollapsed, setFiltersCollapsed] = useState(true);
  // Ordenamiento por fecha para resumen: 'none' | 'lastAbono' | 'lastVenta'
  const [orderByMode, setOrderByMode] = useState<
    "none" | "lastAbono" | "lastVenta"
  >("none");
  // resumen clientes collapsed by default
  const [summaryCollapsed, setSummaryCollapsed] = useState(true);
  // filtros detalle collapsed by default
  const [detailFiltersCollapsed, setDetailFiltersCollapsed] = useState(true);

  // filtros detalle
  const [detailFrom, setDetailFrom] = useState<string>(() => firstDayOfMonth());
  const [detailTo, setDetailTo] = useState<string>(() => today());
  const [detailTypeFilter, setDetailTypeFilter] = useState<"ALL" | RecordType>(
    "ALL",
  );

  // detalle collapsed + pagination
  const [detailCollapsed, setDetailCollapsed] = useState<boolean>(true);
  const PAGE_SIZE = 10;
  const [detailPage, setDetailPage] = useState<number>(1);

  const resetDetailDates = () => {
    setDetailFrom(firstDayOfMonth());
    setDetailTo(today());
  };

  const clearDetailDates = () => {
    setDetailFrom("");
    setDetailTo("");
  };

  // modal cliente
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientDescription, setClientDescription] = useState("");

  // modal movimiento
  const [recordModalOpen, setRecordModalOpen] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [recordClientId, setRecordClientId] = useState("");
  const [recordType, setRecordType] = useState<RecordType>("CUENTA_NUEVA");
  const [recordDate, setRecordDate] = useState(today());
  const [recordAmount, setRecordAmount] = useState("");
  const [recordNotes, setRecordNotes] = useState("");

  // modal detalle cliente
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailClientId, setDetailClientId] = useState<string | null>(null);

  const clientModalRef = useRef<HTMLDivElement | null>(null);
  const recordModalRef = useRef<HTMLDivElement | null>(null);
  const detailModalRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const [actionOpenId, setActionOpenId] = useState<string | null>(null);
  const [mainToolsMenuRect, setMainToolsMenuRect] = useState<DOMRect | null>(
    null,
  );
  const [summaryRowMenu, setSummaryRowMenu] = useState<{
    clientId: string;
    rect: DOMRect;
  } | null>(null);
  const [recordClientLocked, setRecordClientLocked] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const { refreshKey, refresh } = useManualRefresh();

  const clientsById = useMemo(() => {
    const map: Record<string, ExternalClient> = {};
    clients.forEach((c) => {
      map[c.id] = c;
    });
    return map;
  }, [clients]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [clientsSnap, recordsSnap] = await Promise.all([
          getDocs(
            query(
              collection(db, "external_pending_clients"),
              orderBy("name", "asc"),
            ),
          ),
          getDocs(
            query(
              collection(db, "external_pending_records"),
              orderBy("date", "asc"),
            ),
          ),
        ]);

        const clientsList: ExternalClient[] = clientsSnap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: d.id,
            name: String(x.name || ""),
            phone: String(x.phone || ""),
            description: String(x.description || ""),
            createdAt: x.createdAt ?? null,
            updatedAt: x.updatedAt ?? null,
          };
        });

        const recordsList: ExternalRecord[] = recordsSnap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: d.id,
            clientId: String(x.clientId || ""),
            clientName: String(x.clientName || ""),
            type: (x.type || "CUENTA_NUEVA") as RecordType,
            date: String(x.date || ""),
            amount: toNum(x.amount),
            notes: String(x.notes || ""),
            createdAt: x.createdAt ?? null,
            updatedAt: x.updatedAt ?? null,
            createdBy: x.createdBy ?? null,
            updatedBy: x.updatedBy ?? null,
          };
        });

        setClients(clientsList);
        setRecords(recordsList);
      } catch (e) {
        console.error("Error cargando saldos pendientes externos:", e);
        setClients([]);
        setRecords([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  const recordsWithBalance = useMemo(() => {
    const grouped: Record<string, ExternalRecord[]> = {};

    for (const r of records) {
      if (!grouped[r.clientId]) grouped[r.clientId] = [];
      grouped[r.clientId].push(r);
    }

    const result: (ExternalRecord & { balanceAfter: number })[] = [];

    Object.keys(grouped).forEach((clientId) => {
      const sorted = [...grouped[clientId]].sort((a, b) => {
        const dateCmp = String(a.date || "").localeCompare(
          String(b.date || ""),
        );
        if (dateCmp !== 0) return dateCmp;
        const aTs = a.createdAt?.seconds ? Number(a.createdAt.seconds) : 0;
        const bTs = b.createdAt?.seconds ? Number(b.createdAt.seconds) : 0;
        return aTs - bTs;
      });

      let balance = 0;

      sorted.forEach((r) => {
        if (r.type === "CUENTA_NUEVA") {
          balance += toNum(r.amount);
        } else {
          balance -= toNum(r.amount);
        }

        result.push({
          ...r,
          balanceAfter: Number(balance.toFixed(2)),
        });
      });
    });

    return result.sort((a, b) => {
      const clientCmp = String(a.clientName || "").localeCompare(
        String(b.clientName || ""),
      );
      if (clientCmp !== 0) return clientCmp;
      const dateCmp = String(a.date || "").localeCompare(String(b.date || ""));
      if (dateCmp !== 0) return dateCmp;
      const aTs = a.createdAt?.seconds ? Number(a.createdAt.seconds) : 0;
      const bTs = b.createdAt?.seconds ? Number(b.createdAt.seconds) : 0;
      return aTs - bTs;
    });
  }, [records]);

  const clientSummaries = useMemo(() => {
    const map: Record<string, ClientSummary> = {};

    clients.forEach((c) => {
      map[c.id] = {
        clientId: c.id,
        clientName: c.name,
        phone: c.phone,
        description: c.description,
        totalCuentas: 0,
        totalAbonos: 0,
        saldoActual: 0,
        registros: 0,
        lastSaleDate: "",
        lastAbonoDate: "",
      };
    });

    recordsWithBalance.forEach((r) => {
      if (!map[r.clientId]) {
        map[r.clientId] = {
          clientId: r.clientId,
          clientName: r.clientName || "Sin nombre",
          phone: "",
          description: "",
          totalCuentas: 0,
          totalAbonos: 0,
          saldoActual: 0,
          registros: 0,
          lastSaleDate: "",
          lastAbonoDate: "",
        };
      }

      const item = map[r.clientId];
      item.registros += 1;
      item.saldoActual = r.balanceAfter;

      if (r.type === "CUENTA_NUEVA") {
        item.totalCuentas += toNum(r.amount);
        if (!item.lastSaleDate || r.date > item.lastSaleDate) {
          item.lastSaleDate = r.date;
        }
      }

      if (r.type === "ABONO") {
        item.totalAbonos += toNum(r.amount);
        if (!item.lastAbonoDate || r.date > item.lastAbonoDate) {
          item.lastAbonoDate = r.date;
        }
      }
    });

    return Object.values(map).sort((a, b) =>
      a.clientName.localeCompare(b.clientName),
    );
  }, [clients, recordsWithBalance]);

  const filteredSummaries = useMemo(() => {
    const list = clientSummaries.filter((c) => {
      if (clientFilter !== "ALL" && c.clientId !== clientFilter) return false;

      if (lastSaleFrom && (!c.lastSaleDate || c.lastSaleDate < lastSaleFrom)) {
        return false;
      }
      if (lastSaleTo && (!c.lastSaleDate || c.lastSaleDate > lastSaleTo)) {
        return false;
      }

      if (
        lastAbonoFrom &&
        (!c.lastAbonoDate || c.lastAbonoDate < lastAbonoFrom)
      ) {
        return false;
      }
      if (lastAbonoTo && (!c.lastAbonoDate || c.lastAbonoDate > lastAbonoTo)) {
        return false;
      }

      return true;
    });

    // Aplicar ordenamiento según selección: por fecha más reciente (desc)
    try {
      if (orderByMode === "lastAbono") {
        list.sort((a, b) => {
          const aa = String(a.lastAbonoDate || "");
          const bb = String(b.lastAbonoDate || "");
          if (aa === bb)
            return String(a.clientName || "").localeCompare(
              String(b.clientName || ""),
            );
          return bb.localeCompare(aa); // reciente primero
        });
      } else if (orderByMode === "lastVenta") {
        list.sort((a, b) => {
          const aa = String(a.lastSaleDate || "");
          const bb = String(b.lastSaleDate || "");
          if (aa === bb)
            return String(a.clientName || "").localeCompare(
              String(b.clientName || ""),
            );
          return bb.localeCompare(aa);
        });
      } else {
        list.sort((a, b) =>
          String(a.clientName || "").localeCompare(String(b.clientName || "")),
        );
      }
    } catch (err) {
      // si ocurre algún error en la ordenación, no romper la UI: devolver lista sin ordenar
      // eslint-disable-next-line no-console
      console.error("Error ordenando clientes:", err);
    }

    return list;
  }, [
    clientSummaries,
    clientFilter,
    lastSaleFrom,
    lastSaleTo,
    lastAbonoFrom,
    lastAbonoTo,
    orderByMode,
  ]);

  const filteredDetailRows = useMemo(() => {
    const allowedClientIds = new Set(filteredSummaries.map((x) => x.clientId));

    return recordsWithBalance.filter((r) => {
      if (!allowedClientIds.has(r.clientId)) return false;

      if (detailTypeFilter !== "ALL" && r.type !== detailTypeFilter) {
        return false;
      }

      if (detailFrom && r.date < detailFrom) return false;
      if (detailTo && r.date > detailTo) return false;

      return true;
    });
  }, [
    filteredSummaries,
    recordsWithBalance,
    detailTypeFilter,
    detailFrom,
    detailTo,
  ]);

  // pagination for detalle
  const totalDetailPages = Math.max(
    1,
    Math.ceil(filteredDetailRows.length / PAGE_SIZE),
  );

  const paginatedDetailRows = useMemo(() => {
    const start = (detailPage - 1) * PAGE_SIZE;
    return filteredDetailRows.slice(start, start + PAGE_SIZE);
  }, [filteredDetailRows, detailPage]);

  // reset page when filters change
  useEffect(() => {
    setDetailPage(1);
  }, [detailFrom, detailTo, detailTypeFilter, filteredSummaries]);

  const generalKpis = useMemo(() => {
    const totalClientes = filteredSummaries.length;
    const totalCuentas = filteredSummaries.reduce(
      (a, b) => a + toNum(b.totalCuentas),
      0,
    );
    const totalAbonos = filteredSummaries.reduce(
      (a, b) => a + toNum(b.totalAbonos),
      0,
    );
    const saldoPendiente = filteredSummaries.reduce(
      (a, b) => a + toNum(b.saldoActual),
      0,
    );
    const totalRegistros = filteredSummaries.reduce(
      (a, b) => a + toNum(b.registros),
      0,
    );

    return {
      totalClientes,
      totalCuentas,
      totalAbonos,
      saldoPendiente,
      totalRegistros,
    };
  }, [filteredSummaries]);

  const selectedClientSummary = useMemo(() => {
    if (!recordClientId) return null;
    return (
      clientSummaries.find((x) => x.clientId === recordClientId) ?? {
        clientId: recordClientId,
        clientName: clientsById[recordClientId]?.name || "",
        phone: clientsById[recordClientId]?.phone || "",
        description: clientsById[recordClientId]?.description || "",
        totalCuentas: 0,
        totalAbonos: 0,
        saldoActual: 0,
        registros: 0,
        lastSaleDate: "",
        lastAbonoDate: "",
      }
    );
  }, [recordClientId, clientSummaries, clientsById]);

  const previewSaldoFinal = useMemo(() => {
    const amount = toNum(recordAmount);
    const current = toNum(selectedClientSummary?.saldoActual || 0);

    if (!amount) return current;
    if (recordType === "CUENTA_NUEVA")
      return Number((current + amount).toFixed(2));
    return Number((current - amount).toFixed(2));
  }, [recordAmount, recordType, selectedClientSummary]);

  const clientDetailRows = useMemo(() => {
    if (!detailClientId) return [];
    return recordsWithBalance.filter((r) => r.clientId === detailClientId);
  }, [detailClientId, recordsWithBalance]);

  const detailClientSummary = useMemo(() => {
    if (!detailClientId) return null;
    return clientSummaries.find((x) => x.clientId === detailClientId) || null;
  }, [detailClientId, clientSummaries]);

  const resetClientForm = () => {
    setEditingClientId(null);
    setClientName("");
    setClientPhone("");
    setClientDescription("");
  };

  const resetRecordForm = () => {
    setEditingRecordId(null);
    setRecordClientId(clientFilter !== "ALL" ? clientFilter : "");
    setRecordType("CUENTA_NUEVA");
    setRecordDate(today());
    setRecordAmount("");
    setRecordNotes("");
    setRecordClientLocked(false);
  };

  const showFeedback = (msg: string) => {
    setFeedbackMsg(msg);
    window.setTimeout(() => setFeedbackMsg(null), 3500);
  };

  const openCreateClientModal = () => {
    resetClientForm();
    setClientModalOpen(true);
  };

  const openEditClientModal = (client: ExternalClient) => {
    setEditingClientId(client.id);
    setClientName(client.name || "");
    setClientPhone(client.phone || "");
    setClientDescription(client.description || "");
    setClientModalOpen(true);
  };

  const openCreateRecordModal = (type: RecordType, forcedClientId?: string) => {
    resetRecordForm();
    setRecordType(type);
    if (forcedClientId) {
      setRecordClientId(forcedClientId);
      setRecordClientLocked(true);
    } else {
      setRecordClientLocked(false);
    }
    setRecordModalOpen(true);
  };

  /** Un solo flujo: mismo modal que cuenta/abono; cliente fijo si viene de una fila. */
  const openMovementModal = (clientId: string) => {
    resetRecordForm();
    setRecordType("CUENTA_NUEVA");
    setRecordClientId(clientId);
    setRecordClientLocked(true);
    setRecordModalOpen(true);
  };

  const openEditRecordModal = (row: ExternalRecord) => {
    setEditingRecordId(row.id);
    setRecordClientId(row.clientId);
    setRecordType(row.type);
    setRecordDate(row.date || today());
    setRecordAmount(String(Number(row.amount || 0).toFixed(2)));
    setRecordNotes(row.notes || "");
    setRecordClientLocked(true);
    setRecordModalOpen(true);
  };

  const saveClient = async () => {
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const description = clientDescription.trim();

    if (!name) {
      window.alert("Debes escribir el nombre del cliente.");
      return;
    }

    const user = auth.currentUser;
    const payload = {
      name,
      phone,
      description,
      updatedAt: serverTimestamp(),
      updatedBy: user ? { uid: user.uid, email: user.email ?? null } : null,
    };

    try {
      if (editingClientId) {
        await updateDoc(
          doc(db, "external_pending_clients", editingClientId),
          payload,
        );
      } else {
        await addDoc(collection(db, "external_pending_clients"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
        });
      }

      setClientModalOpen(false);
      resetClientForm();
      showFeedback(
        editingClientId
          ? "✅ Cliente actualizado correctamente."
          : "✅ Cliente creado correctamente.",
      );
      refresh();
    } catch (e) {
      console.error(e);
      window.alert("No se pudo guardar el cliente.");
    }
  };

  const saveRecord = async () => {
    const clientId = recordClientId.trim();
    const client = clientsById[clientId];
    const date = recordDate;
    const amount = toNum(recordAmount);
    const notes = recordNotes.trim();

    if (!clientId || !client) {
      window.alert("Debes seleccionar un cliente.");
      return;
    }

    if (!date) {
      window.alert(
        recordType === "CUENTA_NUEVA"
          ? "Debes seleccionar la fecha de venta."
          : "Debes seleccionar la fecha de abono.",
      );
      return;
    }

    if (amount <= 0) {
      window.alert(
        recordType === "CUENTA_NUEVA"
          ? "El saldo inicial debe ser mayor que 0."
          : "El abono debe ser mayor que 0.",
      );
      return;
    }

    if (recordType === "ABONO") {
      const summary = clientSummaries.find((x) => x.clientId === clientId);
      const currentBalance = toNum(summary?.saldoActual || 0);

      // si está editando, devolver antes el valor original para no invalidar injustamente
      let availableBalance = currentBalance;
      if (editingRecordId) {
        const original = records.find((x) => x.id === editingRecordId);
        if (original?.type === "ABONO" && original.clientId === clientId) {
          availableBalance += toNum(original.amount);
        }
      }

      if (amount > availableBalance) {
        window.alert(
          `El abono no puede ser mayor al saldo disponible del cliente (${money(
            availableBalance,
          )}).`,
        );
        return;
      }
    }

    const user = auth.currentUser;
    const payload = {
      clientId,
      clientName: client.name || "",
      type: recordType,
      date,
      amount,
      notes,
      updatedAt: serverTimestamp(),
      updatedBy: user ? { uid: user.uid, email: user.email ?? null } : null,
    };

    try {
      if (editingRecordId) {
        await updateDoc(
          doc(db, "external_pending_records", editingRecordId),
          payload,
        );
      } else {
        await addDoc(collection(db, "external_pending_records"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
        });
      }

      setRecordModalOpen(false);
      resetRecordForm();
      showFeedback(
        editingRecordId
          ? "✅ Registro actualizado correctamente."
          : "✅ Registro guardado correctamente.",
      );
      refresh();
    } catch (e) {
      console.error(e);
      window.alert("No se pudo guardar el registro.");
    }
  };

  const deleteClientSafe = async (clientId: string) => {
    const hasRecords = records.some((r) => r.clientId === clientId);
    if (hasRecords) {
      window.alert(
        "No puedes eliminar este cliente porque tiene registros asociados. Elimina primero sus cuentas y abonos.",
      );
      return;
    }

    if (!window.confirm("¿Eliminar este cliente?")) return;

    try {
      await deleteDoc(doc(db, "external_pending_clients", clientId));
      refresh();
    } catch (e) {
      console.error(e);
      window.alert("No se pudo eliminar el cliente.");
    }
  };

  const deleteRecordSafe = async (recordId: string) => {
    if (!window.confirm("¿Eliminar este registro?")) return;

    try {
      await deleteDoc(doc(db, "external_pending_records", recordId));
      refresh();
    } catch (e) {
      console.error(e);
      window.alert("No se pudo eliminar el registro.");
    }
  };

  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();

    const resumenRows: (string | number)[][] = [
      [
        "Cliente",
        "Teléfono",
        "Descripción",
        "Total Cuentas Nuevas",
        "Total Abonos",
        "Saldo Actual",
        "Última Venta",
        "Último Abono",
        "Registros",
      ],
    ];

    filteredSummaries.forEach((r) => {
      resumenRows.push([
        r.clientName,
        r.phone || "",
        r.description || "",
        Number(r.totalCuentas || 0),
        Number(r.totalAbonos || 0),
        Number(r.saldoActual || 0),
        r.lastSaleDate || "",
        r.lastAbonoDate || "",
        Number(r.registros || 0),
      ]);
    });

    const detalleRows: (string | number)[][] = [
      ["Cliente", "Tipo", "Fecha", "Monto", "Saldo Final", "Notas"],
    ];

    filteredDetailRows.forEach((r) => {
      detalleRows.push([
        r.clientName || "",
        r.type === "CUENTA_NUEVA" ? "Cuenta Nueva" : "Abono",
        r.date || "",
        Number(r.amount || 0),
        Number((r as any).balanceAfter || 0),
        r.notes || "",
      ]);
    });

    const generalRows: (string | number)[][] = [
      ["Indicador", "Valor"],
      ["Clientes", generalKpis.totalClientes],
      ["Registros", generalKpis.totalRegistros],
      ["Total Cuentas Nuevas", generalKpis.totalCuentas],
      ["Total Abonos", generalKpis.totalAbonos],
      ["Saldo Pendiente", generalKpis.saldoPendiente],
    ];

    const ws1 = XLSX.utils.aoa_to_sheet(generalRows);
    const ws2 = XLSX.utils.aoa_to_sheet(resumenRows);
    const ws3 = XLSX.utils.aoa_to_sheet(detalleRows);

    XLSX.utils.book_append_sheet(wb, ws1, "KPIs");
    XLSX.utils.book_append_sheet(wb, ws2, "ResumenClientes");
    XLSX.utils.book_append_sheet(wb, ws3, "DetalleRegistros");

    XLSX.writeFile(wb, `saldos_pendientes_externos_${today()}.xlsx`);
  };

  useEffect(() => {
    const handleMouseDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;
      if (target?.closest?.("[data-action-menu-root]")) return;

      if (
        clientModalOpen &&
        clientModalRef.current &&
        !clientModalRef.current.contains(target)
      ) {
        setClientModalOpen(false);
      }

      if (
        recordModalOpen &&
        recordModalRef.current &&
        !recordModalRef.current.contains(target)
      ) {
        setRecordModalOpen(false);
      }

      if (
        detailModalOpen &&
        detailModalRef.current &&
        !detailModalRef.current.contains(target)
      ) {
        setDetailModalOpen(false);
      }

      if (
        actionOpenId &&
        actionMenuRef.current &&
        !actionMenuRef.current.contains(target)
      ) {
        setActionOpenId(null);
      }
    };

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setClientModalOpen(false);
        setRecordModalOpen(false);
        resetRecordForm();
        setDetailModalOpen(false);
        setActionOpenId(null);
        setMainToolsMenuRect(null);
        setSummaryRowMenu(null);
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [clientModalOpen, recordModalOpen, detailModalOpen, actionOpenId]);

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h3 className="text-sm sm:text-lg md:text-md font-bold">
          Saldos Externos
        </h3>

        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            type="button"
            aria-label="Menú de acciones"
            title="Menú de acciones"
            className="inline-flex items-center justify-center px-3 py-2 border rounded bg-white hover:bg-gray-50"
            onClick={(e) =>
              setMainToolsMenuRect(e.currentTarget.getBoundingClientRect())
            }
          >
            <FiMenu className="w-5 h-5 text-slate-800" />
          </button>
        </div>
      </div>

      <ActionMenu
        anchorRect={mainToolsMenuRect}
        isOpen={!!mainToolsMenuRect}
        onClose={() => setMainToolsMenuRect(null)}
        width={220}
      >
        <div className="py-1">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
            onClick={() => {
              setMainToolsMenuRect(null);
              openCreateClientModal();
            }}
          >
            Crear cliente
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
            onClick={() => {
              setMainToolsMenuRect(null);
              openCreateRecordModal("CUENTA_NUEVA");
            }}
          >
            Nueva venta
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
            onClick={() => {
              setMainToolsMenuRect(null);
              openCreateRecordModal("ABONO");
            }}
          >
            Abono
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
            onClick={() => {
              setMainToolsMenuRect(null);
              exportToExcel();
            }}
          >
            Excel
          </button>
        </div>
      </ActionMenu>

      {feedbackMsg && (
        <div
          className="mb-4 p-3 rounded-xl border border-green-200 bg-green-50 text-green-900 text-sm"
          role="status"
        >
          {feedbackMsg}
        </div>
      )}

      <ActionMenu
        anchorRect={summaryRowMenu?.rect ?? null}
        isOpen={!!summaryRowMenu}
        onClose={() => setSummaryRowMenu(null)}
        width={220}
      >
        <div className="py-1">
          {summaryRowMenu &&
            (() => {
              const r = filteredSummaries.find(
                (x) => x.clientId === summaryRowMenu.clientId,
              );
              if (!r) return null;
              return (
                <>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
                    onClick={() => {
                      setDetailClientId(r.clientId);
                      setDetailModalOpen(true);
                      setSummaryRowMenu(null);
                    }}
                  >
                    Ver
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
                    onClick={() => {
                      setSummaryRowMenu(null);
                      openMovementModal(r.clientId);
                    }}
                  >
                    Movimiento
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100"
                    onClick={() => {
                      setSummaryRowMenu(null);
                      openEditClientModal(
                        clientsById[r.clientId] || {
                          id: r.clientId,
                          name: r.clientName,
                          phone: r.phone,
                          description: r.description,
                        },
                      );
                    }}
                  >
                    Editar cliente
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                    onClick={() => {
                      setSummaryRowMenu(null);
                      void deleteClientSafe(r.clientId);
                    }}
                  >
                    Eliminar
                  </button>
                </>
              );
            })()}
        </div>
      </ActionMenu>

      {/* KPI general */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <div className="border rounded-2xl p-3 bg-sky-50">
          <div className="text-[11px] sm:text-xs text-gray-600">Clientes</div>
          <div className="text-lg sm:text-2xl font-bold">
            {generalKpis.totalClientes}
          </div>
        </div>
        <div className="hidden md:block border rounded-2xl p-3 bg-amber-50">
          <div className="text-xs text-gray-600">Movimientos</div>
          <div className="text-2xl font-bold">{generalKpis.totalRegistros}</div>
        </div>

        <div className="border rounded-2xl p-3 bg-emerald-50">
          <div className="text-[11px] sm:text-xs text-gray-600">
            Saldos iniciados
          </div>
          <div className="text-lg sm:text-2xl font-bold">
            {money(generalKpis.totalCuentas)}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-violet-50">
          <div className="text-[11px] sm:text-xs text-gray-600">Abonos</div>
          <div className="text-lg sm:text-2xl font-bold">
            {money(generalKpis.totalAbonos)}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-gray-900 text-white">
          <div className="text-[11px] sm:text-xs opacity-80">
            Saldos pendientes
          </div>
          <div className="text-xl sm:text-2xl font-extrabold">
            {money(generalKpis.saldoPendiente)}
          </div>
        </div>
      </div>

      {/* filtros resumen (card colapsable) */}
      {/* <div className="mb-5">
        <div className="border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50">
            <h3 className="font-semibold">Filtros</h3>
            <button
              type="button"
              onClick={() => setFiltersCollapsed((s: boolean) => !s)}
              className="px-2 py-1 rounded bg-white border text-sm hover:bg-gray-100"
              aria-expanded={!filtersCollapsed}
            >
              {filtersCollapsed ? "Mostrar" : "Ocultar"}
            </button>
          </div>

          {!filtersCollapsed && <div className="p-4 bg-white"></div>}
        </div>
      </div> */}

      {/* tabla resumen clientes (card colapsable) */}
      <div className="mb-6">
        <div className="border rounded-2xl overflow-hidden">
          <div
            className="flex items-center justify-between p-3 bg-gray-50 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => setSummaryCollapsed((s: boolean) => !s)}
            onKeyDown={(e: any) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSummaryCollapsed((s: boolean) => !s);
              }
            }}
          >
            <h3 className="font-semibold">Resumen por cliente</h3>
            {/* Botón Mostrar/Ocultar eliminado — el header ahora es clickable */}
          </div>

          {!summaryCollapsed && (
            <div className="p-4 bg-white">
              {/* Mobile: cards */}
              {/* Controls: cliente select + order buttons. Aligned on one row for md+ */}
              <div className="mb-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div className="w-full md:w-1/3">
                  <label className="block text-sm font-semibold text-blue-600 mb-1">
                    Cliente
                  </label>
                  <select
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                  >
                    <option value="ALL">Todos</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setOrderByMode((s: "none" | "lastAbono" | "lastVenta") =>
                        s === "lastAbono" ? "none" : "lastAbono",
                      )
                    }
                    className={`px-2 py-1 rounded text-xs sm:text-sm border ${
                      orderByMode === "lastAbono"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-blue-600 border-blue-200 hover:bg-blue-50"
                    }`}
                  >
                    Último abono
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setOrderByMode((s: "none" | "lastAbono" | "lastVenta") =>
                        s === "lastVenta" ? "none" : "lastVenta",
                      )
                    }
                    className={`px-2 py-1 rounded text-xs sm:text-sm border ${
                      orderByMode === "lastVenta"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-blue-600 border-blue-200 hover:bg-blue-50"
                    }`}
                  >
                    Última venta
                  </button>
                </div>
              </div>
              <div className="md:hidden space-y-3 mb-3">
                {filteredSummaries.length === 0 ? (
                  <div className="p-3 text-center text-gray-500">
                    No hay clientes para los filtros seleccionados.
                  </div>
                ) : (
                  filteredSummaries.map((r) => (
                    <div
                      key={r.clientId}
                      className="border rounded-lg p-3 bg-white shadow-sm"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 pr-3">
                          <div className="font-medium text-sm">
                            {r.clientName}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {r.phone || "—"} • {r.description || "—"}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-900 border border-emerald-200 font-semibold tabular-nums">
                              <span className="font-medium opacity-90">
                                Cuentas
                              </span>
                              <span>{Number(r.totalCuentas || 0)}</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-violet-100 text-violet-900 border border-violet-200 font-semibold tabular-nums">
                              <span className="font-medium opacity-90">
                                Abonos
                              </span>
                              <span>{Number(r.totalAbonos || 0)}</span>
                            </span>
                          </div>
                        </div>

                        <div className="flex-shrink-0 text-right flex flex-col items-end gap-2">
                          <div className="text-xs text-gray-600">Saldo</div>
                          <div className="font-semibold">
                            {money(r.saldoActual)}
                          </div>
                          <button
                            type="button"
                            aria-label="Acciones del cliente"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSummaryRowMenu({
                                clientId: r.clientId,
                                rect: e.currentTarget.getBoundingClientRect(),
                              });
                            }}
                            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-50"
                          >
                            <FiMenu className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* WEB: resumen por cliente — tabla completa (visible en md+) */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full w-full border text-sm table-auto">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Cliente</th>
                      <th className="border p-2">Cuentas nuevas</th>
                      <th className="border p-2">Abonos</th>
                      <th className="border p-2">Saldo actual</th>
                      <th className="border p-2">Última venta</th>
                      <th className="border p-2">Último abono</th>
                      <th className="border p-2">Movimientos</th>
                      <th className="border p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSummaries.map((r) => (
                      <tr key={r.clientId} className="text-center">
                        <td className="border p-2 text-left font-medium">
                          {r.clientName}
                        </td>
                        <td className="border p-2">{money(r.totalCuentas)}</td>
                        <td className="border p-2">{money(r.totalAbonos)}</td>
                        <td className="border p-2 font-semibold">
                          {money(r.saldoActual)}
                        </td>
                        <td className="border p-2">{r.lastSaleDate || "—"}</td>
                        <td className="border p-2">{r.lastAbonoDate || "—"}</td>
                        <td className="border p-2">{r.registros}</td>
                        <td className="border p-2">
                          <div className="flex items-center justify-center">
                            <button
                              type="button"
                              aria-label="Acciones del cliente"
                              onClick={(e) => {
                                setSummaryRowMenu({
                                  clientId: r.clientId,
                                  rect: e.currentTarget.getBoundingClientRect(),
                                });
                              }}
                              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white p-2 text-slate-700 hover:bg-slate-50"
                            >
                              <FiMenu className="w-5 h-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredSummaries.length === 0 && (
                      <tr>
                        <td
                          colSpan={8}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay clientes para los filtros seleccionados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* tabla detalle (card colapsable) */}
      <div className="mb-6">
        <div className="border rounded-2xl overflow-hidden">
          <div
            className="flex items-center justify-between p-3 bg-gray-50 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => setDetailCollapsed((s: boolean) => !s)}
            onKeyDown={(e: any) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDetailCollapsed((s: boolean) => !s);
              }
            }}
          >
            <h3 className="font-semibold">Detalle de registros</h3>
            {/* header clicable, botón eliminado */}
          </div>

          {!detailCollapsed && (
            <div className="p-4 bg-white">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3 rounded-2xl">
                <div>
                  <label className="block text-xs md:text-sm text-gray-600 mb-1">
                    Desde
                  </label>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 md:px-3 md:py-2 w-full bg-white text-xs md:text-sm"
                    value={detailFrom}
                    onChange={(e) => setDetailFrom(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-xs md:text-sm text-gray-600 mb-1">
                    Hasta
                  </label>
                  <input
                    type="date"
                    className="border rounded px-2 py-1 md:px-3 md:py-2 w-full bg-white text-xs md:text-sm"
                    value={detailTo}
                    onChange={(e) => setDetailTo(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-xs md:text-sm text-gray-600 mb-1">
                    Tipo
                  </label>
                  <select
                    className="border rounded px-2 py-1 md:px-3 md:py-2 w-full bg-white text-xs md:text-sm"
                    value={detailTypeFilter}
                    onChange={(e) =>
                      setDetailTypeFilter(e.target.value as "ALL" | RecordType)
                    }
                  >
                    <option value="ALL">Todos</option>
                    <option value="CUENTA_NUEVA">Cuenta nueva</option>
                    <option value="ABONO">Abono</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-1 md:gap-2 mt-2 mb-3">
                <button
                  type="button"
                  onClick={() => {
                    resetDetailDates();
                    if (detailCollapsed) setDetailCollapsed(false);
                  }}
                  className="px-2 py-0.5 md:py-1 rounded-2xl bg-blue-600 text-white text-xs hover:bg-blue-700"
                >
                  Reiniciar fechas
                </button>

                <button
                  type="button"
                  onClick={() => {
                    clearDetailDates();
                    if (detailCollapsed) setDetailCollapsed(false);
                  }}
                  className="px-2 py-0.5 md:py-1 rounded-2xl bg-gray-100 text-gray-700 text-xs hover:bg-gray-200"
                >
                  Limpiar fechas
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full w-full border text-sm table-auto">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Cliente</th>
                      <th className="border p-2">Movimiento</th>
                      <th className="border p-2">Fecha</th>
                      <th className="border p-2">Monto</th>
                      <th className="border p-2">Saldo final</th>
                      <th className="border p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedDetailRows.map((r) => (
                      <tr key={r.id} className="text-center">
                        <td className="border p-2 text-left">{r.clientName}</td>
                        <td className="border p-2">
                          {r.type === "CUENTA_NUEVA" ? (
                            <span className="text-[11px] px-2 py-[2px] rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                              CUENTA NUEVA
                            </span>
                          ) : (
                            <span className="text-[11px] px-2 py-[2px] rounded-full bg-violet-100 text-violet-800 border border-violet-200">
                              ABONO
                            </span>
                          )}
                        </td>
                        <td className="border p-2">{r.date}</td>
                        <td className="border p-2">{money(r.amount)}</td>
                        <td className="border p-2 font-semibold">
                          {money((r as any).balanceAfter || 0)}
                        </td>
                        <td className="border p-2 relative">
                          <div className="inline-block">
                            <button
                              onClick={() =>
                                setActionOpenId(
                                  actionOpenId === r.id ? null : r.id,
                                )
                              }
                              className="px-2 py-1 rounded hover:bg-gray-100 md:px-1 md:py-0.5 md:text-[12px]"
                              aria-label="Acciones"
                            >
                              ⋯
                            </button>

                            {actionOpenId === r.id && (
                              <div
                                ref={(el) => {
                                  actionMenuRef.current =
                                    el as HTMLDivElement | null;
                                }}
                                className="absolute right-2 mt-1 bg-white border rounded shadow-md z-50 text-left text-sm min-w-[140px]"
                              >
                                <button
                                  className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                                  onClick={() => {
                                    openEditRecordModal(r);
                                    setActionOpenId(null);
                                  }}
                                >
                                  Editar
                                </button>
                                <button
                                  className="block w-full text-left px-3 py-2 text-red-600 hover:bg-gray-100"
                                  onClick={() => {
                                    setActionOpenId(null);
                                    deleteRecordSafe(r.id);
                                  }}
                                >
                                  Eliminar
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredDetailRows.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay registros para los filtros seleccionados.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-2 flex items-center justify-between">
                <div className="text-xs text-gray-600">
                  Mostrando{" "}
                  {filteredDetailRows.length === 0
                    ? 0
                    : (detailPage - 1) * PAGE_SIZE + 1}
                  -{Math.min(detailPage * PAGE_SIZE, filteredDetailRows.length)}{" "}
                  de {filteredDetailRows.length}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDetailPage((p: number) => Math.max(1, p - 1))
                    }
                    disabled={detailPage <= 1}
                    className="px-2 py-1 text-xs rounded bg-white border disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <span className="text-xs">
                    Página {detailPage} / {totalDetailPages}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setDetailPage((p: number) =>
                        Math.min(totalDetailPages, p + 1),
                      )
                    }
                    disabled={detailPage >= totalDetailPages}
                    className="px-2 py-1 text-xs rounded bg-white border disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* modal cliente */}
      {clientModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setClientModalOpen(false)}
          />

          <div
            ref={clientModalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-xl shadow-xl max-h-[90vh] overflow-auto pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                {editingClientId ? "Editar cliente" : "Crear cliente"}
              </h3>

              <button
                type="button"
                onClick={() => setClientModalOpen(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Nombre
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Nombre del cliente"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Teléfono
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder="Teléfono"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Descripción
                </label>
                <textarea
                  className="border rounded px-3 py-2 w-full min-h-[90px]"
                  value={clientDescription}
                  onChange={(e) => setClientDescription(e.target.value)}
                  placeholder="Descripción"
                />
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setClientModalOpen(false)}
                  className="px-2 py-1 md:px-4 mb-5 md:py-2 border rounded text-xs sm:text-sm"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveClient}
                  className="px-2 py-1 md:px-4 md:py-2 mb-5 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs sm:text-sm"
                >
                  Guardar cliente
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* modal registro */}
      {recordModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              setRecordModalOpen(false);
              resetRecordForm();
            }}
          />

          <div
            ref={recordModalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-auto pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                {editingRecordId
                  ? "Editar registro"
                  : recordType === "CUENTA_NUEVA"
                    ? "Agregar Venta"
                    : "Agregar Abono"}
              </h3>

              <button
                type="button"
                onClick={() => {
                  setRecordModalOpen(false);
                  resetRecordForm();
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <label className="block text-sm text-gray-600 mb-1">
                  Cliente
                </label>
                <select
                  className="border rounded px-3 py-2 w-full disabled:bg-gray-100 disabled:cursor-not-allowed"
                  value={recordClientId}
                  disabled={recordClientLocked || !!editingRecordId}
                  onChange={(e) => setRecordClientId(e.target.value)}
                >
                  <option value="">Seleccionar...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">Tipo</label>
                <select
                  className="border rounded px-3 py-2 w-full"
                  value={recordType}
                  onChange={(e) => setRecordType(e.target.value as RecordType)}
                >
                  <option value="CUENTA_NUEVA">Venta nueva</option>
                  <option value="ABONO">Abono</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  {recordType === "CUENTA_NUEVA"
                    ? "Fecha de venta"
                    : "Fecha abono"}
                </label>
                <input
                  type="date"
                  className="border rounded px-3 py-2 w-full"
                  value={recordDate}
                  onChange={(e) => setRecordDate(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  {recordType === "CUENTA_NUEVA" ? "Monto de la venta" : "Abono"}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  className="border rounded px-3 py-2 w-full"
                  placeholder="0.00"
                  value={recordAmount}
                  onChange={(e) => {
                    const val = e.target.value.replace(/,/g, ".");
                    if (decimalInputOk(val)) setRecordAmount(val);
                  }}
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Saldo final
                </label>
                <input
                  className="border rounded px-3 py-2 w-full bg-gray-100"
                  value={money(previewSaldoFinal)}
                  readOnly
                />
              </div>

              {/* <div className="md:col-span-2">
                <label className="block text-sm text-gray-600 mb-1">
                  Notas
                </label>
                <textarea
                  className="border rounded px-3 py-2 w-full min-h-[90px]"
                  value={recordNotes}
                  onChange={(e) => setRecordNotes(e.target.value)}
                  placeholder="Observación opcional"
                />
              </div> */}

              <div className="md:col-span-2">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div className="border rounded-xl p-3 bg-emerald-50">
                    <div className="text-xs text-gray-600">
                      Cuentas acumuladas
                    </div>
                    <div className="font-semibold">
                      {money(selectedClientSummary?.totalCuentas || 0)}
                    </div>
                  </div>

                  <div className="border rounded-xl p-3 bg-violet-50">
                    <div className="text-xs text-gray-600">
                      Abonos acumulados
                    </div>
                    <div className="font-semibold">
                      {money(selectedClientSummary?.totalAbonos || 0)}
                    </div>
                  </div>

                  <div className="border rounded-xl p-3 bg-gray-900 text-white">
                    <div className="text-xs opacity-80">Saldo actual</div>
                    <div className="font-semibold">
                      {money(selectedClientSummary?.saldoActual || 0)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="md:col-span-2 flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setRecordModalOpen(false);
                    resetRecordForm();
                  }}
                  className="px-2 py-1 md:px-4 mb-5 md:py-2 border rounded text-xs sm:text-sm"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveRecord}
                  className="px-2 py-1 md:px-4 md:py-2 mb-5 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs sm:text-sm"
                >
                  Guardar registro
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* modal detalle cliente */}
      {detailModalOpen && detailClientSummary && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailModalOpen(false)}
          />

          <div
            ref={detailModalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-4xl shadow-xl max-h-[90vh] overflow-auto"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                Detalle de {detailClientSummary.clientName}
              </h3>

              <button
                type="button"
                onClick={() => setDetailModalOpen(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="border rounded-xl p-3 bg-emerald-50">
                <div className="text-xs text-gray-600">Cuentas nuevas</div>
                <div className="text-lg font-bold">
                  {money(detailClientSummary.totalCuentas)}
                </div>
              </div>

              <div className="border rounded-xl p-3 bg-violet-50">
                <div className="text-xs text-gray-600">Abonos</div>
                <div className="text-lg font-bold">
                  {money(detailClientSummary.totalAbonos)}
                </div>
              </div>

              <div className="border rounded-xl p-3 bg-amber-50">
                <div className="text-xs text-gray-600">Movimientos</div>
                <div className="text-lg font-bold">
                  {detailClientSummary.registros}
                </div>
              </div>

              <div className="border rounded-xl p-3 bg-gray-900 text-white">
                <div className="text-xs opacity-80">Saldo actual</div>
                <div className="text-lg font-extrabold">
                  {money(detailClientSummary.saldoActual)}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full w-full border text-sm table-auto">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Tipo</th>
                    <th className="border p-2">Fecha</th>
                    <th className="border p-2">Monto</th>
                    <th className="border p-2">Saldo final</th>
                    {/* <th className="border p-2">Notas</th> */}
                  </tr>
                </thead>
                <tbody>
                  {clientDetailRows.map((r) => (
                    <tr key={r.id} className="text-center">
                      <td className="border p-2">
                        {r.type === "CUENTA_NUEVA" ? "Venta" : "Abono"}
                      </td>
                      <td className="border p-2">{r.date}</td>
                      <td className="border p-2">{money(r.amount)}</td>
                      <td className="border p-2 font-semibold">
                        {money((r as any).balanceAfter || 0)}
                      </td>
                      {/* <td className="border p-2 text-left">{r.notes || "—"}</td> */}
                    </tr>
                  ))}

                  {clientDetailRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-4 text-center text-gray-500">
                        Este cliente no tiene movimientos.
                      </td>
                    </tr>
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
