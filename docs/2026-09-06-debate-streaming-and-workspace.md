# 2026-09-06 debate streaming, collapsible turns & project files

Three UX fixes for multi-model and coding conversations:

1. **Collapsible model answers** — every debate turn block (live and replay) now
   expands/collapses via a header toggle and starts collapsed; a one-line preview
   keeps the round readable and the reasoning stays visible when the turn opens.

2. **Coding models see project files** — the coding agent's system prompt now
   carries a bounded workspace snapshot (`core/src/fs.rs::snapshot`): the file
   tree plus inline text contents (≤40 files / 64 KiB, binary and oversized files
   skipped and reported so the model `fs_read`s them explicitly). Coding-mode
   debate participants and the synthesis leader get the same snapshot appended to
   their base prompt.

3. **Streaming + soft typing for the final answer** — the leader synthesis round
   is no longer hidden while it streams: it renders live alongside the debate,
   with its reasoning and text revealed through a requestAnimationFrame
   typewriter (decaying step, soft pulse caret). Duplicating the final answer in
   the live message body was removed; the persisted message still renders the
   synthesis as normal markdown.
