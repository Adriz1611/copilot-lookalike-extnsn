import { GraphNode, ICancellationToken } from '../types';
import { FileHasher } from '../utils/FileHasher';

export class IncrementalUpdater {
    private fileHashes: Map<string, string>;

    constructor(initialHashes: Map<string, string>) {
        this.fileHashes = initialHashes;
    }

    async detectChangedFiles(
        filePaths: string[],
        cancellationToken?: ICancellationToken
    ): Promise<string[]> {
        const changedFiles: string[] = [];

        for (const filePath of filePaths) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }

            try {
                const newHash = await FileHasher.calculateHash(filePath);
                const oldHash = this.fileHashes.get(filePath);

                if (oldHash !== newHash) {
                    changedFiles.push(filePath);
                }
            } catch (error) {
                console.error(`Error checking file ${filePath}:`, error);
            }
        }

        return changedFiles;
    }

    updateHash(filePath: string, hash: string): void {
        this.fileHashes.set(filePath, hash);
    }

    removeFile(filePath: string): void {
        this.fileHashes.delete(filePath);
    }

    getFileHashes(): Map<string, string> {
        return new Map(this.fileHashes);
    }
}
