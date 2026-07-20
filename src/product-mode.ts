export type OpenLeashProductModeId = "individual-open-source" | "private-cloud" | "openleash-cloud";

export type OpenLeashCapability =
  | "singleUserRuntime"
  | "clientRuntime"
  | "pluginRuntime"
  | "publicPluginCatalog"
  | "desktopUpdates"
  | "orgManagement"
  | "dashboard"
  | "identityProviders"
  | "deploymentTokens"
  | "fleetVisibility"
  | "cloudTenancy"
  | "billing";

export type OpenLeashProductMode = {
  id: OpenLeashProductModeId;
  label: string;
  accountScope: "single-user" | "organization" | "multi-tenant";
  capabilities: Record<OpenLeashCapability, boolean>;
};

const coreCapabilities = {
  clientRuntime: true,
  pluginRuntime: true,
  publicPluginCatalog: true,
  desktopUpdates: true
} satisfies Partial<Record<OpenLeashCapability, boolean>>;

const disabledOrgCapabilities = {
  orgManagement: false,
  dashboard: false,
  identityProviders: false,
  deploymentTokens: false,
  fleetVisibility: false,
  cloudTenancy: false,
  billing: false
} satisfies Partial<Record<OpenLeashCapability, boolean>>;

export function openLeashProductModeFromEnv(env: NodeJS.ProcessEnv = process.env): OpenLeashProductMode {
  const raw = String(env.OPENLEASH_PRODUCT_MODE ?? env.OPENLEASH_DEPLOYMENT_MODE ?? env.OPENLEASH_CLIENT_MODE ?? "openleash-cloud").toLowerCase();
  if (raw.includes("individual") || raw.includes("open-source") || raw.includes("opensource") || raw.includes("community") || raw.includes("personal")) {
    return {
      id: "individual-open-source",
      label: "Individual Open Source",
      accountScope: "single-user",
      capabilities: capabilities({
        ...coreCapabilities,
        ...disabledOrgCapabilities,
        singleUserRuntime: true
      })
    };
  }
  if (raw.includes("private") || raw.includes("self-host") || raw.includes("selfhost") || raw.includes("enterprise") || raw.includes("onprem") || raw.includes("on-prem")) {
    return {
      id: "private-cloud",
      label: "Private Cloud",
      accountScope: "organization",
      capabilities: capabilities({
        ...coreCapabilities,
        singleUserRuntime: false,
        orgManagement: true,
        dashboard: true,
        identityProviders: true,
        deploymentTokens: true,
        fleetVisibility: true,
        cloudTenancy: false,
        billing: false
      })
    };
  }
  return {
    id: "openleash-cloud",
    label: "OpenLeash Cloud",
    accountScope: "multi-tenant",
    capabilities: capabilities({
      ...coreCapabilities,
      singleUserRuntime: false,
      orgManagement: true,
      dashboard: true,
      identityProviders: true,
      deploymentTokens: true,
      fleetVisibility: true,
      cloudTenancy: true,
      billing: true
    })
  };
}

export function hasCapability(mode: OpenLeashProductMode, capability: OpenLeashCapability) {
  return mode.capabilities[capability] === true;
}

export function publicProductMode(mode: OpenLeashProductMode) {
  return {
    id: mode.id,
    label: mode.label,
    accountScope: mode.accountScope,
    capabilities: mode.capabilities
  };
}

export function isOrganizationManagedAccount(
  mode: OpenLeashProductMode,
  audience: string | undefined,
) {
  return mode.id === "private-cloud" || audience === "organization";
}

export function pluginExecutionAvailable(
  mode: OpenLeashProductMode,
  executionEnvironment: "any" | "cloud-only" | undefined,
) {
  return executionEnvironment !== "cloud-only" || mode.id === "openleash-cloud";
}

function capabilities(partial: Partial<Record<OpenLeashCapability, boolean>>): Record<OpenLeashCapability, boolean> {
  return {
    singleUserRuntime: false,
    clientRuntime: false,
    pluginRuntime: false,
    publicPluginCatalog: false,
    desktopUpdates: false,
    orgManagement: false,
    dashboard: false,
    identityProviders: false,
    deploymentTokens: false,
    fleetVisibility: false,
    cloudTenancy: false,
    billing: false,
    ...partial
  };
}
