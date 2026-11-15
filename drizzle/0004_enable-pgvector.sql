-- pgvector for listing and query embeddings (768 dims). On Azure Flexible Server the extension is allow-listed
-- (pg_allowed_extensions = ["VECTOR"]); the local and CI databases use the pgvector image.
CREATE EXTENSION IF NOT EXISTS vector;
