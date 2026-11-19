/** Share a module promise across Suspense readers, but let later readers retry
 * a failed download rather than permanently caching its rejection. */
export function retryableImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
