//! DuckDuckGo HTML search used to give every model (any provider) real-time
//! web results. The engine runs the search before building the prompt and
//! injects a formatted result block, so models never need their own browsing.
//!
//! Parsing is deliberately dependency-free: `html.duckduckgo.com/html` serves a
//! small, stable class-marked document (`result__a`, `result__snippet`), which
//! we scan with plain `str::find` loops. The vendored offline registry does not
//! carry an HTML parser.

use std::time::Duration;

/// One search hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

const MAX_RESULTS: usize = 6;
const HTTP_TIMEOUT_SECS: u64 = 12;

/// Runs the search and returns the top results (empty on any failure — search
/// must never block a chat; callers degrade gracefully).
pub async fn search(query: &str) -> Vec<SearchResult> {
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }
    match fetch(&query).await {
        Ok(html) => parse(&html),
        Err(error) => {
            tracing::warn!(%error, "web search failed");
            Vec::new()
        }
    }
}

async fn fetch(query: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .build()?;
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencode(query));
    let response = client.get(url).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        anyhow::bail!("duckduckgo answered HTTP {status}");
    }
    Ok(body)
}

fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Extracts `(title, href)` for the first `max` `result__a` anchors and the
/// matching `result__snippet` text blocks.
pub fn parse(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut cursor = 0;
    while results.len() < MAX_RESULTS {
        let Some(title_tag) = find_class(html, cursor, "result__a") else { break };
        let Some((title, href, after)) = anchor(html, title_tag) else { break };
        let snippet = find_class(html, title_tag, "result__snippet")
            .and_then(|start| strip_tag(html, start))
            .unwrap_or_default();
        results.push(SearchResult {
            title: decode(strip_tags(&title).trim()),
            url: decode(&normalize_url(&href)),
            snippet: decode(strip_tags(&snippet).trim()),
        });
        cursor = after.max(title_tag + 1);
    }
    results
}

/// Finds an opening tag whose class attribute *contains* `class` (class lists
/// have no quoting guarantee, so substring matching keeps it lenient).
fn find_class(html: &str, from: usize, class: &str) -> Option<usize> {
    let mut cursor = from;
    while let Some(rel) = html[cursor..].find("<") {
        let start = cursor + rel;
        let end = html[start..].find('>')? + start;
        let tag = &html[start..=end];
        // Tags without a class attribute (closing tags, etc.) are skipped —
        // aborting there would hide every later result.
        if let Some(class_attr) = tag.find("class=") {
            let value = &tag[class_attr..];
            if value.contains(class) {
                return Some(start);
            }
        }
        cursor = end + 1;
    }
    None
}

/// Reads `href="…"` from a tag and the text up to `</a>`.
fn anchor(html: &str, start: usize) -> Option<(String, String, usize)> {
    let end = html[start..].find('>')? + start;
    let tag = &html[start..=end];
    let href = tag
        .find("href=")
        .map(|i| &tag[i + 5..])
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("")
        .to_string();
    let text_start = end + 1;
    let text_end = html[text_start..].find("</a>")? + text_start;
    Some((html[text_start..text_end].to_string(), href, text_end + 4))
}

/// Reads the inner text of the element starting at `start` (up to `</a>` or
/// `</div>`, whichever comes first).
fn strip_tag(html: &str, start: usize) -> Option<String> {
    let end = html[start..].find('>')? + start;
    let text_start = end + 1;
    let a_end = html[text_start..].find("</a>").map(|i| text_start + i);
    let div_end = html[text_start..].find("</div>").map(|i| text_start + i);
    let text_end = match (a_end, div_end) {
        (Some(a), Some(d)) => a.min(d),
        (Some(a), None) => a,
        (None, Some(d)) => d,
        (None, None) => return None,
    };
    Some(html[text_start..text_end].to_string())
}

fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// DuckDuckGo returns relative redirects like `//duckduckgo.com/l/?uddg=<enc>`.
fn normalize_url(href: &str) -> String {
    let href = href.trim();
    if let Some(rest) = href.strip_prefix("//duckduckgo.com/l/?uddg=") {
        return percent_decode(rest.split('&').next().unwrap_or(rest));
    }
    if href.starts_with("/") {
        return format!("https://duckduckgo.com{href}");
    }
    href.to_string()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Minimal HTML entity decoding (the characters that appear in DDG results).
fn decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];
        let end = after.find(';');
        let entity_end = match end {
            Some(idx) if idx > 1 && idx <= 12 => idx,
            _ => {
                out.push('&');
                out.push_str(&after[1.min(after.len())..]);
                rest = &after[1.min(after.len())..];
                continue;
            }
        };
        let entity = &after[1..entity_end];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" | "#39" | "#x27" | "rsquo" | "lsquo" => out.push('\''),
            "nbsp" => out.push(' '),
            "ndash" => out.push('–'),
            "mdash" => out.push('—'),
            "hellip" => out.push('…'),
            other if other.starts_with('#') => {
                // &#123; / &#x1F;
                let digits = &other[1..];
                let parsed = if let Some(hex) = digits.strip_prefix('x').or_else(|| digits.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    digits.parse::<u32>().ok()
                };
                match parsed.and_then(char::from_u32) {
                    Some(ch) => out.push(ch),
                    None => out.push_str(&after[..=entity_end]),
                }
            }
            _ => out.push_str(&after[..=entity_end]),
        }
        rest = &after[entity_end + 1..];
    }
    out.push_str(rest);
    out
}

/// Renders the injected prompt block shown inside `# Web arama sonuçları`.
pub fn format_results(query: &str, results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "(web araması sonuç döndürmedi — elindeki bilgilerle cevap ver ve belirsizlik belirt)\n".into();
    }
    let mut out = format!("Sorgu: {query}\n");
    for (index, result) in results.iter().enumerate().take(MAX_RESULTS) {
        out.push_str(&format!(
            "{}. [{}]({})\n   {}\n",
            index + 1,
            result.title.trim(),
            result.url.trim(),
            result.snippet.trim()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sample of the actual `html.duckduckgo.com/html` shape (abridged).
    const FIXTURE: &str = r#"
<div class="results">
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frust&amp;rut=abc">Rust &amp; more</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>Rust</b> programming language &#x27;rules&#x27;.</a>
  </div>
  <div class="result">
    <a rel="nofollow" class="result__a" href="https://docs.rs/rust">Rust docs — official</a>
    <a class="result__snippet">Official documentation for Rust.</a>
  </div>
</div>
"#;

    #[test]
    fn parses_titles_urls_and_snippets() {
        let results = parse(FIXTURE);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust & more");
        assert_eq!(results[0].url, "https://example.com/rust");
        assert_eq!(results[0].snippet, "The Rust programming language 'rules'.");
        assert_eq!(results[1].title, "Rust docs — official");
        assert_eq!(results[1].url, "https://docs.rs/rust");
    }

    #[test]
    fn format_renders_a_usable_prompt_block() {
        let results = parse(FIXTURE);
        let block = format_results("rust nedir", &results);
        assert!(block.contains("Sorgu: rust nedir"), "{block}");
        assert!(block.contains("1. [Rust & more](https://example.com/rust)"), "{block}");
        assert!(block.contains("2. [Rust docs — official](https://docs.rs/rust)"), "{block}");
        let empty = format_results("boş", &[]);
        assert!(empty.contains("sonuç döndürmedi"), "{empty}");
    }

    #[test]
    fn decodes_entities_and_capss_results() {
        let mut html = String::new();
        for i in 0..12 {
            html.push_str(&format!(
                "<a class=\"result__a\" href=\"https://e.com/{i}\">Title {i} &amp; more</a>"
            ));
        }
        let results = parse(&html);
        assert_eq!(results.len(), 6);
        assert_eq!(results[0].title, "Title 0 & more");
    }
}
