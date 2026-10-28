export function electronVersion(manifest: unknown): string {
  const pkg = manifest as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } | null;
  const version = pkg?.dependencies?.electron ?? pkg?.devDependencies?.electron;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(
      "Electron cache requires an exact x.y.z pin in dependencies or devDependencies",
    );
  return version;
}
