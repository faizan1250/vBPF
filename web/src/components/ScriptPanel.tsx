import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type * as Monaco from "monaco-editor";

import { configureMonaco } from "../lib/monaco.js";
import { errorToMarker } from "../lib/markers.js";
import { useAppStore } from "../store/useAppStore.js";
import { ExplainSection } from "./ExplainSection.js";
import { Badge } from "./ui/badge.js";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card.js";

const MONACO_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  scrollBeyondLastLine: false,
  automaticLayout: true,
  wordWrap: "on",
  padding: { top: 8 },
};

const LazyEditor = lazy(async () => {
  await configureMonaco();
  return { default: Editor };
});

function PlainFallback() {
  const script = useAppStore((s) => s.script);
  const setScript = useAppStore((s) => s.setScript);
  return (
    <textarea
      value={script}
      onChange={(e) => setScript(e.target.value)}
      spellCheck={false}
      aria-label="Generated bpftrace script"
      className="h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-[13px]"
    />
  );
}

function ScriptEditor() {
  const script = useAppStore((s) => s.script);
  const setScript = useAppStore((s) => s.setScript);
  const validationErrors = useAppStore((s) => s.validationErrors);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const [failed, setFailed] = useState(false);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const markers = validationErrors.map((message) => {
      const { line, text } = errorToMarker(script, message);
      return {
        severity: monaco.MarkerSeverity.Error,
        message: text,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      };
    });
    monaco.editor.setModelMarkers(model, "vbpf-validate", markers);
  }, [validationErrors, script]);

  if (failed) return <PlainFallback />;
  return (
    <Suspense fallback={<PlainFallback />}>
      <EditorErrorBoundary onError={() => setFailed(true)}>
        <LazyEditor
          height="16rem"
          language="bpftrace"
          value={script}
          options={MONACO_OPTIONS}
          onChange={(value) => setScript(value ?? "")}
          onMount={handleMount}
        />
      </EditorErrorBoundary>
    </Suspense>
  );
}

class EditorErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render(): ReactNode {
    if (this.state.failed) return <PlainFallback />;
    return this.props.children;
  }
}

export function ScriptPanel({ validating }: { validating: boolean }) {
  const generation = useAppStore((s) => s.generation);
  const script = useAppStore((s) => s.script);
  const validationOk = useAppStore((s) => s.validationOk);
  const validationErrors = useAppStore((s) => s.validationErrors);
  const validationProbes = useAppStore((s) => s.validationProbes);

  if (!generation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Script</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-muted-foreground">
            Generate a probe to review and edit the script here.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Script</CardTitle>
        {validating ? (
          <Badge tone="neutral">validating…</Badge>
        ) : validationOk === true ? (
          <Badge tone="ok">valid</Badge>
        ) : validationOk === false ? (
          <Badge tone="bad" role="alert">
            invalid
          </Badge>
        ) : null}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-md border border-border">
          <ScriptEditor />
        </div>

        {validationErrors.length > 0 && (
          <ul className="flex flex-col gap-1" aria-live="polite">
            {validationErrors.map((e) => (
              <li key={e} className="text-xs text-red-400">
                {e}
              </li>
            ))}
          </ul>
        )}
        {validationProbes.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            probes: {validationProbes.join(", ")}
          </p>
        )}

        <div>
          <h3 className="mb-1 text-xs font-semibold">Generation summary</h3>
          <p className="text-sm text-muted-foreground">
            {generation.explanation}
          </p>
        </div>
        <ExplainSection script={script} />

        {generation.warnings.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold">Warnings</h3>
            <ul className="flex flex-col gap-1">
              {generation.warnings.map((w) => (
                <li key={w} className="text-xs text-amber-400">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
