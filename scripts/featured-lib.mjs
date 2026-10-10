// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers of the featured-repository generator (scripts/build-featured.mjs), kept apart so vitest can test them:
 * config validation, privacy scrubbing and the index entry. No I/O here.
 */

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

/** `<owner>__<repo>.json`, lower-cased (the app derives the same name). */
export function featuredFileName(repo) {
  const m = REPO_RE.exec(repo);
  if (!m) throw new Error(`invalid repo "${repo}"`);
  return `${m[1]}__${m[2]}.json`.toLowerCase();
}

/** Validate the parsed featured.config.json. Returns normalized entries, throws an Error with every problem listed. */
export function validateConfig(cfg) {
  const problems = [];
  if (typeof cfg !== 'object' || cfg === null || !Array.isArray(cfg.repos)) throw new Error('config: expected { "repos": [...] }');
  const seen = new Set();
  const out = [];
  cfg.repos.forEach((r, i) => {
    const w = `repos[${i}]`;
    if (typeof r !== 'object' || r === null) return problems.push(`${w}: expected object`);
    const repo = typeof r.repo === 'string' ? r.repo.trim() : '';
    if (!REPO_RE.test(repo) || repo.endsWith('.git') || repo.includes('..')) return problems.push(`${w}.repo: expected "owner/name"`);
    const branch = typeof r.branch === 'string' ? r.branch.trim() : '';
    if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.startsWith('-')) problems.push(`${w}.branch: required, a plain branch name`);
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : repo.split('/')[1];
    if (name.length > 60) problems.push(`${w}.name: too long`);
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 200)) problems.push(`${w}.note: expected a string up to 200 characters`);
    const key = repo.toLowerCase();
    if (seen.has(key)) problems.push(`${w}: duplicate ${repo}`);
    seen.add(key);
    const authorMap = r.authorMap && typeof r.authorMap === 'object' ? { ...r.authorMap } : undefined;
    out.push({ repo, name, branch, ...(r.note ? { note: r.note } : {}), ...(authorMap ? { authorMap } : {}) });
  });
  if (out.length === 0 && problems.length === 0) problems.push('config: no repos');
  if (problems.length) throw new Error(`featured config invalid:\n  ${problems.join('\n  ')}`);
  return out;
}

/** Throws unless `gh repo view --json visibility` said PUBLIC. */
export function assertPublic(visibility, repo) {
  if (String(visibility).toUpperCase() !== 'PUBLIC') throw new Error(`${repo} is not public (visibility: ${visibility}); refusing to publish its history`);
}

/**
 * Privacy scrub for data that ships on a public site. Emails are blanked (the app keys author colour on the NAME only; see
 * src/model/rng.ts authorHue). `authorMap` may rename an author. Returns new objects; the input is untouched.
 */
export function scrubCommits(commits, authorMap = {}) {
  return commits.map((c) => ({
    hash: c.hash,
    author: Object.prototype.hasOwnProperty.call(authorMap, c.author) ? String(authorMap[c.author]) : c.author,
    email: '',
    date: c.date,
    message: c.message,
    files: c.files,
  }));
}

/** Refuse output that contains something that must never ship: tokens, or any of the given local path fragments. */
export function assertClean(json, localPaths = []) {
  const tok = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})/.exec(json);
  if (tok) throw new Error('output contains something that looks like a GitHub token');
  for (const p of localPaths) if (p && p.length > 3 && json.includes(p)) throw new Error(`output contains a local path (${p})`);
  if (/"email":"[^"]/.test(json)) throw new Error('output contains a non-empty email');
}

export function authorNames(commits) {
  const m = new Map();
  for (const c of commits) m.set(c.author, (m.get(c.author) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, commits]) => ({ name, commits }));
}

/** One entry of public/featured/index.json. */
export function indexEntry(entry, commits, o) {
  const paths = new Set();
  for (const c of commits) for (const f of c.files) paths.add(f.path);
  return {
    repo: entry.repo,
    name: entry.name,
    ...(entry.note ? { note: entry.note } : {}),
    branch: entry.branch,
    file: featuredFileName(entry.repo),
    commits: commits.length,
    files: paths.size,
    first: commits[0]?.date ?? null,
    last: commits[commits.length - 1]?.date ?? null,
    head: o.head,
    generatedAt: o.generatedAt,
    bytes: o.bytes,
  };
}

/**
 * Keep `generatedAt` stable while nothing changed: a fresh index entry that describes the same head, commit count and byte size as the
 * previous run reuses the previous timestamp, so the weekly workflow produces no diff (and no commit) unless the repository moved.
 */
export function stableEntry(entry, previous) {
  if (previous && previous.head === entry.head && previous.commits === entry.commits && previous.bytes === entry.bytes && previous.generatedAt) {
    return { ...entry, generatedAt: previous.generatedAt };
  }
  return entry;
}
