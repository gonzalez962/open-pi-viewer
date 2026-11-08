# Conversation scroll position

The viewer remembers where you were reading in each project and session. Returning to a session, leaving Settings, or reloading the viewer restores the position after the conversation loads. A session without a saved position starts at the bottom. When you are at the bottom, new messages continue to follow it; use the scroll-to-bottom button to return there.

Positions are stored in the browser's localStorage under a separate key for each project and session: `chat-scroll:` followed by the JSON array `[projectId, sessionId]`. The stored value contains only a pixel offset and whether the viewport was pinned to the bottom; it does not contain conversation content.

If localStorage is unavailable or full, scrolling still works, but positions cannot be persisted. An absent or invalid saved position falls back to the bottom. Positions are pixel offsets, not message anchors, so changes to history or layout can shift the passage shown when a position is restored.
