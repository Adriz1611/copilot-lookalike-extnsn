import * as crypto from 'crypto';
import * as fs from 'fs';

export class FileHasher {
    static async calculateHash(filePath: string): Promise<string> {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Invalid file path provided');
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            
            let errorOccurred = false;
            
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => {
                if (!errorOccurred) {
                    resolve(hash.digest('hex'));
                }
            });
            stream.on('error', (error) => {
                errorOccurred = true;
                stream.destroy();
                reject(new Error(`Failed to hash file ${filePath}: ${error.message}`));
            });
        });
    }

    static async calculateMultipleHashes(filePaths: string[]): Promise<Map<string, string>> {
        if (!Array.isArray(filePaths)) {
            throw new Error('filePaths must be an array');
        }

        const hashes = new Map<string, string>();
        
        for (const filePath of filePaths) {
            if (!filePath || typeof filePath !== 'string') {
                console.warn('FileHasher: Skipping invalid file path:', filePath);
                continue;
            }

            try {
                const hash = await this.calculateHash(filePath);
                hashes.set(filePath, hash);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`FileHasher: Failed to hash ${filePath}:`, errorMsg);
            }
        }
        
        return hashes;
    }
}
