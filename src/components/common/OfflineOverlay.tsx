import React, { useCallback, useEffect, useState } from "react";
import { enableNetwork } from "firebase/firestore";
import { db } from "../../firebase";

/**
 * Pantalla completa cuando el navegador reporta sin conexión.
 * "Re intentar" reactiva Firestore y comprueba conectividad hacia el origen de la app.
 */
export default function OfflineOverlay() {
  const [browserOffline, setBrowserOffline] = useState(() => !navigator.onLine);
  const [connectivityOk, setConnectivityOk] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const onOnline = () => {
      setBrowserOffline(false);
      setConnectivityOk(false);
    };
    const onOffline = () => {
      setBrowserOffline(true);
      setConnectivityOk(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const visible = browserOffline && !connectivityOk;

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await enableNetwork(db);
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`${window.location.origin}/`, {
        cache: "no-store",
        method: "GET",
      });
      if (res.ok) setConnectivityOk(true);
    } catch {
      /* sigue sin red */
    } finally {
      setRetrying(false);
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[350] flex flex-col items-center justify-center bg-slate-950/85 px-6 backdrop-blur-sm"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Sin conexión a internet"
    >
      <div className="w-full max-w-sm rounded-2xl border border-slate-600/80 bg-slate-900/95 p-6 text-center shadow-2xl">
        <p className="text-base leading-relaxed text-white">
          Parece que no tienes internet, intenta conectarte
        </p>
        <button
          type="button"
          disabled={retrying}
          onClick={() => void handleRetry()}
          className="mt-5 w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {retrying ? "Comprobando…" : "Re intentar"}
        </button>
      </div>
    </div>
  );
}
