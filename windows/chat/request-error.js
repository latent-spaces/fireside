/** Some ACP adapters deliver terminal request errors as assistant text.
 * Recognize only the complete transport error, never prose quoting an error.
 * Keep this a presentation concern: the transcript and retry behavior stay intact.
 */
export function requestError(message) {
  if (message.role !== 'assistant') return null;
  const match = /^exceeded retry limit, last status:\s*([45]\d{2})(?:[ \t]+([^\r\n]+))?$/i.exec(String(message.text || '').trim());
  if (!match) return null;
  return { status: match[1], reason: match[2] || '', original: message.text.trim() };
}
