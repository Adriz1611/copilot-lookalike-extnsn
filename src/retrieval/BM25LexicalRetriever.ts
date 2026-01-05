/**
 * BM25LexicalRetriever - Precise lexical recall using BM25 ranking
 * 
 * Provides exact keyword matching with BM25 scoring over search_index.json.
 * Complements fuzzy search with precise lexical recall for technical terms,
 * identifiers, and exact phrase matches.
 * 
 * BM25 (Best Matching 25) is a probabilistic ranking function that considers:
 * - Term frequency (TF): How often a term appears
 * - Inverse document frequency (IDF): How rare the term is across corpus
 * - Document length normalization: Adjusts for varying symbol counts
 * 
 * This implementation is self-contained and doesn't rely on external BM25 libraries.
 */

import { SearchIndex, SymbolLocation, FileMetadata } from '../types';
import * as natural from 'natural';

interface BM25Document {
    id: string; // Unique document identifier
    tokens: string[]; // Tokenized content
    metadata: {
        symbol?: string;
        file?: string;
        type?: string;
        line?: number;
    };
}

interface BM25Result {
    documentId: string;
    score: number;
    symbol?: string;
    file?: string;
    type?: string;
    line?: number;
}

export class BM25LexicalRetriever {
    private documents: BM25Document[];
    private documentIndex: Map<string, BM25Document>;
    private invertedIndex: Map<string, Set<number>>;
    private docLengths: number[];
    private avgDocLength: number;
    private idfScores: Map<string, number>;
    private totalDocs: number;
    private stemmer: typeof natural.PorterStemmer;

    // BM25 parameters (tuned for code search)
    private readonly k1 = 1.5; // Term frequency saturation (higher = more weight to term freq)
    private readonly b = 0.75; // Length normalization (0-1, higher = more length penalty)

    constructor() {
        this.documents = [];
        this.documentIndex = new Map();
        this.invertedIndex = new Map();
        this.docLengths = [];
        this.avgDocLength = 0;
        this.idfScores = new Map();
        this.totalDocs = 0;
        this.stemmer = natural.PorterStemmer;
    }

    /**
     * Index a search index for BM25 retrieval
     */
    indexSearchIndex(searchIndex: SearchIndex): void {
        if (!searchIndex || !Array.isArray(searchIndex.symbolLocations)) {
            throw new Error('[BM25] Invalid search index provided');
        }

        console.log(`[BM25] Indexing ${searchIndex.symbolLocations.length} symbols...`);
        
        this.documents = [];
        this.documentIndex.clear();
        
        // Create documents from symbols
        for (const symbol of searchIndex.symbolLocations) {
            const doc: BM25Document = {
                id: `${symbol.file}:${symbol.line}:${symbol.symbol}`,
                tokens: this.tokenize(this.createSearchableText(symbol)),
                metadata: {
                    symbol: symbol.symbol,
                    file: symbol.file,
                    type: symbol.type,
                    line: symbol.line
                }
            };
            
            this.documents.push(doc);
            this.documentIndex.set(doc.id, doc);
        }
        
        this.totalDocs = this.documents.length;
        
        // Calculate document lengths
        this.docLengths = this.documents.map(doc => doc.tokens.length);
        this.avgDocLength = this.docLengths.reduce((a, b) => a + b, 0) / this.totalDocs;
        
        // Build inverted index and calculate IDF
        this.buildInvertedIndex();
        this.calculateIDF();
        
        console.log(`[BM25] Indexed ${this.totalDocs} documents, avgDocLen=${this.avgDocLength.toFixed(2)}`);
        console.log(`[BM25] Sample tokens in index: ${Array.from(this.invertedIndex.keys()).slice(0, 20).join(', ')}`);
    }

    /**
     * Build inverted index for fast candidate retrieval
     */
    private buildInvertedIndex(): void {
        this.invertedIndex.clear();
        
        for (let i = 0; i < this.documents.length; i++) {
            const uniqueTokens = new Set(this.documents[i].tokens);
            
            for (const token of uniqueTokens) {
                if (!this.invertedIndex.has(token)) {
                    this.invertedIndex.set(token, new Set());
                }
                this.invertedIndex.get(token)!.add(i);
            }
        }
    }

    /**
     * Calculate IDF (Inverse Document Frequency) scores for all terms
     */
    private calculateIDF(): void {
        this.idfScores.clear();
        
        // Count document frequency for each term
        const docFreq = new Map<string, number>();
        for (const doc of this.documents) {
            const uniqueTokens = new Set(doc.tokens);
            for (const token of uniqueTokens) {
                docFreq.set(token, (docFreq.get(token) || 0) + 1);
            }
        }
        
        // Calculate IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        for (const [term, df] of docFreq.entries()) {
            const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);
            this.idfScores.set(term, idf);
        }
    }

    /**
     * Search for symbols matching a query
     */
    search(query: string, topK: number = 10): BM25Result[] {
        if (!query || typeof query !== 'string') {
            console.warn('[BM25] Invalid query provided');
            return [];
        }

        if (this.documents.length === 0) {
            console.warn('[BM25] No documents indexed');
            return [];
        }

        if (topK <= 0) {
            topK = 10;
        }
        
        const queryTokens = this.tokenize(query);
        console.log(`[BM25] Query: "${query}" → Tokens: [${queryTokens.join(', ')}]`);
        
        if (queryTokens.length === 0) {
            return [];
        }
        
        // Get candidate documents using inverted index
        const candidates = this.getCandidates(queryTokens);
        console.log(`[BM25] Found ${candidates.size} candidates for ${queryTokens.length} query tokens`);
        
        // Score all candidates
        const scores: Array<{ docIdx: number; score: number }> = [];
        
        for (const docIdx of candidates) {
            const score = this.calculateBM25Score(docIdx, queryTokens);
            if (score > 0) {
                scores.push({ docIdx, score });
            }
        }
        
        // Sort by score and return top-k
        const results = scores
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ docIdx, score }) => {
                const doc = this.documents[docIdx];
                return {
                    documentId: doc.id,
                    score,
                    ...doc.metadata
                };
            });
        
        return results;
    }

    /**
     * Get candidate documents that contain at least one query term
     */
    private getCandidates(queryTokens: string[]): Set<number> {
        const candidates = new Set<number>();
        
        for (const token of queryTokens) {
            const docIndices = this.invertedIndex.get(token);
            if (docIndices) {
                for (const docIdx of docIndices) {
                    candidates.add(docIdx);
                }
            }
        }
        
        return candidates;
    }

    /**
     * Calculate BM25 score for a document given query tokens
     */
    private calculateBM25Score(docIdx: number, queryTokens: string[]): number {
        const doc = this.documents[docIdx];
        const docLength = this.docLengths[docIdx];
        
        // Calculate term frequencies
        const termFreqs = new Map<string, number>();
        for (const token of doc.tokens) {
            termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
        }
        
        let score = 0;
        for (const qTerm of queryTokens) {
            const tf = termFreqs.get(qTerm) || 0;
            if (tf === 0) continue;
            
            const idf = this.idfScores.get(qTerm) || 0;
            
            // BM25 formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)))
            const numerator = tf * (this.k1 + 1);
            const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
            
            score += idf * (numerator / denominator);
        }
        
        return score;
    }

    /**
     * Create searchable text from a symbol (matches original implementation)
     */
    private createSearchableText(symbol: any): string {
        const parts: string[] = [];
        
        if (symbol.symbol) parts.push(symbol.symbol);
        if (symbol.file) parts.push(symbol.file);
        if (symbol.type) parts.push(symbol.type);
        if (symbol.docComment) parts.push(symbol.docComment);
        
        return parts.join(' ').toLowerCase();
    }

    /**
     * Tokenize text into searchable tokens with stemming
     */
    private tokenize(text: string): string[] {
        if (!text || typeof text !== 'string') {
            return [];
        }

        // Handle camelCase BEFORE lowercasing
        const expandedTokens: string[] = [];
        
        // Split on non-alphanumeric characters first
        const tokens = text.split(/[^a-zA-Z0-9]+/).filter(t => t && t.length > 0);
        
        for (const token of tokens) {
            // Add the whole token (lowercased and stemmed)
            const lowerToken = token.toLowerCase();
            expandedTokens.push(this.stemmer.stem(lowerToken));
            
            // Split camelCase (before lowercasing)
            // Matches: lowercase followed by uppercase, or multiple uppercase followed by lowercase
            const camelParts = token.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(t => t.length > 0);
            if (camelParts.length > 1) {
                expandedTokens.push(...camelParts.map(p => this.stemmer.stem(p.toLowerCase())));
            }
            
            // Split snake_case
            const snakeParts = token.split('_').filter(t => t.length > 0);
            if (snakeParts.length > 1) {
                expandedTokens.push(...snakeParts.map(p => this.stemmer.stem(p.toLowerCase())));
            }
        }
        
        return expandedTokens;
    }

    /**
     * Get statistics about the indexed corpus
     */
    getStats(): { totalDocs: number; avgDocLength: number; uniqueTerms: number } {
        return {
            totalDocs: this.totalDocs,
            avgDocLength: this.avgDocLength,
            uniqueTerms: this.idfScores.size
        };
    }

    /**
     * Explain why a document received its score (for debugging)
     */
    explainScore(documentId: string, query: string): string {
        const doc = this.documentIndex.get(documentId);
        if (!doc) {
            return `Document ${documentId} not found`;
        }
        
        const queryTokens = this.tokenize(query);
        const docIdx = this.documents.findIndex(d => d.id === documentId);
        if (docIdx === -1) {
            return `Document index not found`;
        }
        
        const docLength = this.docLengths[docIdx];
        const termFreqs = new Map<string, number>();
        for (const token of doc.tokens) {
            termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
        }
        
        let explanation = `BM25 Score Breakdown for "${documentId}":\n`;
        explanation += `Document length: ${docLength} (avg: ${this.avgDocLength.toFixed(2)})\n\n`;
        
        let totalScore = 0;
        for (const qTerm of queryTokens) {
            const tf = termFreqs.get(qTerm) || 0;
            const idf = this.idfScores.get(qTerm) || 0;
            
            if (tf > 0) {
                const numerator = tf * (this.k1 + 1);
                const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
                const termScore = idf * (numerator / denominator);
                totalScore += termScore;
                
                explanation += `  "${qTerm}": tf=${tf}, idf=${idf.toFixed(3)}, score=${termScore.toFixed(3)}\n`;
            } else {
                explanation += `  "${qTerm}": NOT FOUND\n`;
            }
        }
        
        explanation += `\nTotal Score: ${totalScore.toFixed(3)}`;
        return explanation;
    }

    /**
     * Get BM25 score for a specific symbol (for HybridReranker)
     */
    getSymbolScore(query: string, symbolName: string): number {
        if (!query || !symbolName) {
            return 0;
        }

        const queryTokens = this.tokenize(query);
        
        // Find all documents matching this symbol name
        let bestScore = 0;
        let matchedDocs = 0;
        for (let i = 0; i < this.documents.length; i++) {
            if (this.documents[i].metadata.symbol === symbolName) {
                matchedDocs++;
                const score = this.calculateBM25Score(i, queryTokens);
                bestScore = Math.max(bestScore, score);
            }
        }
        
        return bestScore;
    }

    /**
     * Get max BM25 score in corpus for normalization
     * Critical for hybrid reranking score combination
     */
    public getMaxScore(): number {
        // Theoretical max BM25 score for this corpus
        // Used for normalizing scores to [0,1] range
        let maxIdf = 0;
        for (const idf of this.idfScores.values()) {
            if (idf > maxIdf) {
                maxIdf = idf;
            }
        }
        
        // Max occurs when all query terms appear with max TF in shortest doc
        const minDocLength = Math.min(...this.docLengths);
        const maxTF = Math.max(...this.docLengths); // Approximate
        
        // BM25 formula upper bound
        const numerator = maxTF * (this.k1 + 1);
        const denominator = maxTF + this.k1 * (1 - this.b + this.b * (minDocLength / this.avgDocLength));
        
        return maxIdf * (numerator / denominator);
    }

    /**
     * Get BM25 score for a specific file (for HybridReranker)
     */
    getFileScore(query: string, filePath: string): number {
        if (!query || !filePath) {
            return 0;
        }

        const queryTokens = this.tokenize(query);
        
        // Find all documents in this file
        let bestScore = 0;
        for (let i = 0; i < this.documents.length; i++) {
            if (this.documents[i].metadata.file === filePath) {
                const score = this.calculateBM25Score(i, queryTokens);
                bestScore = Math.max(bestScore, score);
            }
        }
        
        return bestScore;
    }
}
