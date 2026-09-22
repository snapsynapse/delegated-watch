const SIGNAL_LABELS = {
  commit_metadata: "commit metadata",
  conversation_title_metadata: "conversation title metadata",
  prompt_classification: "prompt classification",
  source_composition: "source composition",
  workspace_activity: "workspace activity"
};

const FAMILY_DESCRIPTIONS = {
  "building:content": "content building",
  "building:feature": "feature building",
  "building:infra": "infrastructure building",
  "building:spec": "specification building",
  building: "building",
  career: "career work",
  "fixing:bug": "bug fixing",
  "fixing:data": "data fixing",
  "fixing:pipeline": "pipeline fixing",
  "fixing:security": "security fixing",
  fixing: "fixing",
  "maintenance:deps": "dependency maintenance",
  "maintenance:docs": "documentation maintenance",
  "maintenance:hygiene": "repository hygiene",
  "maintenance:sync": "synchronization maintenance",
  maintenance: "maintenance",
  research: "research",
  shipping: "shipping",
  strategy: "strategy work",
  writing: "writing"
};

const METHODS = new Set([
  "automated_classification",
  "human_override",
  "human_review",
  "source_derived",
  "unresolved"
]);
const CONFIDENCES = new Set(["clear", "leaning", "contested", "recalled", "derived", "none", "reviewed"]);
const FAMILIES = new Set([...Object.keys(FAMILY_DESCRIPTIONS), "mixed", "unknown", "unreviewed"]);

export const scrubbedLabelProvenance = ({
  driver,
  method,
  signalTypes = [],
  confidence
}) => {
  if (!METHODS.has(method)) throw new Error("Unsupported driver evidence method");
  if (!FAMILIES.has(driver)) throw new Error("Unsupported driver evidence family");
  if (!CONFIDENCES.has(confidence)) throw new Error("Unsupported driver evidence confidence");
  const signals = [...new Set(signalTypes)].sort();
  for (const signal of signals) {
    if (!Object.hasOwn(SIGNAL_LABELS, signal)) {
      throw new Error("Unsupported driver evidence signal");
    }
  }
  return {
    schema_version: 1,
    method,
    work_family: driver,
    confidence,
    signal_types: signals
  };
};

export function validateLabelProvenance(value, driver) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).filter((key) => !["basis_sha256", "context_sha256"].includes(key)).sort().join(",") !== "confidence,method,schema_version,signal_types,work_family" ||
      value.schema_version !== 1 || value.work_family !== driver || !Array.isArray(value.signal_types)) {
    return ["invalid label provenance shape or work family"];
  }
  for (const key of ["basis_sha256", "context_sha256"]) {
    if (Object.hasOwn(value, key) && !/^[a-f0-9]{64}$/.test(value[key])) return ["invalid label provenance input digest"];
  }
  try {
    const normalized = scrubbedLabelProvenance({ driver: value.work_family, method: value.method,
      confidence: value.confidence, signalTypes: value.signal_types });
    if (JSON.stringify(normalized.signal_types) !== JSON.stringify(value.signal_types)) {
      return ["label provenance signals must be sorted and unique"];
    }
    return [];
  } catch { // honesty-ok: invalid enumerated metadata is refused without echoing input.
    return ["label provenance contains an unsupported value"];
  }
}

export const controlledDriverEvidence = ({ driver, method, signalTypes = [] }) => {
  if (method === "unresolved") {
    return "No classified work-family signal was available for this day";
  }
  const description = FAMILY_DESCRIPTIONS[driver];
  if (!description) throw new Error(`No controlled evidence description for driver: ${driver}`);
  const labels = [...new Set(signalTypes)]
    .filter((signal) => Object.hasOwn(SIGNAL_LABELS, signal))
    .map((signal) => SIGNAL_LABELS[signal]);
  const basis = labels.length ? labels.join(" and ") : "classified metadata";
  if (method === "source_derived") return `Source composition establishes ${description}`;
  return `Automated classification: ${basis} supported ${description}`;
};
