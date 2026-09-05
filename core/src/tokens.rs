//! Token usage accounting.
//!
//! Preferred source: the provider's own `usage` numbers. When a provider does not
//! report usage we estimate (marked with `estimated = true` and shown with `~` in the
//! UI). With the optional `tiktoken` feature (enabled for packaged builds) OpenAI-family
//! requests use tiktoken-rs; otherwise a chars/4 heuristic is used.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub estimated: bool,
}

pub fn estimate(text: &str) -> u64 {
    #[cfg(feature = "tiktoken")]
    {
        if !text.is_empty() {
            if let Ok(bpe) = tiktoken_rs::cl100k_base() {
                return bpe.encode_with_special_tokens(text).len() as u64;
            }
        }
    }
    // ~4 characters per token is a solid cross-model approximation for latin scripts;
    // CJK text averages closer to ~1.5 chars/token, so weight non-ASCII more.
    let chars = text.chars().count() as u64;
    let cjk = text.chars().filter(|c| (*c as u32) >= 0x2E80).count() as u64;
    let latin = chars - cjk;
    latin / 4 + cjk * 2 / 3 + 1
}

/// Combine prompt-usage across a request built from many messages.
pub fn estimate_prompt(messages: &[String]) -> u64 {
    messages.iter().map(|m| estimate(m)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_is_monotonic_and_reasonable() {
        assert_eq!(estimate(""), 1);
        let short = "hello world";
        let long = short.repeat(100);
        assert!(estimate(short) < estimate(long.as_str()));
        // Roughly: 11 latin chars → ~3 tokens (+1)
        assert!(estimate(short) >= 3 && estimate(short) <= 5);
        // CJK weights higher per character
        assert!(estimate("你好世界") > estimate("abcd"));
    }
}
