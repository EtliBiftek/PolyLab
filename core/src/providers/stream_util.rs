//! SSE → `ChatEvent` adapter.
//!
//! A small `unfold`-based generator instead of the `async-stream` crate, keeping
//! the build self-sufficient on the vendored registry (which does not carry
//! async-stream).

use futures_util::Stream;
use futures_util::StreamExt;

use super::ChatEvent;

/// Wraps an SSE event stream into a `ChatStream`.
///
/// `on_event(Some(event), out)` processes one SSE event (push emitted events into
/// `out`; return `false` to end the stream). `on_event(None, out)` is the terminal
/// flush: it runs exactly once when the source ends, an SSE transport error
/// occurs, or the per-event call returned `false` — the same semantics as code
/// placed after a `while let Some(event)` loop.
pub fn sse_events<S, E, F>(source: S, on_event: F) -> super::ChatStream
where
    S: Stream<Item = Result<eventsource_stream::Event, E>> + Send + 'static,
    E: std::fmt::Display,
    F: FnMut(Option<&eventsource_stream::Event>, &mut Vec<ChatEvent>) -> bool + Send + 'static,
{
    struct State<S, F> {
        source: std::pin::Pin<Box<S>>,
        on_event: F,
        pending: std::collections::VecDeque<ChatEvent>,
        finishing: bool,
    }

    impl<S, F> State<S, F>
    where
        F: FnMut(Option<&eventsource_stream::Event>, &mut Vec<ChatEvent>) -> bool,
    {
        fn finish(&mut self) {
            if self.finishing {
                return;
            }
            self.finishing = true;
            let mut out = Vec::new();
            (self.on_event)(None, &mut out);
            self.pending.extend(out);
        }
    }

    Box::pin(futures_util::stream::unfold(
        State {
            source: Box::pin(source),
            on_event,
            pending: std::collections::VecDeque::new(),
            finishing: false,
        },
        |mut state| async move {
            loop {
                if let Some(event) = state.pending.pop_front() {
                    return Some((event, state));
                }
                if state.finishing {
                    return None;
                }
                match state.source.next().await {
                    Some(Ok(event)) => {
                        let mut out = Vec::new();
                        let cont = (state.on_event)(Some(&event), &mut out);
                        state.pending.extend(out);
                        if !cont {
                            state.finish();
                        }
                    }
                    Some(Err(error)) => {
                        state.pending.push_back(ChatEvent::Error {
                            detail: format!("stream failed: {error}"),
                        });
                        state.finish();
                    }
                    None => state.finish(),
                }
            }
        },
    ))
}
