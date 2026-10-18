// Builds catalog/endpoints.json from the official AbaNinja OpenAPI specs.
// Usage: node scripts/generate-catalog.mjs
import { mkdir, writeFile } from "node:fs/promises";

const SPEC_BASE = "https://docs.abaninja.ch/specs";
const AREAS = [
  "accounting", "accounts", "addresses", "documents", "exports", "finances",
  "holidays", "products", "time-tracking", "units", "warehouse", "webhooks",
];
const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_DEPTH = 3;

function typeOf(schema) {
  if (!schema) return "any";
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return [...new Set(variants.map(typeOf))].join("|");
  let type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null").join("|") : schema.type;
  if (!type) type = schema.properties ? "object" : "any";
  if (type === "array") type = `${typeOf(schema.items)}[]`;
  if (schema.enum) type = `enum(${schema.enum.join("|")})`;
  return schema.format && type === "string" ? `string(${schema.format})` : type;
}

function short(text) {
  return text ? String(text).replace(/\s+/g, " ").trim().slice(0, 160) : undefined;
}

// Merges the properties of allOf/oneOf/anyOf branches into one flat map.
function propertiesOf(schema) {
  const out = {};
  const required = new Set(schema.required ?? []);
  for (const branch of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    const sub = propertiesOf(branch);
    Object.assign(out, sub.properties);
    sub.required.forEach((name) => required.add(name));
  }
  Object.assign(out, schema.properties);
  return { properties: out, required };
}

function fieldsOf(schema, prefix = "", depth = 1) {
  if (!schema) return [];
  const { properties, required } = propertiesOf(schema.type === "array" && schema.items ? schema.items : schema);
  const fields = [];
  for (const [name, prop] of Object.entries(properties)) {
    const field = { name: prefix + name, type: typeOf(prop) };
    if (required.has(name)) field.required = true;
    const description = short(prop.description);
    if (description) field.description = description;
    fields.push(field);
    const child = prop.type === "array" ? prop.items : prop;
    if (depth < MAX_DEPTH && child && (child.properties || child.allOf)) {
      fields.push(...fieldsOf(child, `${prefix}${name}${prop.type === "array" ? "[]" : ""}.`, depth + 1));
    }
  }
  return fields;
}

const endpoints = [];
for (const area of AREAS) {
  const response = await fetch(`${SPEC_BASE}/${area}-v2.json`);
  if (!response.ok) throw new Error(`${area}: HTTP ${response.status}`);
  const spec = await response.json();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .filter((p) => p.name !== "accountUuid")
        .map((p) => {
          const param = { name: p.name, in: p.in, type: typeOf(p.schema) };
          if (p.required) param.required = true;
          const description = short(p.description);
          if (description) param.description = description;
          return param;
        });
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const entry = {
        area,
        method: method.toUpperCase(),
        path,
        summary: short(op.summary) ?? short(op.description) ?? "",
      };
      if (op.tags?.[0]) entry.tag = op.tags[0];
      if (params.length) entry.params = params;
      const body = fieldsOf(bodySchema);
      if (body.length) entry.body = body;
      endpoints.push(entry);
    }
  }
}

await mkdir("catalog", { recursive: true });
await writeFile("catalog/endpoints.json", JSON.stringify(endpoints) + "\n");
console.log(`${endpoints.length} endpoints written to catalog/endpoints.json`);
