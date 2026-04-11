/**
 * Protocol contract between the daemon's worker loop and a running agent.
 *
 * Phase 1 establishes the shape; the full protocol lands in Phase 2 once
 * real personalities are ported. The daemon writes task files and watches
 * for completion markers; this module documents the file format so the
 * full agent port can honor it.
 */

export interface TaskFileFrontmatter {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export interface CompletionMarker {
  result?: string;
  completedAt?: string;
  artifacts?: string[];
}
