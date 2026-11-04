import { useEffect, useState } from "react";

/**
 * Live "Expires in m:ss" for a consent request that main denies at `expiresAtMs`. `compact`
 * shows only "m:ss" and keeps the full phrase in the title.
 */
export function RequestDeadline({
  expiresAtMs,
  className,
  compact = false,
}: {
  expiresAtMs: number;
  className?: string;
  compact?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  if (compact)
    return (
      <span title={`Expires in ${remaining}`} className={className}>
        {remaining}
      </span>
    );
  return <p className={className}>Expires in {remaining}</p>;
}
