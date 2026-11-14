/** Download from a blob URL so a cross-origin asset can never navigate the app window. */
export async function downloadAsset(src: string, name: string): Promise<void> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("The file could not be downloaded.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
