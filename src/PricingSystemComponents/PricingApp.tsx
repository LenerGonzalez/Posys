import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  Alert,
  Box,
  Button,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Snackbar,
  ThemeProvider,
  Typography,
} from "@mui/material";
import { auth } from "../firebase";
import {
  createPricingInventory,
  deletePricingInventory,
  duplicatePricingInventory,
  getPricingInventory,
  listPricingInventories,
  savePricingInventory,
  saveProductPrice,
} from "./firestorePricing";
import {
  downloadInventoryWorkbook,
  downloadInvoiceTemplate,
  mergeImportedProducts,
  parseInvoiceWorkbook,
} from "./excelPricing";
import ImportPreviewDialog from "./ImportPreviewDialog";
import InventoryWorkspace from "./InventoryWorkspace";
import MainInventory from "./MainInventory";
import ProfitabilityDashboard from "./ProfitabilityDashboard";
import ProductProfitability from "./ProductProfitability";
import InventoryComparisonView from "./InventoryComparison";
import PriceSimulator from "./PriceSimulator";
import ChangeHistory from "./ChangeHistory";
import PriceRanking from "./PriceRanking";
import CommissionPayments from "./CommissionPayments";
import SalesDashboard from "./SalesDashboard.tsx";
import SalesRegister from "./SalesRegister";
import { computeInventory } from "./pricingEngine";
import { dialogActionsSx, useNarrowScreen } from "./screen";
import { pricingTheme } from "./theme";
import "./mobileDensity.css";
import { DEFAULT_SETTINGS, type ImportPreview, type PricingInventory } from "./types";

function pricingSection(pathname: string): "inventarios" | "rentabilidad" | "ranking" | "productos" | "comparacion" | "simulador" | "historial" | "ventas" | "comisiones" | "ventas-comisiones" {
  if (pathname.includes("/pricingSystem/ventas-comisiones")) return "ventas-comisiones";
  if (pathname.includes("/pricingSystem/comisiones")) return "comisiones";
  if (pathname.includes("/pricingSystem/ventas")) return "ventas";
  if (pathname.includes("/pricingSystem/comparacion")) return "comparacion";
  if (pathname.includes("/pricingSystem/productos")) return "productos";
  if (pathname.includes("/pricingSystem/simulador")) return "simulador";
  if (pathname.includes("/pricingSystem/historial")) return "historial";
  if (pathname.includes("/pricingSystem/ranking")) return "ranking";
  if (pathname.includes("/pricingSystem/rentabilidad")) return "rentabilidad";
  return "inventarios";
}

function inventoryIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/pricingSystem\/inventarios\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function signature(inventory: PricingInventory): string {
  return JSON.stringify({
    name: inventory.name,
    settings: inventory.settings,
    products: inventory.products,
  });
}

export default function PricingApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const section = pricingSection(location.pathname);
  const goBack = () => {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate("/admin/pricingSystem/inventarios");
  };
  const routeInventoryId = inventoryIdFromPath(location.pathname);
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<PricingInventory[]>([]);
  const [open, setOpen] = useState<PricingInventory | null>(null);
  const [baseline, setBaseline] = useState("");
  const [toast, setToast] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const narrow = useNarrowScreen();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listPricingInventories());
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudieron cargar los inventarios.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const stop = onAuthStateChanged(auth, (next) => {
      setUser(next);
      setReady(true);
      if (!next) {
        setItems([]);
        setOpen(null);
      }
    });
    return stop;
  }, []);

  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  const remember = (inventory: PricingInventory) => {
    setOpen(inventory);
    setBaseline(signature(inventory));
  };

  useEffect(() => {
    if (/\/pricingSystem\/?$/.test(location.pathname)) {
      navigate("/admin/pricingSystem/inventarios", { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!user || section !== "inventarios") return;
    if (!routeInventoryId) {
      setOpen(null);
      return;
    }
    if (open?.id === routeInventoryId) return;
    let cancelled = false;
    void getPricingInventory(routeInventoryId)
      .then((inventory) => {
        if (!cancelled) remember(inventory);
      })
      .catch((error) => {
        if (!cancelled) {
          setToast(error instanceof Error ? error.message : "No se pudo abrir.");
          navigate("/admin/pricingSystem/inventarios", { replace: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, section, routeInventoryId, location.pathname, navigate]);

  const computed = useMemo(() => (open ? computeInventory(open) : null), [open]);
  const dirty = !!open && signature(open) !== baseline;

  const readFile = async (file: File) => {
    try {
      setPreview(await parseInvoiceWorkbook(await file.arrayBuffer()));
    } catch {
      setToast("No se pudo leer el Excel.");
    }
  };

  const applyImport = async () => {
    if (!preview) return;
    const valid = preview.products;
    if (!valid.length) {
      setToast("No hay filas válidas para importar.");
      return;
    }
    try {
      if (open) {
        setOpen({ ...open, products: mergeImportedProducts(open.products, valid) });
        setToast("Factura aplicada a este inventario. Guarda para conservarla.");
      } else {
        const invoices = [...new Set(valid.map((product) => product.orderCode).filter(Boolean))];
        const created = await createPricingInventory({
          name: invoices[0] ? `Factura ${invoices[0]}` : "Inventario importado",
          settings: { ...DEFAULT_SETTINGS },
          products: valid,
        });
        await reload();
        remember(created);
        navigate(`/admin/pricingSystem/inventarios/${created.id}`);
        setToast("Inventario creado desde la factura.");
      }
      setPreview(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "No se pudo importar.");
    }
  };

  return (
    <ThemeProvider theme={pricingTheme}>
      <Container className="pricing-shell" maxWidth="lg" sx={{ py: { xs: 1, sm: 3 }, px: { xs: 0, sm: 3 }, pb: { xs: "calc(8px + env(safe-area-inset-bottom))", sm: 3 }, minWidth: 0 }}>
        {!ready ? <Alert severity="info">Conectando…</Alert> : null}
        {ready && !user ? (
          <Alert severity="warning">Inicia sesión para ver y guardar tus inventarios.</Alert>
        ) : null}
        {user && section === "rentabilidad" ? (
          <ProfitabilityDashboard inventories={items} />
        ) : null}
        {user && section === "comparacion" ? (
          <InventoryComparisonView inventories={items} onBack={goBack} />
        ) : null}
        {user && section === "productos" ? (
          <ProductProfitability inventories={items} onBack={goBack} />
        ) : null}
        {user && section === "simulador" ? (
          <PriceSimulator inventories={items} onBack={goBack} />
        ) : null}
        {user && section === "historial" ? (
          <ChangeHistory inventories={items} onBack={goBack} />
        ) : null}
        {user && section === "ventas" ? <SalesRegister inventories={items} /> : null}
        {user && section === "comisiones" ? <CommissionPayments inventories={items} /> : null}
        {user && section === "ventas-comisiones" ? <SalesDashboard inventories={items} /> : null}
        {user && section === "ranking" ? (
          <PriceRanking
            inventories={items}
            onSave={async (inventoryId, productId, draft) => {
              await saveProductPrice(inventoryId, productId, draft);
              await reload();
            }}
          />
        ) : null}
        {user && section === "inventarios" && routeInventoryId && !open ? (
          <Alert severity="info">Abriendo inventario…</Alert>
        ) : null}
        {user && section === "inventarios" && !open && !routeInventoryId ? (
          <MainInventory
            inventories={items}
            loading={loading}
            onOpen={(inventory) => {
              navigate(`/admin/pricingSystem/inventarios/${inventory.id}`);
            }}
            onRename={(inventory, name) => {
              void savePricingInventory({ ...inventory, name })
                .then(async () => {
                  await reload();
                  setToast("Nombre actualizado.");
                })
                .catch((error) => setToast(error instanceof Error ? error.message : "No se pudo cambiar el nombre."));
            }}
            onCreate={(name) => {
              void createPricingInventory({
                name,
                settings: { ...DEFAULT_SETTINGS },
                products: [],
              })
                .then(async (created) => {
                  await reload();
                  remember(created);
                  navigate(`/admin/pricingSystem/inventarios/${created.id}`);
                })
                .catch((error) => setToast(error instanceof Error ? error.message : "No se pudo crear."));
            }}
            onDuplicate={(id) => {
              void duplicatePricingInventory(id)
                .then(async () => {
                  await reload();
                  setToast("Inventario duplicado.");
                })
                .catch((error) => setToast(error instanceof Error ? error.message : "No se pudo duplicar."));
            }}
            onDelete={(id) => {
              void deletePricingInventory(id)
                .then(async () => {
                  await reload();
                  setToast("Inventario eliminado.");
                })
                .catch((error) => setToast(error instanceof Error ? error.message : "No se pudo eliminar."));
            }}
            onImportFile={(file) => void readFile(file)}
            onDownloadTemplate={downloadInvoiceTemplate}
          />
        ) : null}
        {user && section === "inventarios" && open && computed ? (
          <InventoryWorkspace
            initialTab={new URLSearchParams(location.search).get("producto") ? 3 : 0}
            inventory={open}
            computed={computed}
            saving={saving}
            dirty={dirty}
            onChange={setOpen}
            onSave={() => {
              if (!open.name.trim()) {
                setToast("Escribe un nombre para el inventario.");
                return;
              }
              setSaving(true);
              void savePricingInventory({ ...open, name: open.name.trim() })
                .then(async (saved) => {
                  remember(saved);
                  await reload();
                  setToast("Inventario guardado.");
                })
                .catch((error) => setToast(error instanceof Error ? error.message : "No se pudo guardar."))
                .finally(() => setSaving(false));
            }}
            onBack={() => {
              if (dirty) setConfirmLeave(true);
              else navigate("/admin/pricingSystem/inventarios");
            }}
            onImportFile={(file) => void readFile(file)}
            onDownloadTemplate={downloadInvoiceTemplate}
            onExport={() => {
              try {
                const filename = downloadInventoryWorkbook(open, computed);
                setToast(`Se descargó ${filename}.`);
              } catch (error) {
                setToast(error instanceof Error ? error.message : "No se pudo exportar el inventario.");
              }
            }}
          />
        ) : null}
      </Container>
      <ImportPreviewDialog
        preview={preview}
        narrow={narrow}
        onClose={() => setPreview(null)}
        onApply={() => void applyImport()}
      />
      <Dialog open={confirmLeave} onClose={() => setConfirmLeave(false)} fullScreen={narrow} fullWidth maxWidth="xs">
        <DialogTitle sx={{ pt: narrow ? "calc(16px + env(safe-area-inset-top))" : undefined }}>Hay cambios sin guardar</DialogTitle>
        <DialogContent>
          <Typography>Si sales ahora, este inventario volverá al último guardado.</Typography>
        </DialogContent>
        <DialogActions sx={dialogActionsSx}>
          <Button onClick={() => setConfirmLeave(false)}>Seguir editando</Button>
          <Button
            color="warning"
            onClick={() => {
              setConfirmLeave(false);
              navigate("/admin/pricingSystem/inventarios");
            }}
          >
            Salir sin guardar
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast("")}
        message={toast}
      />
    </ThemeProvider>
  );
}
