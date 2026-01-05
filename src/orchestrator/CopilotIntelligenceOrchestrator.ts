/**
 * CopilotIntelligenceOrchestrator - Integrates all contextual intelligence components
 * 
 * Orchestrates the full Copilot-like query pipeline:
 * 1. Tree-sitter enhancement of LSP symbols
 * 2. Query intent graph projection
 * 3. Hybrid retrieval (BM25 + semantic)
 * 4. Graph-aware reranking
 * 5. Context assembly with justification
 * 
 * This is the main entry point for enhanced query processing.
 * Preserves existing QueryAnalyzer and FuzzySearcher as fallbacks.
 */

import { TreeSitterEnhancer } from '../syntactic/TreeSitterEnhancer';
import { QueryIntentGraphBuilder, VirtualQueryGraph } from '../semantic/QueryIntentGraph';
import { BM25LexicalRetriever } from '../retrieval/BM25LexicalRetriever';
import { SemanticRetriever } from '../retrieval/SemanticRetriever';
import { HybridReranker, HybridResult } from '../retrieval/HybridReranker';
import { GraphAwareRelevanceScorer } from '../graph/GraphAwareRelevanceScorer';
import { QueryAnalyzer } from '../search/QueryAnalyzer';
import { FuzzySearcher } from '../search/FuzzySearcher';
import { ContextGraph, SearchIndex } from '../types';
import * as fs from 'fs/promises';

export interface EnhancedQueryResult {
    symbol: string;
    file: string;
    line: number;
    type: string;
    relevanceScore: number;
    explanation: {
        lexicalScore: number;
        semanticScore: number;
        graphScore: number;
        matchedTerms: string[];
        graphRelationships: string[];
    };
}

export interface ContextAssembly {
    query: string;
    intent: string;
    results: EnhancedQueryResult[];
    virtualQueryGraph: VirtualQueryGraph;
    totalResults: number;
    processingTime: number;
}

export class CopilotIntelligenceOrchestrator {
    private treeSitterEnhancer: TreeSitterEnhancer;
    private queryIntentBuilder: QueryIntentGraphBuilder;
    private bm25Retriever: BM25LexicalRetriever;
    private semanticRetriever: SemanticRetriever;
    private hybridReranker: HybridReranker;
    private graphScorer: GraphAwareRelevanceScorer;
    
    // Fallback to existing system
    private queryAnalyzer: QueryAnalyzer;
    private fuzzySearcher: FuzzySearcher;
    
    private contextGraph: ContextGraph | null = null;
    private searchIndex: SearchIndex | null = null;
    private isInitialized: boolean = false;

    constructor() {
        this.treeSitterEnhancer = new TreeSitterEnhancer();
        this.queryIntentBuilder = new QueryIntentGraphBuilder();
        this.bm25Retriever = new BM25LexicalRetriever();
        this.semanticRetriever = new SemanticRetriever();
        this.hybridReranker = new HybridReranker(this.bm25Retriever, this.semanticRetriever);
        this.graphScorer = new GraphAwareRelevanceScorer();
        
        // Fallbacks
        this.queryAnalyzer = new QueryAnalyzer();
        this.fuzzySearcher = new FuzzySearcher();
    }

    /**
     * Initialize the orchestrator with workspace data
     * Must be called before query processing
     */
    public async initialize(workspacePath: string): Promise<void> {
        console.log('CopilotIntelligenceOrchestrator: Initializing...');

        try {
            // Load existing indices
            await this.loadIndices(workspacePath);

            // Initialize semantic retriever (loads embedding model)
            await this.semanticRetriever.initialize();

            // Index data for retrieval
            if (this.searchIndex) {
                this.bm25Retriever.indexSearchIndex(this.searchIndex);
                await this.semanticRetriever.indexSearchIndex(this.searchIndex);
            }

            // Load context graph for graph-aware scoring
            if (this.contextGraph) {
                this.graphScorer.loadContextGraph(this.contextGraph);
            }

            this.isInitialized = true;
            console.log('CopilotIntelligenceOrchestrator: Initialization complete');
        } catch (error) {
            console.error('CopilotIntelligenceOrchestrator: Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Process query with full Copilot-like intelligence
     * Returns enhanced results with graph-aware relevance
     */
    public async query(queryText: string, topK: number = 20): Promise<ContextAssembly> {
        if (!this.isInitialized) {
            throw new Error('Orchestrator not initialized. Call initialize() first.');
        }

        const startTime = Date.now();

        console.log(`CopilotIntelligenceOrchestrator: Processing query "${queryText}"`);

        // Step 1: Build Query Intent Graph
        const queryIntentGraph = this.queryIntentBuilder.buildQueryIntentGraph(queryText);
        this.graphScorer.loadQueryGraph(queryIntentGraph);

        // Step 2: Hybrid Retrieval (BM25 + Semantic)
        const hybridResults = await this.hybridReranker.search(queryText, topK * 2); // Get more for graph reranking

        // Step 3: Graph-Aware Reranking
        const graphScoredSymbols = this.graphScorer.scoreSymbols();
        const graphScoreMap = new Map(
            graphScoredSymbols.map(s => [s.symbol, s.score.overall])
        );

        // Step 4: Combine hybrid and graph scores
        const finalResults = this.combineScores(hybridResults, graphScoreMap, topK);

        // Step 5: Assemble context with explanations
        const enhancedResults = this.assembleContext(finalResults, queryIntentGraph);

        const processingTime = Date.now() - startTime;

        return {
            query: queryText,
            intent: queryIntentGraph._intentType,
            results: enhancedResults,
            virtualQueryGraph: queryIntentGraph,
            totalResults: enhancedResults.length,
            processingTime
        };
    }

    /**
     * Query with fallback to existing fuzzy search
     * Used when advanced features fail or are disabled
     */
    public async queryWithFallback(queryText: string, topK: number = 20): Promise<ContextAssembly> {
        try {
            // Try advanced query first
            return await this.query(queryText, topK);
        } catch (error) {
            console.warn('CopilotIntelligenceOrchestrator: Falling back to fuzzy search:', error);
            
            // Fallback to existing system
            if (!this.searchIndex) {
                throw new Error('Search index not loaded');
            }
            const fuzzyResults = await this.fuzzySearcher.search(queryText, this.searchIndex);
            const queryContext = this.queryAnalyzer.analyzeIntent(queryText);

            // Convert to enhanced format
            const enhancedResults: EnhancedQueryResult[] = fuzzyResults.map((r, index) => ({
                symbol: r.symbol,
                file: r.file,
                line: r.line,
                type: r.type,
                relevanceScore: 1.0 - (index / fuzzyResults.length), // Descending score by position
                explanation: {
                    lexicalScore: 0,
                    semanticScore: 0,
                    graphScore: 0,
                    matchedTerms: queryContext.entities,
                    graphRelationships: []
                }
            }));

            return {
                query: queryText,
                intent: queryContext.intent,
                results: enhancedResults,
                virtualQueryGraph: this.queryIntentBuilder.buildQueryIntentGraph(queryText),
                totalResults: enhancedResults.length,
                processingTime: 0
            };
        }
    }

    /**
     * Enhance context graph with Tree-sitter syntactic information
     * Call this during indexing to augment LSP data
     */
    public async enhanceContextGraphWithTreeSitter(
        graph: ContextGraph,
        workspacePath: string
    ): Promise<ContextGraph> {
        console.log('CopilotIntelligenceOrchestrator: Enhancing with Tree-sitter...');

        const enhancedNodes = [];

        for (const node of graph.nodes) {
            try {
                // Read file content
                const content = await fs.readFile(node.filePath, 'utf-8');

                // Enhance with Tree-sitter
                const enhancement = this.treeSitterEnhancer.enhanceGraphNode(node, content);

                // Merge enhancements into symbols
                const enhancedSymbols = this.treeSitterEnhancer.mergeEnhancements(
                    node.symbols,
                    enhancement
                );

                // Add additional call edges
                const additionalCalls = enhancement.additionalCalls;
                graph.callGraph.push(...additionalCalls);

                enhancedNodes.push({
                    ...node,
                    symbols: enhancedSymbols
                });
            } catch (error) {
                console.warn(`Tree-sitter enhancement failed for ${node.filePath}:`, error);
                enhancedNodes.push(node); // Keep original if enhancement fails
            }
        }

        return {
            ...graph,
            nodes: enhancedNodes
        };
    }

    /**
     * Combine hybrid retrieval scores with graph scores
     */
    private combineScores(
        hybridResults: HybridResult[],
        graphScores: Map<string, number>,
        topK: number
    ): HybridResult[] {
        const combined = hybridResults.map(result => {
            const graphScore = result.symbol ? (graphScores.get(result.symbol) || 0) : 0;
            
            // Weighted combination: 40% hybrid, 60% graph
            // Graph scores dominate for explanatory queries
            const finalScore = 0.4 * result.scores.hybrid + 0.6 * graphScore;

            return {
                ...result,
                scores: {
                    ...result.scores,
                    hybrid: finalScore // Override hybrid score with combined
                }
            };
        });

        // Re-sort by combined score
        combined.sort((a, b) => b.scores.hybrid - a.scores.hybrid);

        return combined.slice(0, topK);
    }

    /**
     * Assemble final context with explanations
     */
    private assembleContext(
        results: HybridResult[],
        queryGraph: VirtualQueryGraph
    ): EnhancedQueryResult[] {
        const queryEntities = queryGraph.nodes.flatMap(n => n.symbols.map(s => s.name));

        return results.map((result, index) => {
            // Debug: log first result's scores
            if (index === 0) {
                console.log('[Orchestrator] Top result:', result.symbol, 'scores:', {
                    bm25: result.scores.bm25,
                    semantic: result.scores.semantic,
                    hybrid: result.scores.hybrid,
                    rrf: result.scores.rrf
                });
            }
            
            // Extract graph relationships
            const relationships: string[] = [];
            if (this.contextGraph && result.symbol) {
                const edges = this.contextGraph.callGraph.filter(
                    e => e.from === result.symbol || e.to === result.symbol
                );
                relationships.push(...edges.map(e => `${e.from} -> ${e.to}`));
            }

            // Identify matched terms
            const matchedTerms = queryEntities.filter(entity =>
                result.symbol?.toLowerCase().includes(entity.toLowerCase())
            );

            return {
                symbol: result.symbol || '',
                file: result.file || '',
                line: result.line || 0,
                type: result.type || '',
                relevanceScore: result.scores.hybrid,
                explanation: {
                    lexicalScore: result.scores.bm25,
                    semanticScore: result.scores.semantic,
                    graphScore: result.scores.hybrid - (0.4 * result.scores.bm25 + 0.6 * result.scores.semantic),
                    matchedTerms,
                    graphRelationships: relationships.slice(0, 5) // Top 5 relationships
                }
            };
        });
    }

    /**
     * Load indices from workspace
     */
    private async loadIndices(workspacePath: string): Promise<void> {
        try {
            // Load context graph
            const contextGraphPath = `${workspacePath}/context-graph.json`;
            const contextGraphData = await fs.readFile(contextGraphPath, 'utf-8');
            this.contextGraph = JSON.parse(contextGraphData);

            // Load search index
            const searchIndexPath = `${workspacePath}/search_index.json`;
            const searchIndexData = await fs.readFile(searchIndexPath, 'utf-8');
            this.searchIndex = JSON.parse(searchIndexData);

            console.log('CopilotIntelligenceOrchestrator: Loaded indices from workspace');
        } catch (error) {
            console.error('CopilotIntelligenceOrchestrator: Failed to load indices:', error);
            throw new Error('Failed to load workspace indices. Generate index first.');
        }
    }

    /**
     * Get orchestrator statistics
     */
    public getStats(): {
        bm25: any;
        semantic: any;
        graph: any;
        isInitialized: boolean;
    } {
        return {
            bm25: this.bm25Retriever.getStats(),
            semantic: this.semanticRetriever.getStats(),
            graph: this.graphScorer.getStats(),
            isInitialized: this.isInitialized
        };
    }

    /**
     * Check if orchestrator is ready
     */
    public isReady(): boolean {
        return this.isInitialized;
    }
}
