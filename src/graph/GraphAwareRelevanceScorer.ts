/**
 * GraphAwareRelevanceScorer - Graph-structural relevance scoring
 * 
 * Computes relevance by projecting Query Intent Graph onto code graph structure.
 * Uses graph-theoretic measures to understand code relationships:
 * - Symbol affinity: How closely symbols match query entities
 * - Import proximity: Distance in import graph
 * - Call graph structure: Calling relationships and patterns
 * - Reference density: How central/important a symbol is
 * - Graph centrality: PageRank-style importance
 * 
 * This enables Copilot-style understanding of "how code works" rather than
 * just "where symbols are". Graph relevance dominates for explanatory queries.
 */

import { ContextGraph, GraphNode, CallEdge, SymbolNode } from '../types';
import { VirtualQueryGraph } from '../semantic/QueryIntentGraph';

interface GraphRelevanceScore {
    symbolAffinity: number; // 0-1: Query entity match strength
    importProximity: number; // 0-1: Closeness in import graph
    callGraphMatch: number; // 0-1: Call pattern similarity
    referenceDensity: number; // 0-1: How referenced the symbol is
    centrality: number; // 0-1: Graph centrality (PageRank-like)
    overall: number; // Weighted combination
}

interface ScoredSymbol {
    symbol: string;
    file: string;
    line: number;
    type: string;
    score: GraphRelevanceScore;
    explanation: string;
}

export class GraphAwareRelevanceScorer {
    private contextGraph: ContextGraph | null = null;
    private queryGraph: VirtualQueryGraph | null = null;
    
    // Graph structures for efficient lookup
    private callGraphMap: Map<string, Set<string>>; // symbol -> callees
    private reverseCallGraph: Map<string, Set<string>>; // symbol -> callers
    private importGraphMap: Map<string, Set<string>>; // file -> imported files
    private symbolToFile: Map<string, string>; // symbol -> file path
    private symbolCentrality: Map<string, number>; // Precomputed centrality
    
    // Scoring weights
    private weights = {
        symbolAffinity: 0.3,
        importProximity: 0.15,
        callGraphMatch: 0.25,
        referenceDensity: 0.15,
        centrality: 0.15
    };

    constructor() {
        this.callGraphMap = new Map();
        this.reverseCallGraph = new Map();
        this.importGraphMap = new Map();
        this.symbolToFile = new Map();
        this.symbolCentrality = new Map();
    }

    /**
     * Load context graph and build auxiliary structures
     */
    public loadContextGraph(graph: ContextGraph): void {
        this.contextGraph = graph;
        this.buildGraphStructures();
        this.computeCentrality();
        console.log('GraphAwareRelevanceScorer: Loaded context graph');
    }

    /**
     * Load query intent graph for structural comparison
     */
    public loadQueryGraph(queryGraph: VirtualQueryGraph): void {
        this.queryGraph = queryGraph;

    }

    /**
     * Score all symbols by graph-aware relevance to query
     */
    public scoreSymbols(): ScoredSymbol[] {
        if (!this.contextGraph || !this.queryGraph) {
            console.warn('GraphAwareRelevanceScorer: Graphs not loaded');
            return [];
        }

        const scoredSymbols: ScoredSymbol[] = [];

        // Extract query entities for matching
        const queryEntities = this.extractQueryEntities();

        // Score each symbol in the context graph
        for (const node of this.contextGraph.nodes) {
            for (const symbol of node.symbols) {
                const score = this.scoreSymbol(symbol.name, node.filePath, queryEntities);
                const explanation = this.explainScore(symbol.name, score);

                scoredSymbols.push({
                    symbol: symbol.name,
                    file: node.filePath,
                    line: symbol.location.line,
                    type: symbol.kind,
                    score,
                    explanation
                });
            }
        }

        // Sort by overall score
        scoredSymbols.sort((a, b) => b.score.overall - a.score.overall);

        return scoredSymbols;
    }

    /**
     * Score a specific symbol against query intent graph
     */
    private scoreSymbol(
        symbolName: string,
        filePath: string,
        queryEntities: string[]
    ): GraphRelevanceScore {
        // 1. Symbol Affinity: How well does symbol match query entities
        const symbolAffinity = this.computeSymbolAffinity(symbolName, queryEntities);

        // 2. Import Proximity: How close is this file to query-relevant files
        const importProximity = this.computeImportProximity(filePath, queryEntities);

        // 3. Call Graph Match: Do call patterns match query structure
        const callGraphMatch = this.computeCallGraphMatch(symbolName, queryEntities);

        // 4. Reference Density: How referenced/important is this symbol
        const referenceDensity = this.computeReferenceDensity(symbolName);

        // 5. Centrality: Graph-theoretic importance
        const centrality = this.symbolCentrality.get(symbolName) || 0;

        // Weighted combination
        const overall =
            this.weights.symbolAffinity * symbolAffinity +
            this.weights.importProximity * importProximity +
            this.weights.callGraphMatch * callGraphMatch +
            this.weights.referenceDensity * referenceDensity +
            this.weights.centrality * centrality;

        return {
            symbolAffinity,
            importProximity,
            callGraphMatch,
            referenceDensity,
            centrality,
            overall
        };
    }

    /**
     * Compute symbol affinity score
     * Measures how well symbol name matches query entities
     */
    private computeSymbolAffinity(symbolName: string, queryEntities: string[]): number {
        if (queryEntities.length === 0) {
            return 0;
        }

        const symbolLower = symbolName.toLowerCase();
        let maxSimilarity = 0;

        for (const entity of queryEntities) {
            const entityLower = entity.toLowerCase();
            
            // Exact match
            if (symbolLower === entityLower) {
                maxSimilarity = Math.max(maxSimilarity, 1.0);
                continue;
            }

            // Substring match
            if (symbolLower.includes(entityLower) || entityLower.includes(symbolLower)) {
                maxSimilarity = Math.max(maxSimilarity, 0.8);
                continue;
            }

            // Edit distance based similarity
            const similarity = 1 - this.levenshteinDistance(symbolLower, entityLower) / 
                              Math.max(symbolLower.length, entityLower.length);
            maxSimilarity = Math.max(maxSimilarity, similarity * 0.6);
        }

        return maxSimilarity;
    }

    /**
     * Compute import proximity score
     * Measures how close a file is to query-relevant files in import graph
     */
    private computeImportProximity(filePath: string, queryEntities: string[]): number {
        // Find files that contain query entities
        const relevantFiles = this.findFilesWithEntities(queryEntities);
        
        if (relevantFiles.size === 0) {
            return 0.5; // Neutral score if no relevant files
        }

        // Compute minimum distance to any relevant file in import graph
        const minDistance = this.computeMinImportDistance(filePath, relevantFiles);

        // Convert distance to similarity (0 = same file, 1 = one import away, etc.)
        // Use exponential decay: e^(-d)
        return Math.exp(-minDistance);
    }

    /**
     * Compute call graph match score
     * Measures how well call patterns match query structure
     */
    private computeCallGraphMatch(symbolName: string, queryEntities: string[]): number {
        if (queryEntities.length === 0) {
            return 0;
        }

        // Get callees of this symbol
        const callees = this.callGraphMap.get(symbolName) || new Set();
        
        // Get callers of this symbol
        const callers = this.reverseCallGraph.get(symbolName) || new Set();

        // Count how many query entities are in call neighborhood
        let matchCount = 0;
        for (const entity of queryEntities) {
            if (callees.has(entity) || callers.has(entity)) {
                matchCount++;
            }
        }

        // Also check if query entities call each other (pattern match)
        if (this.queryGraph) {
            const queryCallPatterns = new Set(
                this.queryGraph.callGraph.map(e => `${e.from}->${e.to}`)
            );
            const codeCallPatterns = new Set(
                Array.from(callees).map(callee => `${symbolName}->${callee}`)
            );

            const patternMatches = [...queryCallPatterns].filter(p => codeCallPatterns.has(p)).length;
            matchCount += patternMatches * 2; // Pattern matches are more important
        }

        return Math.min(matchCount / Math.max(queryEntities.length, 1), 1.0);
    }

    /**
     * Compute reference density score
     * Measures how referenced/used a symbol is
     */
    private computeReferenceDensity(symbolName: string): number {
        const callers = this.reverseCallGraph.get(symbolName) || new Set();
        const callees = this.callGraphMap.get(symbolName) || new Set();

        // Symbols with many callers are more important (referenced more)
        const inDegree = callers.size;
        const outDegree = callees.size;

        // Use log scale to handle varying degrees
        const densityScore = Math.log(inDegree + outDegree + 1) / Math.log(10);

        return Math.min(densityScore, 1.0);
    }

    /**
     * Build auxiliary graph structures for efficient lookup
     */
    private buildGraphStructures(): void {
        if (!this.contextGraph) {
            return;
        }

        // Build call graph maps
        for (const edge of this.contextGraph.callGraph) {
            if (!this.callGraphMap.has(edge.from)) {
                this.callGraphMap.set(edge.from, new Set());
            }
            this.callGraphMap.get(edge.from)!.add(edge.to);

            if (!this.reverseCallGraph.has(edge.to)) {
                this.reverseCallGraph.set(edge.to, new Set());
            }
            this.reverseCallGraph.get(edge.to)!.add(edge.from);
        }

        // Build import graph and symbol-to-file mapping
        for (const node of this.contextGraph.nodes) {
            const importedFiles = new Set<string>();
            for (const imp of node.imports) {
                if (imp.resolvedPath) {
                    importedFiles.add(imp.resolvedPath);
                }
            }
            this.importGraphMap.set(node.filePath, importedFiles);

            // Map symbols to files
            for (const symbol of node.symbols) {
                this.symbolToFile.set(symbol.name, node.filePath);
            }
        }
    }

    /**
     * Compute PageRank-style centrality for all symbols
     */
    private computeCentrality(): void {
        if (!this.contextGraph) {
            return;
        }

        // Simple PageRank implementation
        const dampingFactor = 0.85;
        const iterations = 20;
        const symbols = new Set<string>();

        // Collect all symbols
        for (const node of this.contextGraph.nodes) {
            for (const symbol of node.symbols) {
                symbols.add(symbol.name);
            }
        }

        // Initialize centrality scores
        const scores = new Map<string, number>();
        const initialScore = 1.0 / symbols.size;
        for (const symbol of symbols) {
            scores.set(symbol, initialScore);
        }

        // Iterate PageRank
        for (let i = 0; i < iterations; i++) {
            const newScores = new Map<string, number>();

            for (const symbol of symbols) {
                let score = (1 - dampingFactor) / symbols.size;

                // Add contributions from callers
                const callers = this.reverseCallGraph.get(symbol) || new Set();
                for (const caller of callers) {
                    const callerScore = scores.get(caller) || 0;
                    const callerOutDegree = (this.callGraphMap.get(caller) || new Set()).size;
                    if (callerOutDegree > 0) {
                        score += dampingFactor * (callerScore / callerOutDegree);
                    }
                }

                newScores.set(symbol, score);
            }

            // Update scores
            for (const [symbol, score] of newScores) {
                scores.set(symbol, score);
            }
        }

        // Normalize scores to [0, 1]
        const maxScore = Math.max(...scores.values());
        if (maxScore > 0) {
            for (const [symbol, score] of scores) {
                this.symbolCentrality.set(symbol, score / maxScore);
            }
        }

        console.log(`GraphAwareRelevanceScorer: Computed centrality for ${symbols.size} symbols`);
    }

    private extractQueryEntities(): string[] {
        if (!this.queryGraph) {
            return [];
        }

        const entities: string[] = [];
        for (const node of this.queryGraph.nodes) {
            for (const symbol of node.symbols) {
                entities.push(symbol.name);
            }
        }

        return entities;
    }

    private findFilesWithEntities(entities: string[]): Set<string> {
        const files = new Set<string>();
        for (const entity of entities) {
            const file = this.symbolToFile.get(entity);
            if (file) {
                files.add(file);
            }
        }
        return files;
    }

    private computeMinImportDistance(filePath: string, targetFiles: Set<string>): number {
        if (targetFiles.has(filePath)) {
            return 0;
        }

        // BFS to find shortest path in import graph
        const visited = new Set<string>();
        const queue: { file: string; distance: number }[] = [{ file: filePath, distance: 0 }];

        while (queue.length > 0) {
            const { file, distance } = queue.shift()!;

            if (visited.has(file)) {
                continue;
            }
            visited.add(file);

            if (targetFiles.has(file)) {
                return distance;
            }

            const imports = this.importGraphMap.get(file) || new Set();
            for (const importedFile of imports) {
                if (!visited.has(importedFile)) {
                    queue.push({ file: importedFile, distance: distance + 1 });
                }
            }
        }

        return 10; // Max distance if not connected
    }

    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    private explainScore(symbolName: string, score: GraphRelevanceScore): string {
        const parts = [
            `Overall: ${score.overall.toFixed(3)}`,
            `- Symbol Affinity: ${score.symbolAffinity.toFixed(3)}`,
            `- Import Proximity: ${score.importProximity.toFixed(3)}`,
            `- Call Graph Match: ${score.callGraphMatch.toFixed(3)}`,
            `- Reference Density: ${score.referenceDensity.toFixed(3)}`,
            `- Centrality: ${score.centrality.toFixed(3)}`
        ];
        return parts.join('\n  ');
    }

    /**
     * Update scoring weights dynamically
     */
    public updateWeights(weights: Partial<typeof this.weights>): void {
        this.weights = { ...this.weights, ...weights };
        
        // Normalize weights to sum to 1.0
        const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
        for (const key in this.weights) {
            (this.weights as any)[key] /= sum;
        }

        console.log('GraphAwareRelevanceScorer: Updated weights', this.weights);
    }

    /**
     * Get graph statistics
     */
    public getStats(): {
        totalSymbols: number;
        totalCallEdges: number;
        avgInDegree: number;
        avgOutDegree: number;
        topCentralSymbols: { symbol: string; centrality: number }[];
    } {
        const totalSymbols = this.symbolCentrality.size;
        const totalCallEdges = this.contextGraph?.callGraph.length || 0;

        let totalInDegree = 0;
        let totalOutDegree = 0;
        for (const symbol of this.symbolCentrality.keys()) {
            totalInDegree += (this.reverseCallGraph.get(symbol) || new Set()).size;
            totalOutDegree += (this.callGraphMap.get(symbol) || new Set()).size;
        }

        const avgInDegree = totalSymbols > 0 ? totalInDegree / totalSymbols : 0;
        const avgOutDegree = totalSymbols > 0 ? totalOutDegree / totalSymbols : 0;

        // Get top 10 central symbols
        const topCentralSymbols = Array.from(this.symbolCentrality.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([symbol, centrality]) => ({ symbol, centrality }));

        return {
            totalSymbols,
            totalCallEdges,
            avgInDegree: Math.round(avgInDegree * 100) / 100,
            avgOutDegree: Math.round(avgOutDegree * 100) / 100,
            topCentralSymbols
        };
    }
}
