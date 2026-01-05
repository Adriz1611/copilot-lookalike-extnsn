# LogicGraph - Copilot-like Codebase Intelligence Extension

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.75.0+-green.svg)](https://code.visualstudio.com/)

**A VS Code extension that mimics GitHub Copilot's intelligent code search using hybrid retrieval, semantic embeddings, and graph-aware ranking.**

---

## 🎯 Concept

LogicGraph combines **lexical matching** (BM25), **semantic understanding** (transformer embeddings), and **structural analysis** (call graphs + Tree-sitter AST) to provide Copilot-like contextual code search.

### Intuition

Traditional search matches keywords. LogicGraph understands:

- **Meaning**: "find authentication logic" matches `verifyUser()` even without exact terms
- **Context**: Prioritizes symbols based on call graph relationships
- **Structure**: Uses AST to understand code syntax beyond LSP capabilities
- **Relevance**: Combines multiple signals (lexical, semantic, structural) for ranking

---

## 🧠 Core Algorithms

### 1. **BM25 Lexical Retrieval**

**Purpose:** Probabilistic keyword matching

**Formula:**

```
BM25(q,d) = Σ IDF(qi) × (tf(qi,d) × (k1 + 1)) / (tf(qi,d) + k1 × (1 - b + b × |d|/avgdl))
```

**Parameters:**

- `k1 = 1.5` (term frequency saturation)
- `b = 0.75` (length normalization)

**Optimizations:**

- Porter Stemmer for plural/singular matching (`contacts` → `contact`)
- camelCase/snake_case splitting before tokenization
- Inverted index for O(1) candidate retrieval

---

### 2. **Semantic Retrieval (Transformers)**

**Purpose:** Understanding query meaning beyond keywords

**Model:** `Xenova/all-MiniLM-L6-v2` (384-dimensional embeddings)

**Similarity:**

```
cosine_similarity(q, d) = (q · d) / (||q|| × ||d||)
```

**Text Representation:**

```typescript
"type symbolName signature in file";
// Example: "Function getUserById function getUserById(id: string): User in src/api.ts"
```

**Optimizations:**

- Parallel batch embedding (8x faster than sequential)
- Batch size: 32 symbols per iteration
- Scores normalized to [0, 1]

---

### 3. **Hybrid Reranking**

**Purpose:** Combine lexical and semantic signals

**Weighted Combination:**

```
hybrid_score = 0.4 × BM25_normalized + 0.6 × semantic_score
```

**Reciprocal Rank Fusion (RRF):**

```
RRF(rank1, rank2) = 1/(k + rank1) + 1/(k + rank2)  where k=60
```

**Score Normalization:**

- BM25: Linear normalization via `maxScore = max_IDF × max_TF_term`
- Semantic: Map [-1,1] cosine to [0,1]

---

### 4. **Graph-Aware Scoring**

**Purpose:** Leverage code structure for relevance

**Scoring Components:**

```
graph_score = 0.6 × direct_match + 0.3 × distance_score + 0.1 × centrality
```

- **Direct match:** Query terms match symbol name
- **Distance score:** `1 / (1 + path_length)` to query symbols
- **Centrality:** Degree centrality (more connections = more important)

---

### 5. **Tree-sitter Syntactic Enhancement**

**Purpose:** AST-level analysis beyond LSP

**Extracts:**

- Nested function calls inside expressions
- Lambda/arrow function relationships
- Method chaining patterns
- Control flow edges (if/switch/loop calls)

**Languages:** TypeScript, JavaScript, Python

---

### 6. **NLP Query Intent Analysis**

**Purpose:** Understand user's search intent

**Techniques:**

- POS tagging (nouns, verbs, adjectives)
- Porter Stemmer normalization
- Intent classification: DECLARATIVE, INTERROGATIVE, IMPERATIVE
- Entity extraction for key symbols/types

---

## 🔄 Pipeline

```
┌─────────────────┐
│  User Query     │
│ "find login"    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Query Analysis  │ ← NLP + POS tagging + Stemming
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐  ┌──────────┐
│  BM25  │  │ Semantic │ ← Parallel retrieval
└───┬────┘  └────┬─────┘
    │            │
    └─────┬──────┘
          ▼
   ┌──────────────┐
   │   Hybrid     │ ← RRF fusion + Weighted combination
   │  Reranking   │
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │ Graph-Aware  │ ← Call graph + Tree-sitter context
   │   Scoring    │
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │   Top-K      │
   │   Results    │
   └──────────────┘
```

---

## 🛠️ Tools & Technologies

### Core Libraries

- **@xenova/transformers** `v2.17.2` - Semantic embeddings (ONNX runtime)
- **tree-sitter** `v0.21.1` - AST parsing (JavaScript, TypeScript, Python)
- **natural** `v8.1.0` - NLP (Porter Stemmer, POS tagging)
- **fuse.js** `v7.1.0` - Fuzzy search fallback

### Parsing & Analysis

- **@typescript-eslint/parser** - TypeScript/JavaScript AST
- **VS Code LSP** - Symbol extraction (functions, classes, types)

### Optimization

- **SHA-256 hashing** - Incremental update detection
- **Batch processing** - Memory-efficient indexing (50 files/batch)
- **Parallel embeddings** - 8x faster than sequential

---

## 📊 Mathematical Details

### BM25 Score Normalization

```typescript
// Theoretical max for corpus
maxScore = maxIDF × (maxTF × (k1 + 1)) / (maxTF + k1 × (1 - b + b × (minDocLen / avgDocLen)))

// Normalize to [0, 1]
normalized = min(1.0, score / maxScore)
```

### Semantic Similarity (Cosine)

```typescript
// Dot product of normalized vectors
similarity = Σ(qi × di) for i in [0, 384]

// Already in [-1, 1], map to [0, 1]
score = (similarity + 1) / 2
```

### Graph Distance Scoring

```typescript
// Shortest path via BFS
distance = shortestPath(symbolA, symbolB);

// Decay function
relevance = 1 / (1 + distance);
```

---

## 🚀 Usage

1. **Index codebase:** `Cmd+Shift+P` → "LogicGraph: Generate Index"
2. **Search:** `Cmd+Shift+P` → "LogicGraph: Query Codebase"
3. **Query examples:**
   - "find authentication logic"
   - "show database connection"
   - "user validation functions"

---

## 📈 Performance

- **Indexing:** ~500 files/sec (with Tree-sitter)
- **Query:** <500ms for 10k symbols
- **Semantic embedding:** ~8ms/symbol (batched)
- **BM25 retrieval:** <100ms for 100k tokens

---

## 🔒 Security

- Sanitizes secrets (11 patterns: API keys, AWS, JWT, etc.)
- Input validation (500 char limit on queries)
- Error boundaries with graceful degradation

---

## 📝 License

MIT
