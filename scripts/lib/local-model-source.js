const MODEL_SOURCE_MAP = [
  [/^qwen/i, "qwen_local"],
  [/^gemma/i, "gemma_local"],
  [/^llama/i, "llama_local"],
  [/^deepseek/i, "deepseek_local"],
  [/^gpt[-_]?oss/i, "gpt_oss"]
];

export const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "mlx",
  "llamacpp"
]);

const sanitize = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function localModelSource(model, provider = "ollama") {
  for (const [pattern, source] of MODEL_SOURCE_MAP) {
    if (pattern.test(model)) return source;
  }
  if (provider && LOCAL_PROVIDERS.has(provider.toLowerCase())) {
    return `${sanitize(model)}_local`;
  }
  return sanitize(provider || model);
}
