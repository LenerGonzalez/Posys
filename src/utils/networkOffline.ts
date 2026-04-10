/** Evento global: fallo de red al consultar el servidor (fetch u otra acción). */
export const OFFLINE_REQUEST_FAILED = "posys-offline-request-failed";

export function dispatchOfflineRequestFailed(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_REQUEST_FAILED));
}

/**
 * Marca intentos fallidos de red (p. ej. fetch sin conexión) para que el overlay
 * de sin internet pueda mostrarse aunque `navigator.onLine` siga en true.
 */
export function installFetchFailureOfflineHint(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { __posysFetchPatched?: boolean };
  if (w.__posysFetchPatched) return;
  w.__posysFetchPatched = true;

  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!navigator.onLine) {
      dispatchOfflineRequestFailed();
    }
    try {
      return await orig(input, init);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNetworkFailure =
        e instanceof TypeError &&
        (msg.includes("Failed to fetch") ||
          msg.includes("fetch") ||
          msg.includes("Load failed") ||
          msg.includes("NetworkError") ||
          msg.includes("network"));
      if (isNetworkFailure) dispatchOfflineRequestFailed();
      throw e;
    }
  };
}
