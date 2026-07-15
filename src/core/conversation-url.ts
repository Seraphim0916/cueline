export function isExactChatGptConversationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "chatgpt.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      /^\/c\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function normalizedConversationUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const pathname =
      parsed.pathname !== "/" && parsed.pathname.endsWith("/")
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    return `${parsed.origin}${pathname}`;
  } catch {
    return value;
  }
}

export function sameChatGptConversationUrl(left: string, right: string): boolean {
  return (
    isExactChatGptConversationUrl(left) &&
    isExactChatGptConversationUrl(right) &&
    normalizedConversationUrl(left) === normalizedConversationUrl(right)
  );
}
