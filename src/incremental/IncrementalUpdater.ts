import { GraphNode, ICancellationToken, ContextGraph, GraphConfig } from '../types';
import { FileHasher } from '../utils/FileHasher';
import * as fs from 'fs';

export class IncrementalUpdater {
    private fileHashes: Map<string, string>;
    private buildGraphNode: (filePath: string, config: GraphConfig) => Promise<GraphNode>;
    private buildCompleteCallGraph: (graph: ContextGraph) => Promise<void>;

    constructor(
        initialHashes: Map<string, string>,
        buildGraphNode: (filePath: string, config: GraphConfig) => Promise<GraphNode>,
        buildCompleteCallGraph: (graph: ContextGraph) => Promise<void>
    ) {
        this.fileHashes = initialHashes;
        this.buildGraphNode = buildGraphNode;
        this.buildCompleteCallGraph = buildCompleteCallGraph;
    }

    async detectChangedFiles(
        filePaths: string[],
        cancellationToken?: ICancellationToken
    ): Promise<{ modified: string[]; deleted: string[]; added: string[] }> {
        const modified: string[] = [];
        const deleted: string[] = [];
        const added: string[] = [];
        const checkedPaths = new Set<string>();

        for (const filePath of filePaths) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }

            checkedPaths.add(filePath);

            try {
                if (!fs.existsSync(filePath)) {
                    // File was deleted
                    if (this.fileHashes.has(filePath)) {
                        deleted.push(filePath);
                    }
                    continue;
                }

                const newHash = await FileHasher.calculateHash(filePath);
                const oldHash = this.fileHashes.get(filePath);

                if (oldHash === undefined) {
                    // New file
                    added.push(filePath);
                } else if (oldHash !== newHash) {
                    // Modified file
                    modified.push(filePath);
                }
            } catch (error) {
                console.error(`Error checking file ${filePath}:`, error);
            }
        }

        // Check for deleted files that weren't in the current scan
        for (const [oldPath] of this.fileHashes) {
            if (!checkedPaths.has(oldPath) && !fs.existsSync(oldPath)) {
                deleted.push(oldPath);
            }
        }

        return { modified, deleted, added };
    }

    async updateGraph(
        graph: ContextGraph,
        changedFiles: { modified: string[]; deleted: string[]; added: string[] },
        config: GraphConfig,
        cancellationToken?: ICancellationToken
    ): Promise<{ updatedGraph: ContextGraph; errors: Array<{ file: string; error: string }> }> {
        const errors: Array<{ file: string; error: string }> = [];
        const updatedGraph = { ...graph };
        const affectedFiles = new Set<string>([...changedFiles.modified, ...changedFiles.deleted, ...changedFiles.added]);

        // Remove nodes for deleted and modified files
        const filesToRemove = [...changedFiles.deleted, ...changedFiles.modified];
        updatedGraph.nodes = updatedGraph.nodes.filter(node => !filesToRemove.includes(node.filePath));

        // Remove from hashes
        for (const deletedFile of changedFiles.deleted) {
            this.fileHashes.delete(deletedFile);
        }

        // Re-parse modified and added files
        const filesToParse = [...changedFiles.modified, ...changedFiles.added];
        
        for (const filePath of filesToParse) {
            if (cancellationToken?.isCancellationRequested) {
                break;
            }

            try {
                // Check file size
                const stats = fs.statSync(filePath);
                if (stats.size > config.maxFileSize) {
                    errors.push({
                        file: filePath,
                        error: `File too large: ${(stats.size / 1024).toFixed(1)}KB`
                    });
                    continue;
                }

                // Re-parse and build new node
                const newNode = await this.buildGraphNode(filePath, config);
                updatedGraph.nodes.push(newNode);

                // Update hash
                const newHash = await FileHasher.calculateHash(filePath);
                this.fileHashes.set(filePath, newHash);

            } catch (error) {
                errors.push({
                    file: filePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        // Rebuild call graph only for affected files
        try {
            // For now, rebuild entire call graph (can be optimized later)
            await this.buildCompleteCallGraph(updatedGraph);
        } catch (error) {
            console.error('Error rebuilding call graph:', error);
        }

        updatedGraph.generated = new Date().toISOString();

        return { updatedGraph, errors };
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
