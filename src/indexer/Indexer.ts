import {
    GraphConfig,
    ContextGraph,
    GraphNode,
    IndexingError,
    IndexingReport,
    ICancellationToken,
    IProgress
} from '../types';
import { FileScanner } from './FileScanner';
import { FileHasher } from '../utils/FileHasher';

export interface IndexerDependencies {
    fileScanner: FileScanner;
    buildGraphNode: (filePath: string, config: GraphConfig) => Promise<GraphNode>;
    buildCompleteCallGraph: (graph: ContextGraph) => Promise<void>;
}

export class Indexer {
    private fileScanner: FileScanner;
    private buildGraphNode: (filePath: string, config: GraphConfig) => Promise<GraphNode>;
    private buildCompleteCallGraph: (graph: ContextGraph) => Promise<void>;

    constructor(dependencies: IndexerDependencies) {
        this.fileScanner = dependencies.fileScanner;
        this.buildGraphNode = dependencies.buildGraphNode;
        this.buildCompleteCallGraph = dependencies.buildCompleteCallGraph;
    }

    async generateIndex(
        workspacePath: string,
        config: GraphConfig,
        progress?: IProgress,
        cancellationToken?: ICancellationToken
    ): Promise<{ graph: ContextGraph; report: IndexingReport; fileHashes: Map<string, string> }> {
        const startTime = Date.now();
        const errors: IndexingError[] = [];
        let successfulFiles = 0;
        let skippedFiles = 0;

        progress?.report('🔍 Scanning for code files...');

        const allFiles = await this.fileScanner.findCodeFiles(workspacePath, cancellationToken);
        progress?.report(`Found ${allFiles.length} files to index`);

        const contextGraph: ContextGraph = {
            generated: new Date().toISOString(),
            anchor: workspacePath,
            config: config,
            nodes: [],
            callGraph: []
        };

        const fileHashes = new Map<string, string>();
        const visited = new Set<string>();

        // Process files in batches
        const batches = [];
        for (let i = 0; i < allFiles.length; i += config.batchSize) {
            batches.push(allFiles.slice(i, i + config.batchSize));
        }

        let totalProcessed = 0;

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            // Check cancellation
            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Indexing cancelled by user');
            }

            const batch = batches[batchIndex];
            
            for (const filePath of batch) {
                if (cancellationToken?.isCancellationRequested) {
                    throw new Error('Indexing cancelled by user');
                }

                try {
                    if (visited.has(filePath)) {
                        continue;
                    }

                    const fs = await import('fs');
                    const stats = fs.statSync(filePath);
                    
                    if (stats.size > config.maxFileSize) {
                        skippedFiles++;
                        errors.push({
                            file: filePath,
                            error: `File too large: ${(stats.size / 1024).toFixed(1)}KB`,
                            timestamp: new Date().toISOString(),
                            phase: 'scanning'
                        });
                        continue;
                    }

                    const fileHash = await FileHasher.calculateHash(filePath);
                    fileHashes.set(filePath, fileHash);

                    const node = await this.buildGraphNode(filePath, config);
                    contextGraph.nodes.push(node);
                    visited.add(filePath);
                    successfulFiles++;
                    totalProcessed++;

                } catch (error) {
                    errors.push({
                        file: filePath,
                        error: error instanceof Error ? error.message : String(error),
                        timestamp: new Date().toISOString(),
                        phase: 'parsing'
                    });
                }
            }

            progress?.report(`Indexed ${totalProcessed}/${allFiles.length} files...`);

            // Force GC hint
            if (global.gc && batchIndex % 5 === 0) {
                global.gc();
            }
        }

        // Check cancellation before call graph
        if (cancellationToken?.isCancellationRequested) {
            throw new Error('Indexing cancelled by user');
        }

        progress?.report('Building call graph...');
        await this.buildCompleteCallGraph(contextGraph);

        const report: IndexingReport = {
            totalFiles: allFiles.length,
            successfulFiles,
            skippedFiles,
            errors,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };

        return { graph: contextGraph, report, fileHashes };
    }
}
