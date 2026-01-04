import * as crypto from 'crypto';
import * as fs from 'fs';

export class FileHasher {
    static async calculateHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    static async calculateMultipleHashes(filePaths: string[]): Promise<Map<string, string>> {
        const hashes = new Map<string, string>();
        
        for (const filePath of filePaths) {
            try {
                const hash = await this.calculateHash(filePath);
                hashes.set(filePath, hash);
            } catch (error) {
                console.error(`Failed to hash ${filePath}:`, error);
            }
        }
        
        return hashes;
    }
}
