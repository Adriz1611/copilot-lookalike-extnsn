/**
 * QueryIntentGraph - Projects natural language queries into virtual graph space
 * 
 * Creates a ContextGraph-compatible virtual representation of query intent.
 * This is NOT a real code graph - it's a semantic projection used for relevance scoring.
 * All nodes are marked as generated/virtual and do not represent actual files or ASTs.
 * 
 * The Query Intent Graph enables graph-aware relevance scoring by projecting
 * query semantics into the same graph structure used for code, enabling
 * structural similarity comparisons.
 */

const natural = require('natural');
import { GraphNode, SymbolNode, ImportNode, ContextGraph, CallEdge } from '../types';
import { QueryAnalyzer } from '../search/QueryAnalyzer';

interface QueryIntent {
    primaryAction: string; // 'find', 'show', 'explain', 'how', 'where', 'what'
    targetEntities: string[]; // Key nouns/entities
    relationshipType?: string; // 'calls', 'uses', 'implements', 'extends'
    modifiers: string[]; // Adjectives/qualifiers
    scope?: string; // File type, directory hints
}

interface IntentNode {
    type: 'entity' | 'action' | 'relationship' | 'modifier';
    value: string;
    weight: number; // Semantic importance 0-1
    connections: string[]; // Related intent nodes
}

/**
 * Virtual graph representing query intent in ContextGraph-compatible format
 * Marked as generated and does not represent real code structures
 */
export interface VirtualQueryGraph extends ContextGraph {
    _virtual: true; // Explicit marker that this is NOT real code
    _querySource: string; // Original query text
    _intentType: string; // Primary intent classification
}

export class QueryIntentGraphBuilder {
    private tokenizer: any;
    private tfidf: any;
    private stemmer: any;
    private queryAnalyzer: QueryAnalyzer;

    // Domain-specific vocabulary for code semantics
    private codeActions = ['find', 'show', 'explain', 'get', 'list', 'describe', 'how', 'where', 'what', 'why'];
    private codeRelations = ['calls', 'uses', 'implements', 'extends', 'imports', 'depends', 'references'];
    private codeEntities = ['function', 'class', 'method', 'variable', 'type', 'interface', 'component', 'module'];

    constructor() {
        this.tokenizer = new natural.WordTokenizer();
        this.tfidf = new natural.TfIdf();
        this.stemmer = natural.PorterStemmer;
        this.queryAnalyzer = new QueryAnalyzer();
    }

    /**
     * Build a virtual query intent graph from natural language query
     * Returns ContextGraph-compatible structure marked as virtual
     */
    public buildQueryIntentGraph(query: string): VirtualQueryGraph {
        const intent = this.analyzeIntent(query);
        const intentNodes = this.extractIntentNodes(query, intent);
        const virtualGraphNodes = this.projectToGraphNodes(intentNodes, intent);
        const virtualCallGraph = this.projectToCallGraph(intentNodes, intent);

        return {
            _virtual: true,
            _querySource: query,
            _intentType: intent.primaryAction,
            generated: new Date().toISOString(),
            anchor: '[QUERY_INTENT_GRAPH]',
            config: {
                maxDepth: 1,
                useSkeletonMode: true,
                maxFileSize: 0,
                batchSize: 0,
                streamingThreshold: 0
            },
            nodes: virtualGraphNodes,
            callGraph: virtualCallGraph
        };
    }

    /**
     * Analyze query to extract intent structure
     */
    private analyzeIntent(query: string): QueryIntent {
        const tokens = this.tokenizer.tokenize(query.toLowerCase());
        const posTags = this.getPOSTags(tokens);
        
        const action = this.extractPrimaryAction(tokens, posTags);
        const entities = this.extractEntities(tokens, posTags);
        const relationship = this.extractRelationship(tokens);
        const modifiers = this.extractModifiers(tokens, posTags);
        const scope = this.extractScope(query);

        return {
            primaryAction: action,
            targetEntities: entities,
            relationshipType: relationship,
            modifiers,
            scope
        };
    }

    /**
     * Extract intent nodes with semantic weights
     */
    private extractIntentNodes(query: string, intent: QueryIntent): IntentNode[] {
        const nodes: IntentNode[] = [];

        // Add action node
        nodes.push({
            type: 'action',
            value: intent.primaryAction,
            weight: 0.9,
            connections: intent.targetEntities
        });

        // Add entity nodes
        for (const entity of intent.targetEntities) {
            nodes.push({
                type: 'entity',
                value: entity,
                weight: 0.8,
                connections: intent.relationshipType ? [intent.relationshipType] : []
            });
        }

        // Add relationship node if present
        if (intent.relationshipType) {
            nodes.push({
                type: 'relationship',
                value: intent.relationshipType,
                weight: 0.7,
                connections: intent.targetEntities
            });
        }

        // Add modifier nodes
        for (const modifier of intent.modifiers) {
            nodes.push({
                type: 'modifier',
                value: modifier,
                weight: 0.5,
                connections: []
            });
        }

        return nodes;
    }

    /**
     * Project intent nodes into GraphNode format (virtual, not real code)
     */
    private projectToGraphNodes(intentNodes: IntentNode[], intent: QueryIntent): GraphNode[] {
        return intentNodes
            .filter(node => node.type === 'entity' || node.type === 'action')
            .map((node, index) => ({
                filePath: `[VIRTUAL:${node.type}:${node.value}]`,
                language: 'query-intent',
                depth: 0,
                symbols: this.projectToSymbols(node, intentNodes),
                imports: this.projectToImports(node, intentNodes)
            }));
    }

    /**
     * Project intent nodes into virtual symbols
     */
    private projectToSymbols(node: IntentNode, allNodes: IntentNode[]): SymbolNode[] {
        return [{
            name: node.value,
            kind: this.mapIntentTypeToSymbolKind(node.type),
            signature: `[Intent: ${node.type}] ${node.value}`,
            location: { line: 0, character: 0 },
            referencedBy: node.connections,
            docstring: `Query intent node (weight: ${node.weight})`
        }];
    }

    /**
     * Project connections as virtual imports
     */
    private projectToImports(node: IntentNode, allNodes: IntentNode[]): ImportNode[] {
        return node.connections.map(conn => ({
            importPath: `[VIRTUAL:${conn}]`,
            symbols: [conn]
        }));
    }

    /**
     * Project relationships as virtual call graph
     */
    private projectToCallGraph(intentNodes: IntentNode[], intent: QueryIntent): CallEdge[] {
        const edges: CallEdge[] = [];

        // Create edges between action and entities
        const actionNode = intentNodes.find(n => n.type === 'action');
        if (actionNode) {
            for (const entity of intent.targetEntities) {
                edges.push({
                    from: actionNode.value,
                    to: entity,
                    symbol: entity
                });
            }
        }

        // Create edges for relationships
        if (intent.relationshipType) {
            for (let i = 0; i < intent.targetEntities.length - 1; i++) {
                edges.push({
                    from: intent.targetEntities[i],
                    to: intent.targetEntities[i + 1],
                    symbol: intent.relationshipType
                });
            }
        }

        return edges;
    }

    private extractPrimaryAction(tokens: string[], posTags: string[]): string {
        // Find verbs or known action words
        for (let i = 0; i < tokens.length; i++) {
            if (this.codeActions.includes(tokens[i]) || posTags[i].startsWith('VB')) {
                return tokens[i];
            }
        }
        return 'find'; // Default action
    }

    private extractEntities(tokens: string[], posTags: string[]): string[] {
        const entities: string[] = [];
        
        for (let i = 0; i < tokens.length; i++) {
            // Extract nouns and code-specific terms
            if (posTags[i].startsWith('NN') || this.codeEntities.includes(tokens[i])) {
                entities.push(tokens[i]);
            }
            // Extract camelCase or snake_case identifiers
            if (this.isIdentifier(tokens[i])) {
                entities.push(tokens[i]);
            }
        }

        return [...new Set(entities)]; // Deduplicate
    }

    private extractRelationship(tokens: string[]): string | undefined {
        for (const token of tokens) {
            if (this.codeRelations.includes(token)) {
                return token;
            }
        }
        return undefined;
    }

    private extractModifiers(tokens: string[], posTags: string[]): string[] {
        const modifiers: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            if (posTags[i].startsWith('JJ')) { // Adjectives
                modifiers.push(tokens[i]);
            }
        }
        return modifiers;
    }

    private extractScope(query: string): string | undefined {
        const fileTypePatterns = /\.(ts|js|py|java|go|rs|cpp|tsx|jsx)/;
        const match = query.match(fileTypePatterns);
        return match ? match[1] : undefined;
    }

    private getPOSTags(tokens: string[]): string[] {
        // Simple POS tagging using natural library
        // Use default lexicon and ruleset
        try {
            const tagger = new natural.BrillPOSTagger(
                new natural.Lexicon('EN', 'N'),
                new natural.RuleSet('EN')
            );
            const taggedWords = tagger.tag(tokens);
            return taggedWords.taggedWords.map((tw: any) => tw.tag);
        } catch (error) {
            // Fallback: simple heuristic tagging
            return tokens.map(t => t.match(/^[A-Z]/) ? 'NNP' : 'NN');
        }
    }

    private isIdentifier(token: string): boolean {
        // Detect camelCase, PascalCase, snake_case
        return /^[a-z][a-zA-Z0-9]*$/.test(token) || 
               /^[A-Z][a-zA-Z0-9]*$/.test(token) ||
               /^[a-z_][a-z0-9_]*$/.test(token);
    }

    private mapIntentTypeToSymbolKind(intentType: string): string {
        const mapping: { [key: string]: string } = {
            'entity': 'Class',
            'action': 'Function',
            'relationship': 'Interface',
            'modifier': 'Variable'
        };
        return mapping[intentType] || 'Unknown';
    }

    /**
     * Compute semantic similarity between query graph and code graph
     * Returns similarity score 0-1
     */
    public computeGraphSimilarity(
        queryGraph: VirtualQueryGraph,
        codeGraph: ContextGraph
    ): number {
        // Compare graph structures: node overlap, edge patterns, etc.
        const querySymbols = new Set(
            queryGraph.nodes.flatMap(n => n.symbols.map(s => s.name.toLowerCase()))
        );
        const codeSymbols = new Set(
            codeGraph.nodes.flatMap(n => n.symbols.map(s => s.name.toLowerCase()))
        );

        const intersection = new Set([...querySymbols].filter(x => codeSymbols.has(x)));
        const union = new Set([...querySymbols, ...codeSymbols]);

        const symbolSimilarity = intersection.size / union.size;

        // Compare call graph patterns
        const queryEdgePatterns = new Set(queryGraph.callGraph.map(e => `${e.from}->${e.to}`));
        const codeEdgePatterns = new Set(codeGraph.callGraph.map(e => `${e.from}->${e.to}`));
        
        const edgeIntersection = new Set([...queryEdgePatterns].filter(x => codeEdgePatterns.has(x)));
        const edgeUnion = new Set([...queryEdgePatterns, ...codeEdgePatterns]);
        
        const edgeSimilarity = edgeUnion.size > 0 ? edgeIntersection.size / edgeUnion.size : 0;

        // Weighted combination
        return 0.7 * symbolSimilarity + 0.3 * edgeSimilarity;
    }
}
