import { QueryContext } from '../types';
import * as natural from 'natural';

export class QueryAnalyzer {
    private stemmer: typeof natural.PorterStemmer;

    constructor() {
        this.stemmer = natural.PorterStemmer;
    }

    analyzeIntent(query: string): QueryContext {
        if (!query || typeof query !== 'string') {
            throw new Error('Query must be a non-empty string');
        }
        
        const lowerQuery = query.trim().toLowerCase();
        
        let intent: QueryContext['intent'] = 'search';
        
        if (lowerQuery.includes('find') || lowerQuery.includes('where') || lowerQuery.includes('show')) {
            intent = 'search';
        } else if (lowerQuery.includes('definition') || lowerQuery.includes('declare')) {
            intent = 'definition';
        } else if (lowerQuery.includes('call') || lowerQuery.includes('reference') || lowerQuery.includes('use')) {
            intent = 'references';
        } else if (lowerQuery.includes('flow') || lowerQuery.includes('graph')) {
            intent = 'callGraph';
        }

        const entities = this.extractEntities(query);
        const fileTypes = this.detectFileTypes(lowerQuery);

        return {
            query,
            intent,
            entities,
            filters: {
                fileTypes: fileTypes.length > 0 ? fileTypes : undefined
            }
        };
    }

    private extractEntities(query: string): string[] {
        const entities: string[] = [];
        const words = query.split(/\s+/);
        const commonWords = ['the', 'a', 'an', 'is', 'are', 'in', 'on', 'at', 'to', 'for', 'of', 'with'];
        
        for (const word of words) {
            if (commonWords.includes(word.toLowerCase())) {
                continue;
            }
            
            if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word)) {
                entities.push(word);
            }
        }

        return entities;
    }

    private detectFileTypes(lowerQuery: string): string[] {
        const fileTypes: string[] = [];
        
        if (lowerQuery.includes('typescript') || lowerQuery.includes('.ts')) {
            fileTypes.push('typescript', 'typescriptreact');
        }
        if (lowerQuery.includes('python') || lowerQuery.includes('.py')) {
            fileTypes.push('python');
        }
        if (lowerQuery.includes('java')) {
            fileTypes.push('java');
        }
        if (lowerQuery.includes('go')) {
            fileTypes.push('go');
        }

        return fileTypes;
    }

    extractSearchTerms(query: string): string[] {
        if (!query || typeof query !== 'string') {
            return [];
        }

        const stopWords = new Set([
            'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 
            'of', 'with', 'by', 'from', 'about', 'as', 'into', 'through', 'during', 'how',
            'what', 'where', 'when', 'why', 'which', 'who', 'me', 'my', 'find', 'show',
            'get', 'does', 'do', 'this', 'that', 'these', 'those', 'can', 'could', 'would'
        ]);

        return query
            .trim()
            .toLowerCase()
            .split(/\W+/)
            .filter(word => word && word.length > 2 && !stopWords.has(word))
            .map(word => this.stemmer.stem(word)); // Apply stemming to normalize plural/singular forms
    }
}
