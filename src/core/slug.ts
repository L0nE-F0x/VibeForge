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

/**
 * Whether `value` has a slug of its own. A name with no letter a-z or digit in it (テスト, Ревью, an
 * emoji) slugs to "item", as every other such name does, so its slug can't tell it from them.
 */
export function hasSlug(value: string): boolean {
  return /[a-z0-9]/i.test(value);
}

export function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}
