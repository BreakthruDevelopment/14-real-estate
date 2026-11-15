-- WebP is already compressed, so skip TOAST's compression pass for photo bytes: out of line, uncompressed.
ALTER TABLE "photo_blob" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;
