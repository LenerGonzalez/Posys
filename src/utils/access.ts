// src/utils/access.ts
import { hasRole } from "./roles";

export type Role =
  | "admin"
  | "supervisor_pollo"
  | "contador"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

export type Action = "view" | "edit";

export type PathKey =
  // POLLO
  | "bills"
  | "expenses"
  | "customersPollo"
  | "transactionsPollo"
  | "batches"
  | "salesV2"
  | "financialDashboard"
  | "polloCashAudits"
  | "billing" 
  | "statusAccount"
  | "salesCandies"
  | "productsVendorsCandies"
  | "productsPricesCandies"
  | "transactionCandies"
  | "cierreVentasCandies"
  | "customersCandies";

type Permission = Partial<Record<Action, boolean>>;

const PERMISSIONS: Record<Role, Partial<Record<PathKey, Permission>>> = {
  admin: {
    billing: { view: true, edit: true },
  },

  // ===== POLLO =====
  supervisor_pollo: {
    bills: { view: true, edit: false },
    expenses: { view: true, edit: false },
    customersPollo: { view: true, edit: false },
    transactionsPollo: { view: true, edit: false },
    batches: { view: true, edit: false },
    statusAccount: { view: true, edit: true },
  },

  contador: {
    billing: { view: true, edit: true },
    salesV2: { view: true, edit: true },
    customersPollo: { view: true, edit: true },
    batches: { view: true, edit: true }, // (nota: "solo crear lote" lo resolvemos en pantalla luego)
    transactionsPollo: { view: true, edit: false },
    bills: { view: true, edit: false },
    expenses: { view: true, edit: true },
    financialDashboard: { view: true, edit: false },
    statusAccount: { view: true, edit: true },
  },

  vendedor_pollo: {
    salesV2: { view: true, edit: true },
    transactionsPollo: { view: true, edit: false },
    bills: { view: true, edit: false },
    customersPollo: { view: true, edit: true }, // según matriz nueva
  },

  // ===== DULCES =====
  vendedor_dulces: {
    salesCandies: { view: true, edit: true },
    productsVendorsCandies: { view: true, edit: false },
    // En tu matriz: VER = NO para estos 3
    productsPricesCandies: { view: true, edit: false },
    transactionCandies: { view: true, edit: false },
    cierreVentasCandies: { view: true, edit: false },
    customersCandies: { view: true, edit: true },
  },

  vendedor_ropa: {},
};

function normalizeRoles(subject: any): Role[] {
  if (!subject) return [];
  if (Array.isArray(subject)) return subject.filter(Boolean) as Role[];
  return [subject].filter(Boolean) as Role[];
}

export function canPath(subject: any, path: PathKey, action: Action = "view") {
  const roles = normalizeRoles(subject);

  // Admin override total
  if (roles.some((r) => r === "admin")) return true;

  // Unión de permisos por multi-rol
  return roles.some((r) => !!PERMISSIONS[r]?.[path]?.[action]);
}

// ===== Acciones finas (botones/edición) =====
export type FineAction =
  | "create"
  | "update"
  | "delete"
  | "export"
  | "cerrarVentas" // cerrar ventas / cierre
  | "price_edit"; // editar precios

type FinePerm = Partial<Record<FineAction, boolean>>;

// ⚠️ Ajustalo según tu matriz fina. Esto es un punto de partida.
const FINE_PERMISSIONS: Record<Role, Partial<Record<PathKey, FinePerm>>> = {
  admin: {},

  supervisor_pollo: {
    bills: { cerrarVentas: false },
    batches: { create: false, update: false, delete: false, export: false },
    statusAccount: { update: false }, 
  },

  contador: {
    // tu regla: batches "solo crear lote"
    batches: { create: true, update: false, delete: false, export: true },
    bills: { cerrarVentas: false },
    statusAccount: { update: true },
  },

  vendedor_pollo: {
    salesV2: { create: true, update: true },
    customersPollo: { update: true },
    bills: { cerrarVentas: true }, // si "ver cierre" no implica "cerrar", ponelo false
  },

  vendedor_dulces: {
    salesCandies: { create: true, update: true },
    productsVendorsCandies: { create: true, update: false, delete: false },
    customersCandies: { update: true },
    productsPricesCandies: { price_edit: false },
  },

  vendedor_ropa: {},
};

export function canAction(
  subject: any,
  path: PathKey,
  action: FineAction,
): boolean {
  const roles = normalizeRoles(subject);

  // ✅ admin override TOTAL
  if (roles.some((r) => r === "admin")) return true;

  // si no puede ver la pantalla, no puede hacer acciones
  if (!canPath(subject, path, "view")) return false;

  // unión de permisos por multi-rol
  return roles.some((r) => {
    const perm = FINE_PERMISSIONS[r]?.[path];
    return !!perm?.[action];
  });
}

// Helpers opcionales (por si te sirven en layouts)
export function hasAnyRole(subject: any, role: Role) {
  const roles = normalizeRoles(subject);
  if (!roles.length) return false;
  return roles.some((r) => hasRole(roles, role));
}
