import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { miniWobTask } from "./miniwob.ts";

export type MiniWobCampaignFamily =
  | "multi-target-selection"
  | "disclosure-navigation"
  | "multi-step-form"
  | "popup-date-workflow"
  | "stateful-mail-app"
  | "stateful-social-app"
  | "table-reading-reasoning"
  | "command-interface"
  | "drag-and-drop"
  | "dynamic-hover"
  | "visual-coordinate-input";

export type MiniWobCampaignCase = {
  taskId: string;
  family: MiniWobCampaignFamily;
  pressure: string;
  expectedSurfaces: readonly string[];
  relevantSkillTopics: readonly string[];
};

export type MiniWobCampaignEvaluation = {
  taskId: string;
  status: "passed" | "failed" | "not-run" | "invalid";
  evaluationPath: string;
  result: {
    done: boolean;
    reward: number;
    rawReward: number;
    reason: string | null;
    episodeId: number;
    passed: boolean;
  } | null;
  error: string | null;
};

/**
 * Forward Agent acceptance cases selected from official MiniWoB++ pages.
 *
 * These are deliberately not solution scripts. Each episode is operated by an
 * unfamiliar Agent through the installed Skill and scored by the official page.
 */
export const MINIWOB_AGENT_CAMPAIGN: readonly MiniWobCampaignCase[] = [
  {
    taskId: "click-checkboxes-large",
    family: "multi-target-selection",
    pressure: "Resolve and commit at least five generated targets without confusing labels or stale refs.",
    expectedSurfaces: ["full AX observation", "semantic/ref actions", "post-action diff"],
    relevantSkillTopics: ["observation", "actions", "forms"],
  },
  {
    taskId: "click-tab-2-hard",
    family: "disclosure-navigation",
    pressure: "Search across two to six changing tabs, including a possible no-match outcome.",
    expectedSurfaces: ["full AX observation", "fresh refs after disclosure", "semantic Locator"],
    relevantSkillTopics: ["observation", "actions", "navigation-waits"],
  },
  {
    taskId: "form-sequence-3",
    family: "multi-step-form",
    pressure: "Execute a generated sequence across heterogeneous controls while preserving order and committed values.",
    expectedSurfaces: ["semantic Locator", "typed inspect", "form actions", "state verification"],
    relevantSkillTopics: ["forms", "actions", "task-recipes"],
  },
  {
    taskId: "book-flight-nodelay",
    family: "popup-date-workflow",
    pressure: "Commit two runtime autocomplete widgets, a readonly datepicker, result ordering, and final selection under a page countdown.",
    expectedSurfaces: ["runtime field outcome", "AX revision", "popup refs", "date widget", "stable Locator"],
    relevantSkillTopics: ["forms", "observation", "task-recipes", "recovery"],
  },
  {
    taskId: "email-inbox-star-reply",
    family: "stateful-mail-app",
    pressure: "Find the correct generated message and complete two dependent mutations in a stateful inbox UI.",
    expectedSurfaces: ["full AX observation", "semantic Locator", "changing application state", "form input"],
    relevantSkillTopics: ["observation", "actions", "forms", "task-recipes"],
  },
  {
    taskId: "social-media-all",
    family: "stateful-social-app",
    pressure: "Apply a generated action to every matching post while distinguishing repeated cards and state changes.",
    expectedSurfaces: ["repeated semantic regions", "Locator composition", "multi-action state verification"],
    relevantSkillTopics: ["observation", "actions", "task-recipes"],
  },
  {
    taskId: "read-table-2",
    family: "table-reading-reasoning",
    pressure: "Read a generated table, resolve a relational query, and enter the derived answer rather than copying a nearby value.",
    expectedSurfaces: ["bounded full AX", "text reasoning", "semantic form action"],
    relevantSkillTopics: ["observation", "forms", "task-recipes"],
  },
  {
    taskId: "terminal",
    family: "command-interface",
    pressure: "Interpret generated shell-like goals and operate a terminal widget with keyboard semantics and visible output feedback.",
    expectedSurfaces: ["full AX observation", "keyboard input", "application readiness wait"],
    relevantSkillTopics: ["actions", "navigation-waits", "recovery"],
  },
  {
    taskId: "drag-shapes-2",
    family: "drag-and-drop",
    pressure: "Match multiple generated shapes to typed destinations and perform distinct drag transactions.",
    expectedSurfaces: ["atomic AX plus screenshot", "dragTo", "fresh viewport identity"],
    relevantSkillTopics: ["observation", "actions", "screenshot-cua", "forms"],
  },
  {
    taskId: "click-menu",
    family: "dynamic-hover",
    pressure: "Traverse a generated nested hover menu and select the requested leaf whose visibility depends on pointer state.",
    expectedSurfaces: ["full AX observation", "hover", "post-hover observation", "semantic click"],
    relevantSkillTopics: ["observation", "actions", "screenshot-cua"],
  },
  {
    taskId: "use-colorwheel-2",
    family: "visual-coordinate-input",
    pressure: "Use screenshot-grounded coordinate input on a control that is not fully represented by semantic accessibility state.",
    expectedSurfaces: ["atomic AX plus screenshot", "viewport-bound CUA", "visual result verification"],
    relevantSkillTopics: ["screenshot-cua", "observation", "recovery"],
  },
];

export async function miniWobCampaignDefinition(): Promise<{
  suite: "miniwob++";
  evaluator: "official-page";
  count: number;
  families: number;
  cases: readonly MiniWobCampaignCase[];
}> {
  await Promise.all(MINIWOB_AGENT_CAMPAIGN.map(({ taskId }) => miniWobTask(taskId)));
  return {
    suite: "miniwob++",
    evaluator: "official-page",
    count: MINIWOB_AGENT_CAMPAIGN.length,
    families: new Set(MINIWOB_AGENT_CAMPAIGN.map(({ family }) => family)).size,
    cases: MINIWOB_AGENT_CAMPAIGN,
  };
}

export async function readMiniWobCampaignReport(outputRoot: string): Promise<{
  suite: "miniwob++";
  evaluator: "official-page";
  passed: number;
  failed: number;
  notRun: number;
  invalid: number;
  complete: boolean;
  evaluations: readonly MiniWobCampaignEvaluation[];
}> {
  const evaluations = await Promise.all(MINIWOB_AGENT_CAMPAIGN.map(async ({ taskId }) => {
    const evaluationPath = join(outputRoot, taskId, "evaluation.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(evaluationPath, "utf8"));
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === "ENOENT") {
        return { taskId, status: "not-run", evaluationPath, result: null, error: null } satisfies MiniWobCampaignEvaluation;
      }
      return {
        taskId,
        status: "invalid",
        evaluationPath,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      } satisfies MiniWobCampaignEvaluation;
    }
    const result = officialResult(parsed);
    if (!result) {
      return {
        taskId,
        status: "invalid",
        evaluationPath,
        result: null,
        error: "evaluation.json does not contain a valid official MiniWoB++ result",
      } satisfies MiniWobCampaignEvaluation;
    }
    return {
      taskId,
      status: result.passed ? "passed" : "failed",
      evaluationPath,
      result,
      error: null,
    } satisfies MiniWobCampaignEvaluation;
  }));
  const count = (status: MiniWobCampaignEvaluation["status"]) => evaluations.filter(
    (evaluation) => evaluation.status === status,
  ).length;
  const passed = count("passed");
  const failed = count("failed");
  const notRun = count("not-run");
  const invalid = count("invalid");
  return {
    suite: "miniwob++",
    evaluator: "official-page",
    passed,
    failed,
    notRun,
    invalid,
    complete: passed === evaluations.length,
    evaluations,
  };
}

function officialResult(value: unknown): MiniWobCampaignEvaluation["result"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const candidate = result as Record<string, unknown>;
  if (
    typeof candidate.done !== "boolean"
    || typeof candidate.reward !== "number"
    || typeof candidate.rawReward !== "number"
    || !(candidate.reason === null || typeof candidate.reason === "string")
    || typeof candidate.episodeId !== "number"
    || typeof candidate.passed !== "boolean"
  ) return null;
  return {
    done: candidate.done,
    reward: candidate.reward,
    rawReward: candidate.rawReward,
    reason: candidate.reason,
    episodeId: candidate.episodeId,
    passed: candidate.passed,
  };
}
