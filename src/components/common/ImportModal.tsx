import React from "react";

type Props = {
  open: boolean;
  title?: string;
  accept?: string;
  importFileName?: string | null;
  importLoading?: boolean;
  importErrors?: string[];
  onClose: () => void;
  onPickFile: (f: File | null) => void;
  onDownloadTemplate: () => void;
};

export default function ImportModal({
  open,
  title = "Importar archivo",
  accept = ".xlsx,.xls,.csv",
  importFileName,
  importLoading,
  importErrors,
  onClose,
  onPickFile,
  onDownloadTemplate,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100]">
      <div className="bg-white w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-lg border border-slate-200 p-5 text-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xl font-bold">{title}</h3>
          <button
            className="px-3 py-1 rounded-md text-xs font-semibold bg-slate-200 text-slate-700 hover:bg-slate-300"
            onClick={onClose}
            type="button"
          >
            Cerrar
          </button>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-3">
          <div className="flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
            <div>
              <div className="font-semibold">1) Subí tu archivo</div>
              <div className="text-xs text-slate-600">
                Formato aceptado: {accept}
              </div>
            </div>
            <button
              className="px-3 py-2 rounded-md text-xs font-semibold bg-slate-200 text-slate-700 hover:bg-slate-300"
              onClick={onDownloadTemplate}
              type="button"
            >
              Descargar template
            </button>
          </div>

          <div className="mt-3 flex flex-col md:flex-row gap-3 md:items-center">
            <input
              type="file"
              accept={accept}
              onChange={(e) => onPickFile(e.target.files?.[0] || null)}
            />
            {importFileName && (
              <span className="text-xs text-slate-600">
                Archivo: <b>{importFileName}</b>
              </span>
            )}
            {importLoading && <span className="text-xs">Procesando…</span>}
          </div>
        </div>

        {importErrors && importErrors.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded p-3 mb-3">
            <div className="font-semibold text-red-700 mb-2">
              Errores encontrados
            </div>
            <ul className="list-disc pl-5 text-red-700 text-xs space-y-1">
              {importErrors.slice(0, 50).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
