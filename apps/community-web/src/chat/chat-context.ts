export type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
export type PreparedContext = { question: string; text: string; omitted: boolean };

/** Keep the newest complete turns; never silently cut the user's question. */
export function prepareContext(
  messages: readonly ChatMessage[],
  question: string,
  maxBytes = 8192,
): PreparedContext | null {
  const current = question.trim();
  if (!current) return null;
  const encoder = new TextEncoder();
  let text = `用户: ${current}`;
  if (encoder.encode(text).length > maxBytes) return null;
  let index = messages.length;
  let kept = 0;
  while (index >= 2 && kept < 3) {
    const user = messages[index - 2];
    const assistant = messages[index - 1];
    if (!user || !assistant || user.role !== "user" || assistant.role !== "assistant") break;
    const prefix = `用户: ${user.text}\n助手: ${assistant.text}\n`;
    if (encoder.encode(prefix + text).length > maxBytes) break;
    text = prefix + text;
    index -= 2;
    kept++;
  }
  return { question: current, text, omitted: index > 0 };
}
