/**
 * Shared model of the `acc` CLI, parsed statically from the CLI source
 * (Commander registrations). No build of the CLI is required.
 *
 * Used by:
 *   - scripts/generate-cli-docs.mjs   (the command reference page)
 *   - scripts/check-cli-drift.mjs     (hand-written pages vs the real CLI)
 *
 * Nesting is recovered from the receiver of each `.command(` call:
 *   const cmd = program.command('services')   → node "services", bound to `cmd`
 *   cmd.command('list')                        → child of services
 *   const env = cmd.command('env')             → child of services, bound to `env`
 *   env.command('list [service]')              → child of env  ⇒ acc services env list
 *
 * A registration inside `for (const op of ['a', 'b'] as const) { … }` whose
 * signature is a template literal over that variable, as in
 * archives.command(`${op} <archive-id>`) (cli#163), expands to one node per
 * value: `.description({ a: '…', b: '…' }[op])` gives each its own text and
 * an `if (op !== 'b') { ….option(…) }` guard keeps that option off `b`.
 *
 * CLI repo location:
 *   - AF_CLI_REPO env var, else
 *   - ../alternate-clouds-cli (local sibling checkout), else
 *   - ./alternate-clouds-cli (CI checkout inside this repo)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/** Command groups mirroring src/cli.ts COMMAND_GROUPS (display order). */
export const GROUPS = [
  { title: 'Account', dirs: ['auth', 'whoami', 'orgs'] },
  {
    title: 'Compute',
    dirs: ['projects', 'services', 'deployments', 'regions', 'templates', 'ssh', 'cp', 'attest'],
  },
  { title: 'Chat', dirs: ['chat'] },
  // Archives mirrors `{ title: 'Archives', names: ['archives'] }` in the CLI's
  // COMMAND_GROUPS (cli#163, acc 1.10.0). The platform refuses uploads so far
  // (`acc archives capabilities` answers `available: false`), so the group
  // stays off the public page until the feature is switched on. The global
  // DOCS_INCLUDE_UNRELEASED_SURFACES flag has been 1 in CI since the swarm
  // launch and hides nothing on its own, so this group carries its own gate:
  // DOCS_INCLUDE_ARCHIVES=1 renders it (AF_DOCS_PIPELINE.md §4).
  { title: 'Archives', dirs: ['archives'], unreleased: true, gate: 'DOCS_INCLUDE_ARCHIVES' },
  // Swarm groups mirror COMMAND_GROUPS in the CLI's src/cli.ts (2026-09-21
  // split: the normal path, the advanced commands, identity). These modules
  // register top-level commands, so each group is matched by command name.
  // Rendered only with DOCS_INCLUDE_UNRELEASED_SURFACES=1 until the launch
  // flip (AF_DOCS_PIPELINE.md §4); the GraphQL generator has the matching gate.
  {
    title: 'Swarms',
    dirs: ['init', 'add', 'create', 'agents', 'swarms', 'run', 'tasks', 'secrets', 'models'],
    unreleased: true,
  },
  {
    title: 'Swarms, advanced',
    dirs: ['agent', 'state', 'fork', 'watch', 'trace', 'replay', 'mcp', 'skills', 'tools', 'eval', 'dev', 'serve', 'tee'],
    unreleased: true,
  },
  {
    title: 'Identity',
    dirs: ['identities', 'cards', 'delegations', 'proofs'],
    unreleased: true,
  },
  { title: 'Billing', dirs: ['billing', 'pat'] },
];

/** Commands registered directly on the program in src/cli.ts. */
export const ROOT_COMMANDS = ['login', 'logout', 'whoami'];

/** Options Commander adds to every command. */
export const IMPLICIT_OPTIONS = [
  { flag: '-V, --version', description: 'print CLI version', names: ['-V', '--version'], takesValue: false },
  { flag: '-h, --help', description: 'help for any command', names: ['-h', '--help'], takesValue: false },
];

export function findCliRepo(repoRoot) {
  return [
    process.env.AF_CLI_REPO,
    resolve(repoRoot, '../alternate-clouds-cli'),
    resolve(repoRoot, 'alternate-clouds-cli'),
  ]
    .filter(Boolean)
    .find((p) => existsSync(join(p, 'src/commands')));
}

// String literal matched with its own delimiter (', " or `), tolerating the
// other two quote chars inside. STR2/STR3 renumber the backreference for use
// as the 2nd/3rd literal in one pattern.
const STR = `(['"\`])((?:\\\\.|(?!\\1).)*)\\1`;
const STR2 = STR.replace(/\\1/g, '\\3');
const STR3 = STR.replace(/\\1/g, '\\5');
const T_CALL = `t\\(\\s*(['"\`])([A-Za-z0-9_.-]+)\\1\\s*\\)`;

/** `'-p, --project <id-or-name>'` → names + whether a value follows. */
export function parseFlag(flag) {
  const names = [];
  let takesValue = false;
  for (const part of String(flag).split(',')) {
    const token = part.trim().split(/\s+/)[0];
    if (token?.startsWith('-')) names.push(token);
    if (/[<[]/.test(part)) takesValue = true;
  }
  return { names, takesValue };
}

function resolveT(seg, method, en) {
  const m = seg.match(new RegExp(`\\.${method}\\(\\s*${T_CALL}`));
  return m ? (en[m[2]] ?? '') : '';
}

/** Identifier the `.command(` at `idx` is called on, and the variable it is assigned to. */
function receiverAt(content, idx) {
  let j = idx - 1;
  while (j >= 0 && /\s/.test(content[j])) j--;
  if (j < 0) return { receiver: null, assigned: null };
  if (content[j] === ')') return { receiver: '__chain__', assigned: null };
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(content[j])) j--;
  const receiver = content.slice(j + 1, end);
  const before = content.slice(Math.max(0, j - 80), j + 1);
  const am = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  return { receiver, assigned: am ? am[1] : null };
}

/** Index of the quote closing the string that opens at `i` (' or "), or -1. */
function skipQuoted(content, i) {
  const quote = content[i];
  for (i++; i < content.length; i++) {
    if (content[i] === '\\') i++;
    else if (content[i] === quote || content[i] === '\n') return i;
  }
  return -1;
}

/** Index of the backtick closing the template literal that opens at `i`, or -1. */
function skipTemplate(content, i) {
  for (i++; i < content.length; i++) {
    if (content[i] === '\\') i++;
    else if (content[i] === '`') return i;
    else if (content[i] === '$' && content[i + 1] === '{') {
      i = matchBrace(content, i + 1);
      if (i === -1) return -1;
    }
  }
  return -1;
}

/**
 * Index of the `}` matching the `{` at `open`, or -1. Strings, template
 * literals and comments are skipped. Regex literals are not recognised, so a
 * regex holding a quote or an unbalanced brace inside the block can defeat
 * the match; callers then fall back to the unexpanded registration.
 */
function matchBrace(content, open) {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '/' && next === '/') {
      i = content.indexOf('\n', i);
      if (i === -1) return -1;
    } else if (ch === '/' && next === '*') {
      i = content.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i++;
    } else if (ch === "'" || ch === '"') {
      i = skipQuoted(content, i);
      if (i === -1) return -1;
    } else if (ch === '`') {
      i = skipTemplate(content, i);
      if (i === -1) return -1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** STR with its backreference renumbered so it can sit after `group - 1` capture groups. */
const strAt = (group) => STR.replace(/\\1/g, `\\${group}`);

const LOOP_RE = /\bfor\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+\[([^\]]*)\]\s*(?:as\s+const\s*)?\)\s*\{/g;

/**
 * String values of the innermost `for (const name of ['a', 'b'] as const) { … }`
 * whose body holds `idx`, or null when no such loop binds `name`.
 */
function loopValues(content, idx, name) {
  let found = null;
  for (const m of content.matchAll(LOOP_RE)) {
    if (m[1] !== name) continue;
    const open = m.index + m[0].length - 1;
    if (open > idx) break;
    const close = matchBrace(content, open);
    if (close === -1 || close < idx) continue;
    const values = [...m[2].matchAll(new RegExp(STR, 'g'))].map((s) => s[2]);
    if (values.length > 0) found = values; // a later match is an inner loop
  }
  return found;
}

/**
 * `.description({ a: '…', b: '…' }[name])` in `seg`: value → description, or
 * null when the description is not such a lookup.
 */
function lookupDescriptions(seg, name) {
  const at = seg.search(/\.description\(\s*\{/);
  if (at === -1) return null;
  const open = seg.indexOf('{', at);
  const close = matchBrace(seg, open);
  if (close === -1 || !new RegExp(`^\\s*\\[\\s*${name}\\s*\\]`).test(seg.slice(close + 1))) return null;
  const entryRe = new RegExp(`(?:([A-Za-z_$][\\w$]*)|${strAt(2)})\\s*:\\s*${strAt(4)}`, 'g');
  const map = {};
  for (const e of seg.slice(open + 1, close).matchAll(entryRe)) map[e[1] ?? e[3]] = e[5];
  return map;
}

/**
 * `seg` without the `if (name === 'x') { … }` / `if (name !== 'x') { … }`
 * blocks that do not run for `value`, so their `.option(` calls are not
 * attributed to it.
 */
function applyGuards(seg, name, value) {
  const guardRe = new RegExp(`\\bif\\s*\\(\\s*${name}\\s*([!=]==?)\\s*${strAt(2)}\\s*\\)\\s*\\{`, 'g');
  let out = '';
  let last = 0;
  for (const g of seg.matchAll(guardRe)) {
    if (g.index < last) continue;
    const open = g.index + g[0].length - 1;
    const close = matchBrace(seg, open);
    if (close === -1) break;
    const runs = (g[3] === value) === g[1].startsWith('=');
    if (!runs) {
      out += seg.slice(last, g.index);
      last = close + 1;
    }
  }
  return out + seg.slice(last);
}

/**
 * The registrations a `.command(` hit stands for: one per loop value when the
 * signature is a template literal over a variable bound by an enclosing
 * `for … of […]` loop, else the hit itself, untouched.
 */
function expandLoop(content, hit, seg) {
  const plain = [{ signature: hit.signature, seg, description: undefined }];
  if (hit.quote !== '`') return plain;
  const holes = [...new Set([...hit.signature.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((h) => h[1]))];
  if (holes.length !== 1) return plain;
  const name = holes[0];
  const values = loopValues(content, hit.start, name);
  if (!values) return plain;
  const descriptions = lookupDescriptions(seg, name) ?? {};
  const holeRe = new RegExp(`\\$\\{\\s*${name}\\s*\\}`, 'g');
  return values.map((value) => ({
    signature: hit.signature.replace(holeRe, value),
    seg: applyGuards(seg, name, value),
    description: descriptions[value],
  }));
}

/** Every `.command('…')` in a file with its description, options, receiver and assigned variable. */
function parseRegistrations(content, fileLabel, en) {
  const cmdRe = new RegExp(`\\.command\\(\\s*${STR}`, 'g');
  const hits = [];
  let m;
  while ((m = cmdRe.exec(content))) hits.push({ signature: m[2], quote: m[1], start: m.index });
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const segment = content.slice(hits[i].start, hits[i + 1]?.start ?? content.length);
    // One registration, or one per value for a `for (const x of […])` loop.
    for (const { signature, seg, description } of expandLoop(content, hits[i], segment)) {
      const desc = seg.match(new RegExp(`\\.description\\(\\s*${STR}`));
      const optRe = new RegExp(
        `\\.(?:option|requiredOption)\\(\\s*${STR}\\s*,\\s*${STR2}(?:\\s*,\\s*(?:${STR3}|[^)]+))?`,
        'g',
      );
      const options = [...seg.matchAll(optRe)].map((o) => ({
        flag: o[2],
        description: o[4],
        defaultValue: o[6],
        ...parseFlag(o[2]),
      }));
      // Options described with t('key') do not match optRe's string-literal shape.
      const optTRe = new RegExp(`\\.(?:option|requiredOption)\\(\\s*${STR}\\s*,\\s*${T_CALL.replace(/\\1/g, '\\3')}`, 'g');
      for (const o of seg.matchAll(optTRe)) {
        if (!options.some((x) => x.flag === o[2])) {
          options.push({ flag: o[2], description: en[o[4]] ?? '', defaultValue: undefined, ...parseFlag(o[2]) });
        }
      }
      out.push({
        signature: signature.replace(/\s+/g, ' ').trim(),
        description: description ?? (desc ? desc[2] : resolveT(seg, 'description', en)),
        options,
        file: fileLabel,
        ...receiverAt(content, hits[i].start),
      });
    }
  }
  return out;
}

/** Root `program` options: `.option(` calls in cli.ts before the first `.command(`. */
function parseRootOptions(cliTs) {
  const firstCommand = cliTs.search(/\.command\(/);
  const head = firstCommand === -1 ? cliTs : cliTs.slice(0, firstCommand);
  const optRe = new RegExp(`\\.(?:option|requiredOption)\\(\\s*${STR}\\s*,\\s*(?:${STR2}|${T_CALL.replace(/\\1/g, '\\3')})`, 'g');
  const options = [];
  for (const o of head.matchAll(optRe)) {
    options.push({ flag: o[2], description: o[4] ?? '', defaultValue: undefined, ...parseFlag(o[2]) });
  }
  return options;
}

function findCommandFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && entry !== 'prompts' && entry !== 'utils' && entry !== '__tests__') {
      findCommandFiles(fullPath, files);
    } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function makeNode(reg, parent) {
  const node = {
    name: reg.signature.split(' ')[0],
    signature: reg.signature,
    description: reg.description,
    options: reg.options,
    file: reg.file,
    parent,
    children: [],
  };
  parent.children.push(node);
  return node;
}

/** `acc services env list [service]`: parent names without their arguments, own signature. */
export function displayOf(node) {
  const names = [];
  for (let n = node.parent; n && n.parent; n = n.parent) names.unshift(n.name);
  return ['acc', ...names, node.signature].join(' ').replace(/\s+/g, ' ').trim();
}

/** Command path without arguments, e.g. ['services', 'env', 'list']. */
export function pathOf(node) {
  const names = [];
  for (let n = node; n && n.parent; n = n.parent) names.unshift(n.name);
  return names;
}

/** Options accepted on this command: its own, every ancestor's, the root's, plus -h/-V. */
export function allowedOptions(node) {
  const opts = [];
  for (let n = node; n; n = n.parent) opts.push(...(n.options ?? []));
  opts.push(...IMPLICIT_OPTIONS);
  return opts;
}

/**
 * Parse the CLI into a command tree.
 * @returns {{ cliRepo: string, pkg: object, root: object, commands: object[] }}
 *   `root.children` are the top-level commands in registration order;
 *   `commands` is the depth-first flat list (duplicates removed).
 */
export function loadCliModel({ repoRoot, cliRepo = findCliRepo(repoRoot) } = {}) {
  if (!cliRepo) {
    throw new Error('alternate-clouds-cli repo not found. Set AF_CLI_REPO or clone it as a sibling.');
  }
  let en = {};
  try {
    en = JSON.parse(readFileSync(join(cliRepo, 'locales/en.json'), 'utf8'));
  } catch {
    /* no locales file: t() descriptions stay empty */
  }
  const pkg = JSON.parse(readFileSync(join(cliRepo, 'package.json'), 'utf8'));
  const cliTs = readFileSync(join(cliRepo, 'src/cli.ts'), 'utf8');

  const root = { name: 'acc', signature: 'acc', options: parseRootOptions(cliTs), parent: null, children: [], file: 'cli.ts' };

  // Commands registered directly in cli.ts (login/logout/whoami). `help` and
  // `version` are Commander built-ins re-registered for styling.
  for (const reg of parseRegistrations(cliTs, 'cli.ts', en)) {
    if (['help', 'version'].includes(reg.signature.split(' ')[0])) continue;
    makeNode(reg, root);
  }

  // Command groups: one directory per group. index.ts first so the group node
  // exists before sibling files that may register onto it.
  const commandsDir = join(cliRepo, 'src/commands');
  const byDir = new Map();
  for (const file of findCommandFiles(commandsDir)) {
    const rel = file.slice(commandsDir.length + 1);
    const topDir = rel.includes('/') ? rel.split('/')[0] : rel.replace(/\.ts$/, '');
    // src/commands/auth/index.ts is an unregistered legacy module (login/logout
    // are wired directly in cli.ts) — skip it so dead commands don't get documented.
    if (topDir === 'auth') continue;
    if (!byDir.has(topDir)) byDir.set(topDir, []);
    byDir.get(topDir).push({ file, rel });
  }
  for (const [dir, files] of byDir) {
    files.sort((a, b) => (a.rel.endsWith('/index.ts') ? -1 : b.rel.endsWith('/index.ts') ? 1 : a.rel.localeCompare(b.rel)));
    for (const { file, rel } of files) {
      const vars = new Map(); // variable name → node, per file
      const regs = parseRegistrations(readFileSync(file, 'utf8'), rel, en);
      let previous = null;
      for (const reg of regs) {
        let parent;
        if (reg.receiver === 'program') parent = root;
        else if (reg.receiver && vars.has(reg.receiver)) parent = vars.get(reg.receiver);
        else if (reg.receiver === '__chain__' && previous) parent = previous;
        else parent = root.children.find((c) => c.name === dir) ?? root;
        const node = makeNode(reg, parent);
        if (reg.assigned) vars.set(reg.assigned, node);
        previous = node;
      }
    }
  }

  // Depth-first flat list; the same display registered twice keeps the first.
  const commands = [];
  const seen = new Set();
  const walk = (node) => {
    for (const child of node.children) {
      const display = displayOf(child);
      if (!seen.has(display)) {
        seen.add(display);
        commands.push(child);
      }
      walk(child);
    }
  };
  walk(root);

  return { cliRepo, pkg, root, commands };
}
