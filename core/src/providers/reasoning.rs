//! Native reasoning normalization (plan §5.1).
//!
//! Field-based reasoning (`reasoning_content` for DeepSeek-style APIs, `reasoning`
//! string for OpenRouter/xAI, Anthropic `thinking` blocks, Gemini `thought` parts) is
//! handled at the call sites. This module implements the **tag-based** stream filter
//! for models that inline `<think>…</think>` blocks (Qwen3 / R1 distills served by
//! LM Studio and Ollama): text before/after the tags flows to the answer, text inside
//! the tags flows to reasoning. Tag boundaries that span chunk borders are handled by
//! holding back potential partial tags.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Outside,
    Inside,
}

const OPEN_TAG: &str = "<think>";
const CLOSE_TAG: &str = "</think>";

#[derive(Debug, Default)]
pub struct ThinkFilter {
    state: State,
    /// Tail of the previous chunk that might be a partial tag boundary.
    held: String,
}

impl ThinkFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one delta; returns (answer_delta, reasoning_delta).
    pub fn feed(&mut self, delta: &str) -> (String, String) {
        let mut buffer = std::mem::take(&mut self.held);
        buffer.push_str(delta);

        let mut text = String::new();
        let mut reasoning = String::new();

        loop {
            match self.state {
                State::Outside => {
                    let open_at = find_tag(&buffer, OPEN_TAG);
                    let close_at = find_tag(&buffer, CLOSE_TAG);
                    // Drop stray close tags (some models emit a closing tag first) —
                    // but only when no opening tag precedes them.
                    if close_at.is_some_and(|close| !open_at.is_some_and(|open| open < close)) {
                        let at = close_at.unwrap();
                        let (before, rest) = buffer.split_at(at);
                        let after = rest[CLOSE_TAG.len()..].to_string();
                        text.push_str(before);
                        buffer = after;
                        continue;
                    }
                    match open_at {
                        Some(at) => {
                            let (before, rest) = buffer.split_at(at);
                            let after = rest[OPEN_TAG.len()..].to_string();
                            text.push_str(before);
                            self.state = State::Inside;
                            buffer = after;
                        }
                        None => {
                            let keep = partial_tag_suffix_len(&buffer, OPEN_TAG)
                                .max(partial_tag_suffix_len(&buffer, CLOSE_TAG));
                            let split = buffer.len() - keep;
                            let (emit, held) = buffer.split_at(split);
                            text.push_str(emit);
                            self.held = held.to_string();
                            return (text, reasoning);
                        }
                    }
                }
                State::Inside => match find_tag(&buffer, CLOSE_TAG) {
                    Some(at) => {
                        let (before, rest) = buffer.split_at(at);
                        let after = rest[CLOSE_TAG.len()..].to_string();
                        reasoning.push_str(before);
                        self.state = State::Outside;
                        buffer = after;
                    }
                    None => {
                        let keep = partial_tag_suffix_len(&buffer, CLOSE_TAG);
                        let split = buffer.len() - keep;
                        let (emit, held) = buffer.split_at(split);
                        reasoning.push_str(emit);
                        self.held = held.to_string();
                        return (text, reasoning);
                    }
                },
            }
        }
    }

    /// Flush whatever is held at end-of-stream (an unterminated `<think>` keeps its
    /// content classified as reasoning).
    pub fn finish(&mut self) -> (String, String) {
        let held = std::mem::take(&mut self.held);
        match self.state {
            State::Outside => (held, String::new()),
            State::Inside => (String::new(), held),
        }
    }
}

/// Case-insensitive search for `tag`; tags are ASCII so byte-wise search is safe.
fn find_tag(haystack: &str, tag: &str) -> Option<usize> {
    if haystack.len() < tag.len() {
        return None;
    }
    let h = haystack.as_bytes();
    let t = tag.as_bytes();
    (0..=h.len() - t.len()).find(|&i| h[i..i + t.len()].eq_ignore_ascii_case(t))
}

/// How long a suffix of `buffer` is a prefix of `tag` (potential split boundary).
fn partial_tag_suffix_len(buffer: &str, tag: &str) -> usize {
    let b = buffer.as_bytes();
    let t = tag.as_bytes();
    let max = b.len().min(t.len() - 1);
    for length in (1..=max).rev() {
        if b[b.len() - length..].eq_ignore_ascii_case(&t[..length]) {
            return length;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(parts: &[&str]) -> (String, String) {
        let mut filter = ThinkFilter::new();
        let mut text = String::new();
        let mut reasoning = String::new();
        for part in parts {
            let (t, r) = filter.feed(part);
            text.push_str(&t);
            reasoning.push_str(&r);
        }
        let (t, r) = filter.finish();
        text.push_str(&t);
        reasoning.push_str(&r);
        (text, reasoning)
    }

    #[test]
    fn no_tags_passes_through() {
        let (text, reasoning) = collect(&["Merhaba", " dünya"]);
        assert_eq!(text, "Merhaba dünya");
        assert_eq!(reasoning, "");
    }

    #[test]
    fn full_block_is_split() {
        let (text, reasoning) = collect(&["A<think>secret</think>B"]);
        assert_eq!(text, "AB");
        assert_eq!(reasoning, "secret");
    }

    #[test]
    fn tag_split_across_chunks() {
        let (text, reasoning) = collect(&["A<th", "ink>secr", "et</thi", "nk>B"]);
        assert_eq!(text, "AB");
        assert_eq!(reasoning, "secret");
    }

    #[test]
    fn tag_char_by_char() {
        // "<thinkx" is literal text (never a real tag); the stray close tag is dropped.
        let (text, reasoning) = collect(&[
            "<", "t", "h", "i", "n", "k", "x", "<", "/", "t", "h", "i", "n", "k", ">",
        ]);
        assert_eq!(text, "<thinkx");
        assert_eq!(reasoning, "");
    }

    #[test]
    fn stray_close_tag_outside_is_dropped() {
        // Qwen3-style: close tag first, answer after.
        let (text, reasoning) = collect(&["</think>\n\ncevap burada"]);
        assert_eq!(text, "\n\ncevap burada");
        assert_eq!(reasoning, "");
    }

    #[test]
    fn unterminated_block_counts_as_reasoning() {
        let (text, reasoning) = collect(&["a<think>still thinking"]);
        assert_eq!(text, "a");
        assert_eq!(reasoning, "still thinking");
    }

    #[test]
    fn case_insensitive_and_multiple_blocks() {
        let (text, reasoning) = collect(&["a<Think>one</THINK>b<think>two</think>c"]);
        assert_eq!(text, "abc");
        assert_eq!(reasoning, "onetwo");
    }

    #[test]
    fn angle_brackets_outside_are_not_held_back_forever() {
        // "di< "... a lone '<' followed by a non-matching char must flush.
        let mut filter = ThinkFilter::new();
        let (t1, _) = filter.feed("a<b ve ");
        assert_eq!(t1, "a<b ve ");
    }
}
