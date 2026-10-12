// Compose releases emit either one JSON array or one JSON object per line.
export function parseComposeContainers(output) {
  const text = output.trim();
  if (!text) return [];
  return text.startsWith('[') ? JSON.parse(text) : text.split('\n').map(line => JSON.parse(line));
}
