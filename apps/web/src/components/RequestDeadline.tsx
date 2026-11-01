import { useEffect, useState } from "react";

/** Live "Expires in m:ss" for a consent request that main denies at `expiresAtMs`. */
export function RequestDeadline({
  expiresAtMs,
  className,
}: {
  expiresAtMs: number;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  return (
    <p className={className}>
      Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </p>
  );
}
