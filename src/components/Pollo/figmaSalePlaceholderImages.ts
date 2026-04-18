/**
 * Fotos de respaldo cuando un producto en Firestore no tiene imagen.
 * Colocá los .jpg en `public/pollo-sale/` con el mismo nombre (respetá mayúsculas en Linux/hosting).
 *
 * Sin `imageUrl` en Firebase, la imagen se elige por palabras en el nombre del producto
 * (orden importa: reglas más específicas primero). Si no coincide nada, se usa un reparto
 * por hash del id (como antes).
 */
const POLLO_SALE_PLACEHOLDER_FILES = [
  "PECHUGA.jpg",
  "HUEVOS.jpg",
  "CERDO.jpg",
  "MENUDO.jpg",
  "PIERNAS.jpg",
] as const;

export const FIGMA_SALE_PLACEHOLDER_IMAGES: string[] =
  POLLO_SALE_PLACEHOLDER_FILES.map((name) => `/pollo-sale/${name}`);

const polloSalePath = (file: string) => `/pollo-sale/${file}`;

/**
 * Palabra clave en el nombre (minúsculas) → archivo en public/pollo-sale/.
 * Orden: la primera regla que aplique gana.
 */
const PLACEHOLDER_NAME_RULES: ReadonlyArray<{
  keywords: string[];
  file: (typeof POLLO_SALE_PLACEHOLDER_FILES)[number];
}> = [
  { keywords: ["menudo", "mondongo", "tripa"], file: "MENUDO.jpg" },
  { keywords: ["pierna", "muslo", "ala"], file: "PIERNAS.jpg" },
  { keywords: ["pechuga"], file: "PECHUGA.jpg" },
  { keywords: ["huevo", "huevos", "cajilla"], file: "HUEVOS.jpg" },
  { keywords: ["cerdo", "posta", "costilla"], file: "CERDO.jpg" },
];

export function placeholderPathFromProductName(
  name: string | undefined | null,
): string | null {
  const n = String(name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (!n.trim()) return null;
  for (const { keywords, file } of PLACEHOLDER_NAME_RULES) {
    if (keywords.some((k) => n.includes(k))) return polloSalePath(file);
  }
  return null;
}

export function figmaPlaceholderForProductId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % FIGMA_SALE_PLACEHOLDER_IMAGES.length;
  return FIGMA_SALE_PLACEHOLDER_IMAGES[idx]!;
}

function placeholderForProduct(
  productId: string,
  productName?: string | null,
): string {
  const byName = placeholderPathFromProductName(productName);
  if (byName) return byName;
  return figmaPlaceholderForProductId(productId);
}

/** URL segura para <img>: vacío → placeholder por nombre o id; // → https:; rutas / públicas tal cual. */
export function resolveProductImageSrc(
  url: string | undefined | null,
  productId: string,
  productName?: string | null,
): string {
  const t = String(url ?? "").trim();
  if (!t) return placeholderForProduct(productId, productName);
  if (t.startsWith("//")) return `https:${t}`;
  if (/^www\./i.test(t)) return `https://${t}`;
  if (/^(gs:|blob:|file:)/i.test(t))
    return placeholderForProduct(productId, productName);
  return t;
}
