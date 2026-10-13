/**
 * Normalize a display phone string into a tel: URI.
 * Strips everything except digits and a leading '+'.
 * Returns "" for blank/whitespace-only or all-non-digit input so
 * the caller can skip rendering the link.
 */
export function telHref(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}
