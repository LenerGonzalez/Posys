import React, { useState } from "react";
import { createPortal } from "react-dom";
import { FiInfo } from "react-icons/fi";

type CommissionAbonoHelpButtonProps = {
  /** Clases del icono (tamaño/color) */
  iconClassName?: string;
  /** Clases del botón contenedor */
  buttonClassName?: string;
};

/**
 * Botón (i) que abre un modal con la explicación del cálculo de comisión por abono
 * ligado a venta a crédito (proporcional al monto abonado).
 */
export default function CommissionAbonoHelpButton({
  iconClassName = "h-4 w-4",
  buttonClassName = "",
}: CommissionAbonoHelpButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-emerald-700 hover:bg-emerald-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${buttonClassName}`}
        title="Cómo se calcula la comisión por abono"
        aria-label="Información: comisión por abono"
        onClick={() => setOpen(true)}
      >
        <FiInfo className={iconClassName} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="commission-abono-help-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/45"
              aria-label="Cerrar"
              onClick={() => setOpen(false)}
            />
            <div
              className="relative z-10 w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <h3
                  id="commission-abono-help-title"
                  className="text-lg font-bold text-slate-900 pr-2"
                >
                  Comisión por abono (venta a crédito)
                </h3>
                <button
                  type="button"
                  className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
                  onClick={() => setOpen(false)}
                >
                  Cerrar
                </button>
              </div>

              <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
                <p>
                  En cada venta a crédito ya conocés la{" "}
                  <strong>comisión total</strong> del vendedor para esa venta
                  (como en cierre de ventas). Cuando el cliente{" "}
                  <strong>abona</strong> y el movimiento va{" "}
                  <strong>ligado a esa venta</strong>, la comisión que corresponde
                  a <em>ese abono</em> es una parte proporcional del total.
                </p>

                <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 font-mono text-[13px] text-slate-800">
                  comisión del abono = comisión total de la venta × (monto del
                  abono ÷ total de la venta)
                </div>

                <p className="text-slate-600">
                  <span className="font-semibold text-slate-800">Ejemplo:</span>{" "}
                  venta de C$ 100, comisión total C$ 20, abono de C$ 10 → fracción
                  cobrada 10/100; comisión de ese abono = 20 × (10 ÷ 100) = C$
                  2.
                </p>

                <p className="text-slate-600 text-[13px]">
                  Los <strong>abonos generales</strong> (sin venta ligada) no
                  llevan este cálculo: la comisión por abono queda en 0 porque no
                  hay una venta de referencia.
                </p>
              </div>

              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                  onClick={() => setOpen(false)}
                >
                  Entendido
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
