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
        if (!Array.isArray(filePaths)) {
            throw new Error('filePaths must be an array');
        }

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
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`IncrementalUpdater: Error checking file ${filePath}: ${errorMsg}`);
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
        if (!graph || !graph.nodes) {
            throw new Error('Invalid context graph provided');
        }

        if (!changedFiles) {
            throw new Error('changedFiles must be provided');
        }

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
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error('IncrementalUpdater: Error rebuilding call graph:', errorMsg);
            // Add to errors but don't fail the entire update
            errors.push({
                file: '[call-graph]',
                error: `Call graph rebuild failed: ${errorMsg}`
            });
        }

        updatedGraph.generated = new Date().toISOString();

        return { updatedGraph, errors };
    }

    updateHash(filePath: string, hash: string): void {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Invalid file path provided');
        }
        if (!hash || typeof hash !== 'string') {
            throw new Error('Invalid hash provided');
        }
        this.fileHashes.set(filePath, hash);
    }

    removeFile(filePath: string): void {
        if (!filePath || typeof filePath !== 'string') {
            console.warn('IncrementalUpdater: Invalid file path provided to removeFile');
            return;
        }
        this.fileHashes.delete(filePath);
    }

    getFileHashes(): Map<string, string> {
        return new Map(this.fileHashes);
    }
}
