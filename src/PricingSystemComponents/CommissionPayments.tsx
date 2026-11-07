import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { v4 as uuid } from "uuid";
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import PaymentsOutlinedIcon from "@mui/icons-material/PaymentsOutlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import { auth } from "../firebase";
import {
  assessHistoricalRounding,
  balanceCents,
  emptyQueue,
  fromCents,
  historicalRoundingPayment,
  lineKey,
  planPayment,
  toCents,
  UNEXPLAINED_ROUNDING_MESSAGE,
  type CommissionBalance,
  type CommissionPayment,
  type CommissionQueue,
  type PaymentApplication,
} from "./commissionCommit";
import { readCommissionBook, registerPayment } from "./firestorePayments";
import { dateTimeLabel, money } from "./format";
import NumericField from "./NumericField";
import { dialogActionsSx, useNarrowScreen } from "./screen";
import type { PricingInventory } from "./types";

function inventoryLabel(inventories: PricingInventory[], inventoryId: string): string {
  return inventories.find((inventory) => inventory.id === inventoryId)?.name.trim() || "Inventario";
}

function Metric({
  icon,
  label,
  value,
  background,
  color,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  background: string;
  color: string;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, px: { xs: 1, md: 1.5 }, py: { xs: 1, md: 1.5 }, borderRadius: "12px", bgcolor: background }}>
      <Box sx={{ width: { xs: 28, md: 36 }, height: { xs: 28, md: 36 }, borderRadius: "10px", bgcolor: "#FFFFFF", color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ color, display: "block", lineHeight: 1.2 }}>{label}</Typography>
        <Typography sx={{ fontWeight: 800, color, fontSize: { xs: "1.05rem", sm: "1.45rem" }, lineHeight: 1.15, overflowWrap: "anywhere" }}>{value}</Typography>
      </Box>
    </Box>
  );
}

function ApplyMark({ pendingAfter }: { pendingAfter: number }) {
  const complete = toCents(pendingAfter) <= 0;
  return (
    <Box sx={{ px: 1, py: 0.3, borderRadius: 999, bgcolor: complete ? "#E6F4EA" : "#FEF4D6", flexShrink: 0 }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: complete ? "#0D652D" : "#8D4E00" }}>
        {complete ? "Completa" : "Parcial"}
      </Typography>
    </Box>
  );
}

function ApplyBar({ amount, pendingAfter }: { amount: number; pendingAfter: number }) {
  const total = toCents(amount) + toCents(pendingAfter);
  const ratio = total <= 0 ? 0 : toCents(amount) / total;
  const complete = toCents(pendingAfter) <= 0;
  return (
    <Box sx={{ height: 4, borderRadius: 99, bgcolor: "#E8EAED", overflow: "hidden" }}>
      <Box sx={{ width: `${Math.min(100, Math.round(ratio * 100))}%`, height: "100%", bgcolor: complete ? "#0D652D" : "#1A56DB" }} />
    </Box>
  );
}

function sameSeller(queue: CommissionQueue | undefined, sellerUid: string): CommissionQueue {
  if (queue && queue.sellerUid === sellerUid) return queue;
  return emptyQueue(queue?.ownerUid || "", sellerUid);
}

export default function CommissionPayments({ inventories }: { inventories: PricingInventory[] }) {
  const [balances, setBalances] = useState<CommissionBalance[]>([]);
  const [queues, setQueues] = useState<CommissionQueue[]>([]);
  const [payments, setPayments] = useState<CommissionPayment[]>([]);
  const [sellers, setSellers] = useState<Array<{ sellerUid: string; sellerName: string }>>([]);
  const [sellerUid, setSellerUid] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [operationId, setOperationId] = useState(() => uuid());
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState<CommissionPayment | null>(null);
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  const savingRef = useRef(false);
  const narrow = useNarrowScreen();
  const sellerLock = useRef("");

  const reload = async () => {
    const book = await readCommissionBook();
    setBalances(book.balances);
    setQueues(book.queues);
    setPayments(book.payments);
    setSellers(book.sellers);
    setSellerUid((current) => {
      if (current && book.sellers.some((seller) => seller.sellerUid === current)) return current;
      const mine = book.sellers.find((seller) => seller.sellerUid === auth.currentUser?.uid);
      return mine?.sellerUid || book.sellers[0]?.sellerUid || "";
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void reload()
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "No se pudieron consultar las comisiones.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sellerUid) return;
    if (!sellerLock.current) {
      sellerLock.current = sellerUid;
      return;
    }
    if (sellerLock.current === sellerUid) return;
    sellerLock.current = sellerUid;
    setOperationId(uuid());
    setAmount(null);
    setError("");
    setConfirming(false);
  }, [sellerUid]);

  const sellerBalances = useMemo(
    () => balances.filter((balance) => balance.sellerUid === sellerUid),
    [balances, sellerUid],
  );
  const queue = useMemo(
    () => sameSeller(queues.find((item) => item.sellerUid === sellerUid), sellerUid),
    [queues, sellerUid],
  );
  const rounding = useMemo(
    () => assessHistoricalRounding(payments.filter((payment) => payment.sellerUid === sellerUid), sellerBalances),
    [payments, sellerBalances, sellerUid],
  );
  const shownBalances = rounding.balances;
  const roundingPayment = rounding.status === "adjust" ? historicalRoundingPayment(payments.filter((payment) => payment.sellerUid === sellerUid)) : null;
  const generated = fromCents(shownBalances.reduce((sum, balance) => sum + balanceCents(balance).generated, 0));
  const paid = fromCents(shownBalances.reduce((sum, balance) => sum + balanceCents(balance).paid, 0));
  const pending = fromCents(shownBalances.reduce((sum, balance) => sum + balanceCents(balance).pending, 0));
  const plan = rounding.status === "unexplained"
    ? { status: "rejected" as const, message: UNEXPLAINED_ROUNDING_MESSAGE }
    : amount != null && amount > 0 ? planPayment(amount, queue, shownBalances) : null;
  const appliedCents = plan?.status === "planned" ? plan.applications.reduce((sum, line) => sum + toCents(line.amount), 0) : 0;
  const afterPayment = fromCents(Math.max(toCents(pending) - appliedCents, 0));
  const sellerName = sellers.find((seller) => seller.sellerUid === sellerUid)?.sellerName || "Vendedor";
  const history = payments.filter((payment) => payment.sellerUid === sellerUid);
  const openLines = queue.lines.map((line) => {
    const balance = shownBalances.find((item) => lineKey(item.saleId, item.lineIndex) === lineKey(line.saleId, line.lineIndex));
    return { line, pending: balance ? fromCents(balanceCents(balance).pending) : 0 };
  }).filter((item) => item.pending > 0);
  const roundingApplications = roundingPayment
    ? fromCents(roundingPayment.applications.reduce((sum, line) => sum + toCents(line.amount), 0))
    : 0;
  const roundingNote = rounding.status === "adjust"
    ? `Ajuste histórico de redondeo: ${money(0.01)}. Está incluido en la comisión pagada y no es un pago nuevo. El pago de ${money(roundingPayment?.amount || 0)} conserva sus aplicaciones; redondeadas por separado suman ${money(roundingApplications)}.`
    : "";

  const confirm = async () => {
    if (!plan || plan.status !== "planned" || savingRef.current || !sellerUid) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const payment = await registerPayment(operationId, sellerUid, amount || 0);
      setConfirming(false);
      setRegistered(payment);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo registrar el pago.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const closeSuccess = () => {
    setRegistered(null);
    setAmount(null);
    setOperationId(uuid());
    setError("");
  };

  const applicationCard = (line: PaymentApplication, key: string) => (
    <Box key={key} sx={{ display: "grid", gap: 0.75, p: 1.5, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, flexWrap: "wrap" }}>
        <Box sx={{ width: 34, height: 34, borderRadius: "10px", bgcolor: "#E8F0FE", color: "#1A56DB", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Inventory2OutlinedIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ flex: "1 1 140px", minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, lineHeight: 1.25, overflowWrap: "anywhere" }}>{line.productName}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {inventoryLabel(inventories, line.inventoryId)} · Factura {line.invoiceNumber || "sin número"}
          </Typography>
        </Box>
        <Box sx={{ textAlign: "right", flexShrink: 0, ml: "auto" }}>
          <Typography sx={{ fontWeight: 800 }}>{money(line.amount)}</Typography>
          <ApplyMark pendingAfter={line.pendingAfter} />
        </Box>
      </Box>
      <ApplyBar amount={line.amount} pendingAfter={line.pendingAfter} />
      <Typography variant="body2" color="text.secondary">Queda pendiente {money(line.pendingAfter)}</Typography>
    </Box>
  );

  return (
    <Box sx={{ display: "grid", gap: { xs: 1.25, md: 2 } }}>
      <Box>
        <Typography variant="h5">Comisiones</Typography>
        <Typography variant="body2" color="text.secondary">
          La comisión se genera con la venta y se paga después. El pago se reparte desde la comisión más antigua.
        </Typography>
      </Box>
      {error && !confirming ? (
        <Box sx={{ px: 1.25, py: 1, borderRadius: "12px", bgcolor: "#FCE8E6" }}>
          <Typography sx={{ color: "#A50E0E", fontSize: "0.875rem" }}>{error}</Typography>
        </Box>
      ) : null}

      <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: { xs: "1fr 1fr", md: "1fr 1fr 1fr" } }}>
        <Metric icon={<ReceiptLongOutlinedIcon fontSize="small" />} label="Comisión generada" value={loading ? "—" : money(generated)} background="#F8F9FB" color="#44474E" />
        <Metric icon={<CheckCircleOutlinedIcon fontSize="small" />} label="Comisión pagada" value={loading ? "—" : money(paid)} background="#E8F0FE" color="#1A56DB" />
        <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
          <Metric icon={<AccountBalanceWalletOutlinedIcon fontSize="small" />} label="Comisión pendiente" value={loading ? "—" : money(pending)} background="#F7F4FC" color="#6D4BA1" />
        </Box>
      </Box>
      {roundingNote ? (
        <Box sx={{ px: 1.25, py: 1, borderRadius: "12px", bgcolor: "#FEF4D6" }}>
          <Typography sx={{ color: "#8D4E00", fontSize: "0.875rem" }}>{roundingNote}</Typography>
        </Box>
      ) : null}

      <Card variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
        <CardContent sx={{ display: "grid", gap: { xs: 1, md: 1.5 } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: "10px", bgcolor: "#1A56DB", color: "#FFFFFF", display: { xs: "none", md: "flex" }, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <PaymentsOutlinedIcon fontSize="small" />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 800, lineHeight: 1.2 }}>Registrar pago</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Operación {operationId}</Typography>
            </Box>
          </Box>
          {sellers.length > 1 ? (
            <TextField
              select
              label="Vendedor"
              value={sellerUid}
              disabled={loading || saving}
              onChange={(event) => setSellerUid(event.target.value)}
            >
              {sellers.map((seller) => (
                <MenuItem key={seller.sellerUid} value={seller.sellerUid}>{seller.sellerName}</MenuItem>
              ))}
            </TextField>
          ) : (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 1, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
              <PersonOutlineOutlinedIcon sx={{ color: "#1A56DB" }} />
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>Vendedor</Typography>
                <Typography sx={{ fontWeight: 700 }}>{loading ? "Consultando…" : sellerName}</Typography>
              </Box>
            </Box>
          )}
          {!loading && !sellers.length ? (
            <Typography variant="body2" color="text.secondary">Todavía no hay comisiones. Se generan al registrar una venta.</Typography>
          ) : null}
          <NumericField
            label="Monto a pagar"
            kind="cost"
            value={amount}
            adornment="C$"
            adornmentPosition="start"
            onCommit={setAmount}
            clearWhenEmpty
            helperText={pending > 0 ? `Pendiente ${money(pending)}` : "No hay comisión pendiente."}
            disabled={!sellerUid || pending <= 0 || saving}
            sx={{ "& .MuiInputBase-input": { fontSize: { xs: "1.25rem", md: "1.55rem" }, fontWeight: 800 } }}
          />
          <Box sx={{ display: "grid", gap: 0.75, gridTemplateColumns: "1fr 1fr" }}>
            <Box sx={{ px: 1.5, py: 1.15, borderRadius: "12px", bgcolor: "#F7F4FC" }}>
              <Typography variant="caption" sx={{ color: "#6D4BA1", display: "block" }}>Comisión pendiente</Typography>
              <Typography sx={{ fontWeight: 800, color: "#6D4BA1", fontSize: "1.15rem" }}>{money(pending)}</Typography>
            </Box>
            <Box sx={{ px: 1.5, py: 1.15, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Después del pago</Typography>
              <Typography sx={{ fontWeight: 800, fontSize: "1.15rem" }}>{money(afterPayment)}</Typography>
            </Box>
          </Box>
          {plan?.status === "rejected" ? (
            <Typography sx={{ color: "#A50E0E", fontSize: "0.875rem" }}>{plan.message}</Typography>
          ) : null}
          <Button
            variant="contained"
            disabled={!plan || plan.status !== "planned" || saving}
            onClick={() => setConfirming(true)}
            sx={{ minHeight: { xs: 40, md: 48 } }}
          >
            Revisar pago
          </Button>
        </CardContent>
      </Card>

      {plan?.status === "planned" ? (
        <Box sx={{ display: "grid", gap: 1 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "baseline" }}>
            <Typography sx={{ fontWeight: 800 }}>Distribución del pago</Typography>
            <Typography variant="caption" sx={{ color: "#1A56DB", fontWeight: 700 }}>Más antigua primero</Typography>
          </Box>
          {plan.applications.map((line) => applicationCard(line, `${line.saleId}-${line.lineIndex}`))}
        </Box>
      ) : openLines.length ? (
        <Box sx={{ display: "grid", gap: 1 }}>
          <Typography sx={{ fontWeight: 800 }}>Comisiones pendientes</Typography>
          <Typography variant="body2" color="text.secondary">De la más antigua a la más nueva.</Typography>
          {openLines.map(({ line, pending: linePending }) => (
            <Box key={`${line.saleId}-${line.lineIndex}`} sx={{ display: "flex", justifyContent: "space-between", gap: 1, flexWrap: "wrap", p: 1.5, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
              <Box sx={{ minWidth: 0, flex: "1 1 160px" }}>
                <Typography sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>{line.productName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {dateTimeLabel(line.soldAt)} · {inventoryLabel(inventories, line.inventoryId)} · Factura {line.invoiceNumber || "sin número"}
                </Typography>
              </Box>
              <Typography sx={{ fontWeight: 800, flexShrink: 0 }}>{money(linePending)}</Typography>
            </Box>
          ))}
        </Box>
      ) : null}

      {history.length ? (
        <Box sx={{ display: "grid", gap: 1 }}>
          <Typography sx={{ fontWeight: 800 }}>Pagos registrados</Typography>
          {history.map((payment) => {
            const open = Boolean(openHistory[payment.operationId]);
            return (
              <Card key={payment.operationId} variant="outlined" sx={{ boxShadow: "0 1px 2px rgba(26, 28, 30, 0.04)" }}>
                <CardContent sx={{ display: "grid", gap: 1, pb: open ? 2 : 1.5 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 700 }}>{payment.sellerName}</Typography>
                      <Typography variant="body2" color="text.secondary">{dateTimeLabel(payment.paidAt)}</Typography>
                    </Box>
                    <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: "1.15rem" }}>{money(payment.amount)}</Typography>
                    <IconButton
                      aria-label={open ? "Ocultar aplicaciones" : "Ver aplicaciones"}
                      aria-expanded={open}
                      onClick={() => setOpenHistory((current) => ({ ...current, [payment.operationId]: !open }))}
                    >
                      <ExpandMoreIcon sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms ease" }} />
                    </IconButton>
                  </Box>
                  <Collapse in={open}>
                    <Box sx={{ display: "grid", gap: 1 }}>
                      {payment.applications.map((line) => (
                        <Box key={`${payment.operationId}-${line.saleId}-${line.lineIndex}`} sx={{ display: "grid", gap: 0.25, p: 1.25, borderRadius: "12px", bgcolor: "#F8F9FB" }}>
                          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                            <Typography sx={{ fontWeight: 700 }}>{line.productName}</Typography>
                            <Typography sx={{ fontWeight: 800, flexShrink: 0 }}>{money(line.amount)}</Typography>
                          </Box>
                          <Typography variant="body2" color="text.secondary">
                            {inventoryLabel(inventories, line.inventoryId)} · Factura {line.invoiceNumber || "sin número"} · Quedó pendiente {money(line.pendingAfter)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </Collapse>
                </CardContent>
              </Card>
            );
          })}
        </Box>
      ) : null}

      <Dialog
        open={confirming}
        onClose={() => { if (!saving) setConfirming(false); }}
        fullScreen={narrow}
        fullWidth
        maxWidth="sm"
        slotProps={{ paper: { sx: { borderRadius: narrow ? 0 : "20px", overflow: "hidden" } } }}
      >
        <DialogContent sx={{ p: 0 }}>
          <Box sx={{ display: "grid", gap: 1.25, px: { xs: 2, sm: 2.5 }, pt: narrow ? "calc(18px + env(safe-area-inset-top))" : 2, pb: 2, bgcolor: "#E8F0FE" }}>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
              <Box sx={{ width: 42, height: 42, borderRadius: "12px", bgcolor: "#1A56DB", color: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <PaymentsOutlinedIcon fontSize="small" />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" sx={{ color: "#1A56DB", fontWeight: 700, letterSpacing: 0.6 }}>GESTIÓN COMERCIAL</Typography>
                <Typography sx={{ fontWeight: 800, fontSize: "1.2rem", lineHeight: 1.15 }}>CONFIRMAR PAGO</Typography>
              </Box>
            </Box>
            <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
              <Box sx={{ px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF" }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Vendedor</Typography>
                <Typography sx={{ fontWeight: 700 }}>{sellerName}</Typography>
              </Box>
              <Box sx={{ px: 1.25, py: 1, borderRadius: "10px", bgcolor: "#FFFFFF" }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Monto total</Typography>
                <Typography sx={{ fontWeight: 800, color: "#6D4BA1" }}>{money(fromCents(appliedCents))}</Typography>
              </Box>
            </Box>
          </Box>
          <Box sx={{ display: "grid", gap: 1, px: { xs: 2, sm: 2.5 }, py: 2 }}>
            {plan?.status === "planned" ? plan.applications.map((line) => applicationCard(line, `confirm-${line.saleId}-${line.lineIndex}`)) : null}
            {error ? <Typography sx={{ color: "#A50E0E", fontSize: "0.875rem" }}>{error}</Typography> : null}
          </Box>
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setConfirming(false)} disabled={saving}>Cancelar</Button>
          <Button
            variant="contained"
            onClick={() => void confirm()}
            disabled={saving || plan?.status !== "planned"}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {saving ? "Registrando pago..." : "Confirmar y registrar"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(registered)}
        onClose={() => undefined}
        fullScreen={narrow}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: narrow ? 0 : "20px" } } }}
      >
        {registered ? (
          <DialogContent sx={{ display: "grid", alignContent: "start", gridAutoRows: "min-content", justifyItems: "center", gap: 1, textAlign: "center", pt: narrow ? "calc(16px + env(safe-area-inset-top))" : 3 }}>
            <Box sx={{ width: 56, height: 56, borderRadius: "16px", bgcolor: "#E6F4EA", color: "#0D652D", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CheckCircleOutlinedIcon />
            </Box>
            <Typography sx={{ fontWeight: 800, fontSize: "1.2rem", lineHeight: 1.25 }}>Pago registrado correctamente</Typography>
            <Typography sx={{ fontWeight: 800, color: "#0D652D", fontSize: "1.7rem", lineHeight: 1.1 }}>{money(registered.amount)}</Typography>
            <Typography variant="body2" color="text.secondary">{registered.sellerName}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>Operación {registered.operationId}</Typography>
          </DialogContent>
        ) : null}
        <DialogActions sx={{ ...dialogActionsSx, justifyContent: "center" }}>
          <Button variant="contained" onClick={closeSuccess}>Cerrar</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
