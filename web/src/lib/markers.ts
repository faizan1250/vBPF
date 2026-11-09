// Best-effort mapping of a validation error string to an editor line.
// Falls back to line 1 so the marker is always visible. Pure: no editor
// dependency, safe to unit test in node.
export function errorToMarker(
  script: string,
  message: string,
): { line: number; text: string } {
  const lineMatch = /line\s+(\d+)/i.exec(message);
  if (lineMatch) {
    return { line: Math.max(1, Number(lineMatch[1])), text: message };
  }
  const probeMatch =
    /(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software):[^\s,;]*/.exec(
      message,
    );
  if (probeMatch) {
    const idx = script.indexOf(probeMatch[0]);
    if (idx >= 0) {
      return { line: script.slice(0, idx).split("\n").length, text: message };
    }
  }
  return { line: 1, text: message };
}
