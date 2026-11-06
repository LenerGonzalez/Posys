export function money(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `C$ ${safe.toLocaleString("es-NI", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function percent(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toLocaleString("es-NI", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export function qty(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString("es-NI", { maximumFractionDigits: 3 });
}

export function dateTimeLabel(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-NI", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
