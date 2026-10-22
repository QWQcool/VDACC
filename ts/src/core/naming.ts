const ILLEGAL = /[<>:"/\\|?*#\u0000-\u001f]/g;

export function safeName(raw: string, limit = 55, fallback = 'media'): string {
  let s = (raw || '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) return fallback;
  return s.slice(0, limit);
}
