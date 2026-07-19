export type HandledIntentCandidate = {
  eventName: string;
  decision: "allow" | "ask" | "deny";
  intentKey?: string | null;
};

export function canonicalIntentKey(intentKey?: string | null) {
  if (!intentKey) return undefined;
  const parts = intentKey.split("|");
  if (parts.length === 4 && parts[2]?.startsWith("credential-")) {
    return [parts[0], parts[1], "credential", parts[3]].join("|");
  }
  if (parts.length === 5 && parts[3]?.startsWith("credential-")) {
    return [parts[0], parts[2], "credential", parts[4]].join("|");
  }
  return intentKey;
}

export function handledIntentKeysMatch(
  candidateKey?: string | null,
  currentKey?: string | null,
) {
  const candidate = intentIdentity(candidateKey);
  const current = intentIdentity(currentKey);
  if (!candidate || !current) return false;
  if (candidate.canonical === current.canonical) return true;
  if (!candidate.credential || !current.credential) return false;
  return candidate.agent === current.agent &&
    candidate.resource === current.resource &&
    (!candidate.project || !current.project || candidate.project === current.project);
}

export function isReusableHandledIntent(candidate: HandledIntentCandidate) {
  return candidate.eventName !== "UserPromptSubmit" || candidate.decision === "ask";
}

function intentIdentity(intentKey?: string | null) {
  if (!intentKey) return undefined;
  const parts = intentKey.split("|");
  const credentialIndex = parts.findIndex((part) => part.startsWith("credential-"));
  return {
    canonical: canonicalIntentKey(intentKey),
    credential: credentialIndex >= 0,
    agent: parts[0] ?? "",
    project: credentialIndex >= 0 ? (parts[credentialIndex - 1] ?? "") : "",
    resource: credentialIndex >= 0 ? (parts[credentialIndex + 1] ?? "") : "",
  };
}
