/**
 * The API-key check this package applies before it puts a key in an HTTP header. It restates
 * `@deepseek-ai/dsh-llm`'s `normalizeApiKey` transport invariant locally: trim surrounding
 * whitespace, then require printable ASCII with no space. The rule stays local because a tool
 * package should not acquire the whole LLM capability to reuse one regular expression.
 * @module @deepseek-ai/dsh-tool-typesafe/api-key
 */

/**
 * Characters an HTTP header value carries verbatim and every known provider key uses: printable
 * ASCII, space excluded. `fetch` refuses to build a header outside this set, so a key that fails
 * here would otherwise surface as an opaque `401`.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * Judge one supplied API key, trimming surrounding whitespace first, and name where the key came
 * from instead of echoing it.
 * @param raw - the key exactly as configured, stored, or typed.
 * @param ref - the credential reference or configuration field the value came from.
 * @returns the trimmed, usable key.
 * @throws Error when the key is blank or carries characters no HTTP header can transport. The
 *   message names `ref`; the key value never enters it.
 */
export function assertUsableApiKey(raw: string, ref: string): string {
  const value = raw.trim()
  if (value.length === 0) {
    throw new Error(`tool-typesafe: the TypeSafe API key from ${ref} is blank; set ${ref} to the raw key`)
  }
  if (!LEGAL_API_KEY.test(value)) {
    throw new Error(
      `tool-typesafe: the TypeSafe API key from ${ref} contains characters no HTTP header can carry;`
      + ` set ${ref} to the raw key alone`,
    )
  }
  return value
}
