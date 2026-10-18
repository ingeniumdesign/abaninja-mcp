// Builds catalog/endpoints.json from the official AbaNinja OpenAPI specs.
// Usage: node scripts/generate-catalog.mjs   (endpointsOf and typeOf are exported for the offline tests)
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SPEC_BASE = "https://docs.abaninja.ch/specs";
const AREAS = [
  "accounting", "accounts", "addresses", "documents", "exports", "finances",
  "holidays", "products", "time-tracking", "units", "warehouse", "webhooks",
];
const METHODS = ["get", "post", "put", "patch", "delete"];
const OUTPUT = new URL("../catalog/endpoints.json", import.meta.url);

// Replaces local "$ref" pointers (#/components/...) with the schema they point to.
// A reference that points back into itself is cut off as {} to stop endless recursion.
function inlineRefs(node, spec, stack = []) {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, spec, stack));
  if (!node || typeof node !== "object") return node;
  const { $ref, ...rest } = node;
  if (typeof $ref === "string" && $ref.startsWith("#/")) {
    if (stack.includes($ref)) return {};
    const target = $ref.slice(2).split("/").reduce((obj, key) => obj?.[key], spec);
    return { ...inlineRefs(target ?? {}, spec, [...stack, $ref]), ...inlineRefs(rest, spec, stack) };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inlineRefs(value, spec, stack)]));
}

const isObject = (schema) => !!schema && typeof schema === "object" && !Array.isArray(schema);
const isEmpty = (schema) => isObject(schema) && Object.keys(schema).length === 0;
const isNull = (schema) => isObject(schema) && schema.type !== undefined && [schema.type].flat().every((t) => t === "null");
const isArray = (schema) => isObject(schema) && ([schema.type].flat().includes("array") || (!schema.type && "items" in schema));
const isMap = (schema) => isObject(schema) && isObject(schema.additionalProperties) && !schema.properties;
const isRich = (schema) =>
  ["properties", "items", "oneOf", "anyOf", "allOf", "enum", "const", "additionalProperties"].some((key) => key in schema);

// The item schema of a list, also when the list is written as variants that are all lists.
function itemsOf(schema) {
  if (isArray(schema)) return schema.items ?? {};
  const variants = (schema.anyOf ?? schema.oneOf ?? []).filter((v) => !isNull(v));
  if (!variants.length || !variants.every(isArray)) return undefined;
  const items = variants.map((v) => v.items).filter((item) => isObject(item) && !isEmpty(item));
  return items.length > 1 ? { anyOf: items } : items[0] ?? {};
}

// The possible types of a schema, e.g. ["string(uuid)", "integer"].
function typesOf(schema) {
  if (!isObject(schema)) return ["any"];
  if ("const" in schema) return [JSON.stringify(schema.const)];
  if (schema.enum) {
    const values = schema.enum.map((v) => JSON.stringify(v));
    return [values.length === 1 ? values[0] : `enum(${values.join("|")})`];
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const types = [...new Set(variants.flatMap(typesOf))].filter((type) => type !== "null");
    const known = types.filter((type) => type !== "any");
    return known.length ? known : types.length ? types : ["null"];
  }
  if (isArray(schema)) return [`${typeOf(schema.items)}[]`];
  if (isMap(schema)) return [`map<${schema.propertyNames?.enum?.join("|") ?? "string"}, ${typeOf(schema.additionalProperties)}>`];
  const types = [schema.type].flat().filter((type) => type && type !== "null");
  if (!types.length) return [schema.properties || schema.allOf ? "object" : "any"];
  return types.map((type) => {
    if (type !== "string") return type;
    if (schema.format) return `string(${schema.format})`;
    return schema.pattern ? `string(pattern ${schema.pattern})` : type;
  });
}

export const typeOf = (schema) => typesOf(schema).join("|");

function short(text, max = 160) {
  return text ? String(text).replace(/\s+/g, " ").trim().slice(0, max) : undefined;
}

// The discriminator of an oneOf/anyOf branch, such as "type=company", if it has one.
function discriminatorOf(branch) {
  for (const [name, prop] of Object.entries(branch?.properties ?? {})) {
    if (isObject(prop) && "const" in prop) return `${name}=${prop.const}`;
    if (isObject(prop) && prop.enum?.length === 1) return `${name}=${prop.enum[0]}`;
  }
}

// What a value condition says, e.g. "=BANK", " in (a, b)", " not matching ^(CH|LI)".
function valueLabel(prop) {
  if (!isObject(prop)) return " given";
  if ("const" in prop) return `=${prop.const}`;
  if (prop.enum) return ` in (${prop.enum.join(", ")})`;
  if (prop.pattern) return ` matching ${prop.pattern}`;
  if (isObject(prop.not) && "const" in prop.not) return ` not ${prop.not.const}`;
  if (isObject(prop.not)) return ` not${valueLabel(prop.not)}`;
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
// exclusions: fields a branch forbids next to the fields it requires (productNumber not with productUuid).
function propertiesOf(schema) {
  const variants = new Map();
  const required = new Set();
  const conditions = new Map();
  const exclusions = new Map();
  if (!isObject(schema)) return { properties: {}, required, conditions, exclusions };
  const add = (map, name, value) => map.set(name, [...(map.get(name) ?? []), value]);

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
  // Takes over a branch; "outer" holds the discriminator its own conditions additionally need.
  const merge = (sub, outer, refine) => {
    addProperties(sub.properties, refine);
    sub.conditions.forEach((clauses, name) =>
      clauses.forEach((clause) => add(conditions, name, { when: [...outer, ...clause.when], unless: clause.unless })),
    );
    sub.exclusions.forEach((others, name) => others.forEach((other) => add(exclusions, name, other)));
  };

  addProperties(schema.properties, false);
  (schema.required ?? []).forEach((name) => required.add(name));
  for (const branch of schema.allOf ?? []) {
    const sub = propertiesOf(branch);
    merge(sub, [], true);
    sub.required.forEach((name) => required.add(name));
  }
  // A null branch only says the whole value may be null; it is no alternative for the fields.
  const groups = [schema.oneOf, schema.anyOf].map((branches) => ({ branches: (branches ?? []).filter((b) => !isNull(b)) }));
  if (isObject(schema.if) && (schema.then || schema.else)) {
    const label = conditionLabel(schema.if);
    groups.push({ branches: [schema.then ?? {}, schema.else ?? {}], labels: [label, `not (${label})`], refine: true });
  }
  for (const { branches, labels, refine = false } of groups) {
    if (!branches.length) continue;
    const subs = branches.map((branch, i) => ({ ...propertiesOf(branch), branch, discriminator: labels?.[i] ?? discriminatorOf(branch) }));
    const byDiscriminator = subs.every((sub) => sub.discriminator);
    subs.forEach((sub, i) => {
      // Without a discriminator a branch is named by the fields that only it requires.
      const own = [...sub.required].filter((name) => subs.some((other) => !other.required.has(name)));
      sub.label = sub.discriminator ?? (own.length ? `${own.join(" and ")} given` : sub.branch.title ?? `variant ${i + 1}`);
      merge(sub, byDiscriminator ? [sub.label] : [], refine);
    });
    for (const sub of subs) {
      for (const name of sub.required) {
        if (subs.every((other) => other.required.has(name))) required.add(name);
        else if (byDiscriminator) add(conditions, name, { when: [sub.label], unless: [] });
        else add(conditions, name, { when: [], unless: subs.filter((o) => !o.required.has(name)).map((o) => o.label) });
      }
      // Two fields exclude each other when a branch forbids one next to the other and no branch allows both.
      for (const [name, prop] of Object.entries(sub.branch.properties ?? {})) {
        if (prop !== false) continue;
        for (const other of sub.required) {
          const together = subs.some((s) => s.branch.properties?.[name] !== false && s.branch.properties?.[other] !== false);
          if (!together) add(exclusions, name, other);
        }
      }
    }
  }
  // A required field without a definition of its own still has to show up.
  for (const name of [...required, ...conditions.keys()]) {
    if (!variants.has(name)) variants.set(name, [{}]);
  }
  for (const name of required) conditions.delete(name);
  const properties = Object.fromEntries([...variants].map(([name, list]) => [name, list.length === 1 ? list[0] : { anyOf: list }]));
  return { properties, required, conditions, exclusions };
}

// The descriptions of a field and of the variants it was merged from.
const descriptions = (prop) =>
  isObject(prop) ? [short(prop.description), ...(prop.anyOf ?? []).flatMap(descriptions)].filter(Boolean) : [];

function fieldsOf(schema, prefix = "") {
  if (!isObject(schema)) return [];
  const { properties, required, conditions, exclusions } = propertiesOf(itemsOf(schema) ?? schema);
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
    if (exclusions.has(name)) field.notWith = [...new Set(exclusions.get(name))].join(", ");
    // A null variant with a meaning ("No bank account will be used") is kept as a note.
    const nullVariant = (prop.oneOf ?? prop.anyOf ?? []).find((v) => isNull(v) && (v.title || v.description));
    if (nullVariant) field.nullMeans = short(nullVariant.title ?? nullVariant.description);
    const description = short([...new Set(descriptions(prop))].join(" | "), 240);
    if (prop.deprecated || /^deprecated/i.test(description ?? "")) field.deprecated = true;
    if (description) field.description = description;
    fields.push(field);

    // Nested fields of objects, list items and map values; a list inside a list is left out.
    const items = itemsOf(prop);
    const child = items ?? (isMap(prop) ? prop.additionalProperties : prop);
    if (Object.keys(propertiesOf(child).properties).length) {
      fields.push(...fieldsOf(child, `${prefix}${name}${items ? "[]" : isMap(prop) ? ".<key>" : ""}.`));
    }
  }
  return fields;
}

// The catalog entries of one area's spec. Undefined values are left out of the JSON.
export function endpointsOf(area, raw) {
  const spec = inlineRefs(raw, raw);
  const endpoints = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS.filter((m) => item[m])) {
      const op = item[method];
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .filter((p) => p.name !== "accountUuid")
        .map((p) => ({ name: p.name, in: p.in, type: typeOf(p.schema), required: p.required || undefined, description: short(p.description) }));
      const content = op.requestBody?.content ?? {};
      const body = fieldsOf(content["application/json"]?.schema);
      endpoints.push({
        area,
        method: method.toUpperCase(),
        path,
        summary: short(op.summary) ?? short(op.description) ?? "",
        tag: op.tags?.[0],
        deprecated: op.deprecated || undefined,
        params: params.length ? params : undefined,
        body: body.length ? body : undefined,
        note: content["multipart/form-data"] && !content["application/json"]
          ? "Expects a multipart/form-data file upload, which abaninja_request cannot send."
          : undefined,
      });
    }
  }
  return endpoints;
}

// Run as a script; the tests import the functions instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoints = [];
  for (const area of AREAS) {
    const response = await fetch(`${SPEC_BASE}/${area}-v2.json`);
    if (!response.ok) throw new Error(`Spec "${area}": HTTP ${response.status}`);
    const found = endpointsOf(area, await response.json());
    if (!found.length) throw new Error(`Spec "${area}" has no endpoints`);
    endpoints.push(...found);
  }
  await writeFile(OUTPUT, JSON.stringify(endpoints) + "\n");
  console.log(`${endpoints.length} endpoints written to catalog/endpoints.json`);
}
