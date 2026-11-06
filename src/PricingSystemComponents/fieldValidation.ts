export type NumericKind =
  | "logistics"
  | "commission"
  | "margin"
  | "cost"
  | "packages"
  | "manualPrice"
  | "optionalCommission"
  | "optionalMargin";

export type DraftParse =
  | { state: "empty" }
  | { state: "invalid"; message: string }
  | { state: "valid"; value: number };

const MESSAGES: Record<NumericKind, string> = {
  logistics: "Los gastos logísticos no pueden ser negativos.",
  commission: "La comisión debe estar entre 0 % y 100 %.",
  optionalCommission: "La comisión debe estar entre 0 % y 100 %.",
  margin: "El margen debe ser de 0 % o más, y menor que 100 %.",
  optionalMargin: "El margen debe ser de 0 % o más, y menor que 100 %.",
  cost: "El costo por paquete no puede ser negativo.",
  packages: "La cantidad de paquetes debe ser un número entero mayor que cero.",
  manualPrice: "El precio manual no puede ser negativo.",
};

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function usableMoney(value: number): number {
  const n = finite(Number(value));
  if (n == null || n < 0) return 0;
  return n;
}

export function usableCommission(value: number): number {
  const n = finite(Number(value));
  if (n == null || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Un margen de 100 % o más sigue fuera del cálculo de precio. Uno negativo no entra. */
export function usableSettingsMargin(value: number): number {
  const n = finite(Number(value));
  if (n == null || n < 0) return 0;
  return n;
}

export function usableProductMargin(value: number | null): number | null {
  if (value == null) return null;
  const n = finite(Number(value));
  if (n == null || n < 0 || n >= 100) return null;
  return n;
}

export function usableProductCommission(value: number | null): number | null {
  if (value == null) return null;
  const n = finite(Number(value));
  if (n == null || n < 0 || n > 100) return null;
  return n;
}

export function usableManualPrice(value: number | null): number | null {
  if (value == null) return null;
  const n = finite(Number(value));
  if (n == null || n < 0) return null;
  return n;
}

/** Entero mayor que cero. Un decimal que no es entero no entra al cálculo. */
export function usablePackages(value: number): number {
  const n = finite(Number(value));
  if (n == null || n <= 0) return 0;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 1e-6) return 0;
  return rounded;
}

export function normalizeTyped(previous: string, incoming: string, integer: boolean): string {
  let text = incoming.replace(/,/g, ".");
  text = integer ? text.replace(/[^\d.\-]/g, "") : text.replace(/[^\d.\-]/g, "");
  const negative = text.startsWith("-");
  const unsigned = text.replace(/-/g, "");
  if (integer) {
    text = `${negative ? "-" : ""}${unsigned}`;
  } else {
    const parts = unsigned.split(".");
    text = `${negative ? "-" : ""}${parts[0]}${parts.length > 1 ? `.${parts.slice(1).join("")}` : ""}`;
  }
  if (previous === "0" && /^0\d/.test(text)) text = text.replace(/^0+/, "");
  text = text.replace(/^(-?)0+(?=\d)/, "$1");
  text = text.replace(/^(-?)0+(?=\.)/, "$10");
  return text;
}

function messageFor(kind: NumericKind): string {
  return MESSAGES[kind];
}

function validateNumber(value: number, kind: NumericKind): DraftParse {
  if (!Number.isFinite(value)) return { state: "invalid", message: messageFor(kind) };
  if (kind === "logistics" || kind === "cost" || kind === "manualPrice") {
    if (value < 0) return { state: "invalid", message: messageFor(kind) };
    return { state: "valid", value };
  }
  if (kind === "commission" || kind === "optionalCommission") {
    if (value < 0 || value > 100) return { state: "invalid", message: messageFor(kind) };
    return { state: "valid", value };
  }
  if (kind === "margin" || kind === "optionalMargin") {
    if (value < 0 || value >= 100) return { state: "invalid", message: messageFor(kind) };
    return { state: "valid", value };
  }
  if (!Number.isInteger(value) || value <= 0) {
    return { state: "invalid", message: messageFor(kind) };
  }
  return { state: "valid", value };
}

export function parseNumericDraft(raw: string, kind: NumericKind): DraftParse {
  const text = raw.trim();
  if (text === "" || text === ".") return { state: "empty" };
  if (text.startsWith("-")) return { state: "invalid", message: messageFor(kind) };
  if (kind === "packages" && text.includes(".")) {
    return { state: "invalid", message: messageFor(kind) };
  }
  if (text.endsWith(".")) {
    return validateNumber(Number(text.slice(0, -1)), kind);
  }
  return validateNumber(Number(text), kind);
}

export function reviewNumericChange(
  current: number | null,
  previousDraft: string,
  typed: string,
  kind: NumericKind,
): { draft: string; value: number | null; error: string | null; commit: boolean } {
  const draft = normalizeTyped(previousDraft, typed, kind === "packages");
  const parsed = parseNumericDraft(draft, kind);
  if (parsed.state === "valid") {
    return { draft, value: parsed.value, error: null, commit: true };
  }
  if (parsed.state === "invalid") {
    return { draft, value: current, error: parsed.message, commit: false };
  }
  return { draft, value: current, error: null, commit: false };
}

export function reviewNumericBlur(
  current: number | null,
  draft: string,
  kind: NumericKind,
): { value: number | null; error: string | null; commit: boolean } {
  const parsed = parseNumericDraft(draft, kind);
  if (parsed.state === "valid") return { value: parsed.value, error: null, commit: true };
  if (parsed.state === "invalid") return { value: current, error: parsed.message, commit: false };
  if (kind === "logistics" || kind === "cost") return { value: 0, error: null, commit: true };
  if (kind === "manualPrice" || kind === "optionalCommission" || kind === "optionalMargin") {
    return { value: null, error: null, commit: true };
  }
  return { value: current, error: null, commit: false };
}
