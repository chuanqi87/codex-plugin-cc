// Validate the JSON Schema assertions used by the bundled bridge output schema.
// CLI backends receive the schema in the prompt rather than enforcing it natively.
function validateValue(value, schema, location) {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && (schema.type === "integer" ? !Number.isInteger(value) : type !== schema.type)) {
    return `${location} must be ${schema.type}.`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${location} has an unsupported value.`;
  if (typeof value === "string" && schema.minLength != null && [...value].length < schema.minLength) {
    return `${location} must contain at least ${schema.minLength} character(s).`;
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) return `${location} is below ${schema.minimum}.`;
    if (schema.maximum != null && value > schema.maximum) return `${location} exceeds ${schema.maximum}.`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const error = validateValue(value[index], schema.items, `${location}[${index}]`);
      if (error) return error;
    }
  } else if (type === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) return `${location}.${name} is required.`;
    }
    for (const [name, entry] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, name)) {
        if (schema.additionalProperties === false) return `${location}.${name} is not allowed.`;
        continue;
      }
      const error = validateValue(entry, schema.properties[name], `${location}.${name}`);
      if (error) return error;
    }
  }
  return null;
}

export function validateStructuredOutput(rawOutput, schema) {
  let value;
  try {
    value = JSON.parse(rawOutput);
  } catch {
    return "OpenCode did not return valid JSON for the requested structured output.";
  }
  const error = validateValue(value, schema, "$result");
  return error ? `OpenCode structured output does not match the requested schema: ${error}` : null;
}
