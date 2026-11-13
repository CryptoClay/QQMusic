"""Personal cloud playlists; file references remain encrypted at rest."""

import sqlalchemy as sa
from alembic import op

revision = "c7e9a1b35d02"
down_revision = "b6f8d0a21c94"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "nextcloud_playlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("scope", sa.String(64), nullable=False),
        sa.Column("items_json", sa.JSON(), nullable=False),
    )
    op.create_index("ix_nextcloud_playlists_user_id", "nextcloud_playlists", ["user_id"])


def downgrade():
    op.drop_table("nextcloud_playlists")
