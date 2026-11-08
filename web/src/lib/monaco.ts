import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

let configured = false;

// Bundle monaco locally (no CDN) and register a minimal bpftrace language.
// Plain-text features only, so the single editor worker suffices.
export function configureMonaco(): void {
  if (configured) return;
  configured = true;
  self.MonacoEnvironment = {
    getWorker() {
      return new Worker(
        new URL("monaco-editor/esm/vs/editor/editor.worker?worker", import.meta.url),
        { type: "module" },
      );
    },
  };
  loader.config({ monaco });
  monaco.languages.register({ id: "bpftrace" });
  monaco.languages.setMonarchTokensProvider("bpftrace", {
    keywords: [
      "if",
      "else",
      "for",
      "while",
      "return",
      "continue",
      "break",
      "sizeof",
      "typeof",
    ],
    builtins: [
      "printf",
      "print",
      "count",
      "sum",
      "avg",
      "min",
      "max",
      "hist",
      "lhist",
      "clear",
      "delete",
      "exit",
      "str",
      "comm",
      "pid",
      "tid",
      "nsecs",
      "elapsed",
    ],
    tokenizer: {
      root: [
        [/\/\//, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string"],
        [/\b(BEGIN|END)\b/, "keyword"],
        [/\b(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software)(?=:)/, "type"],
        [/[a-zA-Z_]\w*(?=\s*\()/, "predefined"],
        [/@[a-zA-Z_]\w*/, "variable"],
        [/\b\d[\dxXoObB]*/, "number"],
        [/[{}()[\];,]/, "delimiter"],
        [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@builtins": "predefined", "@default": "identifier" } }],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
    },
  } as never);
}

// Best-effort mapping of a validation error string to an editor line.
// Falls back to line 1 so the marker is always visible.
export function errorToMarker(
  script: string,
  message: string,
): { line: number; text: string } {
  const lineMatch = /line\s+(\d+)/i.exec(message);
  if (lineMatch) {
    return { line: Math.max(1, Number(lineMatch[1])), text: message };
  }
  const probeMatch = /(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software):[^\s,;]*/.exec(
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
