import type { PluginCapabilities } from "@openleash/shared";
import { evaluatePolicies } from "../evaluator.js";
import type { TenantModelKey } from "../model-keys.js";
import { compressPromptCapability, inspectDlpCapability } from "../prompt-transforms.js";

export function createPluginCapabilities({
  apiKey,
  tenantModelKey
}: {
  apiKey?: string;
  tenantModelKey?: TenantModelKey;
}): PluginCapabilities {
  return {
    prompt: {
      compress(request) {
        return compressPromptCapability({ ...request, apiKey });
      }
    },
    dlp: {
      inspect(request) {
        return inspectDlpCapability({ ...request, apiKey });
      }
    },
    security: {
      evaluatePolicies({ request, policies }) {
        return evaluatePolicies(request, policies, tenantModelKey);
      }
    }
  };
}
