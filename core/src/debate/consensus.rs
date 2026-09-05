//! Consensus detection: participants end critique rounds with `CONSENSUS: yes|no`.

/// Extracts the vote from the last matching line of a turn (case-insensitive,
/// tolerant of surrounding whitespace and markdown backticks).
pub fn parse_vote(turn_text: &str) -> Option<bool> {
    let mut vote = None;
    for line in turn_text.lines().rev() {
        let line = line.trim().trim_matches('`').trim();
        let lowered = line.to_ascii_lowercase();
        let Some(rest) = lowered.strip_prefix("consensus:") else {
            continue;
        };
        let rest = rest.trim();
        let value = if rest == "yes" || rest.starts_with("yes") {
            Some(true)
        } else if rest == "no" || rest.starts_with("no") {
            Some(false)
        } else {
            None
        };
        if value.is_some() {
            vote = value;
            break;
        }
    }
    vote
}

/// All remaining participants voted yes?
pub fn unanimous(votes: &[Option<bool>]) -> Option<bool> {
    let mut saw_any = false;
    for vote in votes {
        match vote {
            Some(true) => saw_any = true,
            Some(false) => return Some(false),
            None => return None,
        }
    }
    saw_any.then_some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yes_and_no() {
        assert_eq!(parse_vote("bla bla\nCONSENSUS: yes"), Some(true));
        assert_eq!(parse_vote("CONSENSUS: no"), Some(false));
        assert_eq!(parse_vote("consensus: YES"), Some(true));
        assert_eq!(parse_vote("`CONSENSUS: yes`"), Some(true));
        assert_eq!(parse_vote("  CONSENSUS:   no  "), Some(false));
    }

    #[test]
    fn takes_last_vote_line() {
        assert_eq!(parse_vote("CONSENSUS: yes\nmore text\nCONSENSUS: no"), Some(false));
    }

    #[test]
    fn no_vote_is_none() {
        assert_eq!(parse_vote("no markers here"), None);
        assert_eq!(parse_vote("CONSENSUS: maybe"), None);
        assert_eq!(parse_vote(""), None);
    }

    #[test]
    fn unanimous_logic() {
        assert_eq!(unanimous(&[Some(true), Some(true)]), Some(true));
        assert_eq!(unanimous(&[Some(true), Some(false)]), Some(false));
        assert_eq!(unanimous(&[Some(true), None]), None);
        assert_eq!(unanimous(&[]), None);
    }
}
