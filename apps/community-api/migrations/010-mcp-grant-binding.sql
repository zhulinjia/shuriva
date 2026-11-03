ALTER TABLE mcp_grant
  ADD COLUMN bindingGeneration CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX mcp_grant_binding_generation (bindingGeneration),
  ADD CONSTRAINT mcp_grant_binding_generation_fk FOREIGN KEY (bindingGeneration)
    REFERENCES source_binding_identity (generation) ON DELETE SET NULL;
