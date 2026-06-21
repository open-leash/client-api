import { mcpToolCallFromEvent } from "@openleash/shared";
import { mcpScannerManifest as manifest } from "./manifest.js";
import { pluginRun, type EvaluationPipelineInput } from "../types.js";

export { manifest };

export function runMcpScanner(input: EvaluationPipelineInput) {
  const startedAt = Date.now();
  const call = mcpToolCallFromEvent(input.request.event);
  return {
    call,
    run: pluginRun({
      pluginId: manifest.id,
      event: input.request.event.eventName === "PostToolUse" ? "tool.afterUse" : "tool.beforeUse",
      status: call ? "passed" : "skipped",
      summary: call
        ? `Observed MCP tool ${call.fullToolName}.`
        : "No MCP tool call was found in this event.",
      startedAt,
      findings: call ? [{
        title: "MCP tool call observed",
        severity: "info",
        summary: call.argumentSummary || call.fullToolName,
        evidence: [call.fullToolName]
      }] : undefined,
      metadata: call ? {
        serverName: call.serverName,
        toolName: call.toolName
      } : undefined
    })
  };
}
