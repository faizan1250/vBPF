import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, Loader2, Sparkles } from "lucide-react";

import {
  ApiError,
  MAX_DURATION_S,
  MAX_PROMPT_CHARS,
  MIN_DURATION_S,
  fetchRecipes,
  fixtureMode,
  generatePrompt,
  type GenerateResponse,
} from "../lib/api.js";
import { FIXTURE_RECIPES, fixtureScenarioForPrompt } from "../lib/fixtures.js";
import { useAppStore } from "../store/useAppStore.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardBody, CardHeader, CardTitle } from "./ui/card.js";
import { FieldLabel, Input, Select, Textarea } from "./ui/field.js";

const EXAMPLES = FIXTURE_RECIPES.map((r) => r.description);

export function PromptPanel() {
  const prompt = useAppStore((s) => s.prompt);
  const setPrompt = useAppStore((s) => s.setPrompt);
  const durationS = useAppStore((s) => s.durationS);
  const setDuration = useAppStore((s) => s.setDuration);
  const setGeneration = useAppStore((s) => s.setGeneration);
  const resetForGenerate = useAppStore((s) => s.resetForGenerate);
  const setRunError = useAppStore((s) => s.setRunError);
  const setRunPhase = useAppStore((s) => s.setRunPhase);
  const sessionId = useAppStore((s) => s.sessionId);
  const generation = useAppStore((s) => s.generation);
  const validationOk = useAppStore((s) => s.validationOk);
  const agentReady = useAppStore((s) => s.agentReady);
  const agentStatusHint = useAppStore((s) => s.agentStatusHint);
  const setAgentStatus = useAppStore((s) => s.setAgentStatus);

  const [recipeQuery, setRecipeQuery] = useState("");
  const isFixture = fixtureMode();
  const recipes = useQuery({
    queryKey: ["recipes", recipeQuery],
    queryFn: () => fetchRecipes(recipeQuery),
    staleTime: 60_000,
    // Fixture mode is fully static: the picker serves local entries so the
    // demo works with the network blocked.
    enabled: !isFixture,
  });
  const recipeOptions = isFixture
    ? FIXTURE_RECIPES.filter(
        (r) =>
          recipeQuery.trim() === "" ||
          `${r.title} ${r.description} ${r.tags.join(" ")}`
            .toLowerCase()
            .includes(recipeQuery.trim().toLowerCase()),
      )
    : (recipes.data?.recipes ?? []);

  const generate = useMutation({
    mutationFn: ({
      p,
      sid,
    }: {
      p: string;
      sid: string;
    }): Promise<GenerateResponse> => {
      if (fixtureMode()) {
        const scenario = fixtureScenarioForPrompt(p);
        return Promise.resolve({
          generation_id: `gen_fixture_${scenario.id}_${Date.now()}`,
          script: scenario.script,
          chart_type: scenario.chart,
          explanation: scenario.explanation,
          duration_s: durationS,
          warnings: ["Fixture mode: recorded data, nothing is executed."],
          validation: { status: "ok" as const, attempts: 1, errors: [] },
          based_on_recipe: null,
        });
      }
      return generatePrompt(p, sid === "" ? undefined : sid);
    },
    onMutate: () => {
      resetForGenerate();
    },
    onSuccess: (result) => {
      setGeneration(result);
      setRunPhase("awaiting-confirm");
      setRunError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "AGENT_NOT_READY") {
        setAgentStatus(false, "loading", err.fixHint ?? err.message);
      }
      const message =
        err instanceof ApiError
          ? `${err.code}: ${err.message}${err.fixHint ? ` — ${err.fixHint}` : ""}`
          : "generation failed";
      setRunError(message);
      setRunPhase("failed");
    },
  });

  const promptLen = prompt.length;
  const overCap = promptLen > MAX_PROMPT_CHARS;
  const agentNotReady = agentReady === false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div>
          <FieldLabel htmlFor="prompt">What do you want to observe?</FieldLabel>
          <Textarea
            id="prompt"
            value={prompt}
            maxLength={MAX_PROMPT_CHARS + 100}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Which processes are doing the most disk I/O?"
            aria-invalid={overCap}
            aria-describedby="prompt-count"
          />
          <p
            id="prompt-count"
            className="mt-1 text-right text-[11px] text-muted-foreground"
          >
            {promptLen}/{MAX_PROMPT_CHARS}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setPrompt(ex)}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="recipe">Recipe picker</FieldLabel>
          <div className="flex items-center gap-2">
            <BookOpen
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Input
              id="recipe"
              value={recipeQuery}
              onChange={(e) => setRecipeQuery(e.target.value)}
              placeholder="Search recipes…"
              aria-label="Search recipes"
            />
          </div>
          {recipeOptions.length > 0 && (
            <Select
              aria-label="Insert recipe prompt"
              className="mt-2"
              defaultValue=""
              disabled={agentNotReady}
              onChange={(e) => {
                if (e.target.value !== "") setPrompt(e.target.value);
              }}
            >
              <option value="">Insert a recipe prompt…</option>
              {recipeOptions.slice(0, 20).map((r) => (
                <option key={r.id} value={r.description}>
                  {r.title} ({r.view})
                </option>
              ))}
            </Select>
          )}
          {recipes.isError && !isFixture && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Recipe list unavailable.
            </p>
          )}
        </div>

        <div>
          <FieldLabel htmlFor="duration">Duration: {durationS}s</FieldLabel>
          <input
            id="duration"
            type="range"
            min={MIN_DURATION_S}
            max={MAX_DURATION_S}
            value={durationS}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full accent-sky-500"
            aria-valuetext={`${durationS} seconds`}
          />
        </div>

        {agentNotReady && (
          <p role="alert" className="text-xs text-amber-400">
            AGENT_NOT_READY:{" "}
            {agentStatusHint ??
              "Agent probe catalog is not ready; recipes and generation are disabled until ready."}
          </p>
        )}

        <Button
          intent="primary"
          disabled={
            generate.isPending ||
            prompt.trim() === "" ||
            overCap ||
            agentNotReady
          }
          onClick={() => generate.mutate({ p: prompt, sid: sessionId })}
        >
          {generate.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Sparkles aria-hidden />
          )}
          Generate probe
        </Button>

        {generation && (
          <div className="flex items-center gap-2 text-xs" aria-live="polite">
            <span className="text-muted-foreground">
              attempts {generation.validation.attempts}
              {generation.based_on_recipe
                ? ` · based on ${generation.based_on_recipe}`
                : ""}
            </span>
            {validationOk === true ? (
              <Badge tone="ok">valid</Badge>
            ) : validationOk === false ? (
              <Badge tone="bad">invalid</Badge>
            ) : (
              <Badge tone="neutral">checking…</Badge>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
