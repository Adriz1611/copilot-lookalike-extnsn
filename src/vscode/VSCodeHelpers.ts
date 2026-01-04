/**
 * VSCode-specific helper functions
 * These functions directly use VSCode APIs and cannot be easily abstracted
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type {
    GraphConfig,
    GraphNode,
    SymbolNode,
    ImportNode,
    ContextGraph,
    QuickIndex,
    SearchIndex,
    IndexingReport
} from '../types';

/**
 * Build a graph node using VSCode's LSP
 */
export async function buildGraphNodeVSCode(
    filePath: string,
    config: GraphConfig
): Promise<GraphNode> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const stats = fs.statSync(filePath);

    const node: GraphNode = {
        filePath: document.uri.fsPath,
        language: document.languageId,
        depth: 0,
        symbols: [],
        imports: []
    };

    const fileSize = stats.size;
    if (fileSize < 1024 * 50 && !config.useSkeletonMode) {
        node.content = document.getText();
    }

    try {
        // Use VSCode's built-in symbol provider
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            document.uri
        );

        if (symbols) {
            node.symbols = extractSymbolNodes(document, symbols, config.useSkeletonMode);
        }

        node.imports = await extractImports(document);

    } catch (error) {
        console.error('Error building node:', error);
    }

    return node;
}

function extractSymbolNodes(
    document: vscode.TextDocument,
    symbols: vscode.DocumentSymbol[],
    skeletonMode: boolean
): SymbolNode[] {
    const symbolNodes: SymbolNode[] = [];

    function processSymbols(symbolList: vscode.DocumentSymbol[], parentName: string = '') {
        for (const symbol of symbolList) {
            const kind = vscode.SymbolKind[symbol.kind];
            
            const fullName = parentName ? `${parentName}.${symbol.name}` : symbol.name;
            
            const symbolNode: SymbolNode = {
                name: fullName,
                kind: kind,
                signature: extractSignatureText(document, symbol),
                location: {
                    line: symbol.range.start.line,
                    character: symbol.range.start.character
                },
                referencedBy: []
            };

            if (!skeletonMode && symbol.children.length === 0) {
                const codeLines: string[] = [];
                for (let i = symbol.range.start.line; i <= Math.min(symbol.range.end.line, symbol.range.start.line + 20); i++) {
                    codeLines.push(document.lineAt(i).text);
                }
                symbolNode.fullCode = codeLines.join('\n');
            }

            symbolNodes.push(symbolNode);

            if (symbol.children && symbol.children.length > 0) {
                processSymbols(symbol.children, fullName);
            }
        }
    }

    processSymbols(symbols);
    return symbolNodes;
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

    if (signatureText.length > 200) {
        signatureText = signatureText.substring(0, 200) + '...';
    }

    return signatureText;
}

async function extractImports(document: vscode.TextDocument): Promise<ImportNode[]> {
    const imports: ImportNode[] = [];
    const text = document.getText();
    const language = document.languageId;

    // JavaScript/TypeScript
    if (language === 'javascript' || language === 'typescript' || 
        language === 'javascriptreact' || language === 'typescriptreact') {
        
        const es6Pattern = /import\s+(?:{([^}]+)}|([*\w]+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g;
        let match;

        while ((match = es6Pattern.exec(text)) !== null) {
            const symbols: string[] = [];
            
            if (match[1]) symbols.push(...match[1].split(',').map(s => s.trim()));
            if (match[2]) symbols.push(match[2]);
            if (match[3]) symbols.push(match[3]);

            imports.push({
                importPath: match[4],
                symbols: symbols
            });
        }
    }

    // Python
    if (language === 'python') {
        const pythonPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/gm;
        let match;

        while ((match = pythonPattern.exec(text)) !== null) {
            const fromModule = match[1];
            const importedItems = match[2];

            if (fromModule) {
                imports.push({
                    importPath: fromModule,
                    symbols: importedItems.split(',').map(s => s.trim())
                });
            }
        }
    }

    return imports;
}

/**
 * Build complete call graph
 */
export async function buildCompleteCallGraphVSCode(graph: ContextGraph): Promise<void> {
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

                const symbol = targetNode.symbols.find(s => 
                    s.name === symbolName || s.name.endsWith('.' + symbolName)
                );
                if (symbol) {
                    symbol.referencedBy.push(node.filePath);
                }
            }
        }
    }
}

/**
 * Generate quick index
 */
export function generateQuickIndex(graph: ContextGraph, workspacePath: string): QuickIndex {
    const filesByDirectory: { [directory: string]: any[] } = {};
    const languageCounts: { [key: string]: number } = {};

    for (const node of graph.nodes) {
        const relativePath = path.relative(workspacePath, node.filePath);
        const directory = path.dirname(relativePath);

        if (!filesByDirectory[directory]) {
            filesByDirectory[directory] = [];
        }

        filesByDirectory[directory].push({
            path: relativePath,
            language: node.language,
            symbols: node.symbols.map(s => s.name)
        });

        languageCounts[node.language] = (languageCounts[node.language] || 0) + 1;
    }

    return {
        _description: 'Quick Index for LLM context',
        generated: new Date().toISOString(),
        workspace: workspacePath,
        summary: {
            totalFiles: graph.nodes.length,
            totalSymbols: graph.nodes.reduce((sum, n) => sum + n.symbols.length, 0),
            languages: languageCounts
        },
        filesByDirectory
    };
}

/**
 * Generate search index
 */
export function generateSearchIndex(graph: ContextGraph, workspacePath: string): SearchIndex {
    const symbolLocations: any[] = [];
    const importMap: any[] = [];
    const fileMetadata: any[] = [];

    for (const node of graph.nodes) {
        const relativePath = path.relative(workspacePath, node.filePath);

        for (const symbol of node.symbols) {
            symbolLocations.push({
                symbol: symbol.name,
                type: symbol.kind,
                file: relativePath,
                line: symbol.location.line,
                signature: symbol.signature
            });
        }

        if (node.imports.length > 0) {
            importMap.push({
                file: relativePath,
                imports: node.imports.map(imp => ({
                    from: imp.importPath,
                    symbols: imp.symbols
                }))
            });
        }

        fileMetadata.push({
            path: relativePath,
            language: node.language,
            size: fs.statSync(node.filePath).size,
            symbolCount: node.symbols.length
        });
    }

    return {
        _description: 'Search Index for symbol lookup',
        generated: new Date().toISOString(),
        workspace: workspacePath,
        summary: {
            totalSymbols: symbolLocations.length,
            totalImports: importMap.reduce((sum, m) => sum + m.imports.length, 0),
            topFiles: fileMetadata.slice(0, 10)
        },
        symbolLocations,
        importMap,
        fileMetadata
    };
}

/**
 * Show indexing report in webview
 */
export function showIndexingReportWebview(report: IndexingReport): void {
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
                body { font-family: Arial; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
                .summary { background: #252526; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
                .stat { display: inline-block; margin-right: 30px; }
                .stat-label { color: #858585; font-size: 12px; }
                .stat-value { font-size: 24px; font-weight: bold; color: #4ec9b0; }
                .success { color: #4ec9b0; }
                .error { color: #f48771; }
                h2 { color: #4ec9b0; }
            </style>
        </head>
        <body>
            <h1>📊 Indexing Report</h1>
            <div class="summary">
                <h2>Summary</h2>
                <div class="stat"><div class="stat-label">Total Files</div><div class="stat-value">${report.totalFiles}</div></div>
                <div class="stat"><div class="stat-label">Successful</div><div class="stat-value success">${report.successfulFiles}</div></div>
                <div class="stat"><div class="stat-label">Errors</div><div class="stat-value error">${report.errors.length}</div></div>
                <div class="stat"><div class="stat-label">Success Rate</div><div class="stat-value">${successRate}%</div></div>
            </div>
            ${report.errors.length > 0 ? `<h2>Errors: ${report.errors.length}</h2>` : '<p class="success">✅ No errors!</p>'}
        </body>
        </html>
    `;
}
