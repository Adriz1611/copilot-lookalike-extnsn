import { SecretPattern, ContextGraph } from '../types';

export class SecuritySanitizer {
    private patterns: SecretPattern[];

    constructor() {
        this.patterns = this.getSecretPatterns();
    }

    private getSecretPatterns(): SecretPattern[] {
        return [
            {
                name: 'Generic API Key',
                pattern: /(?:api[_-]?key|apikey|api[_-]?secret)[\s]*[=:]['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
                severity: 'high'
            },
            {
                name: 'AWS Access Key',
                pattern: /(AKIA[0-9A-Z]{16})/g,
                severity: 'high'
            },
            {
                name: 'Private Key',
                pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
                severity: 'high'
            },
            {
                name: 'Database Connection String',
                pattern: /(postgres|mysql|mongodb):\/\/[^\s]+/gi,
                severity: 'high'
            },
            {
                name: 'JWT Token',
                pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
                severity: 'medium'
            },
            {
                name: 'Base64 String (long)',
                pattern: /(?:secret|password|token|key)[\s]*[=:]['"]?([A-Za-z0-9+/]{40,}={0,2})['"]?/gi,
                severity: 'medium'
            },
            {
                name: 'OAuth Token',
                pattern: /(?:oauth|bearer)[\s]*[=:]['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
                severity: 'high'
            },
            {
                name: 'GitHub Token',
                pattern: /ghp_[a-zA-Z0-9]{36}/g,
                severity: 'high'
            },
            {
                name: 'Slack Token',
                pattern: /xox[baprs]-[0-9a-zA-Z]{10,48}/g,
                severity: 'high'
            },
            {
                name: 'Password',
                pattern: /(?:password|passwd|pwd)[\s]*[=:]['"]([^'"]{8,})['"]?/gi,
                severity: 'medium'
            },
            {
                name: 'Environment Variable Secret',
                pattern: /process\.env\[['"]([A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|PASS)['"]\])/g,
                severity: 'low'
            }
        ];
    }

    sanitizeText(text: string): string {
        let sanitized = text;
        const detectedSecrets: string[] = [];

        for (const pattern of this.patterns) {
            const matches = text.matchAll(pattern.pattern);
            
            for (const match of matches) {
                const secretValue = match[0];
                const masked = '[REDACTED_' + pattern.name.toUpperCase().replace(/\s+/g, '_') + ']';
                sanitized = sanitized.replace(secretValue, masked);
                detectedSecrets.push(pattern.name + ' (' + pattern.severity + ')');
            }
        }

        if (detectedSecrets.length > 0) {
            console.warn('🔒 Detected and sanitized secrets:', detectedSecrets);
        }

        return sanitized;
    }

    sanitizeContextGraph(graph: ContextGraph): ContextGraph {
        const sanitized: ContextGraph = {
            ...graph,
            nodes: graph.nodes.map(node => ({
                ...node,
                content: node.content ? this.sanitizeText(node.content) : undefined,
                symbols: node.symbols.map(sym => ({
                    ...sym,
                    signature: this.sanitizeText(sym.signature),
                    fullCode: sym.fullCode ? this.sanitizeText(sym.fullCode) : undefined,
                    docstring: sym.docstring ? this.sanitizeText(sym.docstring) : undefined
                }))
            }))
        };

        return sanitized;
    }
}
