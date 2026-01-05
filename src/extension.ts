/**
 * LogicGraph Extension - Modular Architecture
 * Main entry point with minimal VSCode coupling
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Import types
import type {
    GraphConfig,
    ContextGraph,
    IndexingReport,
    GraphNode,
    QuickIndex,
    SearchIndex
} from './types';

// Import core modules
import { Indexer } from './indexer/Indexer';
import { FileScanner } from './indexer/FileScanner';
import { SecuritySanitizer } from './security/SecuritySanitizer';
import { FuzzySearcher } from './search/FuzzySearcher';
import { QueryAnalyzer } from './search/QueryAnalyzer';
import { IncrementalUpdater } from './incremental/IncrementalUpdater';
import { FileHasher } from './utils/FileHasher';

// Import adapters
import {
    VSCodeProgressAdapter,
    VSCodeCancellationTokenAdapter
} from './adapters/VSCodeAdapter';

// Import Copilot-like intelligence orchestrator
import { CopilotIntelligenceOrchestrator } from './orchestrator/CopilotIntelligenceOrchestrator';

// Import VSCode-specific functions (these will remain in extension.ts)
import {
    buildGraphNodeVSCode,
    buildCompleteCallGraphVSCode,
    generateQuickIndex,
    generateSearchIndex,
    showIndexingReportWebview
} from './vscode/VSCodeHelpers';

// Global state
interface ExtensionState {
    contextGraph: ContextGraph | null;
    incrementalUpdater: IncrementalUpdater | null;
    lastIndexTime: number;
    indexingReport: IndexingReport | null;
    copilotOrchestrator: CopilotIntelligenceOrchestrator | null;
    copilotInitialized: boolean;
    outputChannel: vscode.OutputChannel;
    statusBarItem: vscode.StatusBarItem;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('LogicGraph extension activated!');

    // Create output channel for debugging
    const outputChannel = vscode.window.createOutputChannel('LogicGraph');
    outputChannel.appendLine('LogicGraph extension activated');
    
    // Create status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(search) LogicGraph';
    statusBarItem.tooltip = 'LogicGraph: Not Indexed';
    statusBarItem.show();

    const state: ExtensionState = {
        contextGraph: null,
        incrementalUpdater: null,
        lastIndexTime: 0,
        indexingReport: null,
        copilotOrchestrator: null,
        copilotInitialized: false,
        outputChannel,
        statusBarItem
    };

    // Initialize core modules
    const fileScanner = new FileScanner();
    const securitySanitizer = new SecuritySanitizer();
    const fuzzySearcher = new FuzzySearcher();
    const queryAnalyzer = new QueryAnalyzer();
    
    // Initialize Copilot orchestrator (lazy initialization)
    state.copilotOrchestrator = new CopilotIntelligenceOrchestrator();

    // Command: Generate full index
    const indexCommand = vscode.commands.registerCommand(
        'logicGraph.generateContextJSON',
        async () => {
            await generateIndexWithProgress(context, state, fileScanner, securitySanitizer);
        }
    );

    // Command: Query codebase
    const queryCommand = vscode.commands.registerCommand(
        'logicGraph.queryCodebase',
        async () => {
            await queryCodebase(state, fuzzySearcher, queryAnalyzer);
        }
    );

    // Command: Incremental update
    const incrementalCommand = vscode.commands.registerCommand(
        'logicGraph.incrementalUpdate',
        async () => {
            if (!state.incrementalUpdater) {
                vscode.window.showWarningMessage('No index found. Run full indexing first.');
                return;
            }
            await performIncrementalUpdate(state, fileScanner);
        }
    );

    // Command: View report
    const viewReportCommand = vscode.commands.registerCommand(
        'logicGraph.viewReport',
        async () => {
            if (!state.indexingReport) {
                vscode.window.showInformationMessage('No indexing report available.');
                return;
            }
            showIndexingReportWebview(state.indexingReport);
        }
    );

    // File watcher for auto-incremental updates
    setupFileWatcher(context, state);

    context.subscriptions.push(
        indexCommand,
        queryCommand,
        incrementalCommand,
        viewReportCommand
    );
}

async function generateIndexWithProgress(
    context: vscode.ExtensionContext,
    state: ExtensionState,
    fileScanner: FileScanner,
    securitySanitizer: SecuritySanitizer
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found!');
        return;
    }

    // Use vscode.window.withProgress for cancellable progress
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Indexing Codebase',
            cancellable: true
        },
        async (progress, token) => {
            try {
                const config: GraphConfig = {
                    maxDepth: 1,
                    useSkeletonMode: true,
                    maxFileSize: 1024 * 100,
                    batchSize: 50,
                    streamingThreshold: 1024 * 50
                };

                const progressAdapter = new VSCodeProgressAdapter(progress);
                const cancellationAdapter = new VSCodeCancellationTokenAdapter(token);

                // Create indexer with dependencies
                const indexer = new Indexer({
                    fileScanner,
                    buildGraphNode: (filePath: string, config: GraphConfig) =>
                        buildGraphNodeVSCode(filePath, config),
                    buildCompleteCallGraph: (graph: ContextGraph) =>
                        buildCompleteCallGraphVSCode(graph)
                });

                // Generate index
                const result = await indexer.generateIndex(
                    workspaceFolder.uri.fsPath,
                    config,
                    progressAdapter,
                    cancellationAdapter
                );

                // Sanitize for security
                result.graph = securitySanitizer.sanitizeContextGraph(result.graph);

                // Store state
                state.contextGraph = result.graph;
                state.incrementalUpdater = new IncrementalUpdater(result.fileHashes);
                state.lastIndexTime = Date.now();
                state.indexingReport = result.report;

                // Save to disk
                await saveIndicesToDisk(workspaceFolder.uri.fsPath, result.graph, result.report);

                // Initialize Copilot orchestrator with new index
                if (state.copilotOrchestrator) {
                    vscode.window.showInformationMessage('🤖 Initializing Copilot intelligence...');
                    state.outputChannel.appendLine('Starting Copilot orchestrator initialization...');
                    try {
                        await state.copilotOrchestrator.initialize(workspaceFolder.uri.fsPath);
                        state.copilotInitialized = true;
                        state.statusBarItem.text = '$(sparkle) LogicGraph: Copilot Ready';
                        state.statusBarItem.tooltip = 'LogicGraph: Copilot Intelligence Active';
                        vscode.window.showInformationMessage('✨ Copilot intelligence ready!');
                        state.outputChannel.appendLine('✅ Copilot orchestrator initialized successfully');
                        
                        // Log stats
                        const stats = state.copilotOrchestrator.getStats();
                        state.outputChannel.appendLine(`  - BM25: ${JSON.stringify(stats.bm25)}`);
                        state.outputChannel.appendLine(`  - Semantic: ${JSON.stringify(stats.semantic)}`);
                        state.outputChannel.appendLine(`  - Graph: ${JSON.stringify(stats.graph)}`);
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                        console.warn('Copilot initialization failed:', error);
                        state.outputChannel.appendLine(`❌ Copilot initialization failed: ${errorMsg}`);
                        if (error instanceof Error && error.stack) {
                            state.outputChannel.appendLine(error.stack);
                        }
                        state.copilotInitialized = false;
                        state.statusBarItem.text = '$(search) LogicGraph: Basic';
                        state.statusBarItem.tooltip = 'LogicGraph: Using Basic Search (Copilot initialization failed)';
                        vscode.window.showWarningMessage(`Copilot initialization failed: ${errorMsg}. Using basic search.`);
                    }
                } else {
                    state.statusBarItem.text = '$(search) LogicGraph: Indexed';
                    state.statusBarItem.tooltip = 'LogicGraph: Indexed (Basic search only)';
                }

                // Show results
                const successRate = ((result.report.successfulFiles / result.report.totalFiles) * 100).toFixed(1);
                vscode.window.showInformationMessage(
                    `✅ Indexed ${result.report.successfulFiles}/${result.report.totalFiles} files (${successRate}%) ` +
                    `in ${result.report.duration}ms ⚠️ Errors: ${result.report.errors.length}`
                );

                if (result.report.errors.length > 0) {
                    vscode.window.showWarningMessage(
                        `Indexing completed with ${result.report.errors.length} error(s). Use "View Report" to see details.`
                    );
                }

            } catch (error) {
                if (error instanceof Error && error.message.includes('cancelled')) {
                    vscode.window.showInformationMessage('Indexing cancelled');
                } else {
                    vscode.window.showErrorMessage(
                        `Indexing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
                    );
                }
            }
        }
    );
}

async function saveIndicesToDisk(
    workspacePath: string,
    graph: ContextGraph,
    report: IndexingReport
): Promise<void> {
    // Generate indices
    const quickIndex = generateQuickIndex(graph, workspacePath);
    const searchIndex = generateSearchIndex(graph, workspacePath);

    // Save files
    const quickPath = path.join(workspacePath, 'quick_index.json');
    const searchPath = path.join(workspacePath, 'search_index.json');
    const contextGraphPath = path.join(workspacePath, 'context-graph.json');
    const reportDir = path.join(workspacePath, '.logicgraph');

    fs.mkdirSync(reportDir, { recursive: true });

    fs.writeFileSync(quickPath, JSON.stringify(quickIndex, null, 2), 'utf8');
    fs.writeFileSync(searchPath, JSON.stringify(searchIndex, null, 2), 'utf8');
    fs.writeFileSync(contextGraphPath, JSON.stringify(graph, null, 2), 'utf8');

    const reportPath = path.join(reportDir, 'indexing-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

async function queryCodebase(
    state: ExtensionState,
    fuzzySearcher: FuzzySearcher,
    queryAnalyzer: QueryAnalyzer
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found!');
        return;
    }

    // Check indices exist
    const searchPath = path.join(workspaceFolder.uri.fsPath, 'search_index.json');
    if (!fs.existsSync(searchPath)) {
        vscode.window.showWarningMessage('Index not found. Please run "Generate Index" first.');
        return;
    }

    // Get query
    const query = await vscode.window.showInputBox({
        prompt: 'What do you want to know about the codebase?',
        placeHolder: 'e.g., Find authentication logic, Show database queries, What calls loginUser?'
    });

    if (!query) {
        return;
    }

    state.outputChannel.appendLine(`\n🔍 Query: "${query}"`);
    
    try {
        // Try to use Copilot orchestrator if initialized
        if (state.copilotOrchestrator && state.copilotInitialized) {
            vscode.window.showInformationMessage('🤖 Searching with Copilot intelligence...');
            state.outputChannel.appendLine('Using Copilot Intelligence Orchestrator');
            const contextAssembly = await state.copilotOrchestrator.queryWithFallback(query, 20);
            state.outputChannel.appendLine(`Found ${contextAssembly.totalResults} results in ${contextAssembly.processingTime}ms`);
            
            // Show enhanced results in a new document
            const doc = await vscode.workspace.openTextDocument({
                content: formatEnhancedSearchResults(contextAssembly),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc);
            
        } else {
            // Fallback to existing fuzzy search
            vscode.window.showInformationMessage('🔍 Searching (basic mode)...');
            state.outputChannel.appendLine(`Using basic fuzzy search (Copilot ${state.copilotOrchestrator ? 'not initialized' : 'not available'})`);
            const searchIndex = JSON.parse(fs.readFileSync(searchPath, 'utf8'));
            const results = await fuzzySearcher.search(query, searchIndex);
            state.outputChannel.appendLine(`Found ${results.length} results`);
            
            // Show results in a new document
            const doc = await vscode.workspace.openTextDocument({
                content: formatSearchResults(query, results),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc);
        }

    } catch (error) {
        vscode.window.showErrorMessage(
            `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

function formatSearchResults(query: string, results: any[]): string {
    let output = `# Search Results for: "${query}"\n\n`;
    output += `Found ${results.length} relevant symbols\n\n`;

    for (const result of results) {
        output += `## \`${result.symbol}\` (${result.type})\n`;
        output += `- **File**: ${result.file}:${result.line}\n`;
        output += `- **Signature**: \`${result.signature}\`\n\n`;
    }

    return output;
}

function formatEnhancedSearchResults(contextAssembly: any): string {
    let output = `# 🤖 Copilot Intelligence Search Results\n\n`;
    output += `**Query**: "${contextAssembly.query}"\n`;
    output += `**Intent**: ${contextAssembly.intent}\n`;
    output += `**Processing Time**: ${contextAssembly.processingTime}ms\n`;
    output += `**Results**: ${contextAssembly.totalResults}\n\n`;
    output += `---\n\n`;

    for (let i = 0; i < contextAssembly.results.length; i++) {
        const result = contextAssembly.results[i];
        output += `### ${i + 1}. ${result.symbol} (${result.type})\n\n`;
        output += `- **File**: [${result.file}:${result.line}](${result.file}#L${result.line})\n`;
        output += `- **Relevance Score**: ${(result.relevanceScore * 100).toFixed(1)}%\n\n`;
        
        // Explanation section
        output += `**Relevance Breakdown**:\n`;
        output += `- Lexical Match (BM25): ${(result.explanation.lexicalScore * 100).toFixed(1)}%\n`;
        output += `- Semantic Similarity: ${(result.explanation.semanticScore * 100).toFixed(1)}%\n`;
        output += `- Graph Relevance: ${(result.explanation.graphScore * 100).toFixed(1)}%\n\n`;
        
        if (result.explanation.matchedTerms.length > 0) {
            output += `**Matched Query Terms**: ${result.explanation.matchedTerms.join(', ')}\n\n`;
        }
        
        if (result.explanation.graphRelationships.length > 0) {
            output += `**Call Graph Relationships**:\n`;
            for (const rel of result.explanation.graphRelationships) {
                output += `- \`${rel}\`\n`;
            }
            output += `\n`;
        }
    }

    output += `\n---\n\n`;
    output += `*Powered by Tree-sitter, BM25, Semantic Embeddings, and Graph-Aware Ranking*\n`;

    return output;
}

async function performIncrementalUpdate(
    state: ExtensionState,
    fileScanner: FileScanner
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !state.incrementalUpdater) {
        return;
    }

    vscode.window.showInformationMessage('🔄 Checking for changes...');

    const allFiles = await fileScanner.findCodeFiles(workspaceFolder.uri.fsPath);
    const changedFiles = await state.incrementalUpdater.detectChangedFiles(allFiles);

    vscode.window.showInformationMessage(
        `✅ Found ${changedFiles.length} changed file(s). Use full reindex for now.`
    );
}

function setupFileWatcher(context: vscode.ExtensionContext, state: ExtensionState): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
            workspaceFolder,
            '**/*.{ts,tsx,js,jsx,py,java,go,rs,c,cpp}'
        )
    );

    watcher.onDidChange((uri) => {
        if (state.contextGraph) {
            console.log('File changed:', uri.fsPath);
            // Incremental update logic here
        }
    });

    watcher.onDidCreate((uri) => {
        if (state.contextGraph) {
            console.log('File created:', uri.fsPath);
        }
    });

    watcher.onDidDelete((uri) => {
        if (state.contextGraph) {
            console.log('File deleted:', uri.fsPath);
            state.incrementalUpdater?.removeFile(uri.fsPath);
        }
    });

    context.subscriptions.push(watcher);
}

export function deactivate() {
    console.log('LogicGraph extension deactivated');
}
