/**
 * HybridReranker - Combines BM25 lexical and semantic retrieval
 * 
 * Implements hybrid retrieval strategy:
 * 1. Retrieve candidates from both BM25 (lexical) and semantic retrievers
 * 2. Merge and deduplicate results
 * 3. Rerank using weighted combination of scores
 * 4. Apply reciprocal rank fusion (RRF) for robust ranking
 * 
 * This approach leverages complementary strengths:
 * - BM25: Precise keyword matching, handles technical terms
 * - Semantic: Understands intent, handles paraphrases and synonyms
 */

import { BM25LexicalRetriever } from './BM25LexicalRetriever';
import { SemanticRetriever } from './SemanticRetriever';
import { SearchIndex } from '../types';

export interface HybridResult {
    documentId: string;
    symbol?: string;
    file?: string;
    type?: string;
    line?: number;
    scores: {
        bm25: number;
        semantic: number;
        hybrid: number;
        rrf: number; // Reciprocal Rank Fusion score
    };
    rank: number;
}

export interface RerankerConfig {
    // Weights for score combination (should sum to 1.0)
    bm25Weight: number;
    semanticWeight: number;
    
    // Reciprocal Rank Fusion parameter
    rrfK: number; // Typically 60
    
    // Retrieval parameters
    retrievalTopK: number; // How many candidates to retrieve from each system
    finalTopK: number; // Final number of results to return
}

export class HybridReranker {
    private bm25Retriever: BM25LexicalRetriever;
    private semanticRetriever: SemanticRetriever;
    
    private config: RerankerConfig = {
        bm25Weight: 0.4, // Lexical matching
        semanticWeight: 0.6, // Semantic understanding
        rrfK: 60,
        retrievalTopK: 50, // Retrieve more candidates for reranking
        finalTopK: 20
    };

    constructor(
        bm25Retriever: BM25LexicalRetriever,
        semanticRetriever: SemanticRetriever,
        config?: Partial<RerankerConfig>
    ) {
        this.bm25Retriever = bm25Retriever;
        this.semanticRetriever = semanticRetriever;
        
        if (config) {
            this.config = { ...this.config, ...config };
        }

        // Validate weights sum to 1.0
        const weightSum = this.config.bm25Weight + this.config.semanticWeight;
        if (Math.abs(weightSum - 1.0) > 0.01) {
            console.warn(`HybridReranker: Weights sum to ${weightSum}, normalizing...`);
            this.config.bm25Weight /= weightSum;
            this.config.semanticWeight /= weightSum;
        }
    }

    /**
     * Hybrid search with reranking
     * Combines BM25 and semantic retrieval for best results
     */
    public async search(query: string, topK?: number): Promise<HybridResult[]> {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            console.warn('HybridReranker: Invalid query provided');
            return [];
        }

        const finalTopK = topK && topK > 0 ? topK : this.config.finalTopK;

        console.log(`HybridReranker: Starting hybrid search for "${query}"`);

        try {
            // Step 1: Retrieve candidates from both systems
            const bm25Results = this.bm25Retriever.search(query, this.config.retrievalTopK);
            const semanticResults = await this.semanticRetriever.search(query, this.config.retrievalTopK);

            console.log(`HybridReranker: BM25 found ${bm25Results.length}, Semantic found ${semanticResults.length}`);

            if (bm25Results.length === 0 && semanticResults.length === 0) {
                console.warn('HybridReranker: No results from either retriever');
                return [];
            }

            // Step 2: Merge results and create score maps
        const bm25ScoreMap = new Map<string, number>();
        const bm25RankMap = new Map<string, number>();
        bm25Results.forEach((result, index) => {
            bm25ScoreMap.set(result.documentId, result.score);
            bm25RankMap.set(result.documentId, index + 1);
        });

        const semanticScoreMap = new Map<string, number>();
        const semanticRankMap = new Map<string, number>();
        semanticResults.forEach((result, index) => {
            semanticScoreMap.set(result.documentId, result.score);
            semanticRankMap.set(result.documentId, index + 1);
        });

        // Step 3: Get all unique document IDs
        const allDocIds = new Set([
            ...bm25Results.map(r => r.documentId),
            ...semanticResults.map(r => r.documentId)
        ]);

        // Step 4: Compute hybrid scores for all documents
        const hybridResults: HybridResult[] = [];

        let debugCount = 0;
        let onDemandCount = 0;
        for (const docId of allDocIds) {
            const rawBM25Score = bm25ScoreMap.get(docId);
            let bm25Score: number;
            
            // If document wasn't in BM25 top-K, compute its score now
            if (rawBM25Score === undefined) {
                onDemandCount++;
                const parts = docId.split(':');
                console.log(`[HybridReranker] On-demand for docId: "${docId}" (parts: ${parts.length})`);
                bm25Score = await this.getBM25Score(query, docId);
                bm25Score = this.normalizeScore(bm25Score, 'bm25');
                console.log(`[HybridReranker] On-demand score: ${bm25Score.toFixed(3)}`);
            } else {
                bm25Score = this.normalizeScore(rawBM25Score, 'bm25');
            }
            
            const semanticScore = semanticScoreMap.get(docId) || 0; // Already normalized [0,1]

            // Debug first result
            if (debugCount === 0) {
                console.log('[HybridReranker] First result in allDocIds:', {
                    docId,
                    rawBM25Score: rawBM25Score || 'computed on-demand',
                    normalizedBM25: bm25Score,
                    semanticScore,
                    inBM25Top50: bm25ScoreMap.has(docId),
                    inSemanticTop50: semanticScoreMap.has(docId)
                });
                debugCount++;
            }

            // Weighted combination
            const hybridScore = 
                this.config.bm25Weight * bm25Score +
                this.config.semanticWeight * semanticScore;

            // Reciprocal Rank Fusion score
            const bm25Rank = bm25RankMap.get(docId) || (this.config.retrievalTopK + 1);
            const semanticRank = semanticRankMap.get(docId) || (this.config.retrievalTopK + 1);
            const rrfScore = this.computeRRF(bm25Rank, semanticRank);

            // Get metadata from either result set
            const metadata = this.getMetadata(docId, bm25Results, semanticResults);

            hybridResults.push({
                documentId: docId,
                ...metadata,
                scores: {
                    bm25: bm25Score,
                    semantic: semanticScore,
                    hybrid: hybridScore,
                    rrf: rrfScore
                },
                rank: 0 // Will be set after sorting
            });
        }

        // Step 5: Sort by hybrid score (or RRF, depending on strategy)
        // Default: use weighted hybrid score
        hybridResults.sort((a, b) => b.scores.hybrid - a.scores.hybrid);

        // Optionally use RRF for more robust ranking
        // hybridResults.sort((a, b) => b.scores.rrf - a.scores.rrf);

        // Step 6: Assign final ranks and take top K
        const finalResults = hybridResults.slice(0, finalTopK).map((result, index) => ({
            ...result,
            rank: index + 1
        }));

        console.log(`HybridReranker: Returning top ${finalResults.length} results (computed ${onDemandCount} BM25 scores on-demand)`);
        return finalResults;
        } catch (error) {
            console.error('HybridReranker: Search failed:', error);
            // Return empty results on error rather than throwing
            return [];
        }
    }

    /**
     * Rerank a specific set of candidates
     * Useful when you already have a candidate set from other sources
     */
    public async rerank(
        query: string,
        candidateIds: string[],
        topK?: number
    ): Promise<HybridResult[]> {
        const finalTopK = topK || candidateIds.length;

        // Get scores for all candidates
        const results: HybridResult[] = [];

        for (const docId of candidateIds) {
            const bm25Score = this.normalizeScore(
                await this.getBM25Score(query, docId),
                'bm25'
            );
            const semanticScore = await this.getSemanticScore(query, docId);

            const hybridScore =
                this.config.bm25Weight * bm25Score +
                this.config.semanticWeight * semanticScore;

            results.push({
                documentId: docId,
                scores: {
                    bm25: bm25Score,
                    semantic: semanticScore,
                    hybrid: hybridScore,
                    rrf: 0 // Not computed for reranking
                },
                rank: 0
            });
        }

        // Sort by hybrid score
        results.sort((a, b) => b.scores.hybrid - a.scores.hybrid);

        // Assign ranks and return top K
        return results.slice(0, finalTopK).map((result, index) => ({
            ...result,
            rank: index + 1
        }));
    }

    /**
     * Get score explanation for a specific result
     * Useful for debugging and transparency
     */
    public explainScore(result: HybridResult): string {
        const explanation = [
            `Hybrid Score: ${result.scores.hybrid.toFixed(3)}`,
            `  - BM25 (${this.config.bm25Weight * 100}%): ${result.scores.bm25.toFixed(3)}`,
            `  - Semantic (${this.config.semanticWeight * 100}%): ${result.scores.semantic.toFixed(3)}`,
            `  - RRF: ${result.scores.rrf.toFixed(3)}`,
            `Rank: #${result.rank}`
        ].join('\n');

        return explanation;
    }

    /**
     * Update configuration dynamically
     * Useful for A/B testing or user preferences
     */
    public updateConfig(config: Partial<RerankerConfig>): void {
        this.config = { ...this.config, ...config };

        // Re-normalize weights if changed
        if (config.bm25Weight !== undefined || config.semanticWeight !== undefined) {
            const weightSum = this.config.bm25Weight + this.config.semanticWeight;
            this.config.bm25Weight /= weightSum;
            this.config.semanticWeight /= weightSum;
        }

        console.log('HybridReranker: Updated configuration', this.config);
    }

    private async getBM25Score(query: string, documentId: string): Promise<number> {
        // Handle different document ID formats:
        // - BM25: "filePath:line:symbolName" (3 parts)
        // - Semantic file: "file:filePath" (2 parts)
        // - Semantic symbol: "symbol:filePath:symbolName:lineNumber" (4 parts)
        
        const parts = documentId.split(':');
        
        if (parts.length === 4 && parts[0] === 'symbol') {
            // Semantic symbol format: symbol:filePath:symbolName:lineNumber
            const symbolName = parts[2];
            return this.bm25Retriever.getSymbolScore(query, symbolName);
        } else if (parts.length >= 3 && parts[0] !== 'file') {
            // BM25 format: filePath:line:symbolName
            const symbolName = parts[parts.length - 1];
            return this.bm25Retriever.getSymbolScore(query, symbolName);
        } else if (parts.length === 2 && parts[0] === 'file') {
            // File-level result - no specific symbol to score
            // Could search for file path tokens, but for now return 0
            return 0;
        }
        
        return 0;
    }

    private async getSemanticScore(query: string, documentId: string): Promise<number> {
        // Document IDs are in format: "filePath:line:symbolName"
        const parts = documentId.split(':');
        
        if (parts.length >= 3) {
            const symbolName = parts[parts.length - 1];
            return await this.semanticRetriever.getSymbolScore(query, symbolName);
        }
        
        return 0;
    }

    /**
     * Normalize BM25 scores to [0, 1] range
     * BM25 scores are unbounded, so we use normalization based on corpus max
     */
    private normalizeScore(score: number, type: 'bm25' | 'semantic'): number {
        if (type === 'bm25') {
            // Use actual corpus max score for better normalization
            const maxScore = this.bm25Retriever.getMaxScore();
            if (maxScore > 0) {
                // Linear normalization with soft cap
                return Math.min(1.0, score / maxScore);
            } else {
                // Fallback to sigmoid-like soft normalization
                return score / (score + 10);
            }
        } else {
            // Semantic scores are already in [-1, 1] from cosine similarity
            // Map to [0, 1]
            return (score + 1) / 2;
        }
    }

    /**
     * Compute Reciprocal Rank Fusion score
     * RRF is robust to score scale differences
     */
    private computeRRF(rank1: number, rank2: number): number {
        const k = this.config.rrfK;
        return 1 / (k + rank1) + 1 / (k + rank2);
    }

    private getMetadata(
        docId: string,
        bm25Results: any[],
        semanticResults: any[]
    ): {
        symbol?: string;
        file?: string;
        type?: string;
        line?: number;
    } {
        // Try to find metadata in BM25 results first
        const bm25Result = bm25Results.find(r => r.documentId === docId);
        if (bm25Result) {
            return {
                symbol: bm25Result.symbol,
                file: bm25Result.file,
                type: bm25Result.type,
                line: bm25Result.line
            };
        }

        // Fall back to semantic results
        const semanticResult = semanticResults.find(r => r.documentId === docId);
        if (semanticResult) {
            return {
                symbol: semanticResult.symbol,
                file: semanticResult.file,
                type: semanticResult.type,
                line: semanticResult.line
            };
        }

        return {};
    }

    /**
     * Get current configuration
     */
    public getConfig(): RerankerConfig {
        return { ...this.config };
    }
}
