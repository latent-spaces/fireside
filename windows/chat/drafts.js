/** Add an explicit action or rescued draft without replacing existing writing. */
export function appendDraft(box, text) {
  if (!text) return box.value.length;
  if (box.value === text || box.value.endsWith('\n\n' + text)) return box.value.length - text.length;
  const prefix = box.value ? box.value + '\n\n' : '';
  box.value = prefix + text;
  box.dispatchEvent?.(new Event('input', { bubbles: true }));
  return prefix.length;
}
