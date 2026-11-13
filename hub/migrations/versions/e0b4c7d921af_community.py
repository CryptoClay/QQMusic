"""Requests, collaboration, budgets, resume snapshots, versions and scoped share links."""
import sqlalchemy as sa
from alembic import op

revision = "e0b4c7d921af"
down_revision = "d9a2f5b81c03"
branch_labels = depends_on = None


def user(primary=False):
    return sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"),
                     primary_key=primary, nullable=False)


def owner():
    return sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)


def pk():
    return sa.Column("id", sa.Integer(), primary_key=True)


def col(name, typ, nullable=False):
    return sa.Column(name, typ, nullable=nullable)


def upgrade():
    op.add_column("tracks", sa.Column("size_bytes", sa.Integer(), nullable=True))
    op.create_table("music_requests", pk(), user(), col("kind", sa.String(10)), col("artist", sa.String(512)), col("title", sa.String(512)),
                    col("ref", sa.String(200), True), col("status", sa.String(20)), col("note", sa.Text()),
                    sa.Column("batch_id", sa.Integer(), sa.ForeignKey("download_batches.id", ondelete="SET NULL")),
                    col("created_at", sa.DateTime()), col("updated_at", sa.DateTime()))
    op.create_table("community_playlists", pk(), owner(), col("name", sa.String(200)),
                    col("members_json", sa.JSON()), col("items_json", sa.JSON()), col("revision", sa.Integer()),
                    col("archived", sa.Boolean()), col("updated_at", sa.DateTime()))
    op.create_table("inbox_messages", pk(), user(), col("text", sa.String(1000)), col("target", sa.String(200)),
                    col("created_at", sa.DateTime()), col("read_at", sa.DateTime(), True))
    op.create_table("user_policies", user(True), *(col(n, sa.Integer()) for n in
                    ("max_queue", "storage_mb", "upload_mb", "parallel")))
    op.create_table("resume_states", user(True), sa.Column("device", sa.String(100), primary_key=True),
                    col("data_json", sa.JSON()), col("updated_at", sa.DateTime()))
    op.create_table("version_groups", pk(), col("name", sa.String(512)), col("revision", sa.Integer()))
    op.create_table("version_members", sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True),
                    sa.Column("group_id", sa.Integer(), sa.ForeignKey("version_groups.id", ondelete="CASCADE"), nullable=False),
                    col("kind", sa.String(20)))
    op.create_table("version_preferences", user(True),
                    sa.Column("group_id", sa.Integer(), sa.ForeignKey("version_groups.id", ondelete="CASCADE"), primary_key=True),
                    sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id", ondelete="SET NULL")))
    op.create_table("share_links", pk(), owner(), col("token_hash", sa.String(64)), col("token_enc", sa.String(512), True), col("name", sa.String(200)),
                    col("access", sa.String(20)),
                    sa.Column("collection_id", sa.Integer(), sa.ForeignKey("community_playlists.id", ondelete="SET NULL")),
                    col("tracks_json", sa.JSON()), col("expires_at", sa.DateTime()), col("revoked", sa.Boolean()),
                    col("created_at", sa.DateTime()), sa.UniqueConstraint("token_hash"))
    for table, field in (("music_requests", "user_id"), ("music_requests", "status"),
                         ("community_playlists", "owner_id"), ("inbox_messages", "user_id"),
                         ("version_members", "group_id"), ("share_links", "owner_id")):
        op.create_index(f"ix_{table}_{field}", table, [field])


def downgrade():
    for table in ("share_links", "version_preferences", "version_members", "version_groups", "resume_states",
                  "user_policies", "inbox_messages", "community_playlists", "music_requests"):
        op.drop_table(table)
    op.drop_column("tracks", "size_bytes")
