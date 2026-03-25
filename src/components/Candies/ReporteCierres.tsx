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
  // resumen clientes collapsed by default
  const [summaryCollapsed, setSummaryCollapsed] = useState(true);
  // filtros detalle collapsed by default
  const [detailFiltersCollapsed, setDetailFiltersCollapsed] = useState(true);

  // filtros detalle
  const [detailFrom, setDetailFrom] = useState("");
  const [detailTo, setDetailTo] = useState("");
  const [detailTypeFilter, setDetailTypeFilter] = useState<"ALL" | RecordType>(
    "ALL",
  );

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
    return clientSummaries.filter((c) => {
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
  }, [
    clientSummaries,
    clientFilter,
    lastSaleFrom,
    lastSaleTo,
    lastAbonoFrom,
    lastAbonoTo,
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
    if (forcedClientId) setRecordClientId(forcedClientId);
    setRecordModalOpen(true);
  };

  const openEditRecordModal = (row: ExternalRecord) => {
    setEditingRecordId(row.id);
    setRecordClientId(row.clientId);
    setRecordType(row.type);
    setRecordDate(row.date || today());
    setRecordAmount(String(Number(row.amount || 0).toFixed(2)));
    setRecordNotes(row.notes || "");
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
      const target = ev.target as Node;

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
        setDetailModalOpen(false);
        setActionOpenId(null);
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
        <h2 className="text-xl sm:text-2xl font-bold">
          Saldos Pendientes Externos
        </h2>

        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            type="button"
            onClick={exportToExcel}
            className="px-3 py-2 border rounded bg-white hover:bg-gray-50 text-sm"
          >
            Excel
          </button>
        </div>
      </div>

      {/* acciones */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={openCreateClientModal}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Crear cliente
        </button>

        <button
          type="button"
          onClick={() => openCreateRecordModal("CUENTA_NUEVA")}
          className="bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700"
        >
          Agregar cuenta nueva
        </button>

        <button
          type="button"
          onClick={() => openCreateRecordModal("ABONO")}
          className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
        >
          Agregar abono
        </button>
      </div>

      {/* KPI general */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <div className="border rounded-2xl p-3 bg-sky-50">
          <div className="text-xs text-gray-600">Clientes</div>
          <div className="text-2xl font-bold">{generalKpis.totalClientes}</div>
        </div>

        <div className="border rounded-2xl p-3 bg-emerald-50">
          <div className="text-xs text-gray-600">Cuentas nuevas</div>
          <div className="text-2xl font-bold">
            {money(generalKpis.totalCuentas)}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-violet-50">
          <div className="text-xs text-gray-600">Abonos</div>
          <div className="text-2xl font-bold">
            {money(generalKpis.totalAbonos)}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-amber-50">
          <div className="text-xs text-gray-600">Registros</div>
          <div className="text-2xl font-bold">{generalKpis.totalRegistros}</div>
        </div>

        <div className="border rounded-2xl p-3 bg-gray-900 text-white">
          <div className="text-xs opacity-80">Saldo pendiente general</div>
          <div className="text-2xl font-extrabold">
            {money(generalKpis.saldoPendiente)}
          </div>
        </div>
      </div>

      {/* filtros resumen (card colapsable) */}
      <div className="mb-5">
        <div className="border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50">
            <h3 className="font-semibold">Filtros</h3>
            <button
              type="button"
              onClick={() => setFiltersCollapsed((s) => !s)}
              className="px-2 py-1 rounded bg-white border text-sm hover:bg-gray-100"
              aria-expanded={!filtersCollapsed}
            >
              {filtersCollapsed ? "Mostrar" : "Ocultar"}
            </button>
          </div>

          {!filtersCollapsed && (
            <div className="p-4 bg-white">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
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

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Última venta desde
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={lastSaleFrom}
                    onChange={(e) => setLastSaleFrom(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Última venta hasta
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={lastSaleTo}
                    onChange={(e) => setLastSaleTo(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Último abono desde
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={lastAbonoFrom}
                    onChange={(e) => setLastAbonoFrom(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Último abono hasta
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={lastAbonoTo}
                    onChange={(e) => setLastAbonoTo(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* tabla resumen clientes (card colapsable) */}
      <div className="mb-6">
        <div className="border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50">
            <h3 className="font-semibold">Resumen por cliente</h3>
            <button
              type="button"
              onClick={() => setSummaryCollapsed((s) => !s)}
              className="px-2 py-1 rounded bg-white border text-sm hover:bg-gray-100"
              aria-expanded={!summaryCollapsed}
            >
              {summaryCollapsed ? "Mostrar" : "Ocultar"}
            </button>
          </div>

          {!summaryCollapsed && (
            <div className="p-4 bg-white">
              {/* Mobile: cards */}
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
                          <div className="mt-2 text-xs text-gray-600 grid grid-cols-3 gap-2">
                            <div>
                              <div className="text-[10px]">Cuentas</div>
                              <div className="font-semibold">
                                {Number(r.totalCuentas || 0)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px]">Abonos</div>
                              <div className="font-semibold">
                                {Number(r.totalAbonos || 0)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px]">Registros</div>
                              <div className="font-semibold">{r.registros}</div>
                            </div>
                          </div>
                        </div>

                        <div className="flex-shrink-0 text-right">
                          <div className="text-xs text-gray-600">Saldo</div>
                          <div className="font-semibold">
                            {money(r.saldoActual)}
                          </div>
                          <div className="mt-2 flex flex-col gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setDetailClientId(r.clientId);
                                setDetailModalOpen(true);
                              }}
                              className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Ver
                            </button>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  openCreateRecordModal(
                                    "CUENTA_NUEVA",
                                    r.clientId,
                                  )
                                }
                                className="flex-1 px-2 py-1 text-xs rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 md:px-1 md:py-0.5 md:text-[12px]"
                              >
                                Cuenta
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  openCreateRecordModal("ABONO", r.clientId)
                                }
                                className="flex-1 px-2 py-1 text-xs rounded bg-violet-100 text-violet-700 hover:bg-violet-200 md:px-1 md:py-0.5 md:text-[12px]"
                              >
                                Abono
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Desktop: full table */}
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
                      <th className="border p-2">Registros</th>
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
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setDetailClientId(r.clientId);
                                setDetailModalOpen(true);
                              }}
                              className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Ver
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                openEditClientModal(
                                  clientsById[r.clientId] || {
                                    id: r.clientId,
                                    name: r.clientName,
                                    phone: r.phone,
                                    description: r.description,
                                  },
                                )
                              }
                              className="px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Editar cliente
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                openCreateRecordModal(
                                  "CUENTA_NUEVA",
                                  r.clientId,
                                )
                              }
                              className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Cuenta
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                openCreateRecordModal("ABONO", r.clientId)
                              }
                              className="px-2 py-1 rounded bg-violet-100 text-violet-700 hover:bg-violet-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Abono
                            </button>

                            <button
                              type="button"
                              onClick={() => deleteClientSafe(r.clientId)}
                              className="px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 md:px-1 md:py-0.5 md:text-[12px]"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {filteredSummaries.length === 0 && (
                      <tr>
                        <td
                          colSpan={10}
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

      {/* filtros detalle (card colapsable) */}
      <div className="mb-4">
        <div className="border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50">
            <h3 className="font-semibold">Filtros del detalle</h3>
            <button
              type="button"
              onClick={() => setDetailFiltersCollapsed((s) => !s)}
              className="px-2 py-1 rounded bg-white border text-sm hover:bg-gray-100"
              aria-expanded={!detailFiltersCollapsed}
            >
              {detailFiltersCollapsed ? "Mostrar" : "Ocultar"}
            </button>
          </div>

          {!detailFiltersCollapsed && (
            <div className="p-4 bg-white">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Desde
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={detailFrom}
                    onChange={(e) => setDetailFrom(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Hasta
                  </label>
                  <input
                    type="date"
                    className="border rounded px-3 py-2 w-full bg-white"
                    value={detailTo}
                    onChange={(e) => setDetailTo(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm text-gray-600 mb-1">
                    Tipo
                  </label>
                  <select
                    className="border rounded px-3 py-2 w-full bg-white"
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
            </div>
          )}
        </div>
      </div>

      {/* tabla detalle */}
      <div className="overflow-x-auto">
        <h3 className="font-semibold mb-2">Detalle de registros</h3>

        <table className="min-w-full w-full border text-sm table-auto">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Cliente</th>
              <th className="border p-2">Tipo</th>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Monto</th>
              <th className="border p-2">Saldo final</th>
              <th className="border p-2">Notas</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filteredDetailRows.map((r) => (
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
                <td className="border p-2 text-left">{r.notes || "—"}</td>
                <td className="border p-2 relative">
                  <div className="inline-block">
                    <button
                      onClick={() =>
                        setActionOpenId(actionOpenId === r.id ? null : r.id)
                      }
                      className="px-2 py-1 rounded hover:bg-gray-100 md:px-1 md:py-0.5 md:text-[12px]"
                      aria-label="Acciones"
                    >
                      ⋯
                    </button>

                    {actionOpenId === r.id && (
                      <div
                        ref={(el) => {
                          actionMenuRef.current = el as HTMLDivElement | null;
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
                <td colSpan={7} className="p-4 text-center text-gray-500">
                  No hay registros para los filtros seleccionados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* modal cliente */}
      {clientModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setClientModalOpen(false)}
          />

          <div
            ref={clientModalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-xl shadow-xl"
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
                  className="px-4 py-2 border rounded"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveClient}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
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
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setRecordModalOpen(false)}
          />

          <div
            ref={recordModalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-2xl shadow-xl"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                {editingRecordId
                  ? "Editar registro"
                  : recordType === "CUENTA_NUEVA"
                    ? "Agregar cuenta nueva"
                    : "Agregar abono"}
              </h3>

              <button
                type="button"
                onClick={() => setRecordModalOpen(false)}
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
                  className="border rounded px-3 py-2 w-full"
                  value={recordClientId}
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
                  <option value="CUENTA_NUEVA">Cuenta nueva</option>
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
                  {recordType === "CUENTA_NUEVA" ? "Saldo inicial" : "Abono"}
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

              <div className="md:col-span-2">
                <label className="block text-sm text-gray-600 mb-1">
                  Notas
                </label>
                <textarea
                  className="border rounded px-3 py-2 w-full min-h-[90px]"
                  value={recordNotes}
                  onChange={(e) => setRecordNotes(e.target.value)}
                  placeholder="Observación opcional"
                />
              </div>

              <div className="md:col-span-2">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <div className="border rounded-xl p-3 bg-gray-50">
                    <div className="text-xs text-gray-600">Cliente</div>
                    <div className="font-semibold">
                      {selectedClientSummary?.clientName || "—"}
                    </div>
                  </div>

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
                  onClick={() => setRecordModalOpen(false)}
                  className="px-4 py-2 border rounded"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveRecord}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
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
                <div className="text-xs text-gray-600">Registros</div>
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
                    <th className="border p-2">Notas</th>
                  </tr>
                </thead>
                <tbody>
                  {clientDetailRows.map((r) => (
                    <tr key={r.id} className="text-center">
                      <td className="border p-2">
                        {r.type === "CUENTA_NUEVA" ? "Cuenta nueva" : "Abono"}
                      </td>
                      <td className="border p-2">{r.date}</td>
                      <td className="border p-2">{money(r.amount)}</td>
                      <td className="border p-2 font-semibold">
                        {money((r as any).balanceAfter || 0)}
                      </td>
                      <td className="border p-2 text-left">{r.notes || "—"}</td>
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
