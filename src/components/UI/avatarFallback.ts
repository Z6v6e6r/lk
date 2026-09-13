/** Local SVG: no network request and no user text interpreted as markup. */
export function avatarFallbackUrl(name: string, initials?: string): string {
  const label = (initials?.trim() || name.trim().split(/\s+/u).slice(0, 2)
    .map((part) => Array.from(part)[0] || "").join("") || "?").toUpperCase();
  const escaped = label.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#7353D9"/><text x="50" y="50" dy=".35em" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="33" font-weight="700">${escaped}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
