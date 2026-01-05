import Fuse from 'fuse.js';
import * as path from 'path';
import { SearchIndex, SymbolLocation, QueryContext } from '../types';
import { QueryAnalyzer } from './QueryAnalyzer';

export class FuzzySearcher {
    private queryAnalyzer: QueryAnalyzer;

    constructor() {
        this.queryAnalyzer = new QueryAnalyzer();
    }

    async search(query: string, searchIndex: SearchIndex): Promise<SymbolLocation[]> {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            console.warn('FuzzySearcher: Invalid query provided');
            return [];
        }

        if (!searchIndex || !Array.isArray(searchIndex.symbolLocations)) {
            console.error('FuzzySearcher: Invalid search index provided');
            return [];
        }

        if (searchIndex.symbolLocations.length === 0) {
            return [];
        }

        const queryContext = this.queryAnalyzer.analyzeIntent(query);
        
        const fuse = new Fuse(searchIndex.symbolLocations, {
            keys: ['symbol', 'type', 'signature', 'file'],
            threshold: 0.4,
            includeScore: true,
            useExtendedSearch: true
        });

        let searchQuery = query;
        
        if (queryContext.entities.length > 0) {
            searchQuery = queryContext.entities.join(' | ');
        }

        const results = fuse.search(searchQuery);
        let filteredResults = results.map(r => r.item);

        filteredResults = this.applyFilters(filteredResults, queryContext);
        const scoredResults = this.applyTFIDFScoring(filteredResults, queryContext);

        scoredResults.sort((a, b) => b.score - a.score);
        return scoredResults.slice(0, 20).map(r => r.symbol);
    }

    private applyFilters(symbols: SymbolLocation[], context: QueryContext): SymbolLocation[] {
        if (!symbols || symbols.length === 0) {
            return [];
        }

        if (!context || !context.filters || !context.filters.fileTypes) {
            return symbols;
        }

        return symbols.filter(symbol => {
            const ext = path.extname(symbol.file);
            return context.filters.fileTypes?.some(type => {
                if (type === 'typescript' || type === 'typescriptreact') {
                    return ext === '.ts' || ext === '.tsx';
                }
                if (type === 'python') {
                    return ext === '.py';
                }
                if (type === 'java') {
                    return ext === '.java';
                }
                if (type === 'go') {
                    return ext === '.go';
                }
                return false;
            });
        });
    }

    private applyTFIDFScoring(
        symbols: SymbolLocation[],
        context: QueryContext
    ): Array<{ symbol: SymbolLocation; score: number }> {
        if (!symbols || symbols.length === 0) {
            return [];
        }

        if (!context || !context.entities || context.entities.length === 0) {
            // Return with default score if no entities
            return symbols.map(symbol => ({ symbol, score: 1 }));
        }

        return symbols.map(symbol => {
            let score = 0;
            
            // Safely access symbol properties
            const symbolName = symbol.symbol?.toLowerCase() || '';
            const signature = symbol.signature?.toLowerCase() || '';
            const type = symbol.type?.toLowerCase() || '';
            
            for (const entity of context.entities) {
                const entityLower = entity.toLowerCase();
                
                if (symbolName.includes(entityLower)) {
                    score += 10;
                }
                if (signature.includes(entityLower)) {
                    score += 5;
                }
                if (type.includes(entityLower)) {
                    score += 3;
                }
            }
            
            return { symbol, score };
        });
    }
}
