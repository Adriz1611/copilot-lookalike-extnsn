import * as vscode from 'vscode';
import {
    IWorkspace,
    ITextDocument,
    IFileSystem,
    IProgress,
    ICancellationToken
} from '../types';

// Adapter to abstract VSCode APIs
export class VSCodeWorkspaceAdapter implements IWorkspace {
    constructor(private workspaceFolder: vscode.WorkspaceFolder) {}

    async findFiles(pattern: string, exclude: string): Promise<string[]> {
        const files = await vscode.workspace.findFiles(pattern, exclude);
        return files.map(f => f.fsPath);
    }

    async openTextDocument(path: string): Promise<ITextDocument> {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        return new VSCodeTextDocumentAdapter(doc);
    }

    getWorkspacePath(): string | undefined {
        return this.workspaceFolder.uri.fsPath;
    }
}

export class VSCodeTextDocumentAdapter implements ITextDocument {
    constructor(private document: vscode.TextDocument) {}

    get uri() {
        return { fsPath: this.document.uri.fsPath };
    }

    get languageId() {
        return this.document.languageId;
    }

    getText(): string {
        return this.document.getText();
    }

    lineAt(line: number) {
        return this.document.lineAt(line);
    }

    positionAt(offset: number) {
        return this.document.positionAt(offset);
    }
}

export class VSCodeProgressAdapter implements IProgress {
    constructor(
        private progress: vscode.Progress<{ message?: string; increment?: number }>
    ) {}

    report(message: string): void {
        this.progress.report({ message });
    }
}

export class VSCodeCancellationTokenAdapter implements ICancellationToken {
    constructor(private token: vscode.CancellationToken) {}

    get isCancellationRequested(): boolean {
        return this.token.isCancellationRequested;
    }

    onCancellationRequested(listener: () => void): void {
        this.token.onCancellationRequested(listener);
    }
}

export class FileSystemAdapter implements IFileSystem {
    async readFile(path: string): Promise<string> {
        const fs = await import('fs');
        return fs.promises.readFile(path, 'utf8');
    }

    async writeFile(path: string, content: string): Promise<void> {
        const fs = await import('fs');
        await fs.promises.writeFile(path, content, 'utf8');
    }

    exists(path: string): boolean {
        const fs = require('fs');
        return fs.existsSync(path);
    }

    stat(path: string): { size: number } {
        const fs = require('fs');
        return fs.statSync(path);
    }

    createReadStream(path: string): any {
        const fs = require('fs');
        return fs.createReadStream(path);
    }
}
