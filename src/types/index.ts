// Shared type definitions

export interface GraphConfig {
    maxDepth: number;
    useSkeletonMode: boolean;
    maxFileSize: number;
    batchSize: number;
    streamingThreshold: number;
}

export interface PathAliasConfig {
    aliases: { [alias: string]: string };
    baseUrl: string;
    nodeModulesPath: string;
}

export interface BatchProcessingState {
    processed: number;
    total: number;
    currentBatch: GraphNode[];
}

export interface GraphNode {
    filePath: string;
    language: string;
    depth: number;
    content?: string;
    symbols: SymbolNode[];
    imports: ImportNode[];
}

export interface SymbolNode {
    name: string;
    kind: string;
    signature: string;
    fullCode?: string;
    docstring?: string;
    location: {
        line: number;
        character: number;
    };
    referencedBy: string[];
}

export interface ImportNode {
    importPath: string;
    resolvedPath?: string;
    symbols: string[];
}

export interface ContextGraph {
    generated: string;
    anchor: string;
    config: GraphConfig;
    nodes: GraphNode[];
    callGraph: CallEdge[];
}

export interface QuickIndex {
    _description: string;
    generated: string;
    workspace: string;
    summary: {
        totalFiles: number;
        totalSymbols: number;
        languages: { [key: string]: number };
    };
    filesByDirectory: { [directory: string]: QuickFileEntry[] };
}

export interface QuickFileEntry {
    path: string;
    language: string;
    symbols: string[];
}

export interface SearchIndex {
    _description: string;
    generated: string;
    workspace: string;
    summary: {
        totalSymbols: number;
        totalImports: number;
        topFiles: { path: string; symbolCount: number }[];
    };
    symbolLocations: SymbolLocation[];
    importMap: ImportMapping[];
    fileMetadata: FileMetadata[];
}

export interface SymbolLocation {
    symbol: string;
    type: string;
    file: string;
    line: number;
    signature: string;
}

export interface ImportMapping {
    file: string;
    imports: { from: string; symbols: string[] }[];
}

export interface FileMetadata {
    path: string;
    language: string;
    size: number;
    symbolCount: number;
}

export interface CallEdge {
    from: string;
    to: string;
    symbol: string;
}

export interface IndexingError {
    file: string;
    error: string;
    timestamp: string;
    phase: 'scanning' | 'parsing' | 'symbolExtraction' | 'importResolution';
}

export interface IndexingReport {
    totalFiles: number;
    successfulFiles: number;
    skippedFiles: number;
    errors: IndexingError[];
    duration: number;
    timestamp: string;
}

export interface FileHash {
    path: string;
    hash: string;
    lastIndexed: string;
}

export interface IncrementalIndex {
    version: string;
    lastFullIndex: string;
    fileHashes: FileHash[];
}

export interface QueryContext {
    query: string;
    intent: 'search' | 'definition' | 'references' | 'callGraph';
    entities: string[];
    filters: {
        fileTypes?: string[];
        directories?: string[];
    };
}

export interface SecretPattern {
    name: string;
    pattern: RegExp;
    severity: 'high' | 'medium' | 'low';
}

// VSCode abstraction interfaces
export interface IFileSystem {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    exists(path: string): boolean;
    stat(path: string): { size: number };
    createReadStream(path: string): any;
}

export interface IWorkspace {
    findFiles(pattern: string, exclude: string): Promise<string[]>;
    openTextDocument(path: string): Promise<ITextDocument>;
    getWorkspacePath(): string | undefined;
}

export interface ITextDocument {
    uri: { fsPath: string };
    languageId: string;
    getText(): string;
    lineAt(line: number): { text: string };
    positionAt(offset: number): { line: number; character: number };
}

export interface IProgress {
    report(message: string): void;
}

export interface ICancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): void;
}
