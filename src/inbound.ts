import type { Message } from "spectrum-ts";

// Spectrum groups contain Message objects (including image attachments), not bare Content.
export function inboundMessages(message: Message, depth = 0): Message[] {
  if (message.direction === "outbound" || depth > 8) return [];
  return message.content.type === "group"
    ? message.content.items.flatMap(item => inboundMessages(item, depth + 1))
    : [message];
}
