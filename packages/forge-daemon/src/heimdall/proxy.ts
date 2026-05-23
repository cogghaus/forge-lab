import path from 'node:path';

export interface HeimdallOperation {
  type: 'read' | 'write' | 'execute';
  path?: string;
  content?: string;
}

export interface HeimdallDecision {
  allow: boolean;
  reason?: string;
}

export interface HeimdallPolicy {
  /** Absolute directory roots that agents are permitted to access. */
  allowedPaths: string[];
}

/**
 * Returns a policy that restricts agent file access to the given workdir tree.
 */
export function createPolicy(workdir: string): HeimdallPolicy {
  return { allowedPaths: [workdir] };
}

/**
 * Checks whether an operation is permitted by the policy.
 * With no policy (pass-through mode), all operations are allowed.
 * Path traversal sequences are resolved before comparison.
 */
export function checkOperation(op: HeimdallOperation, policy?: HeimdallPolicy): HeimdallDecision {
  if (!policy) return { allow: true };
  if (op.path === undefined) return { allow: true };

  const resolved = path.resolve(op.path);
  const allowed = policy.allowedPaths.some((root) => {
    const resolvedRoot = path.resolve(root);
    return (
      resolved === resolvedRoot ||
      resolved.startsWith(resolvedRoot + path.sep)
    );
  });

  if (!allowed) {
    return { allow: false, reason: `path outside allowed roots: ${op.path}` };
  }
  return { allow: true };
}
