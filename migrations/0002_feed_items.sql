-- One row per feed entry ever seen, so a rerun never re-reads an article or re-creates a candidate.
CREATE TABLE feed_item (
  link TEXT PRIMARY KEY,
  feed TEXT NOT NULL,
  title TEXT NOT NULL,
  published TEXT,
  seen_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ignored', 'lead', 'candidate', 'accepted'))
);
CREATE INDEX feed_item_feed ON feed_item(feed, seen_at);
