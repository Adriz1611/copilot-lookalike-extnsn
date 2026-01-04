import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as typescriptParse } from '@typescript-eslint/parser';
import { parse as babelParse } from '@babel/parser';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import ignore from 'ignore';
import Fuse from 'fuse.js';
import * as crypto from 'crypto';

interface GraphConfig {
    maxDepth: number;
    useSkeletonMode: boolean;
    maxFileSize: number;
    batchSize: number;
    streamingThreshold: number;
}

interface PathAliasConfig {
    aliases: { [alias: string]: string };
    baseUrl: string;
    nodeModulesPath: string;
}

interface BatchProcessingState {
    processed: number;
    total: number;
    currentBatch: GraphNode[];
}

interface GraphNode {
    filePath: string;
    language: string;
    depth: number;
    content?: string;
    symbols: SymbolNode[];
    imports: ImportNode[];
}

interface SymbolNode {
    name: string;
    kind: string;
    signature: string;
    fullCode?: string;
    docstring?: string;
    location: {
        line: number;
        character: number;
    };
    referencedBy: string[];
}

interface ImportNode {
    importPath: string;
    resolvedPath?: string;
    symbols: string[];
}

interface ContextGraph {
    generated: string;
    anchor: string;
    config: GraphConfig;
    nodes: GraphNode[];
    callGraph: CallEdge[];
}

interface QuickIndex {
    _description: string;
    generated: string;
    workspace: string;
    summary: {
        totalFiles: number;
        totalSymbols: number;
        languages: { [key: string]: number };
    };
    filesByDirectory: { [directory: string]: QuickFileEntry[] };
}

interface QuickFileEntry {
    path: string;
    language: string;
    symbols: string[];
}

interface SearchIndex {
    _description: string;
    generated: string;
    workspace: string;
    summary: {
        totalSymbols: number;
        totalImports: number;
        topFiles: { path: string; symbolCount: number }[];
    };
    symbolLocations: SymbolLocation[];
    importMap: ImportMapping[];
    fileMetadata: FileMetadata[];
}

interface SymbolLocation {
    symbol: string;
    type: string;  // "function", "class", "variable"
    file: string;
    line: number;
    signature: string;
}

interface ImportMapping {
    file: string;
    imports: { from: string; symbols: string[] }[];
}

interface FileMetadata {
    path: string;
    language: string;
    size: number;
    symbolCount: number;
}

interface CallEdge {
    from: string;
    to: string;
    symbol: string;
}

interface IndexingError {
    file: string;
    error: string;
    timestamp: string;
    phase: 'scanning' | 'parsing' | 'symbolExtraction' | 'importResolution';
}

interface IndexingReport {
    totalFiles: number;
    successfulFiles: number;
    skippedFiles: number;
    errors: IndexingError[];
    duration: number;
    timestamp: string;
}

interface FileHash {
    path: string;
    hash: string;
    lastIndexed: string;
}

interface IncrementalIndex {
    version: string;
    lastFullIndex: string;
    fileHashes: FileHash[];
}

interface QueryContext {
    query: string;
    intent: 'search' | 'definition' | 'references' | 'callGraph';
    entities: string[];
    filters: {
        fileTypes?: string[];
        directories?: string[];
    };
}

interface SecretPattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
}

export function activate(context: vscode.ExtensionContext) {
    console.log('copilot-extnsn is now active!');

    // Global state for incremental indexing
    const indexState = {
        contextGraph: null as ContextGraph | null,
        fileHashes: new Map<string, string>(),
        lastIndexTime: 0,
        indexingReport: null as IndexingReport | null
    };

    // Phase 1: Build static index
    const indexCommand = vscode.commands.registerCommand(
        'logicGraph.generateContextJSON',
        async () => {
            const report = await generateContextGraph(context, indexState);
            indexState.indexingReport = report;
            
            // Show detailed report
            if (report.errors.length > 0) {
                const errorCount = report.errors.length;
                vscode.window.showWarningMessage(
                    `Indexing completed with ${errorCount} error(s). Check output for details.`
                );
            }
        }
    );

    // Phase 2 & 3: Query with ripgrep and assemble context
    const queryCommand = vscode.commands.registerCommand(
        'logicGraph.queryCodebase',
        async () => {
            await queryCodebaseWithContext();
        }
    );

    // NEW: Incremental update command
    const incrementalUpdateCommand = vscode.commands.registerCommand(
        'logicGraph.incrementalUpdate',
        async () => {
            if (!indexState.contextGraph) {
                vscode.window.showWarningMessage('No index found. Run full indexing first.');
                return;
            }
            await performIncrementalUpdate(context, indexState);
        }
    );

    // NEW: View indexing report command
    const viewReportCommand = vscode.commands.registerCommand(
        'logicGraph.viewReport',
        async () => {
            if (!indexState.indexingReport) {
                vscode.window.showInformationMessage('No indexing report available yet.');
                return;
            }
            await showIndexingReport(indexState.indexingReport);
        }
    );

    // NEW: File system watcher for auto-incremental updates
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx,py,java,go,rs,c,cpp}')
        );

        watcher.onDidChange(async (uri) => {
            if (indexState.contextGraph) {
                console.log('File changed:', uri.fsPath);
                await updateSingleFile(uri, indexState, context);
            }
        });

        watcher.onDidCreate(async (uri) => {
            if (indexState.contextGraph) {
                console.log('File created:', uri.fsPath);
                await updateSingleFile(uri, indexState, context);
            }
        });

        watcher.onDidDelete((uri) => {
            if (indexState.contextGraph) {
                console.log('File deleted:', uri.fsPath);
                removeSingleFile(uri, indexState);
            }
        });

        context.subscriptions.push(watcher);
    }

    context.subscriptions.push(indexCommand, queryCommand, incrementalUpdateCommand, viewReportCommand);
}

async function generateContextGraph(
    context: vscode.ExtensionContext,
    indexState: any
): Promise<IndexingReport> {
    const startTime = Date.now();
    const errors: IndexingError[] = [];
    let successfulFiles = 0;
    let skippedFiles = 0;

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found!');
            throw new Error('No workspace folder');
        }

        vscode.window.showInformationMessage('🔍 Indexing entire codebase...');

        const config: GraphConfig = {
            maxDepth: 1,
            useSkeletonMode: true,
            maxFileSize: 1024 * 100,
            batchSize: 50,
            streamingThreshold: 1024 * 50
        };

        const contextGraph: ContextGraph = {
            generated: new Date().toISOString(),
            anchor: workspaceFolder.uri.fsPath,
            config: config,
            nodes: [],
            callGraph: []
        };

        const allFiles = await findAllCodeFiles(workspaceFolder);
        vscode.window.showInformationMessage('Found ' + allFiles.length + ' files to index...');

        const visited = new Set<string>();
        const fileHashes = new Map<string, string>();

        // Process files in batches
        const batches = [];
        for (let i = 0; i < allFiles.length; i += config.batchSize) {
            batches.push(allFiles.slice(i, i + config.batchSize));
        }

        let totalProcessed = 0;

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            
            for (const fileUri of batch) {
                const filePath = fileUri.fsPath;
                
                try {
                    if (visited.has(filePath)) {
                        continue;
                    }

                    const stats = fs.statSync(filePath);
                    if (stats.size > config.maxFileSize) {
                        skippedFiles++;
                        errors.push({
                            file: filePath,
                            error: `File too large: ${(stats.size / 1024).toFixed(1)}KB (max: ${config.maxFileSize / 1024}KB)`,
                            timestamp: new Date().toISOString(),
                            phase: 'scanning'
                        });
                        continue;
                    }

                    // Calculate file hash for incremental updates
                    const fileHash = await calculateFileHash(filePath);
                    fileHashes.set(filePath, fileHash);

                    // Use streaming for files above threshold
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const node = stats.size > config.streamingThreshold
                        ? await buildGraphNodeWithStreaming(document, 0, config)
                        : await buildGraphNode(document, 0, config);
                    
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
                    console.error('Error processing file:', filePath, error);
                }
            }

            // Update progress after each batch
            vscode.window.showInformationMessage(
                'Indexed ' + totalProcessed + '/' + allFiles.length + ' files...'
            );

            // Optional: Force garbage collection hint between batches
            if (global.gc && batchIndex % 5 === 0) {
                global.gc();
            }
        }

        await buildCompleteCallGraph(contextGraph);

        // Store in index state
        indexState.contextGraph = contextGraph;
        indexState.fileHashes = fileHashes;
        indexState.lastIndexTime = Date.now();

        // Save incremental index metadata
        const incrementalIndex: IncrementalIndex = {
            version: '1.0',
            lastFullIndex: new Date().toISOString(),
            fileHashes: Array.from(fileHashes.entries()).map(([path, hash]) => ({
                path,
                hash,
                lastIndexed: new Date().toISOString()
            }))
        };
        const incrementalPath = path.join(workspaceFolder.uri.fsPath, '.logicgraph', 'incremental.json');
        fs.mkdirSync(path.dirname(incrementalPath), { recursive: true });
        fs.writeFileSync(incrementalPath, JSON.stringify(incrementalIndex, null, 2), 'utf8');

        // Generate QUICK INDEX for LLM context (ultra-lightweight)
        const quickIndex = generateQuickIndex(contextGraph, workspaceFolder.uri.fsPath);
        const quickPath = path.join(workspaceFolder.uri.fsPath, 'quick_index.json');
        fs.writeFileSync(quickPath, JSON.stringify(quickIndex, null, 2), 'utf8');

        // Generate SEARCH INDEX for ripgrep integration (symbol lookups)
        const searchIndex = generateSearchIndex(contextGraph, workspaceFolder.uri.fsPath);
        const searchPath = path.join(workspaceFolder.uri.fsPath, 'search_index.json');
        fs.writeFileSync(searchPath, JSON.stringify(searchIndex, null, 2), 'utf8');

        // Generate error report
        const reportPath = path.join(workspaceFolder.uri.fsPath, '.logicgraph', 'indexing-report.json');
        const report: IndexingReport = {
            totalFiles: allFiles.length,
            successfulFiles,
            skippedFiles,
            errors,
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        const elapsed = Date.now() - startTime;
        const quickSizeKB = (fs.statSync(quickPath).size / 1024).toFixed(1);
        const searchSizeKB = (fs.statSync(searchPath).size / 1024).toFixed(1);
        
        const successRate = ((successfulFiles / allFiles.length) * 100).toFixed(1);
        vscode.window.showInformationMessage(
            `✅ Indexed ${successfulFiles}/${allFiles.length} files (${successRate}%) in ${elapsed}ms\n` +
            `📄 Quick: ${quickSizeKB}KB | 🔍 Search: ${searchSizeKB}KB | ⚠️ Errors: ${errors.length}`
        );

        return report;

    } catch (error) {
        const report: IndexingReport = {
            totalFiles: 0,
            successfulFiles,
            skippedFiles,
            errors: [...errors, {
                file: 'global',
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
                phase: 'scanning'
            }],
            duration: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };
        
        vscode.window.showErrorMessage(
            'Error: ' + (error instanceof Error ? error.message : 'Unknown error')
        );
        console.error('Context graph error:', error);
        
        return report;
    }
}

async function findAllCodeFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    const patterns = [
        '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
        '**/*.py', '**/*.java', '**/*.c', '**/*.cpp',
        '**/*.h', '**/*.hpp', '**/*.go', '**/*.rs',
        '**/*.cs', '**/*.php', '**/*.rb', '**/*.swift',
        '**/*.kt', '**/*.scala', '**/*.vue', '**/*.svelte'
    ];

    // Load .gitignore patterns
    const ig = await loadGitignorePatterns(workspaceFolder.uri.fsPath);

    // Base exclude patterns (always excluded)
    const baseExcludePattern = '{**/.git/**,**/node_modules/**}';

    const allFiles: vscode.Uri[] = [];

    for (const pattern of patterns) {
        const files = await vscode.workspace.findFiles(pattern, baseExcludePattern);
        allFiles.push(...files);
    }

    // Filter files using .gitignore patterns
    const workspacePath = workspaceFolder.uri.fsPath;
    const filteredFiles = allFiles.filter(fileUri => {
        const relativePath = path.relative(workspacePath, fileUri.fsPath);
        // Normalize path separators for cross-platform compatibility
        const normalizedPath = relativePath.split(path.sep).join('/');
        return !ig.ignores(normalizedPath);
    });

    const uniqueFiles = Array.from(new Set(filteredFiles.map(f => f.fsPath))).map(p => vscode.Uri.file(p));
    
    return uniqueFiles;
}

// Load and parse .gitignore files
async function loadGitignorePatterns(workspacePath: string): Promise<ReturnType<typeof ignore>> {
    const ig = ignore();

    // Default patterns to always ignore (even if not in .gitignore)
    ig.add([
        '.git',
        'node_modules',
        '.next',
        'dist',
        'build',
        'out',
        '.output',
        'coverage',
        '.nyc_output',
        'venv',
        '__pycache__',
        '*.pyc',
        'target',
        'bin',
        'obj',
        '.DS_Store',
        '*.log',
        '.vscode-test',
        '.idea'
    ]);

    // Read .gitignore from workspace root
    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            ig.add(gitignoreContent);
            console.log('Loaded .gitignore patterns from:', gitignorePath);
        } catch (error) {
            console.warn('Failed to read .gitignore:', error);
        }
    }

    // Also check for .gitignore files in common subdirectories
    const subGitignorePaths = [
        path.join(workspacePath, 'src', '.gitignore'),
        path.join(workspacePath, 'packages', '.gitignore')
    ];

    for (const subPath of subGitignorePaths) {
        if (fs.existsSync(subPath)) {
            try {
                const content = fs.readFileSync(subPath, 'utf8');
                ig.add(content);
                console.log('Loaded additional .gitignore from:', subPath);
            } catch (error) {
                console.warn('Failed to read .gitignore:', error);
            }
        }
    }

    return ig;
}

async function buildCompleteCallGraph(graph: ContextGraph): Promise<void> {
    const nodeMap = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
        nodeMap.set(node.filePath, node);
    }

    for (const node of graph.nodes) {
        for (const importNode of node.imports) {
            if (!importNode.resolvedPath) {
                continue;
            }

            const targetNode = nodeMap.get(importNode.resolvedPath);
            if (!targetNode) {
                continue;
            }

            for (const symbolName of importNode.symbols) {
                graph.callGraph.push({
                    from: node.filePath,
                    to: importNode.resolvedPath,
                    symbol: symbolName
                });

                const symbol = targetNode.symbols.find(s => s.name === symbolName || s.name.endsWith('.' + symbolName));
                if (symbol) {
                    symbol.referencedBy.push(node.filePath);
                }
            }
        }

        await resolveNodeFunctionCalls(node, graph, nodeMap);
    }
}

async function buildGraphNode(
    document: vscode.TextDocument,
    depth: number,
    config: GraphConfig
): Promise<GraphNode> {
    const node: GraphNode = {
        filePath: document.uri.fsPath,
        language: document.languageId,
        depth: depth,
        symbols: [],
        imports: []
    };

    // Only store full content for small files (< 50KB) to keep JSON manageable
    const fileSize = fs.statSync(document.uri.fsPath).size;
    if (fileSize < 1024 * 50 && !config.useSkeletonMode) {
        node.content = document.getText();
    }

    try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

        if (symbols) {
            node.symbols = await extractSymbolNodes(
                document,
                symbols,
                config.useSkeletonMode
            );
        }

        node.imports = await extractImports(document);

    } catch (error) {
        console.error('Error building node:', error);
    }

    return node;
}

// NEW: Build graph node with streaming (for large files)
async function buildGraphNodeWithStreaming(
    document: vscode.TextDocument,
    depth: number,
    config: GraphConfig
): Promise<GraphNode> {
    const node: GraphNode = {
        filePath: document.uri.fsPath,
        language: document.languageId,
        depth: depth,
        symbols: [],
        imports: []
    };

    // Never store full content for streamed files
    node.content = undefined;

    try {
        // Still use LSP for symbols (it's already optimized)
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

        if (symbols) {
            node.symbols = await extractSymbolNodes(
                document,
                symbols,
                true  // Always use skeleton mode for streaming
            );
        }

        // Extract imports with streaming
        node.imports = await extractImportsWithStreaming(document.uri);

    } catch (error) {
        console.error('Error building node with streaming:', error);
    }

    return node;
}

// NEW: Extract imports with streaming for large files
async function extractImportsWithStreaming(fileUri: vscode.Uri): Promise<ImportNode[]> {
    return new Promise((resolve, reject) => {
        const imports: ImportNode[] = [];
        const readStream = createReadStream(fileUri.fsPath);
        const rl = createInterface({
            input: readStream,
            crlfDelay: Infinity
        });

        let lineBuffer = '';
        let lineCount = 0;
        const maxLinesToScan = 500;  // Only scan first 500 lines for imports

        rl.on('line', async (line: string) => {
            lineCount++;
            
            // Stop after scanning typical import region
            if (lineCount > maxLinesToScan) {
                rl.close();
                return;
            }

            lineBuffer += line + '\n';

            // Process ES6 imports
            const es6Pattern = /^import\s+(?:{([^}]+)}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/;
            const match = es6Pattern.exec(line);
            
            if (match) {
                const namedImports = match[1];
                const defaultImport = match[2];
                const namespaceImport = match[3];
                const importPath = match[4];

                const symbols: string[] = [];
                
                if (namedImports) {
                    symbols.push(...namedImports.split(',').map(s => s.trim().split(/\s+as\s+/)[0]));
                }
                if (defaultImport) {
                    symbols.push(defaultImport);
                }
                if (namespaceImport) {
                    symbols.push(namespaceImport);
                }

                imports.push({
                    importPath: importPath,
                    resolvedPath: undefined,  // Will resolve later if needed
                    symbols: symbols
                });
            }

            // Process Python imports
            const pythonPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/;
            const pythonMatch = pythonPattern.exec(line);
            
            if (pythonMatch) {
                const moduleName = pythonMatch[1] || pythonMatch[2].split(',')[0].trim();
                imports.push({
                    importPath: moduleName,
                    resolvedPath: undefined,
                    symbols: pythonMatch[2].split(',').map(s => s.trim())
                });
            }

            // Process Java imports
            if (line.startsWith('import ')) {
                const javaPattern = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/;
                const javaMatch = javaPattern.exec(line);
                
                if (javaMatch) {
                    const fullPath = javaMatch[1];
                    const parts = fullPath.split('.');
                    const symbolName = parts[parts.length - 1];
                    
                    imports.push({
                        importPath: fullPath,
                        resolvedPath: undefined,
                        symbols: [symbolName]
                    });
                }
            }

            // Process Go imports
            if (line.includes('import')) {
                const goPattern = /import\s+(?:"([^"]+)"|(\w+)\s+"([^"]+)")/;
                const goMatch = goPattern.exec(line);
                
                if (goMatch) {
                    const importPath = goMatch[1] || goMatch[3];
                    const alias = goMatch[2] || path.basename(importPath);
                    
                    imports.push({
                        importPath: importPath,
                        resolvedPath: undefined,
                        symbols: [alias]
                    });
                }
            }
        });

        rl.on('close', () => {
            resolve(imports);
        });

        rl.on('error', (error: Error) => {
            reject(error);
        });
    });
}

async function resolveNodeFunctionCalls(
    node: GraphNode,
    graph: ContextGraph,
    nodeMap: Map<string, GraphNode>
): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.filePath));
        const text = document.getText();
        const processed = new Set<string>();

        // Use AST parsing instead of regex for accurate call detection
        const functionCalls = await extractFunctionCallsWithAST(document, text);

        for (const { functionName, position } of functionCalls) {
            const callKey = functionName + '@' + position.line + ':' + position.character;
            
            if (processed.has(callKey)) {
                continue;
            }
            processed.add(callKey);

            try {
                const vsPosition = new vscode.Position(position.line, position.character);
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider',
                    document.uri,
                    vsPosition
                );

                if (!locations || locations.length === 0) {
                    continue;
                }

                const defLocation = locations[0];
                const defPath = defLocation.uri.fsPath;

                if (defPath === node.filePath || !nodeMap.has(defPath)) {
                    continue;
                }

                const edgeExists = graph.callGraph.some(
                    edge => edge.from === node.filePath && edge.to === defPath && edge.symbol === functionName
                );

                if (!edgeExists) {
                    graph.callGraph.push({
                        from: node.filePath,
                        to: defPath,
                        symbol: functionName
                    });

                    const targetNode = nodeMap.get(defPath);
                    if (targetNode) {
                        const symbol = targetNode.symbols.find(s => s.name === functionName || s.name.endsWith('.' + functionName));
                        if (symbol && !symbol.referencedBy.includes(node.filePath)) {
                            symbol.referencedBy.push(node.filePath);
                        }
                    }
                }

            } catch (error) {
                // Skip
            }
        }

    } catch (error) {
        console.error('Error resolving calls:', error);
    }
}

// NEW: Extract function calls using AST parsing (handles chained calls, arrow functions, etc.)
async function extractFunctionCallsWithAST(
    document: vscode.TextDocument,
    text: string
): Promise<Array<{ functionName: string; position: { line: number; character: number } }>> {
    const calls: Array<{ functionName: string; position: { line: number; character: number } }> = [];
    const language = document.languageId;

    try {
        if (language === 'typescript' || language === 'typescriptreact') {
            const ast = typescriptParse(text, {
                sourceType: 'module',
                ecmaVersion: 2022,
                loc: true
            });

            // Traverse AST and find CallExpression nodes
            traverseAST(ast, (node: any) => {
                if (node.type === 'CallExpression') {
                    const callee = node.callee;
                    let functionName = null;

                    if (callee.type === 'Identifier') {
                        functionName = callee.name;
                    } else if (callee.type === 'MemberExpression') {
                        // Handle chained calls like obj.method()
                        functionName = getFullMemberExpression(callee);
                    }

                    if (functionName && node.loc) {
                        calls.push({
                            functionName,
                            position: {
                                line: node.loc.start.line - 1,
                                character: node.loc.start.column
                            }
                        });
                    }
                }
            });
        } else if (language === 'javascript' || language === 'javascriptreact') {
            const ast = babelParse(text, {
                sourceType: 'module',
                plugins: ['jsx', 'typescript', 'decorators-legacy']
            });

            traverseAST(ast, (node: any) => {
                if (node.type === 'CallExpression') {
                    const callee = node.callee;
                    let functionName = null;

                    if (callee.type === 'Identifier') {
                        functionName = callee.name;
                    } else if (callee.type === 'MemberExpression') {
                        functionName = getFullMemberExpression(callee);
                    }

                    if (functionName && node.loc) {
                        calls.push({
                            functionName,
                            position: {
                                line: node.loc.start.line - 1,
                                character: node.loc.start.column
                            }
                        });
                    }
                }
            });
        }
    } catch (error) {
        // Fallback to regex if AST parsing fails
        console.warn('AST parsing failed, falling back to regex:', error);
        return extractFunctionCallsWithRegex(text);
    }

    return calls;
}

// Helper: Traverse AST recursively
function traverseAST(node: any, callback: (node: any) => void) {
    if (!node || typeof node !== 'object') {
        return;
    }

    callback(node);

    for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) {
                traverseAST(item, callback);
            }
        } else if (typeof child === 'object') {
            traverseAST(child, callback);
        }
    }
}

// Helper: Get full member expression (e.g., "obj.method.call")
function getFullMemberExpression(node: any): string {
    if (node.type === 'Identifier') {
        return node.name;
    } else if (node.type === 'MemberExpression') {
        const object = getFullMemberExpression(node.object);
        const property = node.property.name || '';
        return object + '.' + property;
    }
    return '';
}

// Fallback: Regex-based extraction (less accurate but works for simple cases)
function extractFunctionCallsWithRegex(
    text: string
): Array<{ functionName: string; position: { line: number; character: number } }> {
    const calls: Array<{ functionName: string; position: { line: number; character: number } }> = [];
    const lines = text.split('\n');
    const callPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

    lines.forEach((line, lineIndex) => {
        let match;
        while ((match = callPattern.exec(line)) !== null) {
            calls.push({
                functionName: match[1],
                position: {
                    line: lineIndex,
                    character: match.index
                }
            });
        }
        callPattern.lastIndex = 0;
    });

    return calls;
}

async function extractSymbolNodes(
    document: vscode.TextDocument,
    symbols: vscode.DocumentSymbol[],
    skeletonMode: boolean
): Promise<SymbolNode[]> {
    const symbolNodes: SymbolNode[] = [];

    function processSymbols(symbolList: vscode.DocumentSymbol[], parentName: string = '') {
        for (const symbol of symbolList) {
            const kind = vscode.SymbolKind[symbol.kind];
            
            if ([
                vscode.SymbolKind.Function,
                vscode.SymbolKind.Method,
                vscode.SymbolKind.Class,
                vscode.SymbolKind.Interface,
                vscode.SymbolKind.Constructor,
                vscode.SymbolKind.Variable,
                vscode.SymbolKind.Constant
            ].includes(symbol.kind)) {
                
                const signature = extractSignatureText(document, symbol);
                const docstring = extractDocstring(document, symbol);
                
                const symbolNode: SymbolNode = {
                    name: parentName ? parentName + '.' + symbol.name : symbol.name,
                    kind: kind,
                    signature: signature,
                    docstring: docstring,
                    location: {
                        line: symbol.range.start.line,
                        character: symbol.range.start.character
                    },
                    referencedBy: []
                };

                if (!skeletonMode) {
                    symbolNode.fullCode = document.getText(symbol.range);
                }

                symbolNodes.push(symbolNode);
            }

            if (symbol.children && symbol.children.length > 0) {
                processSymbols(symbol.children, symbol.name);
            }
        }
    }

    processSymbols(symbols);
    return symbolNodes;
}

async function extractImports(document: vscode.TextDocument): Promise<ImportNode[]> {
    const imports: ImportNode[] = [];
    const text = document.getText();
    const language = document.languageId;

    // JavaScript/TypeScript imports
    if (language === 'javascript' || language === 'typescript' || language === 'javascriptreact' || language === 'typescriptreact') {
        const es6ImportPattern = /import\s+(?:{([^}]+)}|([*\w]+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g;
        let match;

        while ((match = es6ImportPattern.exec(text)) !== null) {
            const namedImports = match[1];
            const defaultImport = match[2];
            const namespaceImport = match[3];
            const importPath = match[4];

            const symbols: string[] = [];
            
            if (namedImports) {
                symbols.push(...namedImports.split(',').map(s => s.trim().split(/\s+as\s+/)[0]));
            }
            if (defaultImport) {
                symbols.push(defaultImport);
            }
            if (namespaceImport) {
                symbols.push(namespaceImport);
            }

            const resolvedPath = await resolveImportPath(document.uri, importPath);
            
            imports.push({
                importPath: importPath,
                resolvedPath: resolvedPath?.fsPath,
                symbols: symbols
            });
        }

        const requirePattern = /(?:const|let|var)\s+(?:{([^}]+)}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        
        while ((match = requirePattern.exec(text)) !== null) {
            const destructured = match[1];
            const variableName = match[2];
            const importPath = match[3];

            const symbols: string[] = [];
            
            if (destructured) {
                symbols.push(...destructured.split(',').map(s => s.trim()));
            } else if (variableName) {
                symbols.push(variableName);
            }

            const resolvedPath = await resolveImportPath(document.uri, importPath);
            
            imports.push({
                importPath: importPath,
                resolvedPath: resolvedPath?.fsPath,
                symbols: symbols
            });
        }
    }

    // Python imports
    if (language === 'python') {
        const pythonImportPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/gm;
        let match;

        while ((match = pythonImportPattern.exec(text)) !== null) {
            const fromModule = match[1];
            const importedItems = match[2];

            if (fromModule) {
                const symbols = importedItems.split(',').map(s => s.trim().split(/\s+as\s+/)[0]);
                imports.push({
                    importPath: fromModule,
                    resolvedPath: undefined,
                    symbols: symbols
                });
            } else {
                const modules = importedItems.split(',').map(s => s.trim().split(/\s+as\s+/)[0]);
                for (const module of modules) {
                    imports.push({
                        importPath: module,
                        resolvedPath: undefined,
                        symbols: [module]
                    });
                }
            }
        }
    }

    // Java imports
    if (language === 'java') {
        const javaImportPattern = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/gm;
        let match;

        while ((match = javaImportPattern.exec(text)) !== null) {
            const fullPath = match[1];
            const parts = fullPath.split('.');
            const symbolName = parts[parts.length - 1];
            
            imports.push({
                importPath: fullPath,
                resolvedPath: undefined,
                symbols: [symbolName]
            });
        }
    }

    // Go imports
    if (language === 'go') {
        const goImportPattern = /import\s+(?:"([^"]+)"|(\w+)\s+"([^"]+)")/g;
        let match;

        while ((match = goImportPattern.exec(text)) !== null) {
            const importPath = match[1] || match[3];
            const alias = match[2] || path.basename(importPath);
            
            imports.push({
                importPath: importPath,
                resolvedPath: undefined,
                symbols: [alias]
            });
        }

        // Handle multi-line import blocks
        const goBlockPattern = /import\s+\(([\s\S]*?)\)/g;
        while ((match = goBlockPattern.exec(text)) !== null) {
            const block = match[1];
            const lines = block.split('\n');
            
            for (const line of lines) {
                const lineMatch = /"([^"]+)"/.exec(line.trim());
                if (lineMatch) {
                    const importPath = lineMatch[1];
                    const alias = path.basename(importPath);
                    imports.push({
                        importPath: importPath,
                        resolvedPath: undefined,
                        symbols: [alias]
                    });
                }
            }
        }
    }

    return imports;
}

async function resolveImportPath(
    fromUri: vscode.Uri,
    importPath: string
): Promise<vscode.Uri | null> {
    // First try the enhanced resolver
    const aliasConfig = await loadPathAliasConfig(fromUri);
    if (aliasConfig) {
        const resolvedWithAlias = await resolveWithAliases(fromUri, importPath, aliasConfig);
        if (resolvedWithAlias) {
            return resolvedWithAlias;
        }
    }

    // Try node_modules resolution
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        const nodeModulesResolved = await resolveFromNodeModules(fromUri, importPath);
        if (nodeModulesResolved) {
            return nodeModulesResolved;
        }
        return null;
    }

    // Original relative path resolution
    const fromDir = path.dirname(fromUri.fsPath);
    const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.json', '.py', '.java', '.go'];
    
    for (const ext of extensions) {
        const fullPath = path.resolve(fromDir, importPath + ext);
        
        try {
            if (fs.existsSync(fullPath)) {
                return vscode.Uri.file(fullPath);
            }
        } catch (error) {
            continue;
        }
    }

    const indexPath = path.resolve(fromDir, importPath);
    for (const ext of ['/index.ts', '/index.js', '/index.tsx', '/index.jsx', '/index.py', '/__init__.py']) {
        try {
            const fullPath = indexPath + ext;
            if (fs.existsSync(fullPath)) {
                return vscode.Uri.file(fullPath);
            }
        } catch (error) {
            continue;
        }
    }

    return null;
}

// NEW: Load path aliases from tsconfig.json, jsconfig.json, or webpack config
async function loadPathAliasConfig(fromUri: vscode.Uri): Promise<PathAliasConfig | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fromUri);
    if (!workspaceFolder) {
        return null;
    }

    const aliases: { [alias: string]: string } = {};
    let baseUrl = workspaceFolder.uri.fsPath;

    // Try tsconfig.json
    const tsconfigPath = path.join(workspaceFolder.uri.fsPath, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
        try {
            const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
            if (tsconfig.compilerOptions?.paths) {
                baseUrl = tsconfig.compilerOptions.baseUrl 
                    ? path.join(workspaceFolder.uri.fsPath, tsconfig.compilerOptions.baseUrl)
                    : workspaceFolder.uri.fsPath;

                for (const [alias, paths] of Object.entries(tsconfig.compilerOptions.paths)) {
                    const cleanAlias = alias.replace(/\/\*$/, '');
                    const targetPath = (paths as string[])[0]?.replace(/\/\*$/, '');
                    if (targetPath) {
                        aliases[cleanAlias] = path.join(baseUrl, targetPath);
                    }
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    // Try jsconfig.json
    const jsconfigPath = path.join(workspaceFolder.uri.fsPath, 'jsconfig.json');
    if (fs.existsSync(jsconfigPath)) {
        try {
            const jsconfig = JSON.parse(fs.readFileSync(jsconfigPath, 'utf-8'));
            if (jsconfig.compilerOptions?.paths) {
                for (const [alias, paths] of Object.entries(jsconfig.compilerOptions.paths)) {
                    const cleanAlias = alias.replace(/\/\*$/, '');
                    const targetPath = (paths as string[])[0]?.replace(/\/\*$/, '');
                    if (targetPath) {
                        aliases[cleanAlias] = path.join(baseUrl, targetPath);
                    }
                }
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    return {
        aliases,
        baseUrl,
        nodeModulesPath: path.join(workspaceFolder.uri.fsPath, 'node_modules')
    };
}

// NEW: Resolve imports using path aliases (@/, ~/, etc.)
async function resolveWithAliases(
    fromUri: vscode.Uri,
    importPath: string,
    aliasConfig: PathAliasConfig
): Promise<vscode.Uri | null> {
    for (const [alias, aliasPath] of Object.entries(aliasConfig.aliases)) {
        if (importPath.startsWith(alias)) {
            const relativePath = importPath.substring(alias.length);
            const fullPath = path.join(aliasPath, relativePath);
            
            const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.json'];
            for (const ext of extensions) {
                if (fs.existsSync(fullPath + ext)) {
                    return vscode.Uri.file(fullPath + ext);
                }
            }
        }
    }
    return null;
}

// NEW: Resolve from node_modules
async function resolveFromNodeModules(
    fromUri: vscode.Uri,
    packageName: string
): Promise<vscode.Uri | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fromUri);
    if (!workspaceFolder) {
        return null;
    }

    const nodeModulesPath = path.join(workspaceFolder.uri.fsPath, 'node_modules', packageName);
    
    // Check for package.json main field
    const packageJsonPath = path.join(nodeModulesPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            const mainFile = packageJson.main || 'index.js';
            const mainPath = path.join(nodeModulesPath, mainFile);
            if (fs.existsSync(mainPath)) {
                return vscode.Uri.file(mainPath);
            }
        } catch (error) {
            // Ignore parse errors
        }
    }

    // Fallback to index.js
    const indexPath = path.join(nodeModulesPath, 'index.js');
    if (fs.existsSync(indexPath)) {
        return vscode.Uri.file(indexPath);
    }

    return null;
}

function extractSignatureText(
    document: vscode.TextDocument,
    symbol: vscode.DocumentSymbol
): string {
    const line = document.lineAt(symbol.range.start.line);
    let signatureText = line.text.trim();

    let currentLine = symbol.range.start.line;
    const maxLines = 10;
    let linesRead = 0;

    while (currentLine <= symbol.range.end.line && linesRead < maxLines) {
        const lineText = document.lineAt(currentLine).text;
        
        if (currentLine > symbol.range.start.line) {
            signatureText += ' ' + lineText.trim();
        }

        if (lineText.includes('{')) {
            break;
        }

        currentLine++;
        linesRead++;
    }

    const braceIndex = signatureText.indexOf('{');
    if (braceIndex !== -1) {
        signatureText = signatureText.substring(0, braceIndex).trim();
    }

    return signatureText;
}

function extractDocstring(
    document: vscode.TextDocument,
    symbol: vscode.DocumentSymbol
): string | undefined {
    const symbolLine = symbol.range.start.line;
    
    let docLines: string[] = [];
    let currentLine = symbolLine - 1;
    let inDocBlock = false;

    while (currentLine >= 0 && currentLine >= symbolLine - 20) {
        const lineText = document.lineAt(currentLine).text.trim();

        if (lineText.startsWith('*/')) {
            inDocBlock = true;
            currentLine--;
            continue;
        }

        if (inDocBlock) {
            if (lineText.startsWith('/**') || lineText.startsWith('/*')) {
                docLines.reverse();
                return docLines.join(' ').trim();
            }
            
            const cleanLine = lineText.replace(/^\*\s?/, '').trim();
            if (cleanLine) {
                docLines.push(cleanLine);
            }
        } else if (lineText.startsWith('//')) {
            const cleanLine = lineText.replace(/^\/\/\s?/, '').trim();
            if (cleanLine) {
                docLines.push(cleanLine);
            }
        } else if (lineText === '') {
            if (inDocBlock) {
                currentLine--;
                continue;
            } else {
                break;
            }
        } else {
            break;
        }

        currentLine--;
    }

    if (docLines.length > 0) {
        docLines.reverse();
        return docLines.join(' ').trim();
    }

    return undefined;
}

/**
 * Generate Quick Index - Minimal JSON for LLM context
 * Contains only file paths and symbol names (no code)
 */
function generateQuickIndex(graph: ContextGraph, workspacePath: string): QuickIndex {
    // Group files by directory for better organization
    const filesByDirectory: { [directory: string]: QuickFileEntry[] } = {};
    const languageCount: { [key: string]: number } = {};
    let totalSymbols = 0;

    for (const node of graph.nodes) {
        const relativePath = node.filePath.replace(workspacePath, '');
        const directory = path.dirname(relativePath) || '/';
        
        if (!filesByDirectory[directory]) {
            filesByDirectory[directory] = [];
        }

        const symbols = node.symbols.map(s => s.name);
        totalSymbols += symbols.length;

        filesByDirectory[directory].push({
            path: relativePath,
            language: node.language,
            symbols: symbols
        });

        // Count languages
        languageCount[node.language] = (languageCount[node.language] || 0) + 1;
    }

    return {
        _description: 'Quick Index: Lightweight codebase overview for LLM context. Contains file structure and symbol names only.',
        generated: new Date().toISOString(),
        workspace: workspacePath,
        summary: {
            totalFiles: graph.nodes.length,
            totalSymbols: totalSymbols,
            languages: languageCount
        },
        filesByDirectory: filesByDirectory
    };
}

/**
 * Generate Search Index - Optimized for ripgrep-style lookups
 * Contains symbol locations and import mappings
 */
function generateSearchIndex(graph: ContextGraph, workspacePath: string): SearchIndex {
    const symbolLocations: SymbolLocation[] = [];
    const importMap: ImportMapping[] = [];
    const fileMetadata: FileMetadata[] = [];

    for (const node of graph.nodes) {
        const relativePath = node.filePath.replace(workspacePath, '');

        // Extract symbol locations
        for (const symbol of node.symbols) {
            symbolLocations.push({
                symbol: symbol.name,
                type: symbol.kind,
                file: relativePath,
                line: symbol.location.line,
                signature: symbol.signature
            });
        }

        // Build import map
        if (node.imports.length > 0) {
            importMap.push({
                file: relativePath,
                imports: node.imports
                    .filter(imp => imp.resolvedPath)
                    .map(imp => ({
                        from: imp.resolvedPath!.replace(workspacePath, ''),
                        symbols: imp.symbols
                    }))
            });
        }

        // Add file metadata
        fileMetadata.push({
            path: relativePath,
            language: node.language,
            size: node.content?.length || 0,
            symbolCount: node.symbols.length
        });
    }

    // Sort and get top 10 files by symbol count
    const topFiles = fileMetadata
        .sort((a, b) => b.symbolCount - a.symbolCount)
        .slice(0, 10)
        .map(f => ({ path: f.path, symbolCount: f.symbolCount }));

    return {
        _description: 'Search Index: Detailed symbol locations and import mappings for fast lookup. Use with ripgrep for code retrieval.',
        generated: new Date().toISOString(),
        workspace: workspacePath,
        summary: {
            totalSymbols: symbolLocations.length,
            totalImports: importMap.reduce((sum, m) => sum + m.imports.length, 0),
            topFiles: topFiles
        },
        symbolLocations: symbolLocations,
        importMap: importMap,
        fileMetadata: fileMetadata
    };
}

function sanitizeContextGraph(graph: ContextGraph): ContextGraph {
    // Use enhanced security sanitization
    function sanitizeString(str: string): string {
        return enhancedSecuritySanitization(str);
    }

    const sanitized: ContextGraph = {
        ...graph,
        nodes: graph.nodes.map(node => ({
            ...node,
            content: node.content ? sanitizeString(node.content) : undefined,
            symbols: node.symbols.map(sym => ({
                ...sym,
                signature: sanitizeString(sym.signature),
                fullCode: sym.fullCode ? sanitizeString(sym.fullCode) : undefined,
                docstring: sym.docstring ? sanitizeString(sym.docstring) : undefined
            }))
        }))
    };

    return sanitized;
}

/**
 * PHASE 2 & 3: Query codebase with ripgrep and assemble context
 */
async function queryCodebaseWithContext() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found!');
            return;
        }

        // Check if indices exist
        const quickPath = path.join(workspaceFolder.uri.fsPath, 'quick_index.json');
        const searchPath = path.join(workspaceFolder.uri.fsPath, 'search_index.json');
        
        if (!fs.existsSync(quickPath) || !fs.existsSync(searchPath)) {
            const response = await vscode.window.showWarningMessage(
                'Indices not found. Generate them first?',
                'Generate Now',
                'Cancel'
            );
            
            if (response === 'Generate Now') {
                // This needs to be fixed - we need to pass context and indexState
                vscode.window.showWarningMessage('Please use the "LogicGraph: Generate Index" command first.');
            }
            return;
        }

        // Get user query
        const query = await vscode.window.showInputBox({
            prompt: 'What do you want to know about the codebase?',
            placeHolder: 'e.g., Find authentication logic, Show database queries, What calls loginUser?'
        });

        if (!query) {
            return;
        }

        vscode.window.showInformationMessage('🔍 Searching codebase with enhanced intelligence...');

        // Load indices
        const quickIndex: QuickIndex = JSON.parse(fs.readFileSync(quickPath, 'utf8'));
        const searchIndex: SearchIndex = JSON.parse(fs.readFileSync(searchPath, 'utf8'));

        // NEW: Use enhanced search with fuzzy matching and intent detection
        const relevantSymbols = await enhancedSymbolSearch(query, searchIndex);
        
        console.log(`Found ${relevantSymbols.length} relevant symbols using enhanced search`);

        // Extract fallback search terms
        const searchTerms = extractSearchTerms(query);

        // Phase 2: Use ripgrep to fetch actual code
        const ripgrepResults = await searchWithRipgrep(
            workspaceFolder.uri.fsPath,
            searchTerms,
            relevantSymbols
        );

        // Phase 3: Assemble context with enhanced security
        const assembledContext = assembleContext(
            quickIndex,
            searchIndex,
            relevantSymbols,
            ripgrepResults,
            query
        );

        // Display results in a new document
        const doc = await vscode.workspace.openTextDocument({
            content: assembledContext,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage(
            '✅ Found ' + relevantSymbols.length + ' relevant symbols'
        );

    } catch (error) {
        vscode.window.showErrorMessage(
            'Error: ' + (error instanceof Error ? error.message : 'Unknown error')
        );
    }
}

/**
 * Extract searchable terms from user query
 */
function extractSearchTerms(query: string): string[] {
    // Remove common words and extract potential code terms
    const commonWords = ['how', 'does', 'what', 'is', 'the', 'a', 'an', 'show', 'me', 'find', 'where'];
    
    const words = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !commonWords.includes(word));

    return [...new Set(words)];
}

/**
 * Search codebase with ripgrep
 */
async function searchWithRipgrep(
    workspacePath: string,
    searchTerms: string[],
    relevantSymbols: SymbolLocation[]
): Promise<{ [key: string]: string }> {
    const results: { [key: string]: string } = {};

    // For each relevant symbol, use ripgrep to get context
    for (const symbol of relevantSymbols.slice(0, 10)) { // Limit to 10 most relevant
        try {
            const filePath = path.join(workspacePath, symbol.file);
            
            if (!fs.existsSync(filePath)) {
                continue;
            }

            // Read file and extract context around the symbol
            const fileContent = fs.readFileSync(filePath, 'utf8');
            const lines = fileContent.split('\n');
            
            // Get 10 lines before and after the symbol
            const startLine = Math.max(0, symbol.line - 10);
            const endLine = Math.min(lines.length, symbol.line + 20);
            const context = lines.slice(startLine, endLine).join('\n');
            
            results[symbol.file + ':' + symbol.symbol] = context;

        } catch (error) {
            console.error('Error reading file:', error);
        }
    }

    return results;
}

/**
 * Assemble final context for LLM
 */
function assembleContext(
    quickIndex: QuickIndex,
    searchIndex: SearchIndex,
    relevantSymbols: SymbolLocation[],
    ripgrepResults: { [key: string]: string },
    query: string
): string {
    let context = '# 🎯 Codebase Context Assembly\n\n';
    context += '## User Query\n```\n' + query + '\n```\n\n';
    
    context += '## 📊 Codebase Overview (Phase 1: Static Index)\n';
    context += '- **Total Files**: ' + quickIndex.summary.totalFiles + '\n';
    context += '- **Total Symbols**: ' + quickIndex.summary.totalSymbols + '\n';
    context += '- **Languages**: ' + Object.entries(quickIndex.summary.languages)
        .map(([lang, count]) => lang + ' (' + count + ')')
        .join(', ') + '\n';
    context += '- **Workspace**: ' + quickIndex.workspace + '\n';
    context += '- **Relevant Symbols Found**: ' + relevantSymbols.length + '\n\n';

    context += '## 🔍 Relevant Symbols (Phase 2: Search Results)\n\n';
    for (const symbol of relevantSymbols) {
        context += '### `' + symbol.symbol + '` (' + symbol.type + ')\n';
        context += '- **File**: ' + symbol.file + '\n';
        context += '- **Line**: ' + symbol.line + '\n';
        context += '- **Signature**: `' + symbol.signature + '`\n\n';
    }

    context += '## 📝 Code Context (Phase 3: Ripgrep Results)\n\n';
    for (const [key, code] of Object.entries(ripgrepResults)) {
        const [file, symbol] = key.split(':');
        context += '### ' + symbol + ' in ' + file + '\n';
        context += '```\n' + code + '\n```\n\n';
    }

    context += '---\n\n';
    context += '**💡 This context can now be sent to an LLM for analysis**\n';
    context += 'The LLM has:\n';
    context += '1. ✅ Overview of entire codebase structure\n';
    context += '2. ✅ Signatures of relevant functions/classes\n';
    context += '3. ✅ Actual implementation code where needed\n';

    return context;
}

// ============================================================================
// NEW: Incremental Update Functions
// ============================================================================

async function calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function updateSingleFile(
    uri: vscode.Uri,
    indexState: any,
    context: vscode.ExtensionContext
): Promise<void> {
    try {
        const filePath = uri.fsPath;
        const newHash = await calculateFileHash(filePath);
        const oldHash = indexState.fileHashes.get(filePath);

        // Skip if file hasn't changed
        if (oldHash === newHash) {
            return;
        }

        console.log('Updating index for changed file:', filePath);

        // Remove old node if exists
        if (indexState.contextGraph) {
            const nodeIndex = indexState.contextGraph.nodes.findIndex(
                (n: GraphNode) => n.filePath === filePath
            );
            if (nodeIndex !== -1) {
                indexState.contextGraph.nodes.splice(nodeIndex, 1);
            }

            // Rebuild the node
            const document = await vscode.workspace.openTextDocument(uri);
            const stats = fs.statSync(filePath);
            const config = indexState.contextGraph.config;

            const node = stats.size > config.streamingThreshold
                ? await buildGraphNodeWithStreaming(document, 0, config)
                : await buildGraphNode(document, 0, config);

            indexState.contextGraph.nodes.push(node);
            indexState.fileHashes.set(filePath, newHash);

            // Rebuild call graph (this is efficient as it uses HashMap)
            await buildCompleteCallGraph(indexState.contextGraph);

            console.log('✅ Updated index for:', filePath);
        }
    } catch (error) {
        console.error('Error updating file:', error);
    }
}

function removeSingleFile(uri: vscode.Uri, indexState: any): void {
    const filePath = uri.fsPath;
    
    if (indexState.contextGraph) {
        const nodeIndex = indexState.contextGraph.nodes.findIndex(
            (n: GraphNode) => n.filePath === filePath
        );
        
        if (nodeIndex !== -1) {
            indexState.contextGraph.nodes.splice(nodeIndex, 1);
            indexState.fileHashes.delete(filePath);
            console.log('✅ Removed from index:', filePath);
        }
    }
}

async function performIncrementalUpdate(
    context: vscode.ExtensionContext,
    indexState: any
): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    vscode.window.showInformationMessage('🔄 Performing incremental update...');

    const allFiles = await findAllCodeFiles(workspaceFolder);
    let updated = 0;

    for (const fileUri of allFiles) {
        const filePath = fileUri.fsPath;
        const newHash = await calculateFileHash(filePath);
        const oldHash = indexState.fileHashes.get(filePath);

        if (oldHash !== newHash) {
            await updateSingleFile(fileUri, indexState, context);
            updated++;
        }
    }

    vscode.window.showInformationMessage(`✅ Incremental update complete: ${updated} files updated`);
}

// ============================================================================
// NEW: Enhanced Query Intelligence with Fuzzy Search & Intent Detection
// ============================================================================

function analyzeQueryIntent(query: string): QueryContext {
    const lowerQuery = query.toLowerCase();
    
    let intent: QueryContext['intent'] = 'search';
    
    if (lowerQuery.includes('find') || lowerQuery.includes('where') || lowerQuery.includes('show')) {
        intent = 'search';
    } else if (lowerQuery.includes('definition') || lowerQuery.includes('declare')) {
        intent = 'definition';
    } else if (lowerQuery.includes('call') || lowerQuery.includes('reference') || lowerQuery.includes('use')) {
        intent = 'references';
    } else if (lowerQuery.includes('flow') || lowerQuery.includes('graph')) {
        intent = 'callGraph';
    }

    // Extract entities (capitalized words, function names, etc.)
    const entities: string[] = [];
    const words = query.split(/\s+/);
    
    for (const word of words) {
        // Skip common words
        if (['the', 'a', 'an', 'is', 'are', 'in', 'on', 'at', 'to', 'for', 'of', 'with'].includes(word.toLowerCase())) {
            continue;
        }
        
        // Include words that look like identifiers
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word)) {
            entities.push(word);
        }
    }

    // Detect file type filters
    const fileTypes: string[] = [];
    if (lowerQuery.includes('typescript') || lowerQuery.includes('.ts')) {
        fileTypes.push('typescript', 'typescriptreact');
    }
    if (lowerQuery.includes('python') || lowerQuery.includes('.py')) {
        fileTypes.push('python');
    }
    if (lowerQuery.includes('java')) {
        fileTypes.push('java');
    }

    return {
        query,
        intent,
        entities,
        filters: {
            fileTypes: fileTypes.length > 0 ? fileTypes : undefined
        }
    };
}

async function enhancedSymbolSearch(
    query: string,
    searchIndex: SearchIndex
): Promise<SymbolLocation[]> {
    const queryContext = analyzeQueryIntent(query);
    
    // Use Fuse.js for fuzzy search
    const fuse = new Fuse(searchIndex.symbolLocations, {
        keys: ['symbol', 'type', 'signature', 'file'],
        threshold: 0.4,
        includeScore: true,
        useExtendedSearch: true
    });

    // Build search query
    let searchQuery = query;
    
    // If we have entities, prioritize them
    if (queryContext.entities.length > 0) {
        searchQuery = queryContext.entities.join(' | ');
    }

    const results = fuse.search(searchQuery);

    // Filter by intent and file types
    let filteredResults = results.map(r => r.item);

    if (queryContext.filters.fileTypes) {
        filteredResults = filteredResults.filter(symbol => {
            const ext = path.extname(symbol.file);
            return queryContext.filters.fileTypes?.some(type => {
                if (type === 'typescript' || type === 'typescriptreact') {
                    return ext === '.ts' || ext === '.tsx';
                }
                if (type === 'python') {
                    return ext === '.py';
                }
                if (type === 'java') {
                    return ext === '.java';
                }
                return false;
            });
        });
    }

    // Apply TF-IDF-like scoring based on query terms
    const scoredResults = filteredResults.map(symbol => {
        let score = 0;
        
        for (const entity of queryContext.entities) {
            if (symbol.symbol.toLowerCase().includes(entity.toLowerCase())) {
                score += 10;
            }
            if (symbol.signature.toLowerCase().includes(entity.toLowerCase())) {
                score += 5;
            }
            if (symbol.type.toLowerCase().includes(entity.toLowerCase())) {
                score += 3;
            }
        }
        
        return { symbol, score };
    });

    // Sort by score and return top results
    scoredResults.sort((a, b) => b.score - a.score);
    return scoredResults.slice(0, 20).map(r => r.symbol);
}

// ============================================================================
// NEW: Enhanced Security Sanitization
// ============================================================================

function getSecretPatterns(): SecretPattern[] {
    return [
        // API Keys
        {
            name: 'Generic API Key',
            pattern: /(?:api[_-]?key|apikey|api[_-]?secret)[\s]*[=:]['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
            severity: 'high'
        },
        // AWS Keys
        {
            name: 'AWS Access Key',
            pattern: /(AKIA[0-9A-Z]{16})/g,
            severity: 'high'
        },
        // Private Keys
        {
            name: 'Private Key',
            pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
            severity: 'high'
        },
        // Database URLs
        {
            name: 'Database Connection String',
            pattern: /(postgres|mysql|mongodb):\/\/[^\s]+/gi,
            severity: 'high'
        },
        // JWT Tokens
        {
            name: 'JWT Token',
            pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
            severity: 'medium'
        },
        // Base64 Encoded (potential secrets)
        {
            name: 'Base64 String (long)',
            pattern: /(?:secret|password|token|key)[\s]*[=:]['"]?([A-Za-z0-9+/]{40,}={0,2})['"]?/gi,
            severity: 'medium'
        },
        // OAuth Tokens
        {
            name: 'OAuth Token',
            pattern: /(?:oauth|bearer)[\s]*[=:]['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
            severity: 'high'
        },
        // GitHub Token
        {
            name: 'GitHub Token',
            pattern: /ghp_[a-zA-Z0-9]{36}/g,
            severity: 'high'
        },
        // Slack Token
        {
            name: 'Slack Token',
            pattern: /xox[baprs]-[0-9a-zA-Z]{10,48}/g,
            severity: 'high'
        },
        // Generic Password
        {
            name: 'Password',
            pattern: /(?:password|passwd|pwd)[\s]*[=:]['"]([^'"]{8,})['"]?/gi,
            severity: 'medium'
        },
        // Environment Variables (potential secrets)
        {
            name: 'Environment Variable Secret',
            pattern: /process\.env\[['"]([A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|PASS)['"]\])/g,
            severity: 'low'
        }
    ];
}

function enhancedSecuritySanitization(text: string): string {
    let sanitized = text;
    const patterns = getSecretPatterns();
    const detectedSecrets: string[] = [];

    for (const pattern of patterns) {
        const matches = text.matchAll(pattern.pattern);
        
        for (const match of matches) {
            const secretValue = match[0];
            const masked = '[REDACTED_' + pattern.name.toUpperCase().replace(/\s+/g, '_') + ']';
            sanitized = sanitized.replace(secretValue, masked);
            detectedSecrets.push(pattern.name + ' (' + pattern.severity + ')');
        }
    }

    if (detectedSecrets.length > 0) {
        console.warn('🔒 Detected and sanitized secrets:', detectedSecrets);
    }

    return sanitized;
}

// ============================================================================
// NEW: Indexing Report Display
// ============================================================================

async function showIndexingReport(report: IndexingReport): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'indexingReport',
        'Indexing Report',
        vscode.ViewColumn.One,
        {}
    );

    const errorsByPhase = report.errors.reduce((acc, error) => {
        acc[error.phase] = (acc[error.phase] || 0) + 1;
        return acc;
    }, {} as { [key: string]: number });

    const successRate = ((report.successfulFiles / report.totalFiles) * 100).toFixed(1);

    panel.webview.html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    padding: 20px;
                    background: #1e1e1e;
                    color: #d4d4d4;
                }
                .summary { 
                    background: #252526; 
                    padding: 20px; 
                    border-radius: 5px; 
                    margin-bottom: 20px;
                }
                .stat { 
                    display: inline-block; 
                    margin-right: 30px; 
                    margin-bottom: 10px;
                }
                .stat-label { 
                    color: #858585; 
                    font-size: 12px;
                }
                .stat-value { 
                    font-size: 24px; 
                    font-weight: bold;
                    color: #4ec9b0;
                }
                .error-list { 
                    background: #252526; 
                    padding: 15px; 
                    border-radius: 5px;
                    max-height: 400px;
                    overflow-y: auto;
                }
                .error-item { 
                    padding: 10px; 
                    margin-bottom: 10px; 
                    background: #2d2d30;
                    border-left: 3px solid #f48771;
                    border-radius: 3px;
                }
                .error-file { 
                    font-weight: bold; 
                    color: #569cd6;
                    word-break: break-all;
                }
                .error-message { 
                    color: #ce9178; 
                    margin-top: 5px;
                }
                .phase-badge {
                    background: #3a3d41;
                    padding: 2px 8px;
                    border-radius: 3px;
                    font-size: 11px;
                    color: #cccccc;
                }
                h2 { color: #4ec9b0; }
                .success { color: #4ec9b0; }
                .warning { color: #dcdcaa; }
                .error { color: #f48771; }
            </style>
        </head>
        <body>
            <h1>📊 Indexing Report</h1>
            
            <div class="summary">
                <h2>Summary</h2>
                <div class="stat">
                    <div class="stat-label">Total Files</div>
                    <div class="stat-value">${report.totalFiles}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Successful</div>
                    <div class="stat-value success">${report.successfulFiles}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Skipped</div>
                    <div class="stat-value warning">${report.skippedFiles}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Errors</div>
                    <div class="stat-value error">${report.errors.length}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Success Rate</div>
                    <div class="stat-value">${successRate}%</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Duration</div>
                    <div class="stat-value">${report.duration}ms</div>
                </div>
            </div>

            ${Object.keys(errorsByPhase).length > 0 ? `
                <h2>Errors by Phase</h2>
                <div class="summary">
                    ${Object.entries(errorsByPhase).map(([phase, count]) => `
                        <div class="stat">
                            <div class="stat-label">${phase}</div>
                            <div class="stat-value error">${count}</div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            ${report.errors.length > 0 ? `
                <h2>Error Details</h2>
                <div class="error-list">
                    ${report.errors.map(error => `
                        <div class="error-item">
                            <div class="error-file">${error.file}</div>
                            <div><span class="phase-badge">${error.phase}</span></div>
                            <div class="error-message">${error.error}</div>
                        </div>
                    `).join('')}
                </div>
            ` : '<p class="success">✅ No errors detected!</p>'}
        </body>
        </html>
    `;
}

