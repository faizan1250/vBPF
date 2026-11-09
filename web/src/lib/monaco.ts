import { loader } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

let configured = false;

// Bundle monaco locally (no CDN) and register a minimal bpftrace language.
// The editor module loads lazily so unit tests and SSR never pay for it.
// Plain-text features only, so the single editor worker suffices.
export async function configureMonaco(): Promise<void> {
  if (configured) return;
  configured = true;
  const monaco: typeof import("monaco-editor") = await import("monaco-editor");
  self.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker() as Worker;
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
        [
          /\b(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software)(?=:)/,
          "type",
        ],
        [/[a-zA-Z_]\w*(?=\s*\()/, "predefined"],
        [/@[a-zA-Z_]\w*/, "variable"],
        [/\b\d[\dxXoObB]*/, "number"],
        [/[{}()[\];,]/, "delimiter"],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@builtins": "predefined",
              "@default": "identifier",
            },
          },
        ],
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

export type MonacoModule = typeof Monaco;
