/**
 * Classifier (Reckon v5). Decides whether a diff is EXPLANATION-WORTHY — significant
 * enough that the human should be able to explain what shipped. Same quiet heuristic
 * as v2 (keep the interrupt rate low): a new dependency, or a substantial change.
 * The fork-specific "kind" inference is gone — v5 doesn't fork, it grades explanations.
 */

export interface ClassificationResult {
  shouldCheckpoint: boolean;
  trigger?: 'new_import' | 'large_change';
  concept?: string;
  subsystem?: string;
}

export class Classifier {
  private readonly LARGE_CHANGE_THRESHOLD = 40;

  classify(diff: string, _context: string, filePath: string): ClassificationResult {
    const lines = diff.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

    const hasNewImport = this.detectNewImport(diff);
    const isLargeChange = added + removed > this.LARGE_CHANGE_THRESHOLD;

    if (!hasNewImport && !isLargeChange) return { shouldCheckpoint: false };

    const subsystem = this.extractSubsystem(filePath);
    return hasNewImport
      ? { shouldCheckpoint: true, trigger: 'new_import', concept: `dependency-${this.extractImportName(diff)}`, subsystem }
      : { shouldCheckpoint: true, trigger: 'large_change', concept: `change-${subsystem}`, subsystem };
  }

  private detectNewImport(diff: string): boolean {
    return [
      /^\+\s*import\s+/m,
      /^\+\s*from\s+['"][\w@/-]+['"]\s+import/m,
      /^\+\s*const\s+\w+\s*=\s*require\(/m,
      /^\+\s*require\(/m,
      /^\+\s*use\s+/m,
    ].some((p) => p.test(diff));
  }

  private extractImportName(diff: string): string {
    const m = diff.match(/^\+\s*(?:import\s+.*?from\s+['"]([^'"]+)|const\s+\w+\s*=\s*require\(['"]([^'"]+))/m);
    if (m) {
      const name = m[1] || m[2];
      return name.split('/').pop() || name;
    }
    return 'unknown';
  }

  private extractSubsystem(filePath: string): string {
    const parts = filePath.split('/').filter((p) => !p.startsWith('.') && !['src', 'lib', 'test', 'tests'].includes(p) && !p.includes('.'));
    return parts[parts.length - 1] || 'root';
  }
}
