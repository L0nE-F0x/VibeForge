export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "item";
}

export function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}
