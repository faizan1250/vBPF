import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { ApiError, fixtureMode, validateScript } from "../lib/api.js";
import { useAppStore } from "../store/useAppStore.js";

const DEBOUNCE_MS = 600;

// Debounced live validation for the edited script. Surface errors go to the
// store (editor markers + panel); the confirm gate reads validationOk.
export function useDebouncedValidate(): { validating: boolean } {
  const script = useAppStore((s) => s.script);
  const [validating, setValidating] = useState(false);
  const timer = useRef<number | null>(null);
  const validate = useMutation({
    mutationFn: validateScript,
  });

  useEffect(() => {
    if (fixtureMode()) {
      useAppStore
        .getState()
        .setValidation(true, [], ["tracepoint:raw_syscalls:sys_enter"]);
      return;
    }
    if (script.trim() === "") {
      useAppStore.getState().setValidation(null, [], []);
      return;
    }
    setValidating(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      validate.mutate(script, {
        onSuccess: (result) => {
          useAppStore
            .getState()
            .setValidation(result.ok, result.errors, result.probes);
          setValidating(false);
        },
        onError: (err) => {
          const message =
            err instanceof ApiError
              ? `${err.code}: ${err.message}`
              : "validation request failed";
          useAppStore.getState().setValidation(false, [message], []);
          setValidating(false);
        },
      });
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [script]);

  return { validating };
}
