CREATE INDEX "gateway_commands_post_kind_created_id_idx"
ON "gateway_commands"("postId", "kind", "createdAt", "id");
