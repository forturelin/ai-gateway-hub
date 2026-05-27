/**
 * Anthropic prompt caching 命中率测试
 *
 * 思路:
 * - system 是一段 ~1500 tokens 的代码评审规范(标 cache_control: ephemeral)
 * - 第一轮代码 A → 期望 cache_creation_input_tokens > 0
 * - 第二轮代码 B(同 system,不同 user) → 期望 cache_read_input_tokens > 0
 * - 通过 ai-gateway-hub 本地 SK 走 anthropic 路由(本地Anthropics mapping)
 */

const SK = 'sk-local-TuoUANfgvENdaHF-UfJj9rMJrojf27Ag-h3qBCmsLM0';
const URL = 'http://127.0.0.1:44559/v1/messages';
const MODEL = 'claude-opus-4-7';

// 1500+ tokens 代码评审规范(英文,token 密度高,占位足够)
const SYSTEM_TEXT = `You are a senior code reviewer with 15+ years of experience across multiple language stacks (TypeScript, Python, Go, Rust, Java, C++). You produce thorough, actionable code reviews following the rubric below.

# Review Rubric

## 1. Correctness (P0)
- Off-by-one errors, integer overflow, signed/unsigned mismatches
- Null / undefined / None safety; optional chaining usage
- Race conditions, deadlocks, TOCTOU issues in concurrent code
- Resource leaks: file handles, sockets, DB connections, event listeners
- Error handling: swallowed exceptions, error code propagation, retry logic
- Edge cases: empty inputs, single-element collections, max int boundaries
- Floating point comparison, NaN handling

## 2. Security (P0)
- SQL injection, command injection, XSS, CSRF surfaces
- Insecure deserialization, prototype pollution
- Hardcoded secrets, weak crypto (MD5, SHA1, ECB)
- Path traversal, unsafe file operations
- Authentication & authorization checks
- Input validation and sanitization
- Dependency CVEs (note version if obviously old)

## 3. Performance (P1)
- Algorithmic complexity (Big-O); avoid O(n^2) where O(n log n) suffices
- Database query patterns: N+1, missing indexes, unbounded scans
- Memory allocation in hot paths; object pooling opportunities
- Async/await misuse causing accidental serialization
- Caching opportunities; TTL and invalidation strategy
- Network round-trips; batching and HTTP/2 multiplexing
- CPU-bound work on event loop / main thread

## 4. Readability (P1)
- Naming: descriptive, consistent, no abbreviations except well-known
- Function length: ideally <50 lines, definitely <100
- Cyclomatic complexity: <10 per function
- Comments explain WHY not WHAT; outdated comments are worse than none
- Magic numbers and strings; extract constants
- Nested conditionals: prefer early returns and guard clauses

## 5. Maintainability (P1)
- Single Responsibility: one reason to change
- DRY without over-abstracting; rule of three
- Dependency injection vs hardcoded instantiation
- Test coverage and testability of the new code
- Backwards compatibility with existing callers
- Migration path for breaking changes
- Logging and observability hooks

## 6. Style (P2)
- Linter / formatter compliance (eslint, ruff, gofmt, rustfmt)
- Import order and grouping
- Trailing whitespace, line endings, file encoding
- Consistent quote style and indentation
- Idiomatic constructs for the language

# Output Format

For each issue found, produce:
- **Severity**: P0 (must fix), P1 (should fix), P2 (nice to have)
- **Category**: from sections above
- **Location**: file:line or function name
- **Issue**: what is wrong
- **Why**: impact, attack vector, or user-visible consequence
- **Fix**: concrete code change or pseudo-code

Then end with a one-paragraph SUMMARY and a verdict line:
\`VERDICT: APPROVE | APPROVE_WITH_NITS | REQUEST_CHANGES | BLOCK\`

Always be concrete. Quote line ranges. If you would rewrite a block, show the rewrite. Avoid vague advice like "consider refactoring" without specifying what and how. If the code looks fine, say so explicitly and explain why it satisfies the rubric.`;

const CODE_A = `function findDuplicates(arr) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] === arr[j] && !result.includes(arr[i])) {
        result.push(arr[i]);
      }
    }
  }
  return result;
}`;

const CODE_B = `async function fetchAll(urls) {
  const results = [];
  for (const url of urls) {
    const resp = await fetch(url);
    const data = await resp.json();
    results.push(data);
  }
  return results;
}`;

async function send(userText, label) {
    const body = {
        model: MODEL,
        max_tokens: 600,
        system: [
            { type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
            { role: 'user', content: `Review this code per the rubric. Be brief — top 3 issues only.\n\n\`\`\`js\n${userText}\n\`\`\`` }
        ],
        stream: false
    };
    const t0 = Date.now();
    const resp = await fetch(URL, {
        method: 'POST',
        headers: {
            'x-api-key': SK,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const elapsed = Date.now() - t0;
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { console.error('[' + label + '] non-JSON:', text.slice(0, 500)); return null; }
    if (!resp.ok) {
        console.error(`[${label}] HTTP ${resp.status}`, JSON.stringify(json).slice(0, 500));
        return null;
    }
    const u = json.usage || {};
    console.log(`\n[${label}] HTTP ${resp.status}  ${elapsed}ms`);
    console.log(`  input_tokens         : ${u.input_tokens}`);
    console.log(`  output_tokens        : ${u.output_tokens}`);
    console.log(`  cache_creation_input : ${u.cache_creation_input_tokens || 0}`);
    console.log(`  cache_read_input     : ${u.cache_read_input_tokens || 0}`);
    const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const cached = u.cache_read_input_tokens || 0;
    if (total > 0) console.log(`  cache hit ratio      : ${(cached / total * 100).toFixed(1)}%  (cached/total-input)`);
    return u;
}

(async () => {
    console.log('=== Round 1: code A (cold cache, expect cache_creation > 0) ===');
    const u1 = await send(CODE_A, 'R1');

    // 立刻发第二轮,5min TTL 内绝对命中
    console.log('\n=== Round 2: code B (warm cache, expect cache_read > 0) ===');
    const u2 = await send(CODE_B, 'R2');

    console.log('\n=== Verdict ===');
    if (!u1 || !u2) { console.log('test failed (HTTP error)'); process.exit(1); }
    const created = u1.cache_creation_input_tokens || 0;
    const read = u2.cache_read_input_tokens || 0;
    if (created > 0 && read > 0) {
        console.log(`✓ Cache works:  R1 created ${created} tokens → R2 read ${read} tokens`);
        const r2_total = (u2.input_tokens || 0) + (u2.cache_creation_input_tokens || 0) + read;
        console.log(`  R2 hit rate = ${(read / r2_total * 100).toFixed(1)}%`);
    } else if (created > 0 && read === 0) {
        console.log(`✗ R1 created cache (${created}) but R2 missed it. Possible reasons: TTL expired, system text differs, upstream re-routed to different node.`);
    } else if (created === 0) {
        console.log(`✗ R1 did not create cache. system content may be too short (need ≥1024 tokens) or upstream stripped cache_control.`);
    }
})();
