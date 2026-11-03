// useLive(topic, load): data that reloads whenever the server publishes on
// `topic`, and after the realtime connection comes back.
import { useCallback, useEffect, useState } from "react";
import { onReconnect, subscribe } from "./live";

export function useLive<T>(topic: string, load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(
    () =>
      load().then(
        (value) => {
          setData(value);
          setError(undefined);
        },
        (err: Error) => setError(err),
      ),
    [topic],
  );
  useEffect(() => {
    void reload();
    const stopTopic = subscribe(topic, () => void reload());
    const stopReconnect = onReconnect(() => void reload());
    return () => {
      stopTopic();
      stopReconnect();
    };
  }, [reload]);
  return { data, error, reload };
}
