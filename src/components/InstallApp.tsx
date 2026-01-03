import React, { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function InstallPWAButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    // Detecta si ya está instalada
    const checkInstalled = () => {
      const isStandalone =
        window.matchMedia?.("(display-mode: standalone)")?.matches ||
        (window.navigator as any).standalone === true;
      setInstalled(!!isStandalone);
    };

    checkInstalled();
    window.addEventListener("appinstalled", () => {
      setInstalled(true);
      setDeferred(null);
    });

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (installed) return null;

  const onClickInstall = async () => {
    if (!deferred) {
      // No está installable → mostramos ayuda
      setShowHelp(true);
      return;
    }
    try {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
    } catch {
      setShowHelp(true);
    }
  };

  return (
    <div className="fixed bottom-20 right-3 z-[9999]">
      <button
        onClick={onClickInstall}
        className="px-4 py-3 rounded-2xl shadow-2xl bg-blue-600 text-white font-semibold"
      >
        {deferred ? "Instalar Posys" : "Cómo instalar"}
      </button>

      {showHelp && (
        <div className="mt-2 w-[320px] bg-white border rounded-2xl shadow-2xl p-3 text-sm">
          <div className="font-bold mb-2">Instalar en Android</div>

          <ol className="list-decimal ml-5 space-y-1 text-gray-700">
            <li>
              Abrí en <b>Chrome</b> (no Facebook/Instagram browser).
            </li>
            <li>
              Entrá a tu URL: <b>https://posys-103de.web.app/</b>
            </li>
            <li>
              Probá: <b>⋮</b> → <b>Agregar a pantalla principal</b>.
            </li>
            <li>
              Si no aparece, borrá datos del sitio:
              <br />
              Chrome → Ajustes → Configuración de sitios → Almacenamiento →
              buscá <b>posys-103de.web.app</b> → <b>Borrar</b>.
            </li>
          </ol>

          <div className="flex justify-end mt-2">
            <button
              className="px-3 py-2 rounded-xl bg-gray-200"
              onClick={() => setShowHelp(false)}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
