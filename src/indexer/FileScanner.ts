import ignore from 'ignore';
import * as fs from 'fs';
import * as path from 'path';
import { ICancellationToken } from '../types';

export class FileScanner {
    private gitignoreCache: Map<string, ReturnType<typeof ignore>> = new Map();

    async findCodeFiles(
        workspacePath: string,
        cancellationToken?: ICancellationToken
    ): Promise<string[]> {
        const patterns = [
            '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
            '**/*.py', '**/*.java', '**/*.c', '**/*.cpp',
            '**/*.h', '**/*.hpp', '**/*.go', '**/*.rs',
            '**/*.cs', '**/*.php', '**/*.rb', '**/*.swift',
            '**/*.kt', '**/*.scala', '**/*.vue', '**/*.svelte'
        ];

        const ig = await this.loadGitignorePatterns(workspacePath);
        const allFiles: string[] = [];

        for (const pattern of patterns) {
            if (cancellationToken?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            const files = await this.glob(workspacePath, pattern);
            allFiles.push(...files);
        }

        const filteredFiles = allFiles.filter(filePath => {
            const relativePath = path.relative(workspacePath, filePath);
            const normalizedPath = relativePath.split(path.sep).join('/');
            return !ig.ignores(normalizedPath);
        });

        return Array.from(new Set(filteredFiles));
    }

    private async glob(basePath: string, pattern: string): Promise<string[]> {
        // Simple glob implementation - in real usage, this would use a proper glob library
        // For now, we'll just walk the directory tree
        const files: string[] = [];
        const extension = pattern.replace('**/*', '');
        
        const walk = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory()) {
                        // Skip common exclude directories
                        if (!['node_modules', '.git', 'dist', 'build', 'out'].includes(entry.name)) {
                            walk(fullPath);
                        }
                    } else if (entry.isFile() && fullPath.endsWith(extension)) {
                        files.push(fullPath);
                    }
                }
            } catch (error) {
                // Skip inaccessible directories
            }
        };

        walk(basePath);
        return files;
    }

    private async loadGitignorePatterns(workspacePath: string): Promise<ReturnType<typeof ignore>> {
        if (this.gitignoreCache.has(workspacePath)) {
            return this.gitignoreCache.get(workspacePath)!;
        }

        const ig = ignore();

        // Default patterns
        ig.add([
            '.git', 'node_modules', '.next', 'dist', 'build', 'out',
            '.output', 'coverage', '.nyc_output', 'venv', '__pycache__',
            '*.pyc', 'target', 'bin', 'obj', '.DS_Store', '*.log',
            '.vscode-test', '.idea'
        ]);

        // Load .gitignore
        const gitignorePath = path.join(workspacePath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf8');
                ig.add(content);
            } catch (error) {
                console.warn('Failed to read .gitignore:', error);
            }
        }

        this.gitignoreCache.set(workspacePath, ig);
        return ig;
    }
}
