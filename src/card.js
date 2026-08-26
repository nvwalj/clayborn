// Agent Card construction + conformance validation.
//
// Field names here follow the AUTHORITATIVE source: specification/a2a.proto in
// a2aproject/A2A (v1.0.1, 2026-05-26), ProtoJSON-mapped to lowerCamelCase.
// They are NOT copied from blog posts — several widely-cited "common mistakes"
// lists describe the pre-1.0 shape and are wrong for v1.0. Notably:
//
//   * The interface list is `supportedInterfaces` (proto: supported_interfaces).
//     Pre-1.0 guidance calling for `additionalInterfaces` is obsolete.
//   * There is NO top-level `protocolVersion` or `url` on AgentCard in v1.0.
//     Both live inside each `supportedInterfaces[]` entry.
//   * `capabilities` is an OBJECT (AgentCapabilities message), never an array.
//
// AgentCard REQUIRED fields per proto field_behavior:
//   name, description, supportedInterfaces, version, capabilities,
//   defaultInputModes, defaultOutputModes, skills

export const PROTOCOL_VERSION = "1.0";

/** Build a spec-shaped AgentCard from user config + the resolved public URL. */
export function buildCard(config, publicUrl) {
  const base = publicUrl.replace(/\/+$/, "");

  const card = {
    name: config.name,
    description: config.description,
    // REQUIRED. Each entry carries its own url + binding + protocol version.
    supportedInterfaces: [
      {
        url: `${base}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: PROTOCOL_VERSION,
      },
      {
        url: base,
        protocolBinding: "HTTP+JSON",
        protocolVersion: PROTOCOL_VERSION,
      },
    ],
    version: config.version || "0.1.0",
    // REQUIRED, and an object — not an array.
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: config.defaultInputModes || ["text/plain"],
    defaultOutputModes: config.defaultOutputModes || ["text/plain"],
    skills: (config.skills || []).map(toSkill),
  };

  if (config.provider?.organization && config.provider?.url) {
    // AgentProvider requires BOTH fields; emit it only when both are present.
    card.provider = {
      organization: config.provider.organization,
      url: config.provider.url,
    };
  }
  if (config.documentationUrl) card.documentationUrl = config.documentationUrl;
  if (config.iconUrl) card.iconUrl = config.iconUrl;

  const peersOn = config.peers?.mode && config.peers.mode !== "off";
  if (config.auth?.mode === "bearer" || peersOn) {
    // securitySchemes is a map<string, SecurityScheme>, not a list. With peer
    // auth on, the bearer is a JWT (EdDSA, iss = the caller's own card base) —
    // declare the format so a stranger knows what to mint.
    card.securitySchemes = {
      bearer: {
        httpAuthSecurityScheme: peersOn
          ? { scheme: "bearer", bearerFormat: "JWT (EdDSA; iss = caller base URL, keys at iss/.well-known/jwks.json)" }
          : { scheme: "bearer" },
      },
    };
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
  }

  return card;
}

function toSkill(s) {
  const skill = {
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags || [],
  };
  if (s.examples?.length) skill.examples = s.examples;
  if (s.inputModes?.length) skill.inputModes = s.inputModes;
  if (s.outputModes?.length) skill.outputModes = s.outputModes;
  return skill;
}

const REQUIRED = [
  "name",
  "description",
  "supportedInterfaces",
  "version",
  "capabilities",
  "defaultInputModes",
  "defaultOutputModes",
  "skills",
];

/**
 * Validate a card against the v1.0 shape.
 * Returns { ok, errors[], warnings[] }. Used by `npm run check` and at boot,
 * so a malformed card fails here rather than silently on someone else's client.
 */
export function validateCard(card) {
  const errors = [];
  const warnings = [];

  if (!card || typeof card !== "object") {
    return { ok: false, errors: ["card is not an object"], warnings };
  }

  for (const f of REQUIRED) {
    if (card[f] === undefined || card[f] === null) errors.push(`missing required field: ${f}`);
  }

  // The three failure modes that account for most non-conformant cards in the wild.
  if (Array.isArray(card.capabilities)) {
    errors.push("capabilities must be an object (AgentCapabilities), not an array");
  } else if (card.capabilities && typeof card.capabilities !== "object") {
    errors.push("capabilities must be an object");
  }
  if (card.additionalInterfaces) {
    errors.push("`additionalInterfaces` is pre-1.0; v1.0 uses `supportedInterfaces`");
  }
  if (card.protocolVersion) {
    warnings.push(
      "top-level `protocolVersion` is not a v1.0 AgentCard field — it belongs on each supportedInterfaces[] entry"
    );
  }
  if (card.url) {
    warnings.push(
      "top-level `url` is not a v1.0 AgentCard field — it belongs on each supportedInterfaces[] entry"
    );
  }

  if (card.supportedInterfaces !== undefined) {
    if (!Array.isArray(card.supportedInterfaces)) {
      errors.push("supportedInterfaces must be an array");
    } else if (card.supportedInterfaces.length === 0) {
      errors.push("supportedInterfaces must declare at least one interface");
    } else {
      card.supportedInterfaces.forEach((i, n) => {
        for (const f of ["url", "protocolBinding", "protocolVersion"]) {
          if (!i?.[f]) errors.push(`supportedInterfaces[${n}] missing required field: ${f}`);
        }
        if (i?.url && !/^https?:\/\//.test(i.url)) {
          errors.push(`supportedInterfaces[${n}].url must be an absolute http(s) URL`);
        }
      });
    }
  }

  if (card.skills !== undefined) {
    if (!Array.isArray(card.skills)) {
      errors.push("skills must be an array");
    } else {
      if (card.skills.length === 0) {
        warnings.push("skills is empty — nothing is discoverable about this agent");
      }
      const seen = new Set();
      card.skills.forEach((s, n) => {
        for (const f of ["id", "name", "description", "tags"]) {
          if (s?.[f] === undefined) errors.push(`skills[${n}] missing required field: ${f}`);
        }
        if (s?.tags !== undefined && !Array.isArray(s.tags)) {
          errors.push(`skills[${n}].tags must be an array`);
        }
        if (s?.id) {
          if (seen.has(s.id)) errors.push(`duplicate skill id: ${s.id}`);
          seen.add(s.id);
        }
      });
    }
  }

  for (const f of ["defaultInputModes", "defaultOutputModes"]) {
    if (card[f] !== undefined && !Array.isArray(card[f])) errors.push(`${f} must be an array`);
  }

  if (card.provider && !(card.provider.organization && card.provider.url)) {
    errors.push("provider requires BOTH organization and url");
  }
  if (Array.isArray(card.securitySchemes)) {
    errors.push("securitySchemes must be a map (object keyed by scheme name), not an array");
  }

  return { ok: errors.length === 0, errors, warnings };
}
