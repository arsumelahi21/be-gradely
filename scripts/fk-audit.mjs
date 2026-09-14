/**
 * Delete-dependency audit.
 *
 * Parses prisma/schema.prisma and, for every model, lists the foreign keys that
 * POINT AT it, with the referential action Postgres will apply on delete.
 *
 *   node scripts/fk-audit.mjs            # every model that is referenced
 *   node scripts/fk-audit.mjs Subject    # just these models
 *
 * Prisma's defaults when `onDelete` is omitted: Restrict for a required
 * relation, SetNull for an optional one. Restrict/NoAction are what make a
 * delete fail; those are the rows flagged BLOCKS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const schema = readFileSync(
  path.resolve('prisma/schema.prisma'),
  'utf8',
);

const models = new Map(); // name -> { fields: [...] }
let current = null;
for (const raw of schema.split(/\r?\n/)) {
  const line = raw.trim();
  const start = /^model\s+(\w+)\s*\{/.exec(line);
  if (start) {
    current = { name: start[1], relations: [] };
    models.set(current.name, current);
    continue;
  }
  if (!current) continue;
  if (line === '}') {
    current = null;
    continue;
  }
  // A child-side relation carries `fields: [...]`.
  const rel = /^(\w+)\s+(\w+)(\?)?\s+@relation\((.*)\)/.exec(line);
  if (rel && /fields\s*:/.test(rel[4])) {
    const [, field, target, optional, args] = rel;
    const onDelete = /onDelete\s*:\s*(\w+)/.exec(args)?.[1];
    const fkField = /fields\s*:\s*\[([^\]]+)\]/.exec(args)?.[1].trim();
    current.relations.push({
      field,
      target,
      optional: !!optional,
      fk: fkField,
      // Prisma's implicit default, spelled out.
      onDelete: onDelete ?? (optional ? 'SetNull*' : 'Restrict*'),
      explicit: !!onDelete,
    });
  }
}

// Invert: which models point AT each model.
const incoming = new Map();
for (const m of models.values()) {
  for (const r of m.relations) {
    if (!incoming.has(r.target)) incoming.set(r.target, []);
    incoming.get(r.target).push({ from: m.name, ...r });
  }
}

const BLOCKING = (a) => a.startsWith('Restrict') || a.startsWith('NoAction');

const wanted = process.argv.slice(2);
const targets = wanted.length
  ? wanted
  : [...incoming.keys()].sort();

let totalBlocking = 0;
for (const name of targets) {
  const refs = (incoming.get(name) ?? []).sort((a, b) =>
    a.from.localeCompare(b.from),
  );
  if (!refs.length) continue;
  const blocking = refs.filter((r) => BLOCKING(r.onDelete));
  totalBlocking += blocking.length;
  console.log(
    `\n${name}  (${refs.length} FKs point at it, ${blocking.length} BLOCK delete)`,
  );
  for (const r of refs) {
    const mark = BLOCKING(r.onDelete)
      ? 'BLOCKS '
      : r.onDelete.startsWith('Cascade')
        ? 'cascade'
        : r.onDelete.startsWith('SetNull')
          ? 'setnull'
          : '       ';
    console.log(
      `  ${mark} ${r.from}.${r.fk}${r.explicit ? '' : '  (implicit)'}  -> ${r.onDelete}`,
    );
  }
}
console.log(`\nTOTAL blocking FKs across listed models: ${totalBlocking}`);
