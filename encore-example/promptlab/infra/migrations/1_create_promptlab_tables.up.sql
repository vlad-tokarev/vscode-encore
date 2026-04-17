CREATE TABLE prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    template TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE eval_runs (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL,
    score DOUBLE PRECISION NOT NULL
);
