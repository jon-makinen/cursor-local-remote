import { execFile } from "child_process";
import { promisify } from "util";
import type { ModelInfo } from "@/lib/types";
import { serverError, safeErrorMessage } from "@/lib/errors";
import { MODELS_CACHE_TTL_MS, MODELS_FETCH_TIMEOUT_MS } from "@/lib/constants";
import { getConfig } from "@/lib/session-store";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

function parseModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("Tip:")) continue;

    const match = trimmed.match(
      /^(\S+)\s+-\s+(.+?)(?:\s+\((default|current)(?:,\s*(default|current))?\))?$/,
    );
    if (!match) continue;

    const [, id, label, tag1, tag2] = match;
    const tags = [tag1, tag2].filter(Boolean);

    models.push({
      id,
      label: label.trim(),
      isDefault: tags.includes("default"),
      isCurrent: tags.includes("current"),
    });
  }

  return models;
}

let cachedModels: { models: ModelInfo[]; fetchedAt: number } | null = null;

export async function GET() {
  if (cachedModels && Date.now() - cachedModels.fetchedAt < MODELS_CACHE_TTL_MS) {
    return Response.json({ models: cachedModels.models });
  }

  try {
    if (process.env.CLR_VERBOSE === "1") {
      console.warn(`[models] fetching (timeout=${MODELS_FETCH_TIMEOUT_MS}ms)`);
    }

    const agentArgs = ["models"];
    const trustEnv = process.env.CURSOR_TRUST;
    const trustConfig = trustEnv === "0" ? false : trustEnv === "1" ? true : (await getConfig("trust")) !== "0";
    if (trustConfig) agentArgs.push("--trust");

    const { stdout } = await execFileAsync("agent", agentArgs, {
      encoding: "utf-8",
      timeout: MODELS_FETCH_TIMEOUT_MS,
    });

    const models = parseModels(stdout);

    if (models.length > 0) {
      cachedModels = { models, fetchedAt: Date.now() };
    }

    return Response.json({ models });
  } catch (err) {
    safeErrorMessage(err, "Failed to fetch models");
    return serverError("Failed to fetch models");
  }
}
