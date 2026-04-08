export class FileOwnershipRegistry {
  private readonly owners = new Map<string, string>();
  private readonly claimsByWorker = new Map<string, Set<string>>();

  claim(workerId: string, filePath: string): boolean {
    const currentOwner = this.owners.get(filePath);
    if (currentOwner && currentOwner !== workerId) {
      return false;
    }

    this.owners.set(filePath, workerId);
    let claims = this.claimsByWorker.get(workerId);
    if (!claims) {
      claims = new Set<string>();
      this.claimsByWorker.set(workerId, claims);
    }
    claims.add(filePath);
    return true;
  }

  claimAll(workerId: string, filePaths: readonly string[]): boolean {
    const normalizedPaths = [...new Set(filePaths)].sort();
    if (
      normalizedPaths.some((filePath) => {
        const currentOwner = this.owners.get(filePath);
        return currentOwner !== undefined && currentOwner !== workerId;
      })
    ) {
      return false;
    }

    for (const filePath of normalizedPaths) {
      this.claim(workerId, filePath);
    }
    return true;
  }

  release(workerId: string, filePath: string): void {
    if (this.owners.get(filePath) !== workerId) {
      return;
    }

    this.owners.delete(filePath);
    const claims = this.claimsByWorker.get(workerId);
    claims?.delete(filePath);
    if (claims && claims.size === 0) {
      this.claimsByWorker.delete(workerId);
    }
  }

  releaseAll(workerId: string): void {
    const claims = this.claimsByWorker.get(workerId);
    if (!claims) {
      return;
    }

    for (const filePath of claims) {
      if (this.owners.get(filePath) === workerId) {
        this.owners.delete(filePath);
      }
    }
    this.claimsByWorker.delete(workerId);
  }
}
