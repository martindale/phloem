// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../src/model/events';
export interface FeaturedConfigEntry { repo: string; name: string; branch: string; note?: string; authorMap?: Record<string, string> }
export interface FeaturedIndexEntry { repo: string; name: string; note?: string; branch: string; file: string; commits: number; files: number; first: string | null; last: string | null; head: string; generatedAt: string; bytes: number }
export function featuredFileName(repo: string): string;
export function validateConfig(cfg: unknown): FeaturedConfigEntry[];
export function assertPublic(visibility: unknown, repo: string): void;
export function scrubCommits(commits: CommitEvent[], authorMap?: Record<string, string>): CommitEvent[];
export function assertClean(json: string, localPaths?: string[]): void;
export function authorNames(commits: CommitEvent[]): Array<{ name: string; commits: number }>;
export function indexEntry(entry: FeaturedConfigEntry, commits: CommitEvent[], o: { head: string; generatedAt: string; bytes: number }): FeaturedIndexEntry;
export function stableEntry(entry: FeaturedIndexEntry, previous: FeaturedIndexEntry | undefined): FeaturedIndexEntry;
