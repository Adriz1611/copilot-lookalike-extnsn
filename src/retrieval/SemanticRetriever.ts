/**
 * SemanticRetriever - Dense vector retrieval using embeddings
 * 
 * Provides semantic similarity search using transformer-based embeddings.
 * Uses @xenova/transformers for lightweight in-browser/Node.js embeddings.
 * Implements simple dense retrieval with cosine similarity.
 * 
 * For production scale, this can be replaced with FAISS or ScaNN for
 * approximate nearest neighbor (ANN) search, but for VS Code extension
 * use cases (typically < 10k symbols), exact search is sufficient.
 */

import { pipeline, Pipeline } from '@xenova/transformers';
import { SearchIndex, SymbolLocation, FileMetadata } from '../types';

interface EmbeddedDocument {
    id: string;
    embedding: number[];
    metadata: {
        symbol?: string;
        file?: string;
        type?: string;
        line?: number;
        signature?: string;
    };
}

interface SemanticResult {
    documentId: string;
    score: number; // Cosine similarity [-1, 1]
    symbol?: string;
    file?: string;
    type?: string;
    line?: number;
}

export class SemanticRetriever {
    private embeddingModel: Pipeline | null = null;
    private documents: EmbeddedDocument[] = [];
    private documentIndex: Map<string, EmbeddedDocument>;
    private isInitialized: boolean = false;

    // Model configuration
    private readonly modelName = 'Xenova/all-MiniLM-L6-v2'; // 384-dim embeddings, ~80MB
    private readonly embeddingDim = 384;

    constructor() {
        this.documentIndex = new Map();
    }

    /**
     * Initialize the embedding model
     * Call this once during extension activation
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            console.log('SemanticRetriever: Initializing embedding model...');
            // @ts-ignore - Type definition issue with transformers
            this.embeddingModel = await pipeline('feature-extraction', this.modelName);
            this.isInitialized = true;
            console.log('SemanticRetriever: Model loaded successfully');
        } catch (error) {
            console.error('SemanticRetriever: Failed to load model:', error);
            throw new Error('Failed to initialize semantic retrieval model');
        }
    }

    /**
     * Index SearchIndex data with embeddings
     * Generates embeddings for all symbols and files
     */
    public async indexSearchIndex(searchIndex: SearchIndex): Promise<void> {
        if (!this.isInitialized || !this.embeddingModel) {
            throw new Error('SemanticRetriever not initialized. Call initialize() first.');
        }

        if (!searchIndex || !Array.isArray(searchIndex.symbolLocations)) {
            throw new Error('Invalid search index provided');
        }

        this.documents = [];
        this.documentIndex.clear();

        console.log('SemanticRetriever: Generating embeddings for symbols...');

        // Batch process symbols for efficiency
        const batchSize = 32;
        const symbols = searchIndex.symbolLocations;

        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const texts = batch.map(s => this.createTextRepresentation(s));
            
            // Generate embeddings for batch
            const embeddings = await this.batchEmbed(texts);

            // Store documents with embeddings
            for (let j = 0; j < batch.length; j++) {
                const symbol = batch[j];
                const doc: EmbeddedDocument = {
                    id: `symbol:${symbol.file}:${symbol.symbol}:${symbol.line}`,
                    embedding: embeddings[j],
                    metadata: {
                        symbol: symbol.symbol,
                        file: symbol.file,
                        type: symbol.type,
                        line: symbol.line,
                        signature: symbol.signature
                    }
                };
                this.documents.push(doc);
                this.documentIndex.set(doc.id, doc);
            }

            console.log(`SemanticRetriever: Processed ${Math.min(i + batchSize, symbols.length)}/${symbols.length} symbols`);
        }

        // Index file metadata
        const files = searchIndex.fileMetadata;
        for (const file of files) {
            const text = this.createTextFromFile(file);
            const embedding = await this.embed(text);
            const doc: EmbeddedDocument = {
                id: `file:${file.path}`,
                embedding,
                metadata: {
                    file: file.path,
                    type: file.language
                }
            };
            this.documents.push(doc);
            this.documentIndex.set(doc.id, doc);
        }

        console.log(`SemanticRetriever: Indexed ${this.documents.length} documents with embeddings`);
    }

    /**
     * Semantic search using cosine similarity
     * Returns top-k most semantically similar results
     */
    public async search(query: string, topK: number = 20): Promise<SemanticResult[]> {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            console.warn('SemanticRetriever: Invalid query provided');
            return [];
        }

        if (!this.isInitialized || !this.embeddingModel) {
            console.warn('SemanticRetriever: Not initialized');
            return [];
        }

        if (this.documents.length === 0) {
            console.warn('SemanticRetriever: No documents indexed');
            return [];
        }

        // Generate query embedding
        const queryEmbedding = await this.embed(query);

        // Compute cosine similarity with all documents
        const scores = this.documents.map(doc => ({
            doc,
            score: this.cosineSimilarity(queryEmbedding, doc.embedding)
        }));

        // Sort by similarity and take top K
        const results: SemanticResult[] = scores
            .filter(s => s.score > 0.3) // Threshold for relevance
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(s => ({
                documentId: s.doc.id,
                score: s.score,
                ...s.doc.metadata
            }));

        console.log(`SemanticRetriever: Found ${results.length} results for query "${query}"`);
        return results;
    }

    /**
     * Get semantic similarity score for specific symbol
     */
    public async getSymbolScore(query: string, symbolName: string): Promise<number> {
        if (!this.isInitialized || !this.embeddingModel) {
            return 0;
        }

        const doc = Array.from(this.documentIndex.values()).find(
            d => d.metadata.symbol === symbolName
        );

        if (!doc) {
            return 0;
        }

        const queryEmbedding = await this.embed(query);
        return this.cosineSimilarity(queryEmbedding, doc.embedding);
    }

    /**
     * Batch scoring for efficient reranking
     */
    public async batchScore(query: string, symbolNames: string[]): Promise<Map<string, number>> {
        const scores = new Map<string, number>();

        if (!this.isInitialized || !this.embeddingModel) {
            return scores;
        }

        const queryEmbedding = await this.embed(query);

        for (const symbolName of symbolNames) {
            const doc = Array.from(this.documentIndex.values()).find(
                d => d.metadata.symbol === symbolName
            );
            if (doc) {
                const score = this.cosineSimilarity(queryEmbedding, doc.embedding);
                scores.set(symbolName, score);
            } else {
                scores.set(symbolName, 0);
            }
        }

        return scores;
    }

    /**
     * Find semantically similar symbols to a given symbol
     * Useful for "find similar" functionality
     */
    public async findSimilar(symbolName: string, topK: number = 10): Promise<SemanticResult[]> {
        if (!this.isInitialized) {
            return [];
        }

        const doc = Array.from(this.documentIndex.values()).find(
            d => d.metadata.symbol === symbolName
        );

        if (!doc) {
            return [];
        }

        const scores = this.documents
            .filter(d => d.id !== doc.id) // Exclude the query symbol itself
            .map(d => ({
                doc: d,
                score: this.cosineSimilarity(doc.embedding, d.embedding)
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(s => ({
                documentId: s.doc.id,
                score: s.score,
                ...s.doc.metadata
            }));

        return scores;
    }

    /**
     * Generate embedding for a single text
     */
    private async embed(text: string): Promise<number[]> {
        if (!this.embeddingModel) {
            throw new Error('Embedding model not initialized');
        }

        const output = await this.embeddingModel(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    /**
     * Generate embeddings for multiple texts efficiently
     */
    private async batchEmbed(texts: string[]): Promise<number[][]> {
        if (!this.embeddingModel) {
            throw new Error('Embedding model not initialized');
        }

        const embeddings: number[][] = [];
        for (const text of texts) {
            const embedding = await this.embed(text);
            embeddings.push(embedding);
        }

        return embeddings;
    }

    /**
     * Create text representation for a symbol
     * Combines symbol name, type, and signature for rich semantic representation
     */
    private createTextRepresentation(symbol: SymbolLocation): string {
        // Format: "type symbolName signature in file"
        // Example: "Function calculateTotal function calculateTotal(items: Item[]): number in src/utils/helper.ts"
        const parts = [
            symbol.type,
            symbol.symbol,
            symbol.signature,
            'in',
            symbol.file
        ];
        return parts.join(' ');
    }

    /**
     * Create text representation for a file
     */
    private createTextFromFile(file: FileMetadata): string {
        return `${file.language} file ${file.path}`;
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSimilarity(vec1: number[], vec2: number[]): number {
        if (vec1.length !== vec2.length) {
            throw new Error('Vector dimensions must match');
        }

        let dotProduct = 0;
        let norm1 = 0;
        let norm2 = 0;

        for (let i = 0; i < vec1.length; i++) {
            dotProduct += vec1[i] * vec2[i];
            norm1 += vec1[i] * vec1[i];
            norm2 += vec2[i] * vec2[i];
        }

        norm1 = Math.sqrt(norm1);
        norm2 = Math.sqrt(norm2);

        if (norm1 === 0 || norm2 === 0) {
            return 0;
        }

        return dotProduct / (norm1 * norm2);
    }

    /**
     * Get statistics about indexed embeddings
     */
    public getStats(): {
        totalDocuments: number;
        embeddingDimension: number;
        modelName: string;
        isInitialized: boolean;
    } {
        return {
            totalDocuments: this.documents.length,
            embeddingDimension: this.embeddingDim,
            modelName: this.modelName,
            isInitialized: this.isInitialized
        };
    }

    /**
     * Save embeddings to disk for faster subsequent loads
     * Optional optimization for production use
     */
    public async saveEmbeddings(path: string): Promise<void> {
        const fs = await import('fs/promises');
        const data = {
            modelName: this.modelName,
            documents: this.documents
        };
        await fs.writeFile(path, JSON.stringify(data), 'utf-8');
        console.log(`SemanticRetriever: Saved embeddings to ${path}`);
    }

    /**
     * Load embeddings from disk
     * Skip embedding generation if already cached
     */
    public async loadEmbeddings(path: string): Promise<void> {
        const fs = await import('fs/promises');
        const data = JSON.parse(await fs.readFile(path, 'utf-8'));
        
        if (data.modelName !== this.modelName) {
            console.warn('SemanticRetriever: Cached model mismatch, regenerating...');
            return;
        }

        this.documents = data.documents;
        this.documentIndex.clear();
        for (const doc of this.documents) {
            this.documentIndex.set(doc.id, doc);
        }

        console.log(`SemanticRetriever: Loaded ${this.documents.length} embeddings from ${path}`);
    }
}
