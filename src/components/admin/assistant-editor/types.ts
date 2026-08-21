import type { AssistantConfig } from "@/lib/assistants/schema";
import type { GuardrailKind, GuardrailSeverity } from "@/lib/guardrails/types";

/** Ce que la page serveur passe à l'éditeur. */
export type AssistantEditorData = {
  id: string;
  config: AssistantConfig;
  status: string;
  version: number;
  suitePassed: boolean;
  needsRecompile: boolean;
  compiledPrompt: string | null;
  compiledAt: string | null;
  users: { id: string; name: string; email: string; role: string }[];
  packs: { id: string; label: string; itemCount: number }[];
  coreRules: EditorRule[];
  ownRules: EditorRule[];
  lastRun: EditorRun | null;
};

export type EditorRule = {
  id: string;
  key: string;
  label: string;
  kind: GuardrailKind;
  severity: GuardrailSeverity;
  enabled: boolean;
};

export type EditorRun = {
  id: string;
  passed: boolean;
  total: number;
  passedCount: number;
  createdAt: string;
  results: {
    label: string;
    passed: boolean;
    severity: GuardrailSeverity;
    reason: string | null;
    output: string;
  }[];
};

export type TabProps = {
  config: AssistantConfig;
  update: (mutate: (draft: AssistantConfig) => void) => void;
  data: AssistantEditorData;
};
