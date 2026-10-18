type Pin = { latitude: number; longitude: number; label?: string; expires: number };

// Parse only coordinates explicitly shared by the user; never fetch arbitrary links.
export function parseLocationLink(text: string): Omit<Pin, "expires"> | null {
  for (const match of text.matchAll(/https:\/\/[^\s<>]+/g)) {
    let url: URL;
    try { url = new URL(match[0]); } catch { continue; }
    const apple = url.hostname === "maps.apple.com";
    const google = ["maps.google.com", "www.google.com", "google.com"].includes(url.hostname);
    if (!apple && !google) continue;
    if (google && url.hostname !== "maps.google.com" && !url.pathname.startsWith("/maps")) continue;
    const coordinates = apple
      ? url.searchParams.get("coordinate") ?? url.searchParams.get("ll") ?? url.searchParams.get("q")
      : url.searchParams.get("query") ?? url.searchParams.get("q");
    const pair = coordinates?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!pair) continue;
    const latitude = Number(pair[1]), longitude = Number(pair[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    return { latitude, longitude };
  }
  return null;
}

export class LocationTrial {
  private pins = new Map<string, Pin>();
  constructor(private now: () => number = Date.now) {}
  handle(conversation: string, text: string): string | null {
    const command = text.trim().toLowerCase();
    // Delete expired pins for every conversation rather than retaining old coordinates.
    for (const [key, value] of this.pins) if (value.expires <= this.now()) this.pins.delete(key);
    if (command === "forget location" || command === "reset") {
      this.pins.delete(conversation);
      return command === "reset" ? null : "Forgot your shared location.";
    }
    const pin = parseLocationLink(text);
    if (pin) {
      this.pins.set(conversation, { ...pin, expires: this.now() + 60 * 60_000 });
      return "Received your shared map pin. If this is where you're studying, reply location name library (or cafe, home, etc.). I'll keep it in memory for one hour. This doesn't enable live tracking.";
    }
    if (command.startsWith("location name ")) {
      const current = this.pins.get(conversation);
      if (!current) return "Send a map pin first. Text location for instructions.";
      const label = text.trim().slice("location name ".length).trim();
      if (!label || label.length > 60 || /[\r\n]/.test(label)) return "Use a short place name, for example: location name library";
      current.label = label;
      return `Labeled your shared pin: ${label}. This is a location test; it isn't linked to a study session yet.`;
    }
    if (command === "where am i" || command === "where am i?") {
      const current = this.pins.get(conversation);
      return current
        ? `Your last shared pin${current.label ? ` (${current.label})` : ""}: ${current.latitude.toFixed(5)}, ${current.longitude.toFixed(5)}. I can't tell whether you're still there.`
        : "I don't have a recent shared pin. Text location for instructions.";
    }
    if (command === "location") return "To try location sharing: in Apple Maps, share your current-location pin to this chat. Or paste a full Maps link containing coordinates. Short links aren't supported yet. I keep the pin only in memory for one hour; text forget location to remove it.";
    if (/https:\/\/(?:maps\.apple\.com|maps\.app\.goo\.gl|maps\.google\.com|(?:www\.)?google\.com\/maps)(?:[\/\s?]|$)/i.test(text))
      return "That Maps link doesn't include coordinates I can read. Try sharing your current-location pin from Apple Maps, or a full link like https://maps.apple.com/?ll=47.65,-122.30 . Example coordinates aren't your detected location.";
    return null;
  }
}
