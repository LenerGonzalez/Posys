import React, { useCallback, useEffect, useState } from "react";
import { enableNetwork } from "firebase/firestore";
import { db } from "../../firebase";
import {
  OFFLINE_REQUEST_FAILED,
  dispatchOfflineRequestFailed,
} from "../../utils/networkOffline";

/**
 * Pantalla cuando no hay red o cuando falla una consulta al servidor.
 * "Re intentar" reactiva Firestore y comprueba conectividad hacia el origen.
 */
export default function OfflineOverlay() {
  const [online, setOnline] = useState(() => navigator.onLine);
  /** true si hubo fallo de red en una petición (aunque el navegador diga online). */
  const [requestFailed, setRequestFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** No mostrar overlay si la PWA está en segundo plano (evita falsos al cambiar de app). */
  const [appForeground, setAppForeground] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      setRequestFailed(false);
    };
    const onOffline = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      setOnline(false);
      setRequestFailed(false);
    };
    const onRequestFailed = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      setRequestFailed(true);
    };
    const onVisibility = () => {
      const fg = document.visibilityState === "visible";
      setAppForeground(fg);
      if (fg) {
        setOnline(navigator.onLine);
        if (navigator.onLine) setRequestFailed(false);
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener(OFFLINE_REQUEST_FAILED, onRequestFailed);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(OFFLINE_REQUEST_FAILED, onRequestFailed);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const showProblem = !online || requestFailed;
  const visible = appForeground && showProblem;

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
      if (res.ok) {
        setRequestFailed(false);
        if (navigator.onLine) setOnline(true);
      } else {
        dispatchOfflineRequestFailed();
      }
    } catch {
      dispatchOfflineRequestFailed();
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
