export const tokenUsageForResult = (result) => {
  const input = result.input_tokens ?? 0;
  const cached =
    result.input_cached_tokens ?? result.cached_input_tokens ?? 0;
  const output = result.output_tokens ?? 0;
  const components = {};
  if (Number.isSafeInteger(result.input_tokens) && result.input_tokens >= 0) {
    components.input_tokens = result.input_tokens;
  }
  if (Number.isSafeInteger(result.output_tokens) && result.output_tokens >= 0) {
    components.output_tokens = result.output_tokens;
  }
  if (Number.isSafeInteger(result.input_cached_tokens) && result.input_cached_tokens >= 0) {
    components.cached_input_tokens = result.input_cached_tokens;
  } else if (Number.isSafeInteger(result.cached_input_tokens) && result.cached_input_tokens >= 0) {
    components.cached_input_tokens = result.cached_input_tokens;
  }
  return {
    tokens: Math.max(0, input - cached) + output,
    cached,
    components
  };
};
export const nextUsagePage = (body) => {
  if (!body || !Array.isArray(body.data)) {
    throw new Error("OpenAI Usage API response data must be an array");
  }
  if (!body.has_more) return null;
  if (typeof body.next_page !== "string" || !body.next_page) {
    throw new Error("OpenAI Usage API response has_more without next_page");
  }
  return body.next_page;
};
