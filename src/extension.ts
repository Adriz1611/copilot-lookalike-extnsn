import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface GraphConfig {
    maxDepth: number;
    useSkeletonMode: boolean;
    maxFileSize: number;
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

export function activate(context: vscode.ExtensionContext) {
    console.log('copilot-extnsn is now active!');

    // Phase 1: Build static index
    const indexCommand = vscode.commands.registerCommand(
        'logicGraph.generateContextJSON',
        async () => {
            await generateContextGraph();
        }
    );

    // Phase 2 & 3: Query with ripgrep and assemble context
    const queryCommand = vscode.commands.registerCommand(
        'logicGraph.queryCodebase',
        async () => {
            await queryCodebaseWithContext();
        }
    );

    context.subscriptions.push(indexCommand, queryCommand);
}

async function generateContextGraph() {
    const startTime = Date.now();

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found!');
            return;
        }

        vscode.window.showInformationMessage('🔍 Indexing entire codebase...');

        const config: GraphConfig = {
            maxDepth: 1,
            useSkeletonMode: true,  // Use signatures only (much smaller!)
            maxFileSize: 1024 * 100  // Limit to 100KB per file
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
        let processed = 0;

        for (const fileUri of allFiles) {
            try {
                const filePath = fileUri.fsPath;
                
                if (visited.has(filePath)) {
                    continue;
                }

                const stats = fs.statSync(filePath);
                if (stats.size > config.maxFileSize) {
                    console.log('Skipping large file:', filePath);
                    continue;
                }

                const document = await vscode.workspace.openTextDocument(fileUri);
                const node = await buildGraphNode(document, 0, config);
                contextGraph.nodes.push(node);
                visited.add(filePath);

                processed++;
                if (processed % 10 === 0) {
                    vscode.window.showInformationMessage('Indexed ' + processed + '/' + allFiles.length + ' files...');
                }

            } catch (error) {
                console.error('Error processing file:', error);
            }
        }

        await buildCompleteCallGraph(contextGraph);

        // Generate QUICK INDEX for LLM context (ultra-lightweight)
        const quickIndex = generateQuickIndex(contextGraph, workspaceFolder.uri.fsPath);
        const quickPath = path.join(workspaceFolder.uri.fsPath, 'quick_index.json');
        fs.writeFileSync(quickPath, JSON.stringify(quickIndex, null, 2), 'utf8');

        // Generate SEARCH INDEX for ripgrep integration (symbol lookups)
        const searchIndex = generateSearchIndex(contextGraph, workspaceFolder.uri.fsPath);
        const searchPath = path.join(workspaceFolder.uri.fsPath, 'search_index.json');
        fs.writeFileSync(searchPath, JSON.stringify(searchIndex, null, 2), 'utf8');

        const elapsed = Date.now() - startTime;
        const quickSizeKB = (fs.statSync(quickPath).size / 1024).toFixed(1);
        const searchSizeKB = (fs.statSync(searchPath).size / 1024).toFixed(1);
        
        vscode.window.showInformationMessage(
            '✅ Indexed ' + contextGraph.nodes.length + ' files in ' + elapsed + 'ms\n' +
            '📄 Quick: ' + quickSizeKB + 'KB | 🔍 Search: ' + searchSizeKB + 'KB'
        );

    } catch (error) {
        vscode.window.showErrorMessage(
            'Error: ' + (error instanceof Error ? error.message : 'Unknown error')
        );
        console.error('Context graph error:', error);
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

    const excludePattern = '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/venv/**,**/__pycache__/**,**/target/**,**/bin/**,**/obj/**}';

    const allFiles: vscode.Uri[] = [];

    for (const pattern of patterns) {
        const files = await vscode.workspace.findFiles(pattern, excludePattern);
        allFiles.push(...files);
    }

    const uniqueFiles = Array.from(new Set(allFiles.map(f => f.fsPath))).map(p => vscode.Uri.file(p));
    
    return uniqueFiles;
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

async function resolveNodeFunctionCalls(
    node: GraphNode,
    graph: ContextGraph,
    nodeMap: Map<string, GraphNode>
): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.filePath));
        const text = document.getText();

        const callPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
        let match;
        const processed = new Set<string>();

        while ((match = callPattern.exec(text)) !== null) {
            const functionName = match[1];
            const callKey = functionName + '@' + match.index;
            
            if (processed.has(callKey)) {
                continue;
            }
            processed.add(callKey);

            const position = document.positionAt(match.index);

            try {
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider',
                    document.uri,
                    position
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

    return imports;
}

async function resolveImportPath(
    fromUri: vscode.Uri,
    importPath: string
): Promise<vscode.Uri | null> {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        return null;
    }

    const fromDir = path.dirname(fromUri.fsPath);
    const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '.json'];
    
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
    for (const ext of ['/index.ts', '/index.js', '/index.tsx', '/index.jsx']) {
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
    const sensitivePatterns = [
        /(['"`])[a-zA-Z0-9]{20,}\1/g,
        /(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*['"`][^'"`]+['"`]/gi,
        /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g,
        /[a-f0-9]{32,}/gi
    ];

    function sanitizeString(str: string): string {
        let sanitized = str;
        
        for (const pattern of sensitivePatterns) {
            sanitized = sanitized.replace(pattern, (match) => {
                if (match.length > 15 && !/test|example|dummy|sample|placeholder/i.test(match)) {
                    return '[REDACTED]';
                }
                return match;
            });
        }
        
        return sanitized;
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
                await generateContextGraph();
            }
            return;
        }

        // Get user query
        const query = await vscode.window.showInputBox({
            prompt: 'What do you want to know about the codebase?',
            placeHolder: 'e.g., How does authentication work? Show me the login function'
        });

        if (!query) {
            return;
        }

        vscode.window.showInformationMessage('🔍 Searching codebase...');

        // Load indices
        const quickIndex: QuickIndex = JSON.parse(fs.readFileSync(quickPath, 'utf8'));
        const searchIndex: SearchIndex = JSON.parse(fs.readFileSync(searchPath, 'utf8'));

        // Phase 2: Extract relevant terms from query
        const searchTerms = extractSearchTerms(query);
        
        // Find relevant symbols from search index
        const relevantSymbols = searchIndex.symbolLocations.filter(loc =>
            searchTerms.some(term => 
                loc.symbol.toLowerCase().includes(term.toLowerCase()) ||
                loc.signature.toLowerCase().includes(term.toLowerCase())
            )
        );

        // Phase 2: Use ripgrep to fetch actual code
        const ripgrepResults = await searchWithRipgrep(
            workspaceFolder.uri.fsPath,
            searchTerms,
            relevantSymbols
        );

        // Phase 3: Assemble context
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

export function deactivate() {
    console.log('copilot-extnsn deactivated');
}
