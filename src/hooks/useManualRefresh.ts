import { useState, useCallback } from "react";

export default function useManualRefresh() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { refreshKey, refresh };
}
