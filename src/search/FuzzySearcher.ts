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
        if (!context.filters.fileTypes) {
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
        return symbols.map(symbol => {
            let score = 0;
            
            for (const entity of context.entities) {
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
    }
}
