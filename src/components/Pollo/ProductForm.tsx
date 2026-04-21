// src/components/Pollo/ProductForm.tsx
import React, { useEffect, useRef, useState } from "react";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../../firebase";
import {
  addDoc,
  collection,
  deleteField,
  doc,
  getDocs,
  updateDoc,
} from "firebase/firestore";
import SlideOverDrawer from "../common/SlideOverDrawer";
import Button from "../common/Button";
import ActionMenu, {
  ActionMenuTrigger,
  actionMenuItemClass,
  actionMenuItemClassDestructive,
  actionMenuItemClassGreen,
} from "../common/ActionMenu";
import { propagatePolloProductDisplayFields } from "../../Services/syncPolloProductDisplay";
import { ImageWithFallback } from "../common/ImageWithFallback";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

/** Mismo bucket que Candies (`precios_venta`); carpeta dedicada a catálogo Pollo. */
const POLLO_PRODUCT_IMAGES_PREFIX = "productos_pollo";

function normalizeCategory(s: string) {
  return String(s ?? "")
    .trim()
    .toUpperCase();
}

function normalizeMeasurement(s: string) {
  return String(s ?? "")
    .trim()
    .toUpperCase();
}

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  measurement: string;
  providerPrice?: number;
  active?: boolean;
  imageUrl?: string;
}

function pickProductImageUrlFromDoc(it: Record<string, unknown>): string | undefined {
  const images = it.images;
  const firstFromArray =
    Array.isArray(images) &&
    images.length > 0 &&
    typeof images[0] === "string"
      ? (images[0] as string).trim()
      : "";
  const cands: unknown[] = [
    it.imageUrl,
    it.image,
    it.photo,
    it.picture,
    it.thumbnail,
    it.img,
    it.imageURL,
    it.displayImageUrl,
    it.photoUrl,
    firstFromArray || undefined,
  ];
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export default function ProductForm() {
  const [name, setName] = useState("");
  const [price, setPrice] = useState<number>(0);
  const [providerPrice, setProviderPrice] = useState<number>(0);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [measurement, setMeasurement] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageUploading, setImageUploading] = useState(false);
  const productImageInputRef = useRef<HTMLInputElement>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  /** null = cerrado; producto base al editar (para propagar solo si cambió). */
  const [drawerEditBase, setDrawerEditBase] = useState<Product | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [rowMenu, setRowMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);

  const loadProducts = async () => {
    setLoadingList(true);
    const snap = await getDocs(collection(db, "products"));
    const rows: Product[] = [];
    snap.forEach((d) => {
      const it = d.data() as any;
      rows.push({
        id: d.id,
        name: it.name ?? "",
        price: Number(it.price ?? 0),
        providerPrice: Number(it.providerPrice ?? 0),
        category: normalizeCategory(it.category ?? ""),
        measurement: normalizeMeasurement(it.measurement ?? ""),
        active: it.active !== false,
        imageUrl: pickProductImageUrlFromDoc(it as Record<string, unknown>),
      });
    });
    setProducts(rows);
    setLoadingList(false);
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const resetForm = () => {
    setName("");
    setPrice(0);
    setProviderPrice(0);
    setCategory("");
    setMeasurement("");
    setImageUrl("");
    setImageUploading(false);
    setMessage("");
    setDrawerEditBase(null);
  };

  const openCreate = () => {
    resetForm();
    setDrawerOpen(true);
  };

  const openEdit = (p: Product) => {
    setDrawerEditBase(p);
    setName(p.name);
    setPrice(p.price);
    setProviderPrice(p.providerPrice || 0);
    setCategory(p.category);
    setMeasurement(p.measurement);
    setImageUrl(p.imageUrl ?? "");
    setMessage("");
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setDrawerEditBase(null);
    resetForm();
  };

  const handlePickProductImage = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage("❌ Seleccioná un archivo de imagen.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setMessage("❌ La imagen debe pesar menos de 4 MB.");
      return;
    }
    const folderId = drawerEditBase?.id ?? "pending";
    setImageUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const safe = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)
        ? ext
        : "jpg";
      const path = `${POLLO_PRODUCT_IMAGES_PREFIX}/${folderId}/${Date.now()}.${safe}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, {
        contentType: file.type || "image/jpeg",
      });
      const url = await getDownloadURL(storageRef);
      setImageUrl(url);
      setMessage(
        "✅ Imagen subida. Misma ubicación que Candies (Firebase Storage). Guardá el producto para confirmar.",
      );
      setTimeout(() => setMessage(""), 4000);
    } catch (err) {
      console.error(err);
      setMessage(
        "❌ No se pudo subir la imagen. Revisá que seas admin y las reglas de Storage. Si ves CORS: scripts/storage-cors.json en el bucket (ver firebase.ts).",
      );
    } finally {
      setImageUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    const cat = normalizeCategory(category);
    const meas = normalizeMeasurement(measurement);

    if (!name.trim() || price <= 0 || !meas) {
      setMessage("❌ Completa nombre, precio válido y unidad de medida");
      return;
    }

    try {
      const trimmedImg = imageUrl.trim();
      if (drawerEditBase) {
        const ref = doc(db, "products", drawerEditBase.id);
        await updateDoc(ref, {
          name: name.trim(),
          price: parseFloat(price.toFixed(2)),
          providerPrice: parseFloat((providerPrice || 0).toFixed(2)),
          category: cat,
          measurement: meas,
          ...(trimmedImg
            ? { imageUrl: trimmedImg }
            : { imageUrl: deleteField() }),
        });

        const patch: {
          name?: string;
          category?: string;
          measurement?: string;
        } = {};
        if (name.trim() !== drawerEditBase.name) patch.name = name.trim();
        if (cat !== normalizeCategory(drawerEditBase.category))
          patch.category = cat;
        if (meas !== normalizeMeasurement(drawerEditBase.measurement))
          patch.measurement = meas;

        if (Object.keys(patch).length > 0) {
          await propagatePolloProductDisplayFields(drawerEditBase.id, patch);
        }

        setProducts((prev) =>
          prev.map((x) =>
            x.id === drawerEditBase.id
              ? {
                  ...x,
                  name: name.trim(),
                  category: cat,
                  measurement: meas,
                  price: parseFloat(price.toFixed(2)),
                  providerPrice: parseFloat((providerPrice || 0).toFixed(2)),
                  imageUrl: trimmedImg || undefined,
                }
              : x,
          ),
        );
      } else {
        const payload = {
          name: name.trim(),
          price: parseFloat(price.toFixed(2)),
          providerPrice: parseFloat((providerPrice || 0).toFixed(2)),
          category: cat,
          measurement: meas,
          active: true,
          ...(trimmedImg ? { imageUrl: trimmedImg } : {}),
        };
        const newRef = await addDoc(collection(db, "products"), payload);
        setProducts((prev) => [{ id: newRef.id, ...payload }, ...prev]);
      }

      closeDrawer();
    } catch (err: any) {
      setMessage("❌ Error: " + err.message);
    }
  };

  const toggleActive = async (p: Product) => {
    const ref = doc(db, "products", p.id);
    const newActive = !(p.active !== false);
    await updateDoc(ref, { active: newActive });
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: newActive } : x)),
    );
    setRowMenu(null);
  };

  /** “Eliminar” = baja lógica; no borra documento ni afecta ventas/lotes históricos. */
  const softDeleteProduct = async (p: Product) => {
    const ok = confirm(
      "¿Ocultar este producto en listas nuevas?\n" +
        "Las ventas e inventarios ya registrados no se modifican.",
    );
    if (!ok) return;
    const ref = doc(db, "products", p.id);
    await updateDoc(ref, { active: false });
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: false } : x)),
    );
    setRowMenu(null);
  };

  const visibleRows = showInactive
    ? products
    : products.filter((p) => p.active !== false);

  const drawerTitle = drawerEditBase ? "Editar producto" : "Registrar producto";

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Productos</h2>
        <Button type="button" variant="primary" size="md" onClick={openCreate}>
          <span className="inline-block bg-white/15 rounded-full p-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </span>
          Nuevo producto
        </Button>
      </div>

      <SlideOverDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={drawerTitle}
        subtitle={drawerEditBase ? `ID: ${drawerEditBase.id}` : undefined}
        titleId="product-form-drawer-title"
        panelMaxWidthClassName="max-w-lg"
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end border-t border-gray-100 pt-3">
            <Button type="button" variant="secondary" onClick={closeDrawer}>
              Cancelar
            </Button>
            <Button type="submit" form="product-form-drawer-form" variant="primary">
              {drawerEditBase ? "Guardar cambios" : "Agregar producto"}
            </Button>
          </div>
        }
      >
        <form
          id="product-form-drawer-form"
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Categoría
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-green-400 uppercase"
            >
              <option value="">Selecciona</option>
              <option value="POLLO">Pollo</option>
              <option value="CERDO">Cerdo</option>
              <option value="HUEVO">Huevos</option>
              <option value="ROPA">Ropa</option>
              <option value="OTROS">Otros</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Nombre del producto
            </label>
            <input
              type="text"
              className="w-full border p-2 rounded-lg"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Tipo de unidad de medida
            </label>
            <select
              value={measurement}
              onChange={(e) => setMeasurement(e.target.value)}
              className="w-full border border-gray-300 p-2 rounded-lg focus:ring-2 focus:ring-green-400 uppercase"
            >
              <option value="">Selecciona</option>
              <option value="LB">Libra</option>
              <option value="CAJILLA">Cajilla</option>
              <option value="KG">Kilogramo</option>
              <option value="UNIDAD">Unidad</option>
            </select>
          </div>

          <div>
            <label className="block text-sm">Precio proveedor (ej: 40.00)</label>
            <input
              type="number"
              step="0.01"
              className="w-full border p-2 rounded-lg"
              value={Number.isNaN(providerPrice) ? "" : providerPrice}
              onChange={(e) => setProviderPrice(parseFloat(e.target.value))}
            />
          </div>

          <div>
            <label className="block text-sm">Precio por unidad (ej: 55.50)</label>
            <input
              type="number"
              step="0.01"
              className="w-full border p-2 rounded-lg"
              value={Number.isNaN(price) ? "" : price}
              onChange={(e) => setPrice(parseFloat(e.target.value))}
              onFocus={(e) =>
                e.target.value === "0" ? setPrice(NaN) : null
              }
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-semibold text-gray-700">
              Imagen del producto (opcional)
            </label>
            <p className="text-xs text-gray-500 -mt-1">
              Se sube al mismo Storage que Candies (carpeta{" "}
              <code className="text-[11px] bg-slate-100 px-1 rounded">
                {POLLO_PRODUCT_IMAGES_PREFIX}/
              </code>
              ). La URL queda guardada en el documento del producto.
            </p>
            <input
              ref={productImageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handlePickProductImage}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={imageUploading}
                onClick={() => productImageInputRef.current?.click()}
              >
                {imageUploading ? "Subiendo…" : "Subir imagen"}
              </Button>
              {imageUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={imageUploading}
                  onClick={() => {
                    setImageUrl("");
                    setMessage("Imagen quitada del formulario. Guardá para borrarla del producto.");
                    setTimeout(() => setMessage(""), 3000);
                  }}
                >
                  Quitar imagen
                </Button>
              ) : null}
            </div>
            {imageUrl ? (
              <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/80 p-2">
                <div className="w-20 h-20 shrink-0 rounded-lg overflow-hidden border border-slate-200 bg-white">
                  <ImageWithFallback
                    src={imageUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-[11px] text-slate-600 break-all min-w-0 pt-1">
                  {imageUrl}
                </p>
              </div>
            ) : null}
            <div className="space-y-1 pt-1 border-t border-slate-100">
              <label className="block text-xs font-medium text-gray-600">
                O pegar URL manualmente
              </label>
              <input
                type="url"
                inputMode="url"
                className="w-full border p-2 rounded-lg text-sm"
                placeholder="https://…"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
              />
            </div>
          </div>

          {message ? <p className="text-sm text-gray-700">{message}</p> : null}
        </form>
      </SlideOverDrawer>

      <div className="flex items-center justify-between mt-6 mb-2">
        <h3 className="text-lg font-semibold p-2">Productos</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Mostrar inactivos
        </label>
      </div>

      <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr className="text-[11px] uppercase tracking-wider text-slate-600">
              <th className="p-3 border-b text-left">Nombre</th>
              <th className="p-3 border-b text-left">Categoría</th>
              <th className="p-3 border-b text-left">Unidad</th>
              <th className="p-3 border-b text-right">Precio proveedor</th>
              <th className="p-3 border-b text-right">Precio</th>
              <th className="p-3 border-b text-left">Estado</th>
              <th className="p-3 border-b text-left w-24">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loadingList ? (
              <tr>
                <td colSpan={7} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-4 text-center">
                  Sin productos
                </td>
              </tr>
            ) : (
              visibleRows.map((p) => {
                const isActive = p.active !== false;
                return (
                  <tr
                    key={p.id}
                    className="text-center odd:bg-white even:bg-slate-50"
                  >
                    <td className="p-3 border-b text-left">{p.name}</td>
                    <td className="p-3 border-b text-left uppercase">
                      {normalizeCategory(p.category)}
                    </td>
                    <td className="p-3 border-b text-left uppercase">
                      {normalizeMeasurement(p.measurement)}
                    </td>
                    <td className="p-3 border-b text-right">
                      {money(p.providerPrice || 0)}
                    </td>
                    <td className="p-3 border-b text-right">{money(p.price)}</td>
                    <td className="p-3 border-b text-left">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          isActive
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-200 text-gray-700"
                        }`}
                      >
                        {isActive ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="p-3 border-b text-left">
                      <ActionMenuTrigger
                        aria-label={`Acciones ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (
                            e.currentTarget as HTMLButtonElement
                          ).getBoundingClientRect();
                          setRowMenu({ id: p.id, rect: r });
                        }}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <ActionMenu
        anchorRect={rowMenu?.rect ?? null}
        isOpen={!!rowMenu}
        onClose={() => setRowMenu(null)}
      >
        {rowMenu ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClassGreen}
              onClick={() => {
                const p = products.find((x) => x.id === rowMenu.id);
                if (p) openEdit(p);
                setRowMenu(null);
              }}
            >
              Editar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClass}
              onClick={() => {
                const p = products.find((x) => x.id === rowMenu.id);
                if (p) void toggleActive(p);
              }}
            >
              {products.find((x) => x.id === rowMenu.id)?.active !== false
                ? "Desactivar"
                : "Activar"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClassDestructive}
              onClick={() => {
                const p = products.find((x) => x.id === rowMenu.id);
                if (p) void softDeleteProduct(p);
              }}
            >
              Eliminar (ocultar)
            </Button>
          </>
        ) : null}
      </ActionMenu>
    </div>
  );
}
