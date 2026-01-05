/**
 * TreeSitterEnhancer - Enhances LSP-derived symbols with Tree-sitter syntax analysis
 * 
 * This module complements (does NOT replace) the existing VSCode LSP symbol extraction.
 * It provides additional syntactic signals for symbol boundaries, scopes, and call relationships.
 * Results are merged into existing GraphNode, SymbolNode, and CallEdge structures.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import * as fs from 'fs';
import * as path from 'path';
import { GraphNode, SymbolNode, CallEdge } from '../types';

interface TreeSitterSymbol {
    name: string;
    kind: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    scope: string[];
    calls: string[];
}

interface TreeSitterEnhancement {
    refinedSymbols: Map<string, TreeSitterSymbol>;
    additionalCalls: CallEdge[];
    scopeHierarchy: Map<string, string[]>;
}

export class TreeSitterEnhancer {
    private parser: Parser;
    private tsLanguage: any;
    private jsLanguage: any;
    private pyLanguage: any;

    constructor() {
        this.parser = new Parser();
        
        // Initialize language parsers
        this.tsLanguage = TypeScript.typescript;
        this.jsLanguage = JavaScript;
        this.pyLanguage = Python;
    }

    /**
     * Enhance a GraphNode with Tree-sitter syntactic information
     * Complements LSP symbols without replacing them
     */
    public enhanceGraphNode(node: GraphNode, content: string): TreeSitterEnhancement {
        const language = this.getLanguageParser(node.language);
        if (!language) {
            return {
                refinedSymbols: new Map(),
                additionalCalls: [],
                scopeHierarchy: new Map()
            };
        }

        this.parser.setLanguage(language);
        
        try {
            const tree = this.parser.parse(content);
            const rootNode = tree.rootNode;

            const refinedSymbols = new Map<string, TreeSitterSymbol>();
            const additionalCalls: CallEdge[] = [];
            const scopeHierarchy = new Map<string, string[]>();

            // Extract syntactic information
            this.traverseTree(rootNode, node.filePath, [], refinedSymbols, additionalCalls, scopeHierarchy);

            return { refinedSymbols, additionalCalls, scopeHierarchy };
        } catch (error) {
            console.error(`Tree-sitter parsing failed for ${node.filePath}:`, error);
            return {
                refinedSymbols: new Map(),
                additionalCalls: [],
                scopeHierarchy: new Map()
            };
        }
    }

    /**
     * Merge Tree-sitter enhancements into existing SymbolNode array
     * Refines boundaries and adds scope information without replacing LSP data
     */
    public mergeEnhancements(
        existingSymbols: SymbolNode[],
        enhancements: TreeSitterEnhancement
    ): SymbolNode[] {
        return existingSymbols.map(symbol => {
            const enhanced = enhancements.refinedSymbols.get(symbol.name);
            if (enhanced) {
                // Refine location if Tree-sitter provides more precise boundaries
                return {
                    ...symbol,
                    location: {
                        line: enhanced.startPosition.row + 1, // Tree-sitter uses 0-based
                        character: enhanced.startPosition.column
                    },
                    // Add scope metadata (optional, doesn't break schema)
                    ...(enhanced.scope.length > 0 && {
                        docstring: symbol.docstring 
                            ? `${symbol.docstring}\n[Scope: ${enhanced.scope.join(' > ')}]`
                            : `[Scope: ${enhanced.scope.join(' > ')}]`
                    })
                };
            }
            return symbol;
        });
    }

    /**
     * Extract additional call edges not detected by LSP
     */
    public extractAdditionalCallEdges(
        filePath: string,
        content: string,
        existingEdges: CallEdge[]
    ): CallEdge[] {
        const language = this.getLanguageParser(this.detectLanguage(filePath));
        if (!language) {
            return existingEdges;
        }

        this.parser.setLanguage(language);

        try {
            const tree = this.parser.parse(content);
            const additionalCalls: CallEdge[] = [];
            const existingSet = new Set(existingEdges.map(e => `${e.from}->${e.to}:${e.symbol}`));

            this.extractCallsFromTree(tree.rootNode, filePath, additionalCalls, existingSet);

            return [...existingEdges, ...additionalCalls];
        } catch (error) {
            return existingEdges;
        }
    }

    private traverseTree(
        node: Parser.SyntaxNode,
        filePath: string,
        scope: string[],
        refinedSymbols: Map<string, TreeSitterSymbol>,
        additionalCalls: CallEdge[],
        scopeHierarchy: Map<string, string[]>
    ): void {
        // Extract function/class definitions
        if (this.isDefinitionNode(node)) {
            const symbol = this.extractSymbol(node, scope);
            if (symbol) {
                refinedSymbols.set(symbol.name, symbol);
                scopeHierarchy.set(symbol.name, [...scope]);
                
                // Recurse with updated scope
                const newScope = [...scope, symbol.name];
                for (const child of node.children) {
                    this.traverseTree(child, filePath, newScope, refinedSymbols, additionalCalls, scopeHierarchy);
                }
                return;
            }
        }

        // Extract call expressions
        if (this.isCallExpression(node)) {
            const call = this.extractCall(node, filePath, scope);
            if (call) {
                additionalCalls.push(call);
            }
        }

        // Recurse through children
        for (const child of node.children) {
            this.traverseTree(child, filePath, scope, refinedSymbols, additionalCalls, scopeHierarchy);
        }
    }

    private extractCallsFromTree(
        node: Parser.SyntaxNode,
        filePath: string,
        calls: CallEdge[],
        existingSet: Set<string>
    ): void {
        if (this.isCallExpression(node)) {
            const call = this.extractCall(node, filePath, []);
            if (call) {
                const key = `${call.from}->${call.to}:${call.symbol}`;
                if (!existingSet.has(key)) {
                    calls.push(call);
                }
            }
        }

        for (const child of node.children) {
            this.extractCallsFromTree(child, filePath, calls, existingSet);
        }
    }

    private isDefinitionNode(node: Parser.SyntaxNode): boolean {
        const defTypes = [
            'function_declaration',
            'function_definition',
            'method_definition',
            'class_declaration',
            'class_definition',
            'arrow_function',
            'function_expression'
        ];
        return defTypes.includes(node.type);
    }

    private isCallExpression(node: Parser.SyntaxNode): boolean {
        const callTypes = ['call_expression', 'new_expression', 'decorator'];
        return callTypes.includes(node.type);
    }

    private extractSymbol(node: Parser.SyntaxNode, scope: string[]): TreeSitterSymbol | null {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
            return null;
        }

        const name = nameNode.text;
        const kind = this.mapNodeTypeToSymbolKind(node.type);
        const calls = this.extractCallsFromNode(node);

        return {
            name,
            kind,
            startPosition: node.startPosition,
            endPosition: node.endPosition,
            scope,
            calls
        };
    }

    private extractCall(
        node: Parser.SyntaxNode,
        filePath: string,
        scope: string[]
    ): CallEdge | null {
        const functionNode = node.childForFieldName('function');
        if (!functionNode) {
            return null;
        }

        const calleeName = this.extractCalleeNameFromNode(functionNode);
        if (!calleeName) {
            return null;
        }

        const caller = scope.length > 0 ? scope[scope.length - 1] : path.basename(filePath);

        return {
            from: caller,
            to: calleeName,
            symbol: calleeName
        };
    }

    private extractCallsFromNode(node: Parser.SyntaxNode): string[] {
        const calls: string[] = [];
        const visitNode = (n: Parser.SyntaxNode) => {
            if (this.isCallExpression(n)) {
                const functionNode = n.childForFieldName('function');
                if (functionNode) {
                    const name = this.extractCalleeNameFromNode(functionNode);
                    if (name) {
                        calls.push(name);
                    }
                }
            }
            for (const child of n.children) {
                visitNode(child);
            }
        };
        visitNode(node);
        return calls;
    }

    private extractCalleeNameFromNode(node: Parser.SyntaxNode): string | null {
        if (node.type === 'identifier') {
            return node.text;
        }
        if (node.type === 'member_expression') {
            const propertyNode = node.childForFieldName('property');
            return propertyNode ? propertyNode.text : null;
        }
        return null;
    }

    private mapNodeTypeToSymbolKind(nodeType: string): string {
        const mapping: { [key: string]: string } = {
            'function_declaration': 'Function',
            'function_definition': 'Function',
            'method_definition': 'Method',
            'class_declaration': 'Class',
            'class_definition': 'Class',
            'arrow_function': 'Function',
            'function_expression': 'Function'
        };
        return mapping[nodeType] || 'Unknown';
    }

    private getLanguageParser(languageId: string): any {
        const langMap: { [key: string]: any } = {
            'typescript': this.tsLanguage,
            'typescriptreact': this.tsLanguage,
            'javascript': this.jsLanguage,
            'javascriptreact': this.jsLanguage,
            'python': this.pyLanguage
        };
        return langMap[languageId];
    }

    private detectLanguage(filePath: string): string {
        const ext = path.extname(filePath);
        const extMap: { [key: string]: string } = {
            '.ts': 'typescript',
            '.tsx': 'typescriptreact',
            '.js': 'javascript',
            '.jsx': 'javascriptreact',
            '.py': 'python'
        };
        return extMap[ext] || 'unknown';
    }
}
