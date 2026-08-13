/**
 * Capitalizes just the first letter of user-typed text for display (history
 * chips, "Re: ..." headings, the history modal list) — the query itself is
 * sent to the server unchanged, this only affects how it's rendered back.
 */
export function capitalizeFirst(text: string): string {
  if (text === "") return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
