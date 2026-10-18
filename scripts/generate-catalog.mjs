// Builds catalog/endpoints.json from the official AbaNinja OpenAPI specs.
// Usage: node scripts/generate-catalog.mjs
import { mkdir, writeFile } from "node:fs/promises";

const SPEC_BASE = "https://docs.abaninja.ch/specs";
const AREAS = [
  "accounting", "accounts", "addresses", "documents", "exports", "finances",
  "holidays", "products", "time-tracking", "units", "warehouse", "webhooks",
];
const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_DEPTH = 8;

// Replaces local "$ref" pointers (#/components/...) with the schema they point to.
// A reference that points back into itself is cut off as {} to stop endless recursion.
function inlineRefs(node, spec, stack = []) {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, spec, stack));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const { $ref, ...rest } = node;
    if (stack.includes($ref)) return {};
    const target = $ref
      .slice(2)
      .split("/")
      .reduce((obj, key) => obj?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return { ...inlineRefs(target ?? {}, spec, [...stack, $ref]), ...inlineRefs(rest, spec, stack) };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inlineRefs(value, spec, stack)]));
}

const isObject = (schema) => !!schema && typeof schema === "object" && !Array.isArray(schema);
const isEmpty = (schema) => isObject(schema) && Object.keys(schema).length === 0;
const isArray = (schema) =>
  isObject(schema) &&
  (schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array")) ||
    (!schema.type && "items" in schema));
const isMap = (schema) => isObject(schema) && isObject(schema.additionalProperties) && !schema.properties;
const isRich = (schema) =>
  ["properties", "items", "oneOf", "anyOf", "allOf", "enum", "const", "additionalProperties"].some((key) => key in schema);
const variantsOf = (schema) => (schema.anyOf ?? schema.oneOf ?? []).filter((v) => isObject(v) && v.type !== "null");

// The item schema of a list, also when the list is written as variants that are all lists.
function itemsOf(schema) {
  if (!isObject(schema)) return undefined;
  if (isArray(schema)) return schema.items ?? {};
  const variants = variantsOf(schema);
  if (!variants.length || !variants.every(isArray)) return undefined;
  const withItems = variants.filter((v) => isObject(v.items) && !isEmpty(v.items));
  const lists = withItems.length ? withItems : variants;
  return lists.length === 1 ? lists[0].items ?? {} : { anyOf: lists.map((v) => v.items ?? {}) };
}

// Splits "a|enum(x|y)|b" into ["a", "enum(x|y)", "b"]: only "|" outside parentheses or <> separates types.
function splitTypes(type) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of type) {
    if (char === "(" || char === "<") depth++;
    if (char === ")" || char === ">") depth--;
    if (char === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return [...parts, current];
}

function typeOf(schema) {
  if (schema === false) return "forbidden";
  if (!isObject(schema)) return "any";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum) {
    return schema.enum.length === 1 ? JSON.stringify(schema.enum[0]) : `enum(${schema.enum.map((v) => JSON.stringify(v)).join("|")})`;
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const types = [...new Set(variants.flatMap((variant) => splitTypes(typeOf(variant))))].filter((type) => type !== "null");
    const known = types.filter((type) => type !== "any");
    return (known.length ? known : types).join("|") || "null";
  }
  if (isArray(schema)) return `${typeOf(schema.items)}[]`;
  if (isMap(schema)) return `map<${schema.propertyNames?.enum?.join("|") ?? "string"}, ${typeOf(schema.additionalProperties)}>`;
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((type) => type && type !== "null");
  if (!types.length) return schema.properties || schema.allOf ? "object" : "any";
  return types.map((type) => (type === "string" && schema.format ? `string(${schema.format})` : type)).join("|");
}

function short(text, max = 160) {
  return text ? String(text).replace(/\s+/g, " ").trim().slice(0, max) : undefined;
}

// A readable name for one oneOf/anyOf branch: its discriminator such as "type=company" when it has one,
// otherwise the fields it requires ("singlePrice and productDescription given").
function branchLabel(branch, index) {
  for (const [name, prop] of Object.entries(branch?.properties ?? {})) {
    if (isObject(prop) && "const" in prop) return { label: `${name}=${prop.const}`, discriminated: true };
    if (isObject(prop) && prop.enum?.length === 1) return { label: `${name}=${prop.enum[0]}`, discriminated: true };
  }
  if (branch?.required?.length) return { label: `${branch.required.join(" and ")} given`, discriminated: false };
  return { label: branch?.title ?? `variant ${index + 1}`, discriminated: false };
}

// What a value condition says, e.g. "=BANK", " in (a, b)", " not matching ^(CH|LI)".
function valueLabel(prop) {
  if (!isObject(prop)) return " given";
  if ("const" in prop) return `=${prop.const}`;
  if (prop.enum) return ` in (${prop.enum.join(", ")})`;
  if (prop.pattern) return ` matching ${prop.pattern}`;
  if (isObject(prop.not)) {
    if ("const" in prop.not) return ` not ${prop.not.const}`;
    return ` not${valueLabel(prop.not)}`;
  }
  return " given";
}

// The condition of an if/then/else, e.g. "taxMethod=flat_rate_method" or "signaturePage=true or signees given".
function conditionLabel(condition) {
  if (!isObject(condition)) return "condition met";
  const alternatives = condition.anyOf ?? condition.oneOf;
  if (alternatives) return alternatives.map(conditionLabel).join(" or ");
  if (condition.allOf) return condition.allOf.map(conditionLabel).join(" and ");
  const parts = Object.entries(condition.properties ?? {}).map(([name, prop]) => `${name}${valueLabel(prop)}`);
  for (const name of condition.required ?? []) {
    if (!condition.properties?.[name]) parts.push(`${name} given`);
  }
  return parts.join(" and ") || "condition met";
}

// Merges the fields of allOf, oneOf/anyOf and if/then/else into one flat map.
// required: fields the schema, an allOf branch or every alternative requires.
// conditions: fields only some alternatives require, as clauses. A clause holds the discriminators that
// must all apply ("when", e.g. paymentDirection=IN and paymentType=BANK) and the alternatives that
// replace the field ("unless", e.g. isTemplate=true).
function propertiesOf(schema) {
  const variants = new Map();
  const required = new Set();
  const conditions = new Map();
  if (!isObject(schema)) return { properties: {}, required, conditions };

  // Alternatives keep differing definitions as variants. Constraints (allOf, then/else) only refine a
  // field, so a bare re-declaration such as {type: "array"} does not replace or split a richer one.
  const addProperties = (properties, refine) => {
    for (const [name, prop] of Object.entries(properties ?? {})) {
      if (!isObject(prop)) continue; // true/false only allow or forbid a field in one branch
      const list = variants.get(name) ?? [];
      variants.set(name, list);
      if (list.some((known) => JSON.stringify(known) === JSON.stringify(prop))) continue;
      if (list.length && (isEmpty(prop) || (refine && !isRich(prop)))) continue;
      const placeholder = list.findIndex((known) => isEmpty(known) || (refine && !isRich(known)));
      if (placeholder >= 0) list[placeholder] = prop;
      else list.push(prop);
    }
  };
  const addClause = (name, clause) => {
    const clauses = conditions.get(name) ?? [];
    if (!clauses.some((known) => JSON.stringify(known) === JSON.stringify(clause))) clauses.push(clause);
    conditions.set(name, clauses);
  };
  const merge = (sub, outer, refine) => {
    addProperties(sub.properties, refine);
    sub.conditions.forEach((clauses, name) =>
      clauses.forEach((clause) => addClause(name, { when: outer ? [outer, ...clause.when] : clause.when, unless: clause.unless })),
    );
  };

  addProperties(schema.properties, false);
  (schema.required ?? []).forEach((name) => required.add(name));
  for (const branch of schema.allOf ?? []) {
    const sub = propertiesOf(branch);
    merge(sub, undefined, true);
    sub.required.forEach((name) => required.add(name));
  }
  const groups = [];
  for (const branches of [schema.oneOf, schema.anyOf]) {
    if (branches?.length) groups.push({ branches: branches.map((b, i) => [b, branchLabel(b, i)]), refine: false });
  }
  if (isObject(schema.if) && (schema.then || schema.else)) {
    const label = conditionLabel(schema.if);
    groups.push({
      branches: [
        [schema.then ?? {}, { label, discriminated: true }],
        [schema.else ?? {}, { label: `not (${label})`, discriminated: true }],
      ],
      refine: true,
    });
  }
  for (const { branches, refine } of groups) {
    const subs = branches.map(([branch, info]) => ({ ...propertiesOf(branch), ...info }));
    const byDiscriminator = subs.every((sub) => sub.discriminated);
    subs.forEach((sub) => merge(sub, byDiscriminator ? sub.label : undefined, refine));
    for (const sub of subs) {
      for (const name of sub.required) {
        if (subs.every((other) => other.required.has(name))) required.add(name);
        else if (byDiscriminator) addClause(name, { when: [sub.label], unless: [] });
        else addClause(name, { when: [], unless: subs.filter((o) => !o.required.has(name)).map((o) => o.label) });
      }
    }
  }
  // A required field without a definition of its own still has to show up.
  for (const name of [...required, ...conditions.keys()]) {
    if (!variants.get(name)?.length) variants.set(name, [{}]);
  }
  for (const name of required) conditions.delete(name);

  const properties = {};
  for (const [name, list] of variants) properties[name] = list.length === 1 ? list[0] : { anyOf: list };
  return { properties, required, conditions };
}

function descriptions(prop) {
  if (!isObject(prop)) return [];
  return [prop.description, ...(prop.anyOf ?? []).flatMap(descriptions)].filter(Boolean);
}

function descriptionOf(prop) {
  return short([...new Set(descriptions(prop).map((text) => short(text)))].join(" | "), 240);
}

function fieldsOf(schema, prefix = "", depth = 1) {
  if (!isObject(schema)) return [];
  const { properties, required, conditions } = propertiesOf(itemsOf(schema) ?? schema);
  const fields = [];
  for (const [name, prop] of Object.entries(properties)) {
    const field = { name: prefix + name, type: typeOf(prop) };
    if (required.has(name)) {
      field.required = true;
    } else if (conditions.has(name)) {
      // A rule without a "when" (e.g. "unless isTemplate=true") already requires the field in general,
      // so narrower rules next to it would only make it look optional.
      const clauses = conditions.get(name);
      const general = clauses.filter((c) => !c.when.length);
      const used = general.length ? general : clauses;
      const ifs = [...new Set(used.filter((c) => c.when.length).map((c) => c.when.join(" and ")))];
      const unless = [...new Set(used.flatMap((c) => c.unless))];
      if (ifs.length) field.requiredIf = ifs.join(" or ");
      if (unless.length) field.requiredUnless = unless.join(" or ");
    }
    const description = descriptionOf(prop);
    if (description) field.description = description;
    fields.push(field);

    const items = itemsOf(prop);
    const child = items ?? (isMap(prop) ? prop.additionalProperties : prop);
    const childPrefix = `${prefix}${name}${items ? "[]" : ""}${isMap(prop) ? ".<key>" : ""}.`;
    if (!isObject(child) || !Object.keys(propertiesOf(child).properties).length) continue;
    if (depth < MAX_DEPTH) fields.push(...fieldsOf(child, childPrefix, depth + 1));
    else field.note = "nested fields omitted";
  }
  return fields;
}

const endpoints = [];
for (const area of AREAS) {
  const response = await fetch(`${SPEC_BASE}/${area}-v2.json`);
  if (!response.ok) throw new Error(`${area}: HTTP ${response.status}`);
  const raw = await response.json();
  const spec = inlineRefs(raw, raw);
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
      const content = op.requestBody?.content ?? {};
      const entry = {
        area,
        method: method.toUpperCase(),
        path,
        summary: short(op.summary) ?? short(op.description) ?? "",
      };
      if (op.tags?.[0]) entry.tag = op.tags[0];
      if (params.length) entry.params = params;
      const body = fieldsOf(content["application/json"]?.schema);
      if (body.length) entry.body = body;
      if (!content["application/json"] && content["multipart/form-data"]) {
        entry.note = "Expects a multipart/form-data file upload, which abaninja_request cannot send.";
      }
      endpoints.push(entry);
    }
  }
}

await mkdir("catalog", { recursive: true });
await writeFile("catalog/endpoints.json", JSON.stringify(endpoints) + "\n");
console.log(`${endpoints.length} endpoints written to catalog/endpoints.json`);
