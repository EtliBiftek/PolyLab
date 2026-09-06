# 2026-09-06 chat/settings fixes

This release line fixes chat-history actions, streaming delivery reliability, model groups, provider model search, and provider API-key fallback handling.

Provider API keys remain in the existing secret store. The renderer receives only a masked five-character prefix and key metadata.
