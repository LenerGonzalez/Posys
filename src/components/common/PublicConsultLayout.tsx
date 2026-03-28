import React from "react";
import { NavLink, useNavigate } from "react-router-dom";

const PUBLIC_LINKS = [
  { to: "/publico/precios-venta", label: "Precios ventas" },
  { to: "/publico/saldos-externos", label: "Saldos externos" },
] as const;

export default function PublicConsultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const navigate = useNavigate();

  const goBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: false });
    }
  };

  return (
    <div className="min-h-[100svh] bg-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-200/90 bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 pt-3 pb-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 gap-y-3">
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
            >
              <span aria-hidden>←</span>
              Volver
            </button>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500 sm:ml-1">
              Consulta pública
            </span>
          </div>
          <nav
            className="mt-3 flex flex-wrap gap-2"
            aria-label="Páginas de consulta pública"
          >
            {PUBLIC_LINKS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  [
                    "rounded-xl px-3 py-2 text-sm font-semibold transition",
                    isActive
                      ? "bg-slate-900 text-white shadow"
                      : "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
                  ].join(" ")
                }
                end
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-5 py-5 sm:px-8 sm:py-6">
        {children}
      </main>
    </div>
  );
}
