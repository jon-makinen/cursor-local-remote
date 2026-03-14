import { randomUUID } from "node:crypto";
import { spawnAgent } from "@/lib/cursor-cli";
import { getWorkspace } from "@/lib/workspace";
import { upsertSession } from "@/lib/session-store";
import { registerProcess, promoteToSessionId, pushLiveEvent } from "@/lib/process-registry";
import { chatRequestSchema, parseBody } from "@/lib/validation";
import { badRequest, serverError, safeErrorMessage, parseJsonBody } from "@/lib/errors";
import { AGENT_INIT_TIMEOUT_MS } from "@/lib/constants";
import type { ChatRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

function waitForSessionId(
  child: Awaited<ReturnType<typeof spawnAgent>>,
  workspace: string,
  prompt: string,
  requestId: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let found = false;
    let buffer = "";
    let resolvedSessionId: string | null = null;

    const timer = setTimeout(() => {
      if (!found) resolve(null);
    }, AGENT_INIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (!found && event.type === "system" && event.subtype === "init" && event.session_id) {
            found = true;
            resolvedSessionId = event.session_id;
            clearTimeout(timer);
            void upsertSession(event.session_id, workspace, prompt);
            promoteToSessionId(requestId, event.session_id);
            resolve(event.session_id);
          }

          if (resolvedSessionId && (event.type === "user" || event.type === "assistant")) {
            pushLiveEvent(resolvedSessionId, event);
          }
        } catch {
          // non-json line
        }
      }
    });

    child.on("close", () => {
      if (!found) {
        clearTimeout(timer);
        resolve(null);
      }
    });

    child.on("error", () => {
      if (!found) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

export async function POST(req: Request) {
  const raw = await parseJsonBody<ChatRequest>(req);
  if (raw instanceof Response) return raw;

  const parsed = parseBody(chatRequestSchema, raw);
  if ("error" in parsed) return badRequest(parsed.error);
  const body = parsed.data;

  const workspace = body.workspace || getWorkspace();

  try {
    const requestId = randomUUID();

    const child = await spawnAgent({
      prompt: body.prompt,
      sessionId: body.sessionId,
      workspace,
      model: body.model,
      mode: body.mode,
    });

    registerProcess(requestId, child, workspace);

    if (body.sessionId) {
      promoteToSessionId(requestId, body.sessionId);
    }

    const verbose = process.env.CLR_VERBOSE === "1";

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[agent stderr]", text);
    });

    if (verbose) {
      console.warn(`[chat] spawning agent in ${workspace} (model=${body.model ?? "default"}, mode=${body.mode ?? "agent"})`);
    }

    const sessionId = await waitForSessionId(child, workspace, body.prompt, requestId);

    if (!sessionId) {
      child.kill("SIGTERM");
      console.error("[chat] agent did not emit init event within timeout");
      return serverError("Agent failed to start");
    }

    if (verbose) {
      console.warn(`[chat] agent started session ${sessionId}`);
    }

    return Response.json({ sessionId });
  } catch (err) {
    safeErrorMessage(err, "Failed to start agent");
    return serverError("Failed to start agent");
  }
}
